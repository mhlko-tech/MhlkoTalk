-- Retire optional embedded providers whose operational cost and inconsistent
-- media UX outweigh their value alongside the native MHTalk RTC portfolio.

alter table public.rtc_provider_policies
  drop constraint if exists rtc_provider_policy_known_provider;

delete from public.rtc_provider_policies
where provider in ('100ms', 'cometchat', 'videosdk');

alter table public.rtc_provider_policies
  add constraint rtc_provider_policy_known_provider check (
    provider in (
      'stream', 'agora', 'tencent', 'cloudflare-realtime', 'livekit',
      'whereby', 'jaas', 'mirotalk'
    )
  );
