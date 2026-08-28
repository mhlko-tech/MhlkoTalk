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
ephemeral files. The routing contract already reserves Agora and Daily for RTC,
Cloudflare/Supabase/Firebase for messages, and R2/Supabase/B2 for files. A
provider must not be returned as active until its server credential issuer and
both native client adapters are installed and integration-tested. This prevents
a quota failover from silently dropping camera, audio or room data.

`GET /service/capabilities` reports the active route and which RTC candidates
are ready. Secrets are never included in this response or stored in a client.

## Account plans

- Free: voice, optional microphone noise cancellation, camera/screen sharing up
  to 720p, 20 MB attachments, and every core safety feature.
- Plus: camera/screen sharing up to 1080p, 100 MB attachments, and cosmetic
  profile, theme, emoji, soundboard and invite entitlements.

The database owns `subscription_tier` and `subscription_expires_at`. Only the
service role can update them. Clients clamp quality and file sizes locally for a
fast response, while the signed token response remains authoritative.

Store billing is intentionally a separate integration. Until a verified Google
Play or Windows purchase webhook promotes an account, all accounts resolve to
Free. There is no client-side switch that can grant Plus.
