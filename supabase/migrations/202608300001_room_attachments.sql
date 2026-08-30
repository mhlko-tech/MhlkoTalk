-- Private, short-lived room attachments shared through signed Storage URLs.

insert into storage.buckets (id, name, public, file_size_limit)
values ('mhtalk-room-attachments', 'mhtalk-room-attachments', false, 104857600)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit;

create table if not exists public.room_attachments (
  id uuid primary key,
  room_name text not null,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  object_path text not null unique,
  file_name text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes >= 0 and size_bytes <= 104857600),
  status text not null default 'pending' check (status in ('pending', 'ready')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint room_attachments_valid_expiry check (expires_at > created_at)
);

create index if not exists room_attachments_expiry_idx
  on public.room_attachments (expires_at);

alter table public.room_attachments enable row level security;

revoke all on table public.room_attachments from public, anon, authenticated;
grant select, insert, update, delete on table public.room_attachments to service_role;

-- Storage objects are accessed only through signed URLs created by the Worker.
-- No anon/authenticated object policies are intentionally installed.
