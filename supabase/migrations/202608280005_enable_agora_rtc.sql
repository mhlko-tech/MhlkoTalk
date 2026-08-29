-- Agora has a deployed token service plus Windows and Android native adapters.
-- Keep this migration idempotent so it is safe to apply after live validation.

update public.rtc_provider_policies
set enabled = true,
    updated_at = now()
where provider = 'agora';

insert into public.rtc_provider_usage_cycles (
  provider,
  cycle_start,
  cycle_end,
  provider_used,
  provider_observed_at
)
values (
  'agora',
  date_trunc('month', now()),
  date_trunc('month', now()) + interval '1 month',
  0,
  now()
)
on conflict (provider, cycle_start) do update set
  cycle_end = excluded.cycle_end,
  provider_observed_at = excluded.provider_observed_at,
  updated_at = now();
