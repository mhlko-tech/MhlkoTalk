-- Subscription state is owned by the service role. Clients may read their
-- effective plan but cannot promote themselves to Plus.
alter table public.profiles
  add column if not exists subscription_tier text not null default 'free',
  add column if not exists subscription_expires_at timestamptz;

alter table public.profiles
  drop constraint if exists profiles_subscription_tier_check;

alter table public.profiles
  add constraint profiles_subscription_tier_check
  check (subscription_tier in ('free', 'plus'));

revoke update (subscription_tier, subscription_expires_at)
  on table public.profiles from authenticated;

grant select (subscription_tier, subscription_expires_at)
  on table public.profiles to authenticated;

grant update (subscription_tier, subscription_expires_at)
  on table public.profiles to service_role;
