# Windows 1.6.13

The 1.6.12 screen-audio change explicitly disabled voice processing but did not
exclude the capturing application's own playback on Agora. When a broadcaster
captures system audio, call playback can therefore be retransmitted as screen
audio and a viewer can hear their own voice coming back.

This release requests `restrictOwnAudio: true` on Agora capture and on the common
browser screen-audio constraints used by Cloudflare, Stream and LiveKit. The
capture source excludes call playback where the browser/OS supports it, while
echo cancellation, noise suppression and automatic gain control remain disabled
for screen media. The publisher needs the update for this capture-side change.

The installed Agora SDK supports this option for current Chromium/WebView2
runtimes; the development machine has WebView2 152.0.4191.66. Unsupported runtimes
may ignore this capture constraint. This does not diagnose acoustic echo from a
remote microphone or operating-system microphone monitoring.

Membership badges are restored to member-name rows, cards, menus and Friends.
Only the own-account footer omits the inline badge. Profile views/editors retain
the badge beneath the photo; the yellow dollar support button is preserved.

Regression coverage:

- Capture excludes own playback without re-enabling voice processing.
- Local Agora voice and screen identities never subscribe through remote playback.
- Remote microphone audio remains audible, and screen audio is enabled only when
  that remote screen is watched.
- Existing stereo capture, microphone independence and lifecycle cleanup tests.

Real two-device listening and OS-level capture exclusion have not been verified
by the automated tests. These checks do not justify claiming every source of
self-echo is resolved.

References: [Agora's screen audio API](https://doc.shengwang.cn/api-ref/rtc/javascript/globals)
and [Chromium's own-audio exclusion implementation](https://chromium.googlesource.com/chromium/src/media/+/718680e44b525cd4dcafd60093d92b9235a885c7).
