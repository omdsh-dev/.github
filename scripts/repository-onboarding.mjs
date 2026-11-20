#!/usr/bin/env node
/**
 * Repository onboarding for the omdsh-dev organization.
 *
 * The Cloudflare transfer hook dispatches this workflow when GitHub reports a
 * repository.transferred event. The workflow grants repository-level Admin to
 * the transferrer only when the expected node_id matches the repository that
 * actually landed in the organization. No watchlist or repository snapshot is
 * stored by this workflow.
 *
 * Environment:
 *   GH_TOKEN          token with repo admin (and admin:org for invitations)
 *   MODE              "apply" (default: "dry-run")
 *   INVITE            comma/space separated logins to invite
 *   GRANT_REPO        repository name (or owner/name) to grant
 *   GRANT_USER        login that receives the grant
 *   EXPECTED_NODE_ID  repository node_id from the webhook payload
 */

import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const ORG = process.env.ORG ?? "omdsh-dev";
const REGISTRY_PATH = "governance/repository-maintainers.json";
const MODE = process.env.MODE === "apply" ? "apply" : "dry-run";
const TOKEN = process.env.GH_TOKEN;
const ACTOR = process.env.GITHUB_ACTOR ?? "repository-onboarding";

if (!TOKEN) throw new Error("GH_TOKEN is required");

const inviteUsers = splitList(process.env.INVITE);
const grantRepo = (process.env.GRANT_REPO ?? "").trim().replace(/^[^/]+\//, "");
const grantUser = (process.env.GRANT_USER ?? "").trim().replace(/^@/, "");
const expectedNodeId = (process.env.EXPECTED_NODE_ID ?? "").trim();

const summary = {
  organization: ORG,
  mode: MODE,
  actor: ACTOR,
  invited: [],
  alreadyMembers: [],
  granted: [],
  conflicts: [],
  errors: []
};

function splitList(value) {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((item) => item.trim().replace(/^@/, ""))
    .filter(Boolean);
}

async function request(path, { method = "GET", body } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { status: response.status, data };
}

async function api(path, options) {
  const result = await request(path, options);
  if (result.status >= 400) {
    const detail = typeof result.data === "string" ? result.data : JSON.stringify(result.data);
    throw new Error(`${options?.method ?? "GET"} ${path} -> ${result.status}: ${detail}`);
  }
  return result.data;
}

async function paged(path) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const batch = await api(`${path}${separator}per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

async function isMember(login) {
  const result = await request(`/orgs/${ORG}/members/${login}`);
  if (result.status === 204) return true;
  if (result.status === 404) return false;
  throw new Error(`GET /orgs/${ORG}/members/${login} -> ${result.status}`);
}

async function invite(login) {
  const result = await request(`/orgs/${ORG}/memberships/${login}`, {
    method: "PUT",
    body: { role: "member" }
  });
  if (result.status >= 400) {
    throw new Error(`invite ${login} -> ${result.status}: ${JSON.stringify(result.data)}`);
  }
  return { state: result.data?.state ?? "pending", invited: result.status === 201 };
}

async function grantAdmin(repository, login) {
  if (MODE !== "apply") return { invitation: false, status: 0, dryRun: true };
  const result = await request(`/repos/${ORG}/${repository}/collaborators/${login}`, {
    method: "PUT",
    body: { permission: "admin" }
  });
  if (result.status >= 400) {
    throw new Error(`grant ${login} on ${repository} -> ${result.status}: ${JSON.stringify(result.data)}`);
  }
  return { invitation: Boolean(result.data?.id), status: result.status };
}

function registerMaintainer(registry, repository, login) {
  const current = registry.repositories[repository];
  if (!current?.length) {
    if (MODE === "apply") registry.repositories[repository] = [login];
    return "registered";
  }
  if (current.some((entry) => entry.toLowerCase() === login.toLowerCase())) return "already";
  return "conflict";
}

async function commitRegistry(message) {
  if (MODE !== "apply") return;
  const status = await exec("git", ["status", "--porcelain", "--", REGISTRY_PATH]);
  if (!status.stdout.trim()) return;
  await exec("git", ["config", "user.name", "omdsh-onboarding[bot]"]);
  await exec("git", ["config", "user.email", "onboarding@users.noreply.github.com"]);
  await exec("git", ["add", REGISTRY_PATH]);
  await exec("git", ["commit", "-m", message]);
  try {
    await exec("git", ["push", "origin", "HEAD:main"]);
  } catch {
    await exec("git", ["pull", "--rebase", "--autostash", "origin", "main"]);
    await exec("git", ["push", "origin", "HEAD:main"]);
  }
}

const registry = JSON.parse(await fs.readFile(REGISTRY_PATH, "utf8"));

for (const login of inviteUsers) {
  try {
    if (await isMember(login)) {
      summary.alreadyMembers.push(login);
    } else if (MODE === "apply") {
      const result = await invite(login);
      summary.invited.push({ user: login, state: result.state });
    } else {
      summary.invited.push({ user: login, state: "would-invite" });
    }
  } catch (error) {
    summary.errors.push({ user: login, error: error.message });
  }
}

if (grantRepo && grantUser) {
  try {
    const repository = await api(`/repos/${ORG}/${grantRepo}`).catch(() => null);
    if (!repository) {
      summary.errors.push({ user: grantUser, repo: grantRepo, error: `repository not found in ${ORG}` });
    } else if (expectedNodeId && repository.node_id !== expectedNodeId) {
      summary.errors.push({
        user: grantUser,
        repo: repository.name,
        error: `node_id mismatch: expected ${expectedNodeId}, got ${repository.node_id}`
      });
    } else {
      const outcome = registerMaintainer(registry, repository.name, grantUser);
      if (outcome === "conflict") {
        summary.conflicts.push({ user: grantUser, repo: repository.name });
      } else {
        const grant = await grantAdmin(repository.name, grantUser);
        summary.granted.push({ user: grantUser, repo: repository.name, invitation: grant.invitation });
      }
    }
  } catch (error) {
    summary.errors.push({ user: grantUser, repo: grantRepo, error: error.message });
  }
}

if (MODE === "apply") await commitRegistry(`chore(onboarding): register ${summary.granted.map((item) => item.repo).join(", ") || "no repositories"}`);

const markdown = [
  "# Repository onboarding",
  "",
  `- Mode: **${MODE}**`,
  `- Invited: **${summary.invited.length}**`,
  `- Already members: **${summary.alreadyMembers.length}**`,
  `- Admin granted: **${summary.granted.length}**`,
  `- Conflicts: **${summary.conflicts.length}**`,
  `- Errors: **${summary.errors.length}**`,
  "",
  "```json",
  JSON.stringify(summary, null, 2),
  "```"
].join("\n");

console.log(JSON.stringify(summary, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}
if (summary.errors.length) process.exitCode = 1;
