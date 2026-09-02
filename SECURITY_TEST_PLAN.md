# Security Test Plan

## Automated on every change

### MHTalk Windows/Web and Worker

Run `npm run check` in `C:\Dev\MHTalk Remake`.

Expected coverage includes authentication rules, moderation, session resilience, membership authority, OAuth callback rules, subscription equality, provider safety, usage thresholds, attachment authorization, TypeScript builds, production bundle checks, Worker type checks, Rust format/tests, and server-verified badges.

### MHTalk Android

Run `gradlew testDebugUnitTest lintDebug` in `C:\Dev\MHTalk Android`.

Expected coverage includes tier parsing, paid entitlement equality, narrow intent filters through lint, Kotlin compilation, and Android resource/manifest analysis.

### Membership Worker

Run `npm test`, `npm run check`, and `npm audit --json` in `C:\Dev\MVDownloader\backend\LAVA`.

Expected coverage includes exact public plans, OAuth state, Patreon exchange/membership checks, webhook signature/replay behavior, LAVA behavior, response headers/body limits, and a Cloudflare deployment dry run.

### MVDownloader

Run the pinned Python unit suite and `pip-audit==2.10.1` against `requirements_build.txt`. Build with `MVDownloader.spec` into a temporary directory, list the PyInstaller archive, and confirm:

- no `patreon_runtime_config` module;
- no exact value from ignored local Patreon configuration;
- no payment-card collection vocabulary or client-side OAuth secret path.

## Required sandbox tests before production

1. Apply D1 and Supabase migrations to a non-production environment.
2. Configure separate sandbox secrets and exact Patreon tier IDs.
3. Link Plus and Pro independently through Patreon; verify correct badge and equal cross-platform entitlements.
4. Purchase Plus and Pro independently through LAVA test mode; verify webhook-driven activation and renewal/expiry.
5. Replay each webhook and confirm idempotency; alter one signature byte and confirm rejection.
6. Cancel/refund/revoke and confirm the entitlement becomes Free after authoritative status changes.
7. Verify Ultimate and Max Supporter show distinct badges but receive the Free MHTalk entitlement object.
8. Attempt to forge a participant tier from Windows and Android; verify viewers render the server tier.
9. Exercise expired OAuth state, reused state, invalid campaign, invalid tier, malformed UUID, 51 badge IDs, oversized body, and rate-limit paths.
10. Confirm logs contain no bearer token, access token, refresh token, client secret, webhook secret, email beyond operational necessity, or full provider payload.

## Scheduled security cycle

- Weekly: dependency and secret scanning.
- Monthly: provider configuration, least privilege, retention, alerting, and quota review.
- Before every release: clean builds and full checklist.
- After any auth/payment incident: rotate affected secrets, invalidate sessions, reconcile subscriptions, and execute the incident plan.
