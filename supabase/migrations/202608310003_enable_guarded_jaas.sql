-- JaaS Developer includes 25 MAU but applies paid overage above the allowance.
-- Enable it only with the Worker's strongly consistent 20-credential ceiling.

update public.rtc_provider_policies
set enabled = true,
    quota_limit = 25,
    warning_percent = 60,
    deprioritize_percent = 70,
    drain_percent = 75,
    stop_percent = 80,
    fail_closed_on_stale = false,
    stale_after_seconds = 86400,
    notes = 'JaaS Dev is free for 25 MAU. The Worker requires MHTalk authentication and stops after 20 credential issuances per UTC month, leaving five MAU of overage safety margin.',
    updated_at = now()
where provider = 'jaas';
