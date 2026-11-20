/**
 * GitHub organization webhook receiver for omdsh-dev.
 *
 * On `repository.transferred` it dispatches the `Repository onboarding`
 * workflow in omdsh-dev/.github. The workflow verifies the payload node_id
 * before granting repository-level Admin to the transferrer.
 */

const ORG = "omdsh-dev";
const WORKFLOW = "repository-onboarding.yml";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function verifySignature(secret, body, signature) {
  if (!signature.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = "sha256=" + [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  }
  return diff === 0;
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);

    const body = await request.text();
    const signature = request.headers.get("x-hub-signature-256") ?? "";
    if (!(await verifySignature(env.WEBHOOK_SECRET, body, signature))) {
      return json({ error: "invalid signature" }, 401);
    }

    const event = request.headers.get("x-github-event") ?? "";
    if (event === "ping") return json({ ok: true, pong: true });
    if (event !== "repository") return json({ ok: true, ignored: event });

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return json({ error: "invalid json" }, 400);
    }

    if (payload.action !== "transferred") {
      return json({ ok: true, ignored: payload.action ?? "unknown" });
    }
    if ((payload.repository?.owner?.login ?? "").toLowerCase() !== ORG) {
      return json({ ok: true, ignored: "owner" });
    }

    const repo = payload.repository?.name;
    const user = payload.sender?.login;
    const nodeId = payload.repository?.node_id;
    if (!repo || !user || !nodeId) return json({ error: "incomplete payload" }, 400);

    const response = await fetch(
      `https://api.github.com/repos/${ORG}/.github/actions/workflows/${WORKFLOW}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          "User-Agent": "omdsh-transfer-hook"
        },
        body: JSON.stringify({
          ref: "main",
          inputs: { repo, user, mode: "apply", node_id: nodeId }
        })
      }
    );

    if (!response.ok) {
      const detail = await response.text();
      return json({ ok: false, status: response.status, detail: detail.slice(0, 500) }, 502);
    }

    return json({ ok: true, repo, user, node_id: nodeId, dispatched: true }, 202);
  }
};
