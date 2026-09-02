# Data Inventory

| Data | Purpose | Primary store/processor | Retention/notes |
| --- | --- | --- | --- |
| Account ID, email, username, display name, avatar, bio | Authentication and profile | Supabase Auth/DB | Until account deletion or owner policy |
| Password | Authentication | Supabase Auth | MHTalk does not store plaintext passwords |
| Friend, request, block, presence data | Social functions | Supabase/Cloudflare | Relationship lifetime; presence is temporary |
| Device notification token | Push notifications | Supabase/Firebase | Until replaced, disabled, or account deletion |
| Room identity, ticket, routing metadata | Join and operate a room | Cloudflare/realtime provider | Short-lived operational data |
| Voice, camera, screen media | Live communication | Selected realtime provider | MHTalk does not intentionally record live calls; provider policy applies |
| Private attachment | Room sharing | Private Supabase storage | 24 hours for Free/supporter-badge accounts; 7 days for Plus/Pro |
| Subscription tier and expiry | Entitlements and badge | Supabase profile | Current status plus operational history as configured |
| Opaque membership session token/fingerprint | Link client to verified membership | Cloudflare KV/D1 and local protected client storage | Session/entitlement lifetime; token is not placed in URLs |
| Provider transaction/member/tier IDs | Reconcile subscription | Membership D1, LAVA, Patreon | Financial/operational retention policy applies |
| OAuth access/refresh token for Patreon | Verify Patreon identity/membership | Membership Worker/D1 if required | Server-only, minimum necessary lifetime; never sent to desktop/APK |
| Webhook event ID/signature metadata | Idempotency and replay defense | Membership D1 | Operational security window/history |
| Payment-card details | Payment processing | LAVA/Patreon and their payment processors | Never collected or stored by MHTalk/MVDownloader |
| MVDownloader settings/history | Desktop operation | User's device | User-controlled local data |
| Security/build logs | Diagnostics and incident response | CI/local build systems | Must exclude secrets/tokens; retain only as needed |

Production owners must confirm legal retention, deletion, export, and provider agreements before release. The table documents application behavior and is not legal advice.
