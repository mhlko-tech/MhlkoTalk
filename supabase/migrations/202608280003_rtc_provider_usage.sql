-- Durable, service-owned quota state for the multi-provider RTC broker.
-- Client applications never read or mutate these tables directly.

create table if not exists public.rtc_provider_policies (
  provider text primary key,
  priority smallint not null unique check (priority > 0),
  enabled boolean not null default false,
  quota_unit text not null check (
    quota_unit in ('participant_minute', 'egress_byte', 'monthly_active_user', 'micro_usd')
  ),
  quota_limit numeric(30, 0) not null check (quota_limit > 0),
  cycle_kind text not null check (
    cycle_kind in ('monthly', 'annual_offer', 'non_resetting', 'provider_defined')
  ),
  warning_percent numeric(5, 2) not null,
  deprioritize_percent numeric(5, 2) not null,
  drain_percent numeric(5, 2) not null,
  stop_percent numeric(5, 2) not null,
  fail_closed_on_stale boolean not null default true,
  stale_after_seconds integer not null default 3600 check (stale_after_seconds >= 60),
  notes text not null default '',
  updated_at timestamptz not null default now(),
  constraint rtc_provider_policy_thresholds check (
    warning_percent >= 0
    and warning_percent <= deprioritize_percent
    and deprioritize_percent <= drain_percent
    and drain_percent <= stop_percent
    and stop_percent <= 100
  ),
  constraint rtc_provider_policy_known_provider check (
    provider in (
      'stream', 'agora', 'tencent', 'cloudflare-realtime', 'livekit',
      '100ms', 'cometchat', 'whereby', 'jaas', 'vonage', 'videosdk'
    )
  )
);

create table if not exists public.rtc_provider_usage_cycles (
  provider text not null references public.rtc_provider_policies(provider) on delete cascade,
  cycle_start timestamptz not null,
  cycle_end timestamptz not null,
  internal_used numeric(30, 0) not null default 0 check (internal_used >= 0),
  provider_used numeric(30, 0) not null default 0 check (provider_used >= 0),
  provider_observed_at timestamptz,
  forced_disabled boolean not null default false,
  disabled_reason text,
  updated_at timestamptz not null default now(),
  primary key (provider, cycle_start),
  constraint rtc_provider_usage_valid_cycle check (cycle_end > cycle_start)
);

create index if not exists rtc_provider_usage_current_idx
  on public.rtc_provider_usage_cycles (provider, cycle_end desc);

create table if not exists public.rtc_provider_usage_reports (
  report_id uuid primary key,
  provider text not null references public.rtc_provider_policies(provider) on delete cascade,
  cycle_start timestamptz not null,
  room_hash text not null check (char_length(room_hash) between 16 and 128),
  source text not null check (source in ('windows', 'android', 'worker')),
  measured_from timestamptz not null,
  measured_to timestamptz not null,
  amount numeric(30, 0) not null check (amount >= 0),
  created_at timestamptz not null default now(),
  constraint rtc_provider_report_valid_window check (measured_to >= measured_from),
  foreign key (provider, cycle_start)
    references public.rtc_provider_usage_cycles(provider, cycle_start)
    on delete cascade
);

create index if not exists rtc_provider_usage_reports_cycle_idx
  on public.rtc_provider_usage_reports (provider, cycle_start, created_at);

alter table public.rtc_provider_policies enable row level security;
alter table public.rtc_provider_usage_cycles enable row level security;
alter table public.rtc_provider_usage_reports enable row level security;

