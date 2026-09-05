# Release acceptance — 2026-09-05

## Automated verification

- Android 1.6.7 (versionCode 30) published as Latest from commit `9497589`.
  Quality gates [33969152338](https://github.com/mhlko-tech/MHTalk-Android/actions/runs/33969152338)
  and signed release [33969372817](https://github.com/mhlko-tech/MHTalk-Android/actions/runs/33969372817)
  succeeded. APK/AAB GitHub digests match the published build checksums, the
  signing certificate matches the established identity, and the APK link returns 200.
  [Download APK](https://github.com/mhlko-tech/MHTalk-Android/releases/download/v1.6.7/app-release.apk).
- Windows 1.6.11: `npm run check` passed, including frontend tests/build,
  Worker type checking, Rust formatting, and Rust unit tests.
- Windows Credential Manager: both ignored authentication integration tests
  passed when explicitly run with `cargo test --manifest-path src-tauri/Cargo.toml auth_storage_tests:: -- --ignored --test-threads=1`.
- Installed Windows application: the local uninstall registry reports 1.6.11.
  This does not prove successful startup, login, or membership restoration.
- Membership backend: 45 tests passed and `npm run check` passed, including
  the Worker deployment dry run. The fixtures cover the four paid/gifted plans,
  expired gifts, and disconnect isolation in both directions between applications.
  The isolation test now also verifies two MHTalk devices, preservation of the
  shared OAuth credentials while one session remains, and credential removal
  after the last session disconnects. All 45 tests passed again after expansion.
- Live membership health: `ok=true`, `configured=true`, LAVA and Patreon enabled.
- Public website: HTTP 200.
- Live RTC capabilities: Agora active at 7.25%, Stream at 4.2%; Cloudflare
  Realtime, JaaS, and MiroTalk ready at 0%. Tencent, LiveKit, and Whereby remain
  administratively disabled. Five ready providers; fifteen-minute monitoring.
- No Android device was connected to ADB during this verification.

## Human validation still required

Use Windows 1.6.11 and the new Android 1.6.7 release. Record the device models,
Android version, headphones, provider, and observed result. A blank checkbox
means unverified; automated source-contract tests do not count as a pass here.

| Check | Expected result | Passed |
| --- | --- | --- |
| Windows restart | Account and correct membership return without a permanent restoration screen or incomplete-session error | [ ] |
| Android update | Install over the previous signed APK and confirm version 1.6.7 | [ ] |
| Main room | Both devices join and see each other | [ ] |
| Private room | Authorized devices join the same private room | [ ] |
| Microphone | Mute/unmute takes effect on the other device | [ ] |
| Camera | Show/hide works in both directions | [ ] |
| Screen sharing | Start/view/stop works in both directions | [ ] |
| Independent screen audio | Shared audio remains audible while the sender's microphone is muted | [ ] |
| Bluetooth | Shared audio reaches the receiving headphones | [ ] |
| PiP and full screen | Controls appear and open/close correctly | [ ] |
| Leave/hang-up | Both platforms disconnect immediately | [ ] |
| Chat and attachments | Delivery, progress, and received content are correct | [ ] |
| Friends and presence | Search, invite, and presence updates work | [ ] |
| Reconnect and room switch | Network recovery and switching rooms preserve usable controls | [ ] |
| Provider failover | A newly created room selects another ready provider and retains the same UI | [ ] |

For the failover test, record the existing routing configuration first and restore
it after the test. Use a controlled test window; do not enable disabled providers.
Existing rooms remain pinned to their provider for their lifetime, so use a new
room after making the active provider unavailable for new rooms.

## Real-account membership acceptance

1. Link the same Patreon account in MVDownloader and MHTalk; verify the same plan.
2. Disconnect this MHTalk device; confirm MVDownloader remains Premium.
3. Relink MHTalk, then disconnect MVDownloader; confirm MHTalk remains Premium.
4. With a second MHTalk device linked, disconnect only one MHTalk device and
   confirm the other device remains linked.
5. Check paid and gifted Plus, Pro, Ultimate, and Max Supporter where test
   accounts are available. Ultimate and Max Supporter receive every Pro feature.
6. Confirm an expired gift returns Guest.

Record results without access tokens, OAuth codes, signing material, or other secrets.
