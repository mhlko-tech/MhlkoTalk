# Changelog

## 1.6.7 - 2026-09-02

- Restored the LiveKit media behavior contract across Windows and Android: microphone mute no longer controls screen audio.
- Added cross-platform provider capability gates so Windows and Android cannot be split across incompatible RTC rooms.
- Enabled independent Stream screen audio on Windows and unified audio-output routing for remote voice and shared media.
- Added stable Android Bluetooth/AirPods routing for non-LiveKit native providers.
- Replaced KV-backed presence tickets and social invitations with signed tokens, and moved new private-room codes to Durable Object storage.
- Routed Windows social requests through the bounded native MHTalk network client and isolated presence reconnect failures from the Friends UI.

## 1.6.0 - 2026-08-30

- Added capability contract v2 across the Worker, Windows and Android clients.
- Completed Stream room events and native MHTalk chat interoperability on Android.
- Added private, expiring Supabase Storage attachments with signed upload,
  download and deletion capabilities.
- Added signed, idempotent RTC usage heartbeats and scheduled quota-health sync.
- Added Windows/Worker CI, staging configuration, release gates and rollback docs.
- Kept incomplete providers unavailable until both clients and quota controls ship.
