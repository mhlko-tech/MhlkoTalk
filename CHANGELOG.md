# Changelog

## 1.6.14 - 2026-09-12

- Retry a failed RTC connection on an available compatible provider, with bounded attempts, deadlines and cancellation-safe cleanup.
- Coordinate room routing through strongly consistent participant leases so simultaneous failures do not send members to separate voice servers.
- Recover when an active provider disconnects or reaches its guarded usage limit; preserve old-client room occupancy during rollout.
- Show the actual server and green/yellow/red quota status above the account profile. Missing or stale quota data is explicitly unknown.
- Count room presence only after the SDK connects, and release failed joins without charging synthetic participant minutes.
- Restore the existing LiveKit route as the preferred provider after a successful two-client synthetic audio/data check; preserve its quota limits.
- Camera and screen capture stop during provider recovery. Restart sharing after reconnecting.

## 1.6.13 - 2026-09-07

- Restored membership badges beside member names in room lists, media cards, member menus and Friends. Only the account footer remains free of the inline badge; profiles keep the badge below the photo.
- Request exclusion of the capturing application's own audio from Agora and Cloudflare screen capture, preventing call playback from being sent back to viewers on supported runtimes. Stream and LiveKit use the same shared capture constraint.
- Added guards against playing the local Agora voice or screen identity through remote media controls, with regression coverage for local and remote playback.
- Kept screen audio stereo quality and disabled voice processing unchanged.

## 1.6.12 - 2026-09-07

- Moved paid membership badges below the photo in profile views and the profile editor; names and usernames no longer overlap with badges.
- Replaced the yellow question-mark support button with a dollar sign and updated its accessible label.
- Disabled echo cancellation, noise suppression and automatic gain control for Agora, Stream and Cloudflare screen audio; microphone settings remain independent.
- Publish Agora screen audio with the 48 kHz, 192 kbps stereo music preset, and LiveKit screen audio with its high-quality stereo preset without discontinuous transmission.
- Clean up Agora screen capture after cancellation or publishing failures, and report video-only sources without claiming they include audio.
- Added regression coverage for capture/encoding settings, microphone independence, sources without audio, repeated sharing, picker stop and failure cleanup.

## 1.6.7 - 2026-09-02

- Restored the LiveKit media behavior contract across Windows and Android: microphone mute no longer controls screen audio.
- Added cross-platform provider capability gates so Windows and Android cannot be split across incompatible RTC rooms.
- Enabled independent Stream screen audio on Windows and unified audio-output routing for remote voice and shared media.
- Added stable Android Bluetooth/AirPods routing for non-LiveKit native providers.
- Replaced KV-backed presence tickets and social invitations with signed tokens, and moved new private-room codes to Durable Object storage.
- Moved provider-health telemetry to Durable Object storage so exhausted KV allowances cannot close every call route.
- Routed Windows social requests through the bounded native MHTalk network client and isolated presence reconnect failures from the Friends UI.

## 1.6.0 - 2026-08-30

- Added capability contract v2 across the Worker, Windows and Android clients.
- Completed Stream room events and native MHTalk chat interoperability on Android.
- Added private, expiring Supabase Storage attachments with signed upload,
  download and deletion capabilities.
- Added signed, idempotent RTC usage heartbeats and scheduled quota-health sync.
- Added Windows/Worker CI, staging configuration, release gates and rollback docs.
- Kept incomplete providers unavailable until both clients and quota controls ship.
