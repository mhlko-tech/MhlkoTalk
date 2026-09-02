-- Keep product access server-authoritative while preserving the member's
-- verified display tier. Ultimate and Max Supporter intentionally inherit the
-- Pro/paid feature set; they only add a distinct supporter badge in MHTalk.

alter table public.profiles
  drop constraint if exists profiles_subscription_tier_check;

alter table public.profiles
  add constraint profiles_subscription_tier_check
  check (subscription_tier in ('free', 'plus', 'pro', 'ultimate', 'max_supporter'));

-- Social surfaces receive the server-owned tier so badges cannot be selected
-- through the ordinary profile editor.
drop function if exists public.social_friends();
create function public.social_friends()
returns table(id uuid, username text, display_name text, avatar_url text, bio text, friend_since timestamptz, subscription_tier text, subscription_expires_at timestamptz)
language sql stable security definer set search_path = public as $$
  select p.id, p.username::text, p.display_name, p.avatar_url, p.bio, f.created_at,
    p.subscription_tier, p.subscription_expires_at
  from friendships f join profiles p on p.id = case when f.user_a = auth.uid() then f.user_b else f.user_a end
  where auth.uid() in (f.user_a, f.user_b)
    and not exists (select 1 from blocks b where (b.blocker_id = auth.uid() and b.blocked_id = p.id) or (b.blocker_id = p.id and b.blocked_id = auth.uid()))
  order by p.display_name;
$$;

drop function if exists public.social_friend_requests();
create function public.social_friend_requests()
returns table(request_id uuid, id uuid, username text, display_name text, avatar_url text, created_at timestamptz, subscription_tier text, subscription_expires_at timestamptz)
language sql stable security definer set search_path = public as $$
  select r.id, p.id, p.username::text, p.display_name, p.avatar_url, r.created_at,
    p.subscription_tier, p.subscription_expires_at
  from friend_requests r join profiles p on p.id = r.sender_id
  where r.receiver_id = auth.uid() and r.status = 'pending'
  order by r.created_at desc;
$$;

drop function if exists public.search_profiles(text);
create function public.search_profiles(search_text text)
returns table(id uuid, username text, display_name text, avatar_url text, bio text, is_friend boolean, subscription_tier text, subscription_expires_at timestamptz)
language sql stable security definer set search_path = public as $$
  select p.id, p.username::text, p.display_name, p.avatar_url, p.bio, public.are_friends(p.id),
    p.subscription_tier, p.subscription_expires_at
  from profiles p
  where p.id <> auth.uid() and char_length(trim(search_text)) >= 2
    and (p.username ilike '%' || search_text || '%' or p.display_name ilike '%' || search_text || '%')
    and not exists (select 1 from blocks b where (b.blocker_id = auth.uid() and b.blocked_id = p.id) or (b.blocker_id = p.id and b.blocked_id = auth.uid()))
  order by case when lower(p.username::text) = lower(search_text) then 0 else 1 end, p.display_name
  limit 30;
$$;

grant execute on function public.social_friends() to authenticated;
grant execute on function public.social_friend_requests() to authenticated;
grant execute on function public.search_profiles(text) to authenticated;
