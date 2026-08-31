# MHTalk Beta realtime provider portfolio

This document freezes the target provider set before implementation. A provider
name in this list is not evidence that its adapter is deployed. The routing
broker may select a provider only after its server-side credential issuer and
both Windows and Android client adapters pass the same integration contract.

## Target providers and order

1. `stream` - primary managed RTC provider and first implementation target.
2. `agora` - recurring managed RTC fallback.
3. `tencent` - recurring managed RTC fallback with pay-as-you-go disabled.
4. `cloudflare-realtime` - metered SFU/TURN fallback protected by MHTalk's
   conservative usage circuit breaker.
5. `livekit` - existing native RTC adapter and recurring fallback.
6. `100ms` - conditional fallback; production activation requires verified
   zero-cost suspension behavior.
7. `cometchat` - small-community fallback subject to its free-plan user limit.
8. `whereby` - hard-limited embedded fallback.
9. `jaas` - limited-MAU fallback; never route an uncounted user to it.
10. `vonage` - one-time trial reserve, disabled after its verified credit ends.
11. `videosdk` - prepaid trial-credit reserve, disabled before its balance ends.

`daily` is not part of the target portfolio because its usage-based billing
does not provide the zero-dollar protection required for the Beta. `zegocloud`
is not part of the core eleven because its no-card allocation is a short trial.
Self-hosted Jitsi remains a future VPS route rather than a managed free-tier
provider.

## Cloudflare zero-budget policy

Cloudflare Realtime exposes a 1,000 GB monthly free allocation, but Cloudflare
does not provide a general hard spending cap. MHTalk therefore treats only
600 GB as usable and reserves 400 GB for reporting delay and measurement error.

- At 45% (450 GB), raise an operations warning.
- At 50% (500 GB), lower Cloudflare's routing priority.
- At 55% (550 GB), stop assigning new rooms to Cloudflare.
- At 60% (600 GB), disable the route for the rest of the billing cycle.
- If usage data is stale or unavailable, fail closed and do not assign rooms.
- Re-enable only after the backend verifies a new Cloudflare billing period and
  a reset usage counter.

Client telemetry is sampled frequently and reconciled against provider usage.
Cloudflare's billing dashboard or alert email is not a circuit breaker and is
never the sole source used to protect the budget.

## Routing invariants

- The backend is the single source of truth for provider selection.
- Provider secrets and usage credentials never ship in either client.
- Every room is sticky to one RTC provider for its lifetime.
- Existing rooms are not moved between incompatible providers.
- Draining or exhausted providers receive no new rooms.
- Messages, attachments, presence and media are not silently split across
  providers unless both clients implement and test that exact route.
- A provider with missing credentials, a missing client adapter, stale health,
  or exhausted quota is unavailable rather than best-effort.
- One legitimate provider account is used; account duplication is not a quota
  strategy.

## Version 1.6 readiness decision

| Provider | Source adapter | Production decision |
| --- | --- | --- |
| Stream | Windows + Android + Worker | Eligible after staging; primary guarded route. |
| Agora | Windows + Android + Worker | Eligible after staging and verified dashboard limit. |
| Tencent | Windows + Android + Worker | Eligible only while the annual offer is verified and PAYG is off. |
| Cloudflare Realtime | Windows + Android + Worker | Disabled until credentials exist; 60% hard internal cutoff. |
| LiveKit | Windows + Android + Worker | Compatible fallback; disabled while its current allowance is exhausted. |
| Whereby | Embedded Windows + Android + Worker | Eligible after staging; conservative participant-minute guard. |
| 100ms | Credential placeholders only | Not routable; native clients and zero-cost cutoff are unverified. |
| CometChat | Credential placeholders only | Not routable; native clients and reset policy are unverified. |
| JaaS | Credential placeholders only | Not routable; MAU identity guard and native clients are missing. |
| Vonage | Credential placeholders only | Not routable; trial balance and native clients are unverified. |
| VideoSDK | Credential placeholders only | Not routable; prepaid balance collector and native clients are missing. |

This evaluation intentionally leaves five providers behind `adapterReady =
false`. Adding a provider name or secret is never treated as implementation.

## Delivery sequence

The implementation order is deliberately different from the eventual routing
order: establish the common adapter contract, ship Stream end to end, then add
one provider at a time with Windows/Android interoperability tests. The existing
LiveKit path remains available until a replacement has passed those tests.
