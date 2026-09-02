# Security Release Checklist

## Blocking approvals and external configuration

- [ ] Confirm whether a real Patreon client secret was ever shipped in any public MVDownloader build. If yes or uncertain, rotate it before release.
- [ ] Review and approve the Supabase migration `202609020002_membership_badge_tiers.sql`.
- [ ] Review and approve the D1 migration `0003_patreon_memberships.sql`.
- [ ] Configure server-only LAVA offer IDs for Plus ($5) and Pro ($10).
- [ ] Configure Patreon client ID/secret, campaign ID, webhook secret, and exact Plus/Pro tier IDs as Worker secrets/variables.
- [ ] If existing Ultimate/Max Supporter Patreon tiers are retained, configure their exact IDs; do not expose them as new public checkout plans.
- [ ] Complete all sandbox tests in `SECURITY_TEST_PLAN.md`.
- [ ] Obtain explicit owner approval for production migration and deployment.

## Code and build gates

- [x] Windows/Web/Worker checks pass.
- [x] Android unit tests and lint pass.
- [x] Membership Worker tests and dry-run pass.
- [x] MVDownloader tests pass.
- [x] JavaScript audit reports zero known vulnerabilities in the scanned dependency sets.
- [x] Python dependency audit reports zero known vulnerabilities in `requirements_build.txt`.
- [x] Clean MVDownloader EXE excludes the retired Patreon runtime-config module and exact local OAuth values.
- [x] GitHub CI passes on the pushed implementation commits.
- [ ] Production artifacts are rebuilt from the reviewed commits only.

## Functional policy

- [x] Only Plus and Pro are public purchase plans.
- [x] Plus and Pro show their matching verified badge beside the MHTalk name.
- [x] Ultimate and Max Supporter keep their own badge and grant no paid MHTalk feature.
- [x] Windows and Android use the same server-owned tier names and entitlement mapping.
- [x] No redirect, client amount, local profile, or participant payload can independently activate membership.
