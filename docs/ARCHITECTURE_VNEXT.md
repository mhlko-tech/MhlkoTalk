# MHTalk vNext architecture

## Objective

Build a Windows-first private communication client that remains responsive during
network changes, recovers automatically, and keeps durable user actions separate
from realtime media.

English is the only supported application language.

## Decisions

1. Keep Tauri, Rust, React, SQLite, signed updates, native audio capture, and the
   recoverable screen-recording pipeline.
2. Keep React components presentation-focused. User actions are typed commands
   protected from concurrent duplicate execution.
3. Access a room through `services/roomSession.ts`; UI code must not instantiate a
   signaling or WebRTC implementation directly.
4. Replace peer-to-peer mesh media with an SFU adapter after the control-plane
   contract and network test harness are in place.
5. Use a durable control channel for chat, moderation, acknowledgements, and replay.
   Media transport must never be the only record of a durable user action.
6. Move large attachments to encrypted, resumable object storage. File traffic must
   not compete with call media.
7. Roll out backend changes behind compatibility flags. Never replace the working
   transport without a measured rollback path.

## Required session states

`idle -> connecting -> connected -> reconnecting -> connected`

Terminal failures enter `failed` with a reason and an explicit retry action. A clean
user exit enters `disconnected`, not `failed`.

## Required command states

`idle -> pending -> succeeded`

A failure enters `failed` and exposes retry. Commands carry idempotency keys at the
control-plane boundary. React state is not used as a mutual-exclusion lock.

## Migration gates

- English-only source validation passes.
- TypeScript, production architecture checks, the voice build, and Worker checks pass.
- Room open and updater commands reject rapid duplicate execution.
- The new SFU path passes packet-loss, latency, sleep/resume, and long-running tests.
- Durable chat passes disconnect/replay tests without loss or duplication.
- Resumable attachments survive process termination and verify their final hash.

## Current implementation status

- English-only runtime and source validation: implemented.
- Duplicate command gate for room entry and updates: implemented.
- UI-to-room factory boundary: implemented.
- LiveKit token endpoint with approved-room authorization and five-minute JWTs: implemented.
- Lazy-loaded LiveKit voice adapter: implemented behind `VITE_MEDIA_BACKEND=livekit`.
- SQLite text-message outbox, bounded receiver deduplication, receipt-driven cleanup,
  reconnect retry, and private-history isolation: implemented.
- Root React crash containment, persistent bounded diagnostics, and guarded critical
  settings/chat/recording/data commands: implemented.
- Main and voice Rust crates, release executables, English-only NSIS, and en-US MSI:
  built successfully on Windows with the stable MSVC Rust toolchain.
- Windows Authenticode and updater artifact signing require the publisher's private
  code-signing certificate and Tauri updater private key; unsigned local artifacts
  are for testing only.
- Server-side durable chat remains a later backend migration; the local outbox now
  protects messages across client restarts while the compatibility transport is active.
- Production activation: blocked until a real LiveKit project, Worker secrets, two-client
  interoperability tests, and network-failure tests are available.
