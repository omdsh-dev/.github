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

## Automation

The `Repository maintainer access` workflow runs daily and can also be started manually.

- `audit` reports missing registrations and permission drift without changing access.
- `enforce` grants the registered repository-level Admin permission and verifies the result.
- Unregistered repositories are reported with their top non-bot contributor as a candidate; no permission is granted.

The workflow requires the repository secret `OMDSH_ADMIN_TOKEN`, scoped to administer repository collaborators in `omdsh-dev` and read all organization repositories.
