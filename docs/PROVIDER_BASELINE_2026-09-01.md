# Production RTC provider baseline — 2026-09-01

Captured at `2026-09-01T20:29:40+03:00` before the sub-80% provider safety
hardening. This file contains no credentials.

## Worker rollback point

- Production Worker version: `71be7517-73b9-4feb-8473-686cfce6eb78`
- Deployment created: `2026-09-01T17:31:00.814Z`
- Public capability endpoint:
  `https://mhtalk-token-service.mhlkotalk.workers.dev/service/capabilities`

## Live capability snapshot

| Provider | Ready | Configured | Adapter | State | Used |
| --- | --- | --- | --- | --- | --- |
| Stream | yes | yes | yes | healthy | 0% |
| Agora | yes | yes | yes | healthy | 0% |
| Tencent | no | yes | yes | administratively disabled | 0% |
| Cloudflare Realtime | yes | yes | yes | healthy | 0% |
| LiveKit | no | yes | yes | administratively disabled | 0% |
| 100ms | no | no | yes | credentials missing | 0% |
| CometChat | no | no | yes | credentials missing | 0% |
| Whereby | no | yes | yes | administratively disabled | 0% |
| JaaS | yes | yes | yes | healthy | 0% |
| MiroTalk | yes | yes | yes | healthy | 0% |
| VideoSDK | no | no | yes | credentials missing | 0% |

## Administrative state to restore if rollback is required

The enabled set was `stream`, `agora`, `cloudflare-realtime`, `jaas`, and
`mirotalk`. Tencent, LiveKit, 100ms, CometChat, Whereby, and VideoSDK were
disabled. The source migrations up to
`202608310004_disable_exhausted_livekit.sql` reproduce the database state, and
the Worker version above reproduces the routing implementation.

Rollback must restore both the Worker version and the provider policy state;
rolling back only one side can leave a route visible with mismatched safety
thresholds.
