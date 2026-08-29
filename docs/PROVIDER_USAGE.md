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
