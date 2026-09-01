# Provider quota accounting

Supabase is the durable source of truth for RTC quota policy, billing cycles and
idempotent usage reports. Cloudflare KV remains only a fast routing cache. This
avoids treating eventually consistent KV counters as financial protection.

The migration `202608280003_rtc_provider_usage.sql` creates:

- `rtc_provider_policies`: provider order, quota unit, quota limit, thresholds,
  stale-data policy and administrative enablement.
- `rtc_provider_usage_cycles`: internal and provider-reported totals for one
  provider billing cycle. Routing uses the greater value.
- `rtc_provider_usage_reports`: idempotent client/worker measurements keyed by
  `report_id`; retrying a report cannot increment usage twice.
- `record_rtc_provider_usage`: atomic report insertion and counter increment.
- `reconcile_rtc_provider_usage`: monotonic provider-side reconciliation.
- `rtc_provider_health_snapshot`: service-only health projection used by the
  routing collector.

All objects are protected by RLS and table/function privileges. Only the
Supabase service role used by the MHTalk Worker can access them. Application
access tokens and publishable keys cannot read quota or mutate routing state.

Quota values are stored in the provider's natural unit. Participant-minute
providers use participant minutes, Cloudflare uses egress bytes, and credit
providers use millionths of a US dollar. Collectors are responsible for
converting raw provider data into that unit before reconciliation.

Version 1.6 adds signed participant heartbeats. Windows and Android submit an
idempotent UUID report after each connected minute and on a normal room exit.
The Worker validates the signed provider/room capability, restricts report
windows to 10–90 seconds and hashes the room/subject before storage. Agora,
Tencent, Whereby and LiveKit are counted in participant minutes. Stream is
charged internally at 12,000 micro-USD per minute—the published 4K ceiling—even
though MHTalk caps output at 1080p; this deliberately underuses the monthly
credit. Cloudflare remains governed by Durable Object egress accounting.

Every 15 minutes the Worker calls `rtc_provider_health_snapshot()` and copies
the safe projection into KV for fast routing. General provider snapshots share
one KV document, while Cloudflare Realtime and JaaS keep dedicated guarded
records. Cloudflare per-room egress samples accumulate in its Durable Object
and reach KV only during this refresh. The baseline is therefore roughly 288
KV writes per day instead of exceeding the 1,000-write free daily allowance.
Administrative disablement, staleness and exhaustion all remove a provider
from new assignments. Provider dashboard reconciliation remains monotonic and
can only raise the effective usage above the internal estimate.

The routing cache itself also fails closed when its refresh timestamp is older
than 25 minutes (20 minutes for Cloudflare Realtime). Vendor-metered routes
disable by 75% unless a stricter provider-specific cutoff applies: Cloudflare
disables at 60%, and JaaS stops at 19 of 25 possible monthly endpoints (76%).
MiroTalk is probed over HTTPS every 15 minutes and is removed at once when the
self-hosted SFU is unreachable.
