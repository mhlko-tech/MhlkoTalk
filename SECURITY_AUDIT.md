# MHTalk Security Audit

Date: 2026-09-02
Scope: MHTalk Windows/Web, MHTalk Android, the MHTalk Cloudflare Worker, the shared LAVA/Patreon membership gateway, and MVDownloader membership integration.

## Verdict

**FAIL for production release at this moment.** The reviewed local code and automated checks pass, but production release remains blocked until the historical Patreon desktop-secret question is closed, the database migrations are applied, server-only secrets are configured, and both providers complete sandbox verification. This is a release gate, not a statement that the current local builds are broken.

This does not guarantee 100% security.

## Security boundary

- Cloudflare and Supabase are the authority for authenticated identity, public membership badges, room routing, and MHTalk entitlements.
- The LAVA/Patreon Worker is the authority for payment-provider verification and subscription state.
- Windows and Android clients are untrusted displays. They cannot grant themselves a badge or paid feature by changing a local field.
- LAVA and Patreon are the only supported purchase/link providers. Payment-card data is never collected or stored by MHTalk or MVDownloader.

## Principal results

- Public checkout is restricted to `Plus` and `Pro`.
- `Ultimate` and `Max Supporter` remain recognition badges only. They grant no paid MHTalk product entitlement.
- OAuth access and refresh tokens are no longer forwarded through a custom URI.
- Patreon OAuth and webhook verification moved to the server-owned gateway.
- Public badges are returned by an authenticated, rate-limited server endpoint and override client-supplied participant metadata.
- LAVA and Patreon redirects alone cannot activate a subscription; authoritative provider confirmation is required.
- Current JavaScript and Python dependency audits found no known vulnerability in the scanned sets.
- A clean temporary MVDownloader executable contains neither the retired `patreon_runtime_config` module nor an exact local Patreon configuration value.

## Release decision

Do not deploy the membership migration or payment changes until every blocking item in `SECURITY_RELEASE_CHECKLIST.md` is checked. No live deployment, migration, payment, secret rotation, or provider mutation was performed during this audit.

See `SECURITY_FINDINGS.json` for machine-readable findings and status.
