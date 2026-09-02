# Threat Model

## Protected assets

- Supabase sessions, account identities, profiles, friend relationships, blocks, and device tokens.
- MHTalk room membership, invitations, private attachments, chat, realtime media authorization, and provider credentials.
- LAVA and Patreon OAuth credentials, webhook secrets, session tokens, provider transaction/member identifiers, and subscription state.
- Paid Plus/Pro entitlements and verified `Plus`, `Pro`, `Ultimate`, and `Max Supporter` badges.
- MVDownloader local settings and download history.

## Trust boundaries

1. Windows/Android client to MHTalk Worker over TLS.
2. MHTalk Worker to Supabase and realtime providers using server credentials.
3. MHTalk client to the shared membership Worker using an opaque bearer token.
4. Membership Worker to LAVA and Patreon over TLS and authenticated provider APIs.
5. Provider webhook to membership Worker using raw-body signature verification and replay protection.

Clients, custom URI parameters, participant metadata, redirects, browser state, and payment success pages are untrusted. Only server-side provider verification and server-owned profile state may grant an entitlement.

## Primary abuse cases and controls

| Abuse case | Control |
| --- | --- |
| Forge a paid badge or room profile | Authenticated `/social/badges`; server-owned profile tier; client metadata is overridden |
| Activate from a success redirect | Activation requires verified LAVA/Patreon state; redirects do not grant access |
| Replay or forge a webhook | Raw-body signature check, timestamp/replay/idempotency records, bounded body |
| Steal OAuth tokens through deep links | Code/error-only callback, PKCE/provider exchange, no raw token fragment, narrow Android intent filters |
| Link one membership to several users | Token fingerprint ownership binding and authenticated sync |
| Enumerate profiles through badge lookup | Authentication, UUID validation, 50-ID cap, rate limit, minimal response |
| Leak server credentials in desktop/APK | Secrets remain Worker bindings; templates contain placeholders; build artifact checks |
| Exhaust provider quota | Existing routing health checks and provider thresholds below 80% |
| Oversized or malformed request | Body limits, strict shapes, bounded identifiers, rate limits |
| Dependency compromise | Lockfiles, CI audits/tests, pinned security scanner version, controlled updates |

## Out of scope or unverified

- Security of provider-operated payment pages and media infrastructure beyond documented integration boundaries.
- Live Cloudflare, Supabase, LAVA, and Patreon dashboard configuration.
- Supabase production RLS/App Check state and provider-side webhook delivery because production access was intentionally not changed.
- Malware, rooted devices, compromised operating systems, or a stolen unlocked endpoint.