revoke all on table public.rtc_provider_policies from public, anon, authenticated;
revoke all on table public.rtc_provider_usage_cycles from public, anon, authenticated;
revoke all on table public.rtc_provider_usage_reports from public, anon, authenticated;
grant select, insert, update, delete on table public.rtc_provider_policies to service_role;
grant select, insert, update, delete on table public.rtc_provider_usage_cycles to service_role;
grant select, insert, update, delete on table public.rtc_provider_usage_reports to service_role;

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
values
  ('stream', 1, false, 'micro_usd', 100000000, 'monthly', 70, 80, 90, 95, true, 3600, 'USD 100 monthly Build/Maker credit, represented in millionths of a dollar.'),
  ('agora', 2, false, 'participant_minute', 10000, 'monthly', 70, 80, 90, 95, true, 3600, 'Free RTC allocation.'),
  ('tencent', 3, false, 'participant_minute', 10000, 'annual_offer', 70, 80, 90, 95, true, 3600, 'Monthly allocation during the first-year offer; PAYG must remain disabled.'),
  ('cloudflare-realtime', 4, false, 'egress_byte', 1000000000000, 'monthly', 45, 50, 55, 60, true, 1800, 'Only 600 GB is usable; 400 GB is reserved against reporting delay.'),
  ('livekit', 5, true, 'participant_minute', 5000, 'monthly', 70, 80, 90, 95, false, 86400, 'Existing recurring Cloud allocation.'),
  ('100ms', 6, false, 'participant_minute', 10000, 'monthly', 60, 70, 80, 90, true, 3600, 'Enable only after zero-cost suspension behavior is verified.'),
  ('cometchat', 7, false, 'participant_minute', 10000, 'provider_defined', 60, 70, 80, 90, true, 3600, 'Reset behavior must be verified in the account dashboard.'),
  ('whereby', 8, false, 'participant_minute', 2000, 'monthly', 60, 70, 80, 90, true, 3600, 'Explore plan has no additional participant minutes.'),
  ('jaas', 9, false, 'monthly_active_user', 25, 'monthly', 60, 72, 80, 88, true, 3600, 'Reserve capacity before the twenty-fifth unique active user.'),
  ('vonage', 10, false, 'participant_minute', 75000, 'non_resetting', 60, 70, 80, 90, true, 3600, 'Trial reserve; verify the actual dashboard entitlement before enabling.'),
  ('videosdk', 11, false, 'micro_usd', 20000000, 'non_resetting', 60, 70, 80, 90, true, 3600, 'One-time prepaid USD 20 credit represented in millionths of a dollar.')
on conflict (provider) do update set
  priority = excluded.priority,
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

