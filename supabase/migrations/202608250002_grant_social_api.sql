-- New projects no longer expose table privileges automatically. RLS still
-- decides which authenticated rows each user may read or change.
grant usage on schema public to authenticated;
grant select on table public.profiles to authenticated;
grant update (username, display_name, avatar_url, bio, updated_at) on table public.profiles to authenticated;
grant select on table public.friend_requests, public.friendships, public.blocks to authenticated;
grant select, insert, update, delete on table public.device_tokens to authenticated;

create or replace function public.ensure_my_profile()
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  user_row auth.users%rowtype;
  base_username text;
  profile_name text;
begin
  if auth.uid() is null then
    raise exception 'Sign in is required';
  end if;

  if exists (select 1 from public.profiles where id = auth.uid()) then
    return true;
  end if;

  select * into user_row from auth.users where id = auth.uid();
  if user_row.id is null then
    raise exception 'Account is unavailable';
  end if;

  base_username := regexp_replace(
    coalesce(
      nullif(user_row.raw_user_meta_data->>'preferred_username', ''),
      nullif(split_part(user_row.email, '@', 1), ''),
      'user'
    ),
    '[^A-Za-z0-9_]', '', 'g'
  );
  if char_length(base_username) < 3 then base_username := 'user'; end if;
  base_username := left(base_username, 23) || '_' || left(replace(user_row.id::text, '-', ''), 8);
  profile_name := left(coalesce(
    nullif(user_row.raw_user_meta_data->>'full_name', ''),
    nullif(user_row.raw_user_meta_data->>'name', ''),
    nullif(split_part(user_row.email, '@', 1), ''),
    'MHTalk user'
  ), 60);

  insert into public.profiles (id, username, display_name, avatar_url)
  values (
    user_row.id,
    base_username,
    profile_name,
    coalesce(user_row.raw_user_meta_data->>'avatar_url', user_row.raw_user_meta_data->>'picture')
  )
  on conflict (id) do nothing;

  return exists (select 1 from public.profiles where id = auth.uid());
end;
$$;

grant execute on function public.ensure_my_profile() to authenticated;
