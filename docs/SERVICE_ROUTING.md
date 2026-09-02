# Realtime service routing and plans

The token service is the single source of truth for room routing and account
entitlements. Both clients accept the same response contract:

```json
{
  "routing": {
    "rtc": { "provider": "stream", "serverUrl": "", "clientKey": "public-key" },
    "messaging": { "provider": "stream-events" },
    "files": { "provider": "supabase-storage" }
  },
  "subscription": { "tier": "free", "entitlements": {} }
}
```

Capability contract version 2 requires each client to declare its RTC,
messaging and file implementations. The broker rejects an incomplete route with
`CLIENT_CAPABILITY_MISMATCH`; both clients also verify that the returned
companion services exactly match the selected RTC provider.

The current working tree contains matching Windows, Android and Worker routes
for Stream, Agora, Tencent, Cloudflare Realtime, LiveKit, Whereby, JaaS and
MiroTalk. Daily Prebuilt remains a legacy Beta path and is not part of the
target zero-budget portfolio. `100ms`, CometChat and VideoSDK were retired to
avoid maintaining three redundant embedded call experiences.
`PROVIDER_PORTFOLIO.md` is the authoritative list of the eight target RTC
providers and their activation order. A provider must not be returned as active
until its server credential issuer and both native client adapters are installed
and integration-tested. This prevents a quota failover from silently dropping
camera, audio or room data.

`GET /service/capabilities` reports the active route and which RTC candidates
are ready. Secrets are never included in this response or stored in a client.

## Safe failover policy

- A room receives one sticky RTC provider for two hours. Voice and video are
  never split across vendors, and existing members stay together.
- Clients send their supported adapter list. The broker cannot return a vendor
  that the installed Windows or Android build cannot use.
- Thresholds are provider-specific. Cloudflare warns at 45%, loses priority at
  50%, drains at 55%, and is disabled at 60%. JaaS warns at 60%, stops new rooms
  at 72%, and its strongly consistent guard stops credential issuance at 19 of
  25 monthly MAUs. Other vendor-metered providers warn at 60%, lose priority at
  65%, stop new rooms at 70%, and disable by 75%. MiroTalk is self-hosted and
  fails closed on its HTTPS health probe instead of a synthetic vendor quota.
- `POST /service/provider-health` updates measured usage or disables a provider.
  It requires the `ROUTING_ADMIN_KEY` bearer secret. This endpoint is designed
  for a scheduled quota collector; it is not callable by the apps.
- `POST /service/provider-policies/harden` idempotently applies the reviewed
  sub-80% policy set through the Worker's Supabase service role. It requires the
  same administrator secret and does not accept arbitrary policy values.
- `POST /service/providers/whereby/smoke` creates, reads and deletes a short-lived
  Whereby meeting without enabling live routing. After it succeeds,
  `/service/providers/whereby/enable` reapplies the guarded policies, repeats the
  probe and enables only Whereby. `/service/providers/whereby/disable` is the
  immediate rollback switch. All three require the administrator secret.
- Token acquisition is limited to 12 seconds and RTC connection to 18 seconds
  on both clients. A failed provider therefore produces a clear error instead
  of an infinite spinner.

All eight targets have complete source adapters. Runtime readiness remains
independent: a route is visibly unavailable until its real credentials, account
plan and healthy quota policy are present. This is an intentional release-safety
rule, not a placeholder route.

For Stream, Agora, Tencent and Cloudflare routes, authenticated attachments use
a private Supabase Storage bucket. The Worker issues short-lived upload and
download URLs, validates ownership, room membership, size and retention, and
removes expired objects from the scheduled job. Service-role credentials never
reach either client.

## Account plans

- Free: voice, optional microphone noise cancellation, camera/screen sharing up
  to 720p, local screen recording up to 720p/60 FPS, 20 MB attachments, and
  every core safety feature.
- Plus and Pro: camera/screen sharing up to 1080p, local recording at source resolution
  and up to 120 FPS when the device can sustain it, 100 MB attachments, and
  cosmetic profile, theme, emoji, soundboard and invite entitlements. Each plan
  keeps its verified name badge. Ultimate and Max Supporter retain distinct
  recognition badges but grant no paid MHTalk feature.

The database owns `subscription_tier` and `subscription_expires_at`. Only the
service role can update them. Clients clamp quality and file sizes locally for a
fast response, while the signed token response remains authoritative.

The Beta support surface starts a session on the shared LAVA backend and links
to the Patreon membership page. LAVA's opaque capability is stored in Windows
Credential Manager or the Android Keystore. A user who subscribed through
MVDownloader can explicitly copy that protected activation code and link it from
MHTalk's Support screen. MHTalk's Worker verifies it directly with the membership
backend, binds it to one MHTalk account, and only then updates the server-owned
paid membership fields. There is no client-side switch that can grant a plan.
Patreon uses a server-owned OAuth flow and the same opaque app capability; no
Patreon client secret or access token is stored by either app.
Google Play builds must use Play Billing unless the app is enrolled in an
applicable alternative-billing program.
