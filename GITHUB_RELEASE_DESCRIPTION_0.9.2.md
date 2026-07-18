# MHTalk v0.9.2

إصدار استعادة وتثبيت ينقل النسخة المدققة من المشروع إلى رقم إصدار جديد وآمن، من دون إعادة كتابة أو استبدال الإصدار السابق v0.9.1.

## Highlights

- Promotes the locally audited and restored MHTalk baseline to version 0.9.2.
- Keeps the existing v0.9.1 tag and release history unchanged.
- Synchronizes the release version across MHTalk Desktop, MHTalkVoice, and the signaling Worker.
- Updates npm, Cargo, Tauri, UI runtime, voice runtime, and Worker runtime version references.
- Introduces no intentional feature or behavioral changes as part of this version-only release step.
- Provides a clean release lineage for subsequent build, signing, updater, and deployment verification.

## التحديث التلقائي

سيتم توفير Windows NSIS Installer وملف التوقيع `.sig` وملف `latest.json` بعد نجاح البناء والتوقيع والتحقق النهائي من الإصدار.

## Deployment compatibility

MHTalk 0.9.2 Desktop, MHTalkVoice 0.9.2, and the signaling Worker 0.9.2 form one coordinated release and must be built and deployed together.

## Release packaging

- Includes a fixed-version Windows one-click launcher for source upload, signed NSIS build, Worker deployment, and GitHub Latest publication.
- Preserves the previous remote `main` in `archive/main-before-0.9.2` before promoting this audited release.
