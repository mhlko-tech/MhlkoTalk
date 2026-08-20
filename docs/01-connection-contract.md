# Connection and recovery contract

## Product goal

MHTalk is a Windows desktop voice-first communication client. A temporary loss
of network, an expired media token, or a recoverable transport error must not
make the user manually rejoin a room.

The user may hear a short audio interruption while the network recovers. The
client must restore the same room session, microphone state, camera state, and
screen-share intent automatically whenever recovery is possible.

## Non-negotiable rules

1. Voice has priority over camera and screen sharing.
2. Media uses an SFU; participants never form a peer-to-peer mesh.
3. UI components never connect to the media provider directly. `RoomSession`
   owns room lifecycle, reconnection, token renewal, and device restoration.
4. Text messages and user commands are durable actions. They are queued locally
   and retried with idempotency keys; media is not their source of truth.
5. Recovery is silent for transient failures. A visible failure state is allowed
   only after recovery is exhausted or the user intentionally leaves.
6. Reconnection attempts use bounded exponential backoff with jitter. Parallel
   reconnect attempts are forbidden.

## Session state machine

`idle -> connecting -> connected -> recovering -> connected`

`recovering -> failed` is permitted only after the retry budget is exhausted.
`connected -> leaving -> idle` is the normal user-initiated path.

Each state transition is logged with a correlation ID and the transport reason.

## Initial technical decisions

| Concern | Decision |
| --- | --- |
| Desktop client | Tauri 2 + React + TypeScript |
| Real-time media | LiveKit SFU, using its supported client SDK |
| First deployment | LiveKit Cloud, before considering self-hosting |
| Authorization | Dedicated backend issues short-lived room tokens |
| Durable actions | Local SQLite outbox plus backend acknowledgement |
| Streaming | Separate video/screen tracks; audio is protected first |

## Acceptance gates before video or file transfer

- Two clients remain in the same voice room for two hours.
- Recovery succeeds after Wi-Fi disconnect/reconnect and network switching.
- Recovery never duplicates a participant, track, or text message.
- A temporary media-token failure is renewed without manual rejoin.
- Poor bandwidth reduces video or screen-share quality before audio is harmed.
- Telemetry records reconnect duration, packet loss, jitter, latency, and reason.

