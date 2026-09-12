# Windows 1.6.14 and Android 1.6.8 RTC recovery

The 1.6.13 Windows client stopped on a single Agora gateway failure. The broker
could retry failed credential issuance but did not receive failed SDK joins.
Native parity gates allowed Agora, Tencent and LiveKit; Tencent and LiveKit were
administratively disabled, leaving no usable client alternative.

The new clients exclude failed transports, bound connection attempts, cancel
pending joins on leave, and publish presence only after connection. Shared room
leases are allocated atomically in the existing Durable Object. A participant
cannot migrate while other members still hold the previous transport; clients
wait for its release, then follow the same replacement. Signed usage heartbeats
trigger recovery at the configured disable threshold or stale telemetry. Old
clients retain their lease instead of being silently split during rollout.

The new sidebar indicator uses the actual session provider and its current
capability measurement. Remaining percentage is normalized against MHTalk's
protective disable threshold, not the vendor's full billable allocation. Green,
yellow and red follow provider-specific limits; unknown/stale data stays gray.

On 2026-09-12 a controlled probe on this PC reproduced Agora gateway flag 4096
on two independently issued identities. The existing LiveKit Cloud project
connected two clients, published and subscribed two synthetic audio tracks,
received 30 reliable data events and 646,655 RTP audio bytes with no errors.
Both probes were closed; LiveKit reported zero participants afterward. No new
provider account or paid plan was created. Exact remaining vendor-side quota
could not be read from its signed-out dashboard; the existing configured
5,000-minute allocation and all safety thresholds are preserved.

Regression gates cover simultaneous initial failures, locked-room waiting,
quota/route-change recovery, abandoned SDK completions, exact-zero heartbeats,
lease expiry, legacy occupancy, stale reports and all quota display thresholds.
Actual camera/screen sharing is stopped during transport recovery and requires
the user to restart capture. Synthetic browser RTC tests do not establish
physical Windows-to-Android microphone/speaker quality.

LiveKit enable/disable uses a protected operator endpoint and the existing
GitHub administrator secret. Enabling probes its API and verifies the stored
monthly allocation before changing only the policy's enabled field. Disabling
the route or restoring the prior Worker deployment provides operational rollback.