create or replace function public.record_rtc_provider_usage(
  p_report_id uuid,
  p_provider text,
  p_cycle_start timestamptz,
  p_cycle_end timestamptz,
  p_room_hash text,
  p_source text,
  p_measured_from timestamptz,
  p_measured_to timestamptz,
  p_amount numeric
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_rows integer := 0;
begin
  if p_amount < 0 or p_cycle_end <= p_cycle_start or p_measured_to < p_measured_from then
    raise exception 'invalid rtc usage report';
  end if;

  insert into public.rtc_provider_usage_cycles (provider, cycle_start, cycle_end)
  values (p_provider, p_cycle_start, p_cycle_end)
  on conflict (provider, cycle_start) do update set
    cycle_end = excluded.cycle_end,
    updated_at = now();

  insert into public.rtc_provider_usage_reports (
    report_id,
    provider,
    cycle_start,
    room_hash,
    source,
    measured_from,
    measured_to,
    amount
  )
  values (
    p_report_id,
    p_provider,
    p_cycle_start,
    p_room_hash,
    p_source,
    p_measured_from,
    p_measured_to,
    p_amount
  )
  on conflict (report_id) do nothing;

  get diagnostics inserted_rows = row_count;
  if inserted_rows = 1 then
    update public.rtc_provider_usage_cycles
    set internal_used = internal_used + p_amount,
        updated_at = now()
    where provider = p_provider and cycle_start = p_cycle_start;
    return true;
  end if;
  return false;
end;
$$;

create or replace function public.reconcile_rtc_provider_usage(
  p_provider text,
  p_cycle_start timestamptz,
  p_cycle_end timestamptz,
  p_provider_total numeric,
  p_observed_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_provider_total < 0 or p_cycle_end <= p_cycle_start then
    raise exception 'invalid provider usage reconciliation';
  end if;

  insert into public.rtc_provider_usage_cycles (
    provider,
    cycle_start,
    cycle_end,
    provider_used,
    provider_observed_at
  )
  values (
    p_provider,
    p_cycle_start,
    p_cycle_end,
    p_provider_total,
    p_observed_at
  )
  on conflict (provider, cycle_start) do update set
    cycle_end = excluded.cycle_end,
    provider_used = greatest(
      public.rtc_provider_usage_cycles.provider_used,
      excluded.provider_used
    ),
    provider_observed_at = greatest(
      public.rtc_provider_usage_cycles.provider_observed_at,
      excluded.provider_observed_at
    ),
    updated_at = now();
end;
$$;

create or replace function public.rtc_provider_health_snapshot()
returns table (
  provider text,
  priority smallint,
  enabled boolean,
  quota_unit text,
  quota_limit numeric,
  used_amount numeric,
  used_percent numeric,
  state text,
  cycle_start timestamptz,
  cycle_end timestamptz,
  provider_observed_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    policy.provider,
    policy.priority,
    policy.enabled,
    policy.quota_unit,
    policy.quota_limit,
    greatest(coalesce(usage.internal_used, 0), coalesce(usage.provider_used, 0)) as used_amount,
    round(
      greatest(coalesce(usage.internal_used, 0), coalesce(usage.provider_used, 0))
      * 100 / policy.quota_limit,
      4
    ) as used_percent,
    case
      when not policy.enabled or coalesce(usage.forced_disabled, false) then 'disabled'
      when usage.provider_observed_at is null and policy.fail_closed_on_stale then 'stale'
      when policy.fail_closed_on_stale
        and usage.provider_observed_at < now() - make_interval(secs => policy.stale_after_seconds)
        then 'stale'
      when greatest(coalesce(usage.internal_used, 0), coalesce(usage.provider_used, 0))
        * 100 / policy.quota_limit >= policy.stop_percent then 'exhausted'
      when greatest(coalesce(usage.internal_used, 0), coalesce(usage.provider_used, 0))
        * 100 / policy.quota_limit >= policy.drain_percent then 'draining'
      when greatest(coalesce(usage.internal_used, 0), coalesce(usage.provider_used, 0))
        * 100 / policy.quota_limit >= policy.deprioritize_percent then 'deprioritized'
      when greatest(coalesce(usage.internal_used, 0), coalesce(usage.provider_used, 0))
        * 100 / policy.quota_limit >= policy.warning_percent then 'warning'
      else 'healthy'
    end as state,
    usage.cycle_start,
    usage.cycle_end,
    usage.provider_observed_at
  from public.rtc_provider_policies policy
  left join lateral (
    select cycle.*
    from public.rtc_provider_usage_cycles cycle
    where cycle.provider = policy.provider
      and now() >= cycle.cycle_start
      and now() < cycle.cycle_end
    order by cycle.cycle_start desc
    limit 1
  ) usage on true
  order by policy.priority;
$$;

revoke all on function public.record_rtc_provider_usage(uuid, text, timestamptz, timestamptz, text, text, timestamptz, timestamptz, numeric) from public;
revoke all on function public.reconcile_rtc_provider_usage(text, timestamptz, timestamptz, numeric, timestamptz) from public;
revoke all on function public.rtc_provider_health_snapshot() from public;
grant execute on function public.record_rtc_provider_usage(uuid, text, timestamptz, timestamptz, text, text, timestamptz, timestamptz, numeric) to service_role;
grant execute on function public.reconcile_rtc_provider_usage(text, timestamptz, timestamptz, numeric, timestamptz) to service_role;
grant execute on function public.rtc_provider_health_snapshot() to service_role;
