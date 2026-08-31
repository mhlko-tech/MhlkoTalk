-- Signed client heartbeats provide an internal, conservative usage source for
-- providers without a reliable account-level usage API. External dashboard
-- reconciliation may still raise usage through reconcile_rtc_provider_usage.

update public.rtc_provider_policies
set fail_closed_on_stale = false,
    notes = case provider
      when 'stream' then 'USD 100 monthly credit. Internal metering uses the published 4K ceiling as a conservative cost estimate.'
      when 'agora' then 'Free RTC allocation, measured by signed participant heartbeats.'
      when 'tencent' then 'Monthly allocation during the first-year offer; PAYG must remain disabled. Measured by signed participant heartbeats.'
      when 'whereby' then 'Explore plan has no additional participant minutes. Measured by signed participant heartbeats.'
      else notes
    end,
    updated_at = now()
where provider in ('stream', 'agora', 'tencent', 'whereby');
