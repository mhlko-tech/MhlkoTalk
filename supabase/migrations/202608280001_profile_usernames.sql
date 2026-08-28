-- Username privacy and a server-enforced rolling 30-day change limit.
-- Existing accounts may make one immediate change because their timestamp is null.
alter table public.profiles
  add column if not exists username_visible boolean not null default true,
  add column if not exists username_changed_at timestamptz;

grant update (username_visible) on table public.profiles to authenticated;

create or replace function public.guard_profile_username_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.username::text is distinct from old.username::text then
    if old.username_changed_at is not null
       and old.username_changed_at + interval '30 days' > now() then
      raise exception using
        errcode = 'P0001',
        message = 'Username can only be changed once every 30 days',
        detail = (old.username_changed_at + interval '30 days')::text;
    end if;

    new.username_changed_at := now();
  end if;

  return new;
end;
$$;

-- CITEXT compares case-insensitively, but display-case changes are still real
-- username changes and must stay in sync with the private login lookup table.
create or replace function public.sync_account_login_username()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.username::text is distinct from old.username::text then
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

drop trigger if exists guard_profile_username_change on public.profiles;
create trigger guard_profile_username_change
before update of username on public.profiles
for each row execute function public.guard_profile_username_change();
