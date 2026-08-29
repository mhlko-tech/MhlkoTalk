# MHTalk

MHTalk is a Windows desktop application for persistent voice rooms, video,
screen sharing, room chat, private invitations, file exchange and local screen
recording. The desktop client is built with Tauri, Rust, React and Supabase.
Stream, Agora, Tencent, Whereby Embedded, Daily and LiveKit are its currently
shipped realtime adapters, selected by a capability-gated routing broker for
the public Beta.

## Account system

The desktop and Android clients share the same production account boundary:

- username or email plus password sign-in;
- account registration with private, globally unique usernames;
- mandatory email verification and password recovery deep links;
- Google OAuth with PKCE;
- enumeration-resistant errors and rate-limited auth gateway endpoints;
- encrypted session storage through Windows Credential Manager;
- automatic room departure when an account signs out.

Authentication is backed by Supabase. Username-to-email resolution stays on the
Cloudflare Worker and is never exposed to clients. Apply the migrations in
`supabase/migrations` before deploying the matching Worker in `worker`.

## Development

```powershell
npm install
npm run check
```

The source layout and dependency rules are documented in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

Required public client settings are documented in `.env.example`. Production
secrets belong in Cloudflare Worker secrets and must never be committed.

Official releases are published at
[github.com/mhlko-tech/MhlkoTalk/releases](https://github.com/mhlko-tech/MhlkoTalk/releases).

## Beta service policy

MHTalk is visibly marked **Beta** while it operates on zero-budget service
allocations. The routing broker keeps every room on one compatible RTC provider,
drains providers at 85% usage and stops assigning them at 95%. Windows and
Android also impose hard token/connection deadlines so a provider failure cannot
leave the interface spinning forever. See
[`docs/SERVICE_ROUTING.md`](docs/SERVICE_ROUTING.md) for rollout and credential
requirements.
