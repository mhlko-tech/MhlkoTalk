# MHTalk

MHTalk is a Windows desktop application for persistent voice rooms, video,
screen sharing, room chat, private invitations, file exchange and local screen
recording. The desktop client is built with Tauri, Rust, React, Supabase and
LiveKit.

## Account system

Version 1.3 provides a production account boundary on both desktop and Android:

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
npm test
npm run build
```

Required public client settings are documented in `.env.example`. Production
secrets belong in Cloudflare Worker secrets and must never be committed.

Official releases are published at
[github.com/mhlko-tech/MhlkoTalk/releases](https://github.com/mhlko-tech/MhlkoTalk/releases).
