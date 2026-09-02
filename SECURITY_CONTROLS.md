# Security Controls

## Identity and authorization

- Supabase access tokens authenticate MHTalk API calls.
- Onboarding is required before social, room, attachment, and membership operations.
- Profile membership fields are written by service authority, never accepted from profile edit requests.
- Badge reads are authenticated, validated, rate-limited, and return only `profile id -> tier`.

## Membership and payments

- Public plan identifiers are an allow-list: `plus`, `pro`.
- `Ultimate` and `Max Supporter` may be mapped only from configured Patreon supporter tiers; inside MHTalk they grant a verified recognition badge and no paid feature.
- LAVA and Patreon secrets are server-only Cloudflare bindings.
- Patreon uses OAuth state, server exchange, campaign/tier verification, signature verification, replay protection, and idempotent persistence.
- Membership bearer tokens are bounded, fingerprinted for ownership, and never placed in status URLs.
- MHTalk and MVDownloader do not handle card details.

## Browser and deep-link controls

- OAuth completion forwards only `code` or normalized error fields.
- Completion pages use `no-store`, `no-referrer`, `nosniff`, CSP, and a nonce.
- Android intent filters accept only the required MHTalk callback/reset/invite paths.
- Android rejects unsafe legacy fragments carrying raw credentials.

## Data and transport

- External communication uses HTTPS/WSS.
- Private attachments require authentication and have bounded size/retention.
- Logs and user-visible errors avoid provider secrets and raw credentials.
- Environment examples contain placeholders only; real local configuration remains ignored.

## Build and dependency controls

- CI runs tests, type/build checks, lint where available, and dependency audits.
- MVDownloader's build excludes `patreon_runtime_config`.
- A clean temporary EXE is scanned for the retired module and exact configured OAuth values.
- Production deploy scripts remain separate from ordinary checks; this audit used dry runs only.
