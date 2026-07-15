# MHTalk v0.9.1

إصدار إصلاحي إنتاجي يعالج انقطاع صوت مشاركة الشاشة بعد تعافي الاتصال، ويعيد تشغيل السحب والإفلات للملفات على Windows.

## Highlights

- Closing the stream viewer now immediately stops and detaches screen-share audio, closes PiP, and releases its Web Audio resources without interrupting call voice.
- Only the actively watched screen owns a playback sink; background peers no longer keep hidden screen-audio players alive.
- Screen-share audio now survives signaling reconnects through bounded SDP/ICE queuing and post-join media resynchronization.
- Audio and video tracks recover independently; stale same-kind tracks are replaced instead of accumulating in a peer connection.
- Screen-audio sender refresh and Web Audio rebinding keep playback attached when the captured audio track changes.
- Native voice lifecycle operations are serialized to prevent reconnect/start/stop races.
- Per-peer SDP/ICE operations are serialized, and an incompatible remote SDP lineage rebuilds only that voice transport instead of leaving call audio broken.
- The main peer transport now performs the same immediate SDP-lineage recovery instead of waiting for a delayed ICE watchdog.
- MHTalkVoice heartbeat recovery now confirms native process health with an active probe before restarting the isolated voice engine.
- Presence/media freshness is coalesced across signaling outages, and transient profile-asset network failures use bounded React Query retries.
- HTML5 file drag-and-drop now reaches the React conversation UI on Tauri/Windows while preserving the existing secure transfer validation.
- Sending an attachment immediately creates one in-chat progress message; repeated Enter presses cannot enqueue the same upload again.
- Release checks, test launcher, and updater notes now derive the active version automatically, reducing future release drift.

## التحديث التلقائي

يتضمن الإصدار Windows NSIS Installer موقعاً، وملف `.sig`، و`latest.json`. تستطيع النسخ المثبتة المدعومة اكتشاف `0.9.1` من خلال MHTalk Updater بعد نشر هذا الإصدار كـLatest.

## Deployment compatibility

MHTalk 0.9.1 desktop, MHTalkVoice, and the signaling Worker form one coordinated release. The official release script verifies the GitHub draft assets before deploying the Worker and publishing the Release as Latest.
