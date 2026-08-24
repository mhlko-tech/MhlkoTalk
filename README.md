# MHTalk

MHTalk is a Windows desktop application for persistent voice rooms, video,
screen sharing, room chat, private invitations, file exchange and local screen
recording. Version 1.1 adds opt-in remote video, selectable broadcast quality,
reliable cross-platform profiles, event sounds and a corrected recording mixer.

The desktop client is built with Tauri, Rust, React and LiveKit. The public Main
channel is joined directly, private rooms use invitation codes and signed access
tokens, and transient network failures are recovered in the background.

Remote camera and screen tracks are announced without being downloaded. A user
subscribes only after choosing Watch, and can request any simulcast layer up to
the maximum quality published by the sender. Microphone audio remains connected
for the room conversation.

The Mangatak account boundary is present but intentionally disabled until an
official OAuth-compatible service URL is supplied through
`VITE_MANGATAK_AUTH_ENDPOINT`. No account token is persisted to disk.

Official releases are published at:
https://github.com/mhlko-tech/MhlkoTalk/releases
