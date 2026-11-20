#!/usr/bin/env node
/**
 * Repository onboarding pipeline for the omdsh-dev organization.
 *
 * Invites listed members, keeps a snapshot of the public repositories they own,
 * and grants repository-level Admin permission when one of those repositories
 * moves into the organization. Ownership is proven with the repository node_id,
 * so a grant can only go to the account that previously owned that exact
 * repository. Contributor ranking is never used.
 *
 * Environment:
 *   GH_TOKEN    token with repo admin + admin:org (for invitations)
 *   MODE        "apply" (default: "dry-run")
 *   INVITE      comma/space separated logins to invite and watch
 *   GRANT_REPO  repository name (or owner/name) to grant explicitly
 *   GRANT_USER  login that receives the explicit grant
 */

import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const ORG = process.env.ORG ?? "omdsh-dev";
const QUEUE_PATH = "governance/onboarding-queue.json";
const REGISTRY_PATH = "governance/repository-maintainers.json";
const MODE = process.env.MODE === "apply" ? "apply" : "dry-run";
const TOKEN = process.env.GH_TOKEN;
const WATCH_DAYS = Number(process.env.WATCH_DAYS ?? 180);
const PENDING_DAYS = Number(process.env.PENDING_DAYS ?? 14);
const ACTOR = process.env.GITHUB_ACTOR ?? "repository-onboarding";

if (!TOKEN) throw new Error("GH_TOKEN is required");

const inviteUsers = splitList(process.env.INVITE);
const grantRepo = (process.env.GRANT_REPO ?? "").trim().replace(/^[^/]+\//, "");
const grantUser = (process.env.GRANT_USER ?? "").trim().replace(/^@/, "");

const now = new Date();
const iso = (date = now) => date.toISOString();
const ageMs = (value) => now.getTime() - new Date(value).getTime();
const days = (count) => count * 86_400_000;

const summary = {
  organization: ORG,
  mode: MODE,
  invited: [],
  alreadyMembers: [],
  granted: [],
  conflicts: [],
  pending: [],
  waiting: [],
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

async function readJson(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback) return fallback;
    throw error;
  }
}

async function writeJsonIfChanged(path, value) {
  const next = `${JSON.stringify(value, null, 2)}\n`;
  let previous = null;
  try {
    previous = await fs.readFile(path, "utf8");
  } catch {}
  if (previous === next) return false;
  if (MODE === "apply") await fs.writeFile(path, next);
  return true;
}

