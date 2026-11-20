#!/usr/bin/env node
/**
 * Member onboarding for omdsh-dev.
 *
 * Triggered when a maintainer adds the `approved` label to a join request, or
 * manually via workflow_dispatch. The applicant is always the issue author, so
 * a request cannot invite somebody else. The actor that approved the request
 * must have Admin permission on omdsh-dev/.github.
 */

const ORG = "omdsh-dev";
const REPO = `${ORG}/.github`;
const TOKEN = process.env.GH_TOKEN;
const MODE = process.env.MODE === "apply" ? "apply" : "dry-run";
const LOGIN = (process.env.LOGIN ?? "").trim().replace(/^@/, "");
const ACTOR = (process.env.ACTOR ?? "").trim();
const ISSUE_NUMBER = (process.env.ISSUE_NUMBER ?? "").trim();

if (!TOKEN) throw new Error("GH_TOKEN is required");
if (!LOGIN) throw new Error("LOGIN is required");

const summary = { organization: ORG, mode: MODE, login: LOGIN, actor: ACTOR, issue: ISSUE_NUMBER || null, result: "pending" };

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

async function comment(body) {
  if (!ISSUE_NUMBER || MODE !== "apply") return;
  try {
    await api(`/repos/${REPO}/issues/${ISSUE_NUMBER}/comments`, { method: "POST", body: { body } });
  } catch (error) {
    console.error(`comment failed: ${error.message}`);
  }
}

async function closeIssue() {
  if (!ISSUE_NUMBER || MODE !== "apply") return;
  try {
    await api(`/repos/${REPO}/issues/${ISSUE_NUMBER}`, {
      method: "PATCH",
      body: { state: "closed", state_reason: "completed" }
    });
  } catch (error) {
    console.error(`close failed: ${error.message}`);
  }
}

if (ISSUE_NUMBER) {
  const issue = await api(`/repos/${REPO}/issues/${ISSUE_NUMBER}`);
  if (issue.state !== "open") {
    summary.result = "issue-not-open";
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  }
  const author = (issue.user?.login ?? "").toLowerCase();
  if (author !== LOGIN.toLowerCase()) {
    throw new Error(`issue author ${author} does not match applicant ${LOGIN}`);
  }
  if (!(issue.labels ?? []).some((label) => (label.name ?? "").toLowerCase() === "approved")) {
    throw new Error("issue does not carry the approved label");
  }
}

if (ACTOR) {
  const permission = await api(`/repos/${REPO}/collaborators/${ACTOR}/permission`);
  if (permission.permission !== "admin") {
    throw new Error(`actor ${ACTOR} has ${permission.permission} permission, admin required`);
  }
}

const user = await request(`/users/${LOGIN}`);
if (user.status === 404) throw new Error(`GitHub user ${LOGIN} not found`);

const membership = await request(`/orgs/${ORG}/members/${LOGIN}`);
if (membership.status === 204) {
  summary.result = "already-member";
  await comment(`@${LOGIN} 已经是组织成员，无需重复邀请。`);
  await closeIssue();
} else {
  if (MODE !== "apply") {
    summary.result = "would-invite";
  } else {
    const invitation = await request(`/orgs/${ORG}/memberships/${LOGIN}`, {
      method: "PUT",
      body: { role: "member" }
    });
    if (invitation.status >= 400) {
      throw new Error(`invite ${LOGIN} -> ${invitation.status}: ${JSON.stringify(invitation.data)}`);
    }
    summary.result = invitation.status === 201 ? "invited" : "invitation-updated";
    await comment(`已向 @${LOGIN} 发出组织邀请（角色 member），请查收 GitHub 邮件或在通知里接受。`);
    await closeIssue();
  }
}

console.log(JSON.stringify(summary, null, 2));
