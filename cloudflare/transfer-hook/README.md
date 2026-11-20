# omdsh-transfer-hook

GitHub organization webhook receiver for `omdsh-dev`.

When a repository is transferred into the organization, GitHub sends a
`repository` event with action `transferred`. This Worker verifies the
HMAC signature and dispatches `.github/workflows/repository-onboarding.yml`
with the repository name, the transferrer (`sender.login`), and the
repository `node_id`. The workflow then grants repository-level Admin only
if the node ID matches.

## Deploy

```bash
cd cloudflare/transfer-hook
wrangler deploy
wrangler secret put GITHUB_TOKEN       # token with actions:write on omdsh-dev/.github
wrangler secret put WEBHOOK_SECRET     # random string, shared with the org webhook
```

## Organization webhook

Settings → Webhooks → Add webhook:

- Payload URL: `https://omdsh-transfer-hook.<account>.workers.dev`
- Content type: `application/json`
- Secret: same value as `WEBHOOK_SECRET`
- Events: **Repository** only

## Security

- The Worker only accepts `repository.transferred` for repositories owned by
  `omdsh-dev`.
- The dispatched workflow verifies `node_id`, so a forged dispatch cannot
  grant Admin on an arbitrary repository.
- `GITHUB_TOKEN` only needs permission to dispatch the workflow.
