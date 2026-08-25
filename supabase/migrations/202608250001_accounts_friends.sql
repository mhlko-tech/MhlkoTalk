-- MHTalk stores identity/social data only. Chat messages and attachments intentionally have no tables.
create extension if not exists citext with schema extensions;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username extensions.citext not null unique,
  display_name text not null,
  avatar_url text,
  bio text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint username_format check (username ~ '^[A-Za-z0-9_]{3,32}$'),
  constraint display_name_length check (char_length(display_name) between 1 and 60),
  constraint bio_length check (bio is null or char_length(bio) <= 160)
);

create table if not exists public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  receiver_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint different_request_users check (sender_id <> receiver_id)
);
create unique index if not exists one_pending_friend_request
  on public.friend_requests (least(sender_id, receiver_id), greatest(sender_id, receiver_id))
  where status = 'pending';

create table if not exists public.friendships (
  user_a uuid not null references public.profiles(id) on delete cascade,
  user_b uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_a, user_b),
  constraint ordered_friendship check (user_a < user_b)
);

create table if not exists public.blocks (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint different_block_users check (blocker_id <> blocked_id)
);

create table if not exists public.device_tokens (
  token text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  platform text not null check (platform in ('android', 'desktop', 'unknown')),
  updated_at timestamptz not null default now()
);
create index if not exists device_tokens_user_id on public.device_tokens(user_id);

alter table public.profiles enable row level security;
alter table public.friend_requests enable row level security;
alter table public.friendships enable row level security;
alter table public.blocks enable row level security;
alter table public.device_tokens enable row level security;

create policy "signed in users can find profiles" on public.profiles for select to authenticated using (true);
create policy "users edit their profile" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy "request participants can read" on public.friend_requests for select to authenticated using (auth.uid() in (sender_id, receiver_id));
create policy "friends can read friendship" on public.friendships for select to authenticated using (auth.uid() in (user_a, user_b));
create policy "users read own blocks" on public.blocks for select to authenticated using (blocker_id = auth.uid());
create policy "users manage own device tokens" on public.device_tokens for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.create_profile_for_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  base_username text;
begin
  base_username := regexp_replace(coalesce(new.raw_user_meta_data->>'preferred_username', split_part(new.email, '@', 1), 'user'), '[^A-Za-z0-9_]', '', 'g');
  if char_length(base_username) < 3 then base_username := 'user'; end if;
  base_username := left(base_username, 23) || '_' || left(replace(new.id::text, '-', ''), 8);
  insert into public.profiles (id, username, display_name, avatar_url)
  values (
    new.id,
    base_username,
    left(coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1), 'MHTalk user'), 60),
    coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture')
  ) on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.create_profile_for_new_user();

create or replace function public.are_friends(other_profile uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from friendships
    where user_a = least(auth.uid(), other_profile) and user_b = greatest(auth.uid(), other_profile)
  );
$$;

