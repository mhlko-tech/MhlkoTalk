-- Keep every vendor-metered route below 80% of its verified free or prepaid
-- allowance. MiroTalk is self-hosted and is governed by infrastructure health
-- rather than a synthetic vendor quota percentage.

alter table public.rtc_provider_policies
  drop constraint if exists rtc_provider_policy_sub_80_stop;

update public.rtc_provider_policies
set warning_percent = 60,
    deprioritize_percent = 65,
    drain_percent = 70,
    stop_percent = 75,
    stale_after_seconds = least(stale_after_seconds, 1500),
    notes = case provider
      when 'stream' then 'USD 100 monthly credit. Warn at USD 60, stop new rooms at USD 70, and disable by USD 75 using conservative internal metering.'
      when 'agora' then '10,000 monthly participant minutes. Warn at 6,000, stop new rooms at 7,000, and disable by 7,500.'
      when 'tencent' then '10,000 monthly participant minutes during the verified annual offer. PAYG must remain disabled; route disables by 7,500.'
      when 'livekit' then '5,000 monthly participant minutes. Keep disabled while exhausted; after a verified reset the route disables by 3,750.'
      when '100ms' then '10,000 monthly participant minutes. Enable only after zero-cost suspension is verified; route disables by 7,500.'
      when 'cometchat' then 'Enable only after the account limit and reset unit are verified; the policy must disable by 75% of that verified limit.'
      when 'whereby' then '2,000 monthly participant minutes with no overage allocation. Route disables by 1,500 minutes.'
      when 'videosdk' then 'One-time prepaid USD 20 credit. Route disables by USD 15 and remains off when the balance cannot be reconciled.'
      else notes
    end,
    updated_at = now()
where provider not in ('cloudflare-realtime', 'jaas', 'mirotalk');

-- Cloudflare already has the stricter 45/50/55/60 egress circuit breaker.
update public.rtc_provider_policies
set warning_percent = 45,
    deprioritize_percent = 50,
    drain_percent = 55,
    stop_percent = 60,
    fail_closed_on_stale = true,
    stale_after_seconds = 1200,
    notes = 'Serverless SFU with dedicated egress telemetry. Warn at 450 GB, stop new rooms at 550 GB, and disable at 600 GB of the 1,000 GB free allocation.',
    updated_at = now()
where provider = 'cloudflare-realtime';

-- Nineteen possible endpoints are 76% of JaaS Developer's 25 MAU allowance.
-- The strongly consistent Durable Object enforces the same exact count.
update public.rtc_provider_policies
set quota_limit = 25,
    warning_percent = 60,
    deprioritize_percent = 68,
    drain_percent = 72,
    stop_percent = 76,
    fail_closed_on_stale = false,
    stale_after_seconds = 1500,
    notes = 'JaaS Developer allows 25 MAU. Authenticated issuance stops at 19 credentials (76%), keeping the account below 80%.',
    updated_at = now()
where provider = 'jaas';

alter table public.rtc_provider_policies
  add constraint rtc_provider_policy_sub_80_stop check (
    provider = 'mirotalk' or stop_percent < 80
  );
