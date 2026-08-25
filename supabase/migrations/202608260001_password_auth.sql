-- Private lookup data used only by the MHTalk authentication gateway.
-- Passwords remain entirely inside Supabase Auth and are never stored here.
create table if not exists public.account_logins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username extensions.citext not null unique,
  email extensions.citext not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint account_login_username_format check (username ~ '^[A-Za-z0-9_]{3,32}$')
);

alter table public.account_logins enable row level security;
revoke all on table public.account_logins from public, anon, authenticated;
grant select, insert, update, delete on table public.account_logins to service_role;

insert into public.account_logins (user_id, username, email)
select profiles.id, profiles.username, users.email
from public.profiles profiles
join auth.users users on users.id = profiles.id
where users.email is not null
on conflict (user_id) do update
set username = excluded.username, email = excluded.email, updated_at = now();

create or replace function public.mhtalk_username_reserved(candidate text)
returns boolean language sql immutable set search_path = public as $$
  select lower(candidate) = any (array[
    'admin', 'administrator', 'api', 'bot', 'everyone', 'help', 'here',
    'mhlko', 'mhtalk', 'moderator', 'official', 'root', 'security',
    'staff', 'support', 'system', 'verified'
  ]);
$$;
revoke all on function public.mhtalk_username_reserved(text) from public, anon, authenticated;

create or replace function public.create_profile_for_new_user()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare
  requested_username text;
  selected_username text;
  selected_name text;
begin
  requested_username := trim(coalesce(new.raw_user_meta_data->>'preferred_username', ''));
  if requested_username <> '' then
    if requested_username !~ '^[A-Za-z0-9_]{3,32}$' or public.mhtalk_username_reserved(requested_username) then
      raise exception 'Username is unavailable';
    end if;
    selected_username := requested_username;
  else
    selected_username := regexp_replace(coalesce(split_part(new.email, '@', 1), 'user'), '[^A-Za-z0-9_]', '', 'g');
    if char_length(selected_username) < 3 then selected_username := 'user'; end if;
    selected_username := left(selected_username, 23) || '_' || left(replace(new.id::text, '-', ''), 8);
  end if;

  selected_name := trim(coalesce(
    new.raw_user_meta_data->>'full_name',
    new.raw_user_meta_data->>'name',
    split_part(new.email, '@', 1),
    'MHTalk user'
  ));
  if selected_name = '' then selected_name := 'MHTalk user'; end if;

  insert into public.profiles (id, username, display_name, avatar_url)
  values (
    new.id,
    selected_username,
    left(selected_name, 60),
    coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture')
  );

  if new.email is not null then
    insert into public.account_logins (user_id, username, email)
    values (new.id, selected_username, new.email);
  end if;
  return new;
exception
  when unique_violation then
    raise exception 'Username or email is unavailable';
end $$;

create or replace function public.sync_account_login_username()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.username is distinct from old.username then
    if public.mhtalk_username_reserved(new.username::text) then
      raise exception 'Username is unavailable';
    end if;
    update public.account_logins
      set username = new.username, updated_at = now()
      where user_id = new.id;
  end if;
  return new;
exception
  when unique_violation then
    raise exception 'Username is unavailable';
end $$;

drop trigger if exists on_profile_username_changed on public.profiles;
create trigger on_profile_username_changed
after update of username on public.profiles
for each row execute function public.sync_account_login_username();

create or replace function public.sync_account_login_email()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.email is not null and new.email is distinct from old.email then
    update public.account_logins
      set email = new.email, updated_at = now()
      where user_id = new.id;
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed
after update of email on auth.users
for each row execute function public.sync_account_login_email();
