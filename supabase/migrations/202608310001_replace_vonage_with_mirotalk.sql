-- Replace the unusable Vonage trial route with MHTalk's self-hosted MiroTalk
-- SFU. Existing Vonage usage rows are intentionally removed with the policy;
-- the route was never enabled in production.

alter table public.rtc_provider_policies
  drop constraint if exists rtc_provider_policy_known_provider;

delete from public.rtc_provider_policies
where provider = 'vonage';

insert into public.rtc_provider_policies (
  provider,
  priority,
  enabled,
  quota_unit,
  quota_limit,
  cycle_kind,
  warning_percent,
  deprioritize_percent,
  drain_percent,
  stop_percent,
  fail_closed_on_stale,
  stale_after_seconds,
  notes
)
values (
  'mirotalk',
  10,
  true,
  'participant_minute',
  999999999999,
  'provider_defined',
  95,
  96,
  97,
  98,
  false,
  86400,
  'Self-hosted on an Oracle Always Free A1 instance; no paid overage or vendor quota.'
)
on conflict (provider) do update set
  priority = excluded.priority,
  enabled = excluded.enabled,
  quota_unit = excluded.quota_unit,
  quota_limit = excluded.quota_limit,
  cycle_kind = excluded.cycle_kind,
  warning_percent = excluded.warning_percent,
  deprioritize_percent = excluded.deprioritize_percent,
  drain_percent = excluded.drain_percent,
  stop_percent = excluded.stop_percent,
  fail_closed_on_stale = excluded.fail_closed_on_stale,
  stale_after_seconds = excluded.stale_after_seconds,
  notes = excluded.notes,
  updated_at = now();

alter table public.rtc_provider_policies
  add constraint rtc_provider_policy_known_provider check (
    provider in (
      'stream', 'agora', 'tencent', 'cloudflare-realtime', 'livekit',
      '100ms', 'cometchat', 'whereby', 'jaas', 'mirotalk', 'videosdk'
    )
  );
