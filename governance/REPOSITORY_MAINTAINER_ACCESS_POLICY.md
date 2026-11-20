# OMDSH Repository Maintainer Access Policy

## Policy

Every active repository in `omdsh-dev` must have at least one explicitly registered primary maintainer. A registered maintainer receives Admin permission only on the corresponding repository. This policy does not grant organization Owner status or access to unrelated repositories.

The registry in `repository-maintainers.json` is the source of truth. Contribution ranking may be used to suggest a candidate for an unregistered repository, but it must never grant access automatically.

## Changes

- Add or replace maintainers by changing the registry through normal review.
- New repositories must be registered before the scheduled enforcement run can pass.
- Archived repositories remain registered for auditability but are not enforced.
- Removing a maintainer from the registry does not automatically revoke access. Revocation requires a separate, explicit security review.
- Admin invitations remain pending until the recipient accepts them.

## Transfers

When the previous owner transfers a repository into `omdsh-dev`, the onboarding workflow registers that owner as the primary maintainer of the repository and grants repository-level Admin. Ownership is proven by the repository node ID: the grant only goes to the account that owned that exact repository before the transfer. Contribution ranking is not used, and the member's organization role stays `member`.

Repositories that are not part of the watched public set (for example, private repositories) are not detected automatically and can be granted explicitly with the onboarding workflow's `repo` and `user` inputs.

## Automation

The `Repository maintainer access` workflow runs daily and can also be started manually.

- `audit` reports missing registrations and permission drift without changing access.
- `enforce` grants the registered repository-level Admin permission and verifies the result.
- Unregistered repositories are reported with their top non-bot contributor as a candidate; no permission is granted.

The `Repository onboarding` workflow runs every ten minutes and covers members and transfers:

- invites the members listed in the `users` input (organization role `member`) and records a snapshot of the public repositories they own;
- grants repository-level Admin when a repository they owned moves into the organization, then registers it in `repository-maintainers.json`;
- supports explicit `repo` and `user` grants for private or otherwise undetected transfers.

See `REPOSITORY_ONBOARDING.md` for details.

Both workflows require the repository secret `OMDSH_ADMIN_TOKEN`, scoped to administer repository collaborators in `omdsh-dev`, read all organization repositories, and invite members.
