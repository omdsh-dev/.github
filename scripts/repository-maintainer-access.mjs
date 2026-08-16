#!/usr/bin/env node

import fs from "node:fs/promises";

const registryPath = process.argv[2] ?? "governance/repository-maintainers.json";
const mode = process.argv[3] ?? "audit";

if (!new Set(["audit", "enforce"]).has(mode)) {
  throw new Error(`Invalid mode: ${mode}`);
}

const token = process.env.GH_TOKEN;
if (!token) throw new Error("GH_TOKEN is required");

const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
const org = registry.organization;
const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28"
};

async function api(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: { ...headers, ...options.headers }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${options.method ?? "GET"} ${path}: ${response.status} ${body}`);
  }
  return response.status === 204 ? null : response.json();
}

async function paged(path) {
  const values = [];
  for (let page = 1; ; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const items = await api(`${path}${separator}per_page=100&page=${page}`);
    values.push(...items);
    if (items.length < 100) return values;
  }
}

async function candidate(repo) {
  const contributors = await paged(`/repos/${org}/${repo}/contributors?anon=1`);
  return contributors.find(item => item.type === "User" && !item.login.endsWith("[bot]"))?.login ?? "unresolved";
}

const repos = await paged(`/orgs/${org}/repos?type=all`);
const active = repos.filter(repo => !repo.archived);
const missing = [];
const drift = [];
const changed = [];
const pending = [];

for (const repo of active) {
  const maintainers = registry.repositories[repo.name];
  if (!maintainers?.length) {
    missing.push({ repo: repo.name, candidate: await candidate(repo.name) });
    continue;
  }

  for (const user of maintainers) {
    const current = await api(`/repos/${org}/${repo.name}/collaborators/${user}/permission`);
    if (current.permission === registry.requiredPermission) continue;

    const invitations = await paged(`/repos/${org}/${repo.name}/invitations`);
    const existingInvitation = invitations.find(
      item => item.invitee?.login.toLowerCase() === user.toLowerCase()
        && item.permissions === registry.requiredPermission
        && !item.expired
    );
    if (existingInvitation) {
      pending.push({ repo: repo.name, user, invitation: existingInvitation.id });
      continue;
    }

    drift.push({ repo: repo.name, user, current: current.permission });
    if (mode !== "enforce") continue;

    const invitation = await api(`/repos/${org}/${repo.name}/collaborators/${user}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permission: registry.requiredPermission })
    });
    if (invitation?.id) pending.push({ repo: repo.name, user, invitation: invitation.id });
    else changed.push({ repo: repo.name, user });
  }
}

const stale = Object.keys(registry.repositories).filter(name => !repos.some(repo => repo.name === name));
const summary = {
  organization: org,
  mode,
  activeRepositories: active.length,
  registeredRepositories: Object.keys(registry.repositories).length,
  missing,
  drift,
  changed,
  pending,
  stale
};

console.log(JSON.stringify(summary, null, 2));

if (process.env.GITHUB_STEP_SUMMARY) {
  const lines = [
    "# Repository maintainer access",
    "",
    `- Mode: **${mode}**`,
    `- Active repositories: **${active.length}**`,
    `- Missing registrations: **${missing.length}**`,
    `- Permission drift: **${drift.length}**`,
    `- Permissions changed: **${changed.length}**`,
    `- Pending invitations: **${pending.length}**`,
    "",
    "```json",
    JSON.stringify(summary, null, 2),
    "```"
  ];
  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}

if (missing.length || stale.length || (mode === "audit" && drift.length)) process.exitCode = 1;
