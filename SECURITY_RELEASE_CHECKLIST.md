# Security Release Checklist

## Blocking approvals and external configuration

- [ ] Confirm whether a real Patreon client secret was ever shipped in any public MVDownloader build. If yes or uncertain, rotate it before release.
- [ ] Review and approve the Supabase migration `202609020002_membership_badge_tiers.sql`.
- [ ] Review and approve the D1 migration `0003_patreon_memberships.sql`.
- [ ] Configure server-only LAVA offer IDs for Plus ($5), Pro ($7), Ultimate ($10), and Max Supporter ($15).
- [ ] Configure Patreon client ID/secret, campaign ID, webhook secret, and all four exact tier IDs as Worker secrets/variables.
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

- [x] Plus, Pro, Ultimate, and Max Supporter are public purchase plans with canonical prices.
- [x] All four tiers show their matching verified badge beside the MHTalk name.
- [x] Plus grants HD media entitlements; Pro, Ultimate, and Max Supporter grant the complete MHTalk entitlement set.
- [x] Windows and Android use the same server-owned tier names and entitlement mapping.
- [x] No redirect, client amount, local profile, or participant payload can independently activate membership.