create or replace function public.send_friend_request(target_profile uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare request_id uuid;
begin
  if auth.uid() is null or target_profile is null or target_profile = auth.uid() then
    raise exception 'Invalid friend request';
  end if;
  if exists (select 1 from blocks where (blocker_id = auth.uid() and blocked_id = target_profile) or (blocker_id = target_profile and blocked_id = auth.uid())) then
    raise exception 'Friend request is unavailable';
  end if;
  if public.are_friends(target_profile) then raise exception 'Already friends'; end if;
  insert into friend_requests(sender_id, receiver_id) values (auth.uid(), target_profile) returning id into request_id;
  return request_id;
end $$;

create or replace function public.respond_friend_request(request_id uuid, accept_request boolean)
returns boolean language plpgsql security definer set search_path = public as $$
declare request_row friend_requests%rowtype;
begin
  select * into request_row from friend_requests where id = request_id and status = 'pending' for update;
  if request_row.id is null or request_row.receiver_id <> auth.uid() then raise exception 'Friend request not found'; end if;
  update friend_requests set status = case when accept_request then 'accepted' else 'rejected' end, updated_at = now() where id = request_id;
  if accept_request then
    insert into friendships(user_a, user_b) values (least(request_row.sender_id, request_row.receiver_id), greatest(request_row.sender_id, request_row.receiver_id))
    on conflict do nothing;
  end if;
  return accept_request;
end $$;

create or replace function public.remove_friend(friend_profile uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  delete from friendships where user_a = least(auth.uid(), friend_profile) and user_b = greatest(auth.uid(), friend_profile);
  return found;
end $$;

create or replace function public.block_profile(target_profile uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if target_profile is null or target_profile = auth.uid() then raise exception 'Invalid profile'; end if;
  insert into blocks(blocker_id, blocked_id) values (auth.uid(), target_profile) on conflict do nothing;
  delete from friendships where user_a = least(auth.uid(), target_profile) and user_b = greatest(auth.uid(), target_profile);
  update friend_requests set status = 'rejected', updated_at = now()
    where status = 'pending' and least(sender_id, receiver_id) = least(auth.uid(), target_profile)
      and greatest(sender_id, receiver_id) = greatest(auth.uid(), target_profile);
  return true;
end $$;

create or replace function public.social_friends()
returns table(id uuid, username text, display_name text, avatar_url text, bio text, friend_since timestamptz)
language sql stable security definer set search_path = public as $$
  select p.id, p.username::text, p.display_name, p.avatar_url, p.bio, f.created_at
  from friendships f join profiles p on p.id = case when f.user_a = auth.uid() then f.user_b else f.user_a end
  where auth.uid() in (f.user_a, f.user_b)
    and not exists (select 1 from blocks b where (b.blocker_id = auth.uid() and b.blocked_id = p.id) or (b.blocker_id = p.id and b.blocked_id = auth.uid()))
  order by p.display_name;
$$;

create or replace function public.social_friend_requests()
returns table(request_id uuid, id uuid, username text, display_name text, avatar_url text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select r.id, p.id, p.username::text, p.display_name, p.avatar_url, r.created_at
  from friend_requests r join profiles p on p.id = r.sender_id
  where r.receiver_id = auth.uid() and r.status = 'pending'
  order by r.created_at desc;
$$;

create or replace function public.search_profiles(search_text text)
returns table(id uuid, username text, display_name text, avatar_url text, bio text, is_friend boolean)
language sql stable security definer set search_path = public as $$
  select p.id, p.username::text, p.display_name, p.avatar_url, p.bio, public.are_friends(p.id)
  from profiles p
  where p.id <> auth.uid() and char_length(trim(search_text)) >= 2
    and (p.username ilike '%' || search_text || '%' or p.display_name ilike '%' || search_text || '%')
    and not exists (select 1 from blocks b where (b.blocker_id = auth.uid() and b.blocked_id = p.id) or (b.blocker_id = p.id and b.blocked_id = auth.uid()))
  order by case when lower(p.username::text) = lower(search_text) then 0 else 1 end, p.display_name
  limit 30;
$$;

grant execute on function public.are_friends(uuid) to authenticated;
grant execute on function public.send_friend_request(uuid) to authenticated;
grant execute on function public.respond_friend_request(uuid, boolean) to authenticated;
grant execute on function public.remove_friend(uuid) to authenticated;
grant execute on function public.block_profile(uuid) to authenticated;
grant execute on function public.social_friends() to authenticated;
grant execute on function public.social_friend_requests() to authenticated;
grant execute on function public.search_profiles(text) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('profile-avatars', 'profile-avatars', true, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy "avatar images are public" on storage.objects for select using (bucket_id = 'profile-avatars');
create policy "users upload own avatar" on storage.objects for insert to authenticated
  with check (bucket_id = 'profile-avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "users update own avatar" on storage.objects for update to authenticated
  using (bucket_id = 'profile-avatars' and owner_id = auth.uid()::text);
create policy "users delete own avatar" on storage.objects for delete to authenticated
  using (bucket_id = 'profile-avatars' and owner_id = auth.uid()::text);

