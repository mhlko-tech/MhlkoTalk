import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const [
  realtime, app, mainPackageText, mainCargo, mainTauriText, mainLib,
  nativeAudio, companionRust, voiceTs, voiceRust, voicePackageText,
  voiceCargo, voiceTauriText, worker, workerPackageText, buildVoice
] = await Promise.all([
  read('../src/services/realtime.ts'),
  read('../src/App.tsx'),
  read('../package.json'),
  read('../src-tauri/Cargo.toml'),
  read('../src-tauri/tauri.conf.json'),
  read('../src-tauri/src/lib.rs'),
  read('../src-tauri/src/native_audio.rs'),
  read('../src-tauri/src/voice_companion.rs'),
  read('../voice-app/src/main.ts'),
  read('../voice-app/src-tauri/src/main.rs'),
  read('../voice-app/package.json'),
  read('../voice-app/src-tauri/Cargo.toml'),
  read('../voice-app/src-tauri/tauri.conf.json'),
  read('../worker/src/index.ts'),
  read('../worker/package.json'),
  read('./build-voice-sidecar.ps1')
]);

const methodSlice = (source, startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `Could not slice ${startMarker}`);
  return source.slice(start, end);
};

// Main process: hard call-audio boundary.
const createPeer = methodSlice(realtime, '  private createPeer(', '  private ensurePeer(');
const startVoice = methodSlice(realtime, '  async startVoice(', '  async stopVoice(');
assert.match(createPeer, /addTransceiver\('video'/);
assert.doesNotMatch(createPeer, /addTransceiver\('audio'/);
assert.doesNotMatch(createPeer, /createDataChannel\(`mhlko-voice/);
assert.match(createPeer, /Blocked call-audio track|hard isolation/);
assert.match(startVoice, /sendVoiceCompanionCommand\('START_MIC'/);
assert.match(realtime, /capabilities:\s*\{\s*rtpVoice:\s*false,\s*voiceCompanion:\s*true/);
assert.match(realtime, /companion-register/);
assert.match(realtime, /VOICE_DISCONNECTED/);
assert.match(realtime, /heartbeat was lost; system audio was disabled/);
assert.match(realtime, /disableScreenSystemAudio/);
assert.doesNotMatch(realtime, /type:\s*'voice-pcm'/);
assert.doesNotMatch(realtime, /native_voice_push_pcm/);
assert.doesNotMatch(realtime, /voiceTransceiver|voiceSender|voiceDc|voiceStream/);
assert.doesNotMatch(app, /voiceStreams|setVoiceStreams|localVoiceStream|BoostedAudioSink stream=\{voiceStreams/);

// Dedicated voice process: WebRTC/Opus/mic/playback live here only.
assert.match(voiceTs, /addTransceiver\('audio'/);
assert.match(voiceTs, /navigator\.mediaDevices\.getUserMedia/);
assert.match(voiceTs, /setCodecPreferences/);
assert.match(voiceTs, /maxBitrate = 32_000/);
assert.match(voiceTs, /await audio\.play\(\)/);
assert.match(voiceTs, /SET_PEER_VOLUME/);
assert.match(voiceTs, /VOICE_READY/);
assert.match(voiceTs, /VOICE_HEARTBEAT/);
assert.match(voiceTs, /voice_show_interaction_window/);
assert.match(voiceTs, /configured microphone was unavailable|Configured microphone was unavailable/i);
assert.match(voiceTs, /recoverRemotePlayback/);
assert.match(voiceTs, /schedulePlaybackRecovery/);
assert.match(voiceTs, /media-clock-stalled/);
assert.match(voiceTs, /devicechange/);
assert.match(voiceTs, /START_VOICE_MESSAGE_RECORDING/);
assert.match(voiceTs, /voiceMessageSourceTrack/);
assert.match(voiceTs, /\.clone\(\)/);
assert.match(voiceTs, /VOICE_MESSAGE_COMPLETE/);
assert.match(voiceTs, /desiredMicEnabled/);
assert.match(voiceTs, /track\.onmute/);
assert.match(voiceTs, /source recovered after Windows temporarily muted/);
assert.match(realtime, /startVoiceMessageRecording/);
assert.match(realtime, /readVoiceCompanionStatus/);
assert.match(realtime, /scheduleNativeSystemAudioRecovery/);
assert.match(realtime, /serializeScreenAudioLifecycle/);
assert.match(realtime, /pendingRtcSignals/);
assert.match(realtime, /flushPendingRtcSignals/);
assert.match(realtime, /Signaling temporarily unavailable; queued/);
assert.match(realtime, /Remote screen \$\{event\.track\.kind\} muted/);
assert.match(realtime, /audioSender\.replaceTrack\(audioTrack\)/);
assert.match(realtime, /track\.kind === event\.track\.kind && track\.id !== event\.track\.id/);
assert.match(app, /BoostedAudioSink[^>]+refreshToken=/);
assert.match(app, /persistHotkey/);
assert.match(app, /registeredGlobalHotkeysRef/);
assert.match(app, /unregisterAllGlobalShortcuts/);
assert.match(voiceTs, /setSinkId\(''\)/);
assert.match(voiceTs, /switched to the Windows default output/);
assert.match(voiceTs, /type: 'ENGINE_READY'.*version: '\d+\.\d+\.\d+'/);
assert.match(voiceRust, /FRONTEND_READY/);
assert.match(voiceRust, /voice_mark_ready_and_take_pending/);
assert.match(voiceRust, /voice_show_interaction_window/);
assert.match(voiceRust, /window\.hide\(\)/);

// Sidecar process and exact Windows process-tree exclusion.
assert.match(companionRust, /sidecar\(SIDECAR_NAME\)/);
assert.match(companionRust, /MHTalkVoice/);
assert.match(companionRust, /stdout_buffer/);
assert.match(companionRust, /VOICE_DISCONNECTED/);
assert.match(companionRust, /stop_for_voice_engine_change/);
assert.match(nativeAudio, /capture_exclusion_pid\(\)/);
assert.match(nativeAudio, /new_application_loopback_client\(process_id, include_target_tree\)/);
assert.match(nativeAudio, /capture_process_loop\([\s\S]*process_id,[\s\S]*false,[\s\S]*RECORDING_EVENT_NAME/);
assert.match(nativeAudio, /capture_process_loop\([\s\S]*process_id,[\s\S]*true,[\s\S]*RECORDING_MEMBERS_EVENT_NAME/);
assert.match(nativeAudio, /if process_id == 0/);
assert.match(nativeAudio, /exclude-mhtalkvoice-playback/);
assert.match(nativeAudio, /webview2-audio-service/);
assert.match(nativeAudio, /start_native_recording_system_audio/);
assert.match(nativeAudio, /wasapi-process-loopback-exclude-mhtalkvoice-recording/);
assert.match(nativeAudio, /wasapi-process-loopback-include-mhtalkvoice-recording/);
assert.match(mainLib, /start_native_recording_system_audio/);
assert.match(mainLib, /tauri_plugin_shell::init\(\)/);
assert.doesNotMatch(mainLib, /voice_engine::native_voice_push_pcm/);
assert.doesNotMatch(mainLib, /voice_engine::native_voice_start_input_capture/);
assert.doesNotMatch(mainLib, /voice_engine::native_voice_stop_all/);
assert.match(mainTauriText, /"externalBin"[\s\S]*"binaries\/MHTalkVoice"/);
assert.match(buildVoice, /MHTalkVoice-\$targetTriple/);

// Worker: one hidden authenticated companion per approved main session.
assert.match(worker, /kind === 'voice'/);
assert.match(worker, /parentPeerId/);
assert.match(worker, /constantTimeEqual\(parent\.voiceToken, voiceToken\)/);
assert.match(worker, /companion-register/);
assert.match(worker, /voice-auth-failed/);
assert.match(worker, /getApprovedVoiceSockets/);
assert.match(worker, /closeVoiceCompanions/);
assert.match(worker, /attachment\.kind === 'voice'/);
assert.match(worker, /admin-mute-all/);
assert.match(worker, /moderation-denied/);
assert.match(worker, /globalMuteActive/);
assert.match(worker, /isOwnerIdentity\(source\)/);
assert.match(realtime, /Requested server-authorized Mute All/);
assert.match(realtime, /Ignored unauthorized legacy Mute All/);
assert.match(realtime, /admin-mute-state/);

// Separate WebView2 environment and hidden no-bundle helper.
const mainTauri = JSON.parse(mainTauriText);
const voiceTauri = JSON.parse(voiceTauriText);
assert.equal(voiceTauri.app.windows[0].visible, false);
assert.equal(voiceTauri.app.windows[0].skipTaskbar, true);
assert.equal(voiceTauri.app.windows[0].dataDirectory, 'MHTalkVoiceWebView2');
assert.equal(voiceTauri.identifier, 'com.mhlko.talk.voice');
assert.equal(voiceTauri.bundle.active, false);
assert.notEqual(voiceTauri.identifier, mainTauri.identifier);
assert.equal(mainTauri.app.windows[0].dragDropEnabled, false);

// Release versions stay locked together.
const mainPackage = JSON.parse(mainPackageText);
const voicePackage = JSON.parse(voicePackageText);
const workerPackage = JSON.parse(workerPackageText);
const cargoVersion = mainCargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const voiceCargoVersion = voiceCargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const appVersion = app.match(/const APP_VERSION = '([^']+)'/)?.[1];
const voiceRuntimeVersion = voiceTs.match(/type: 'ENGINE_READY'.*version: '([^']+)'/)?.[1];
const workerRuntimeVersion = worker.match(/service: 'MHTalk signaling', version: '([^']+)'/)?.[1];
const releaseVersion = mainPackage.version;
assert.match(releaseVersion, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const versions = [
  mainPackage.version, cargoVersion, mainTauri.version, appVersion,
  voicePackage.version, voiceCargoVersion, voiceTauri.version, voiceRuntimeVersion,
  workerPackage.version, workerRuntimeVersion
];
for (const version of versions) assert.equal(version, releaseVersion);

console.log(`MHTalk ${releaseVersion} audio recovery and server-authorized admin mute checks passed`);
