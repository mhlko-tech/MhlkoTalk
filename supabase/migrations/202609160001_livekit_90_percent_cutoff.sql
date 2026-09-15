-- Owner-approved LiveKit cutoff; retain every other provider's existing limit.
begin;
alter table public.rtc_provider_policies
  drop constraint if exists rtc_provider_policy_sub_80_stop;
alter table public.rtc_provider_policies
  add constraint rtc_provider_policy_sub_80_stop check (
    provider = 'mirotalk'
    or (provider = 'livekit' and stop_percent <= 90)
    or (provider <> 'livekit' and stop_percent < 80)
  );
update public.rtc_provider_policies
set drain_percent = 90,
    stop_percent = 90,
    notes = '5,000 monthly participant minutes. Owner-approved 90% cutoff: stop new rooms and disable at 4,500 minutes.',
    updated_at = now()
where provider = 'livekit';
commit;
