-- One canonical MHTalk account can support Google and/or password sign-in.
-- Google accounts remain gated until they complete MHTalk onboarding and its
-- one-time creation-code challenge. This table is private to the auth gateway.
alter table public.account_logins
  add column if not exists google_linked_at timestamptz,
  add column if not exists password_enabled_at timestamptz,
  add column if not exists creation_verified_at timestamptz,
  add column if not exists onboarding_completed_at timestamptz;

update public.account_logins login
set
  google_linked_at = case when exists (
    select 1 from auth.identities identity
    where identity.user_id = login.user_id and identity.provider = 'google'
  ) then coalesce(login.google_linked_at, login.created_at) else login.google_linked_at end,
  password_enabled_at = case when exists (
    select 1 from auth.identities identity
    where identity.user_id = login.user_id and identity.provider = 'email'
  ) then coalesce(login.password_enabled_at, login.created_at) else login.password_enabled_at end,
  creation_verified_at = case when exists (
    select 1 from auth.identities identity
    where identity.user_id = login.user_id and identity.provider = 'google'
  ) then login.creation_verified_at else coalesce(login.creation_verified_at, login.created_at) end,
  onboarding_completed_at = case when exists (
    select 1 from auth.identities identity
    where identity.user_id = login.user_id and identity.provider = 'google'
  ) then login.onboarding_completed_at else coalesce(login.onboarding_completed_at, login.created_at) end,
  updated_at = now();

create or replace function public.create_profile_for_new_user()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare
  requested_username text;
  selected_username text;
  selected_name text;
  is_google boolean;
  is_password boolean;
  is_email_registration boolean;
begin
  is_google := coalesce(new.raw_app_meta_data->'providers', '[]'::jsonb) @> '["google"]'::jsonb;
  is_password := coalesce(new.raw_app_meta_data->'providers', '[]'::jsonb) @> '["email"]'::jsonb;
  is_email_registration := coalesce((new.raw_user_meta_data->>'mhtalk_registration')::boolean, false);
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
    new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name',
    split_part(new.email, '@', 1), 'MHTalk user'
  ));
  if selected_name = '' then selected_name := 'MHTalk user'; end if;

  insert into public.profiles (id, username, display_name, avatar_url)
  values (
    new.id, selected_username, left(selected_name, 60),
    coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture')
  ) on conflict (id) do nothing;

  if new.email is not null then
    insert into public.account_logins (
      user_id, username, email, google_linked_at, password_enabled_at,
      creation_verified_at, onboarding_completed_at
    ) values (
      new.id, selected_username, new.email,
      case when is_google then now() end,
      case when is_password or is_email_registration then now() end,
      case when is_email_registration and new.email_confirmed_at is not null then now() end,
      case when is_email_registration then now() end
    ) on conflict (user_id) do update set
      google_linked_at = coalesce(public.account_logins.google_linked_at, excluded.google_linked_at),
      password_enabled_at = coalesce(public.account_logins.password_enabled_at, excluded.password_enabled_at),
      updated_at = now();
  end if;
  return new;
exception
  when unique_violation then
    raise exception 'Username or email is unavailable';
end $$;

create or replace function public.sync_account_login_auth_methods()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  providers jsonb;
  is_registration boolean;
begin
  providers := coalesce(new.raw_app_meta_data->'providers', '[]'::jsonb);
  is_registration := coalesce((new.raw_user_meta_data->>'mhtalk_registration')::boolean, false);
  update public.account_logins set
    google_linked_at = case when providers @> '["google"]'::jsonb then coalesce(google_linked_at, now()) else google_linked_at end,
    -- An email identity can also be created by the one-time onboarding OTP.
    -- Only explicit MHTalk registration (or /auth/password-enabled) proves that
    -- the user actually chose a reusable password.
    password_enabled_at = case when is_registration then coalesce(password_enabled_at, now()) else password_enabled_at end,
    creation_verified_at = case when is_registration and new.email_confirmed_at is not null then coalesce(creation_verified_at, now()) else creation_verified_at end,
    onboarding_completed_at = case when is_registration then coalesce(onboarding_completed_at, now()) else onboarding_completed_at end,
    updated_at = now()
  where user_id = new.id;
  return new;
end $$;

drop trigger if exists on_auth_user_methods_changed on auth.users;
create trigger on_auth_user_methods_changed
after update of raw_app_meta_data, raw_user_meta_data, email_confirmed_at on auth.users
for each row execute function public.sync_account_login_auth_methods();

create index if not exists account_logins_pending_onboarding
  on public.account_logins (user_id)
  where onboarding_completed_at is null or creation_verified_at is null;
