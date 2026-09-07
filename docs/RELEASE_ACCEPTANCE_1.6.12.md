# Windows 1.6.12 validation

Changes: membership badges below profile photos, yellow dollar support icon,
unprocessed screen audio and high-quality stereo publishing.

## Verified locally

- `npm run check`: application tests/build, production bundle validation, Worker
  type check, Rust format and tests passed. Three hardware/credential integration
  tests remain ignored by the standard suite; this change does not alter them.
- Application and Worker dependency audits: no known vulnerabilities.
- Native Windows 1.6.12: saved account restored, name/username no longer overlap,
  yellow dollar icon visible, Max Supporter badge centered below the photo in
  the profile editor. Corrected spacing below the photo action during visual QA.
- Agora regression tests cover unprocessed capture, stereo encoding, microphone
  independence, video-only sources, repeated enable/disable, picker stop, and
  cleanup after join/capture/encoder/publish failure.
- Stream regression test verifies independent unprocessed screen audio and
  preservation of video constraints.
- Browser integration check uses the actual installed Agora SDK and the actual
  `AgoraRtcSession` publishing path with synthetic stereo media and an in-memory
  client. After closing the original SDK capture wrapper, both cloned channels
  remained live: approximately 440 Hz left and 1,200 Hz right, RMS 0.1415 each.
  Stopping the share stopped the published audio track.

## Repeat the browser check

Run `npm run dev`, open
`http://127.0.0.1:1425/scripts/test-screen-audio-browser.html`, and click **Run audio
check**. Expect `pass: true` and `stopped: true`. No microphone, screen permission,
real room, or provider credential is used. This page is outside the Vite
production entry points and is not included in the shipped application.

The synthetic integration test exposed that SDK-generated tracks can reject
`applyConstraints`. Voice processing is disabled at capture instead; sample
rate and stereo are selected by the encoder. This compatibility case is also
covered by the automated Agora test.

## Limits

The synthetic test validates SDK track ownership, channel separation and cleanup;
it does not connect to the SFU or prove end-to-end quality on a second device.
Real network playback and Windows/Android listening checks remain human
acceptance checks. No Android client or production backend change is included.
