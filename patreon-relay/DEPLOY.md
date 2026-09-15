# MHTalk Patreon connection

This service carries HTTPS bytes for the Windows Patreon window. It does not terminate Patreon TLS, store Patreon credentials, or decide membership eligibility. The existing shared membership backend remains authoritative for paid and gifted tiers.

Signed-in MHTalk accounts with completed onboarding request a five-minute authorization at `POST /subscription/patreon/connection`. The Worker signs an opaque account subject, audience, expiry and random nonce. The relay consumes each authorization once, then requires a server-validated Turnstile proof bound to hostname, action `patreon_access` and attempt. No invitation is needed.

## Deployment

1. Configure the Worker secret `PATREON_RELAY_ACCESS_SECRET` and the same secret in the relay's private `.env`. Use at least 32 random bytes; never commit this file. Set Worker `PATREON_RELAY_URL` to the exact relay origin.
2. Supply real Turnstile keys and allow the exact production hostname in the widget. Existing Canary hostname and keys can be preserved; action and hostname are checked independently by each service.
3. On the dedicated Patreon VM, install this folder at `/opt/mhtalk-patreon`. Create `data` owned by UID/GID 65532. Protect `.env` with mode 600. Run `sudo docker compose up -d --build`.
4. Add the included Caddy site to the existing HTTPS gateway, validate, then reload. Preserve the Canary site. No access log should record authorization/verification URLs or headers.
5. Check `/health`, an unauthorized tunnel (401), and invalid attempt authorization (403). Run the ignored Rust live TLS test with the actual production URL before publishing the desktop update.

The service listens on loopback 8788, uses at most 256 MiB, and accepts 20 simultaneous pending/active sessions. Sessions last at most 20 minutes, 100 MiB and 24 tunnels. An account can start three attempts per ten minutes, with one pending/active connection at a time. A persisted 512 MiB daily service budget closes forwarding when exhausted. Public availability means any signed-in account is eligible; capacity remains bounded. Monitor utilization before raising these limits.

Checkout requires `ENABLE_CHECKOUT=true`. The Windows client opens Patreon membership selection; Patreon confirms the actual tier and price. Closing checkout never grants a membership: the user must link Patreon and complete server verification. The app's own proxy is scoped to these private windows; the system proxy is unchanged.

## Validation limits

Automated tests cover transport, authorization, quotas, destination restrictions and callback handling. They do not prove a real payment or bank challenge succeeds. Google/Apple/Facebook sign-in and bank domains outside the explicit allowlist may not work in the embedded window; use Patreon email login. Investigate actual blocked destinations before expanding policy. Do not describe payment configuration alone as an end-to-end payment test.

## Rollback

Restore the previous signed desktop release and previous Worker version if needed. Remove only the production Caddy site and stop `/opt/mhtalk-patreon` with `docker compose stop`; preserve its quota data and the separate Canary service. Remove the production Turnstile hostname only after clients stop using it. Keep LAVA and the shared membership backend unchanged.
