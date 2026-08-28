# Realtime service routing and plans

The token service is the single source of truth for room routing and account
entitlements. Both clients accept the same response contract:

```json
{
  "routing": {
    "rtc": { "provider": "livekit", "serverUrl": "wss://…" },
    "messaging": { "provider": "livekit-data" },
    "files": { "provider": "livekit-stream" }
  },
  "subscription": { "tier": "free", "entitlements": {} }
}
```

The current production adapters remain LiveKit for calls, live messages and
ephemeral files. The broker models eleven service integrations: Stream, Agora,
100ms, Daily and LiveKit for RTC; Cloudflare Durable Objects, Supabase Realtime
and Firebase for messaging; and Cloudflare R2, Supabase Storage and Backblaze
B2 for files. A
provider must not be returned as active until its server credential issuer and
both native client adapters are installed and integration-tested. This prevents
a quota failover from silently dropping camera, audio or room data.

`GET /service/capabilities` reports the active route and which RTC candidates
are ready. Secrets are never included in this response or stored in a client.

## Safe failover policy

- A room receives one sticky RTC provider for two hours. Voice and video are
  never split across vendors, and existing members stay together.
- Clients send their supported adapter list. The broker cannot return a vendor
  that the installed Windows or Android build cannot use.
- At 70% usage operations are warned. At 85% a provider drains and receives no
  new rooms when another healthy adapter exists. At 95% it is exhausted and
  new/reconnecting rooms migrate to the next compatible provider.
- `POST /service/provider-health` updates measured usage or disables a provider.
  It requires the `ROUTING_ADMIN_KEY` bearer secret. This endpoint is designed
  for a scheduled quota collector; it is not callable by the apps.
- Token acquisition is limited to 12 seconds and RTC connection to 18 seconds
  on both clients. A failed provider therefore produces a clear error instead
  of an infinite spinner.

Only LiveKit has a shipped end-to-end adapter today. The other entries remain
visibly unavailable until their credentials and both client SDK adapters are
deployed. This is an intentional release-safety rule, not a placeholder route.

## Account plans

- Free: voice, optional microphone noise cancellation, camera/screen sharing up
  to 720p, local screen recording up to 720p/60 FPS, 20 MB attachments, and
  every core safety feature.
- Plus: camera/screen sharing up to 1080p, local recording at source resolution
  and up to 120 FPS when the device can sustain it, 100 MB attachments, and
  cosmetic profile, theme, emoji, soundboard and invite entitlements.

The database owns `subscription_tier` and `subscription_expires_at`. Only the
service role can update them. Clients clamp quality and file sizes locally for a
fast response, while the signed token response remains authoritative.

The Beta support surface starts a session on the existing LAVA backend and links
to the Patreon membership page. LAVA's opaque capability is stored in Windows
Credential Manager or the Android Keystore. MHTalk's Worker verifies it directly
with the membership backend, binds it to one MHTalk account, and only then
updates the server-owned Plus fields. There is no client-side switch that can
grant Plus. Cross-app Patreon identity linking is still gated on the provider's
OAuth credentials. Google Play builds must use Play Billing unless the app is
enrolled in an applicable alternative-billing program.