async function listUserRepositories(login) {
  const repositories = await paged(`/users/${login}/repos?type=owner&sort=updated`);
  const owned = new Map();
  for (const repository of repositories) {
    if (repository.owner?.login?.toLowerCase() !== login.toLowerCase()) continue;
    owned.set(repository.node_id, {
      name: repository.name,
      private: repository.private,
      archived: repository.archived
    });
  }
  return owned;
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
    body: { role: "direct_member" }
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

function findOrCreateWatch(queue, login) {
  let entry = queue.watching.find((item) => item.user.toLowerCase() === login.toLowerCase());
  if (entry) return { entry, created: false };
  entry = {
    user: login,
    addedAt: iso(),
    addedBy: ACTOR,
    repos: {},
    pending: {},
    granted: []
  };
  queue.watching.push(entry);
  return { entry, created: true };
}

async function snapshot(entry) {
  const current = await listUserRepositories(entry.user);
  for (const [nodeId, meta] of Object.entries(entry.repos ?? {})) {
    if (!current.has(nodeId) && !entry.pending[nodeId]) {
      entry.pending[nodeId] = { name: meta.name, since: iso() };
    }
  }
  for (const nodeId of Object.keys(entry.pending)) {
    if (current.has(nodeId)) delete entry.pending[nodeId];
  }
  entry.repos = Object.fromEntries(
    [...current].map(([nodeId, meta]) => [nodeId, { name: meta.name, private: meta.private }])
  );
  return current;
}

async function resolvePending(entry, orgByNode, registry) {
  for (const [nodeId, meta] of Object.entries(entry.pending)) {
    const repository = orgByNode.get(nodeId);
    if (!repository) {
      if (ageMs(meta.since) > days(PENDING_DAYS)) delete entry.pending[nodeId];
      else summary.pending.push({ user: entry.user, repo: meta.name, since: meta.since });
      continue;
    }
    const outcome = registerMaintainer(registry, repository.name, entry.user);
    if (outcome === "conflict") {
      summary.conflicts.push({ user: entry.user, repo: repository.name, nodeId });
      delete entry.pending[nodeId];
      continue;
    }
    const grant = await grantAdmin(repository.name, entry.user);
    entry.granted.push({
      repo: repository.name,
      nodeId,
      at: iso(),
      invitation: grant.invitation,
      source: "transfer"
    });
    delete entry.pending[nodeId];
    summary.granted.push({ user: entry.user, repo: repository.name, invitation: grant.invitation });
  }
}

async function commit(files) {
  if (MODE !== "apply") return false;
  const status = await exec("git", ["status", "--porcelain", "--", ...files]);
  if (!status.stdout.trim()) return false;
  await exec("git", ["config", "user.name", "omdsh-onboarding[bot]"]);
  await exec("git", ["config", "user.email", "onboarding@users.noreply.github.com"]);
  await exec("git", ["add", ...files]);
  await exec("git", ["commit", "-m", `chore(onboarding): update transfer watchlist (${summary.granted.length} grant(s))`]);
  try {
    await exec("git", ["push", "origin", "HEAD:main"]);
  } catch {
    await exec("git", ["pull", "--rebase", "--autostash", "origin", "main"]);
    await exec("git", ["push", "origin", "HEAD:main"]);
  }
  return true;
}

const queue = await readJson(QUEUE_PATH, {
  organization: ORG,
  updatedAt: iso(),
  watching: []
});
const registry = JSON.parse(await fs.readFile(REGISTRY_PATH, "utf8"));

const orgRepositories = await paged(`/orgs/${ORG}/repos?type=all`);
const orgByNode = new Map(orgRepositories.map((repository) => [repository.node_id, repository]));
const orgByName = new Map(orgRepositories.map((repository) => [repository.name, repository]));

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
    const { entry } = findOrCreateWatch(queue, login);
    await snapshot(entry);
  } catch (error) {
    summary.errors.push({ user: login, error: error.message });
  }
}

if (grantRepo && grantUser) {
  const repository = orgByName.get(grantRepo) ?? orgByNode.get(grantRepo);
  if (!repository) {
    summary.errors.push({ user: grantUser, error: `repository ${grantRepo} not found in ${ORG}` });
  } else {
    try {
      const outcome = registerMaintainer(registry, repository.name, grantUser);
      if (outcome === "conflict") {
        summary.conflicts.push({ user: grantUser, repo: repository.name });
      } else {
        const grant = await grantAdmin(repository.name, grantUser);
        summary.granted.push({ user: grantUser, repo: repository.name, invitation: grant.invitation });
      }
    } catch (error) {
      summary.errors.push({ user: grantUser, repo: repository.name, error: error.message });
    }
  }
}

queue.watching = queue.watching.filter((entry) => ageMs(entry.addedAt) < days(WATCH_DAYS));

for (const entry of queue.watching) {
  try {
    await snapshot(entry);
    await resolvePending(entry, orgByNode, registry);
    if (Object.keys(entry.pending).length) summary.waiting.push(entry.user);
  } catch (error) {
    summary.errors.push({ user: entry.user, error: error.message });
  }
}

queue.updatedAt = iso();
queue.organization = ORG;

const queueChanged = await writeJsonIfChanged(QUEUE_PATH, queue);
const registryChanged = await writeJsonIfChanged(REGISTRY_PATH, registry);

if (MODE === "apply" && (queueChanged || registryChanged)) {
  await commit([QUEUE_PATH, REGISTRY_PATH]);
}

const markdown = [
  "# Repository onboarding",
  "",
  `- Mode: **${MODE}**`,
  `- Invited: **${summary.invited.length}**`,
  `- Already members: **${summary.alreadyMembers.length}**`,
  `- Admin granted: **${summary.granted.length}**`,
  `- Conflicts: **${summary.conflicts.length}**`,
  `- Waiting for transfer: ${summary.waiting.length ? summary.waiting.map((user) => `@${user}`).join(", ") : "—"}`,
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
