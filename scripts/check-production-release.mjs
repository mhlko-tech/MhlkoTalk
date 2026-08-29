import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const exists = (path) => access(new URL(path, root));

const [
  realtime,
  voice,
  recorder,
  compositor,
  app,
  models,
  database,
  nativeAudio,
  recorderRust,
  libRust,
  capabilities,
  cargo,
  worker,
  packageText,
  testCmd,
  publishScript
] = await Promise.all([
  read('src/services/realtime.ts'),
  read('voice-app/src/main.ts'),
  read('src/services/screenRecorder.ts'),
  read('src/services/mediaCompositor.ts'),
  read('src/App.tsx'),
  read('src/types/models.ts'),
  read('src/services/db.ts'),
  read('src-tauri/src/native_audio.rs'),
  read('src-tauri/src/screen_recorder.rs'),
  read('src-tauri/src/lib.rs'),
  read('src-tauri/capabilities/default.json'),
  read('src-tauri/Cargo.toml'),
  read('worker/src/index.ts'),
  read('package.json'),
  read('TEST_CURRENT_VERSION.cmd'),
  read('BUILD_AND_PUBLISH.ps1')
]);

// Voice: stable transceiver/track lifecycle and automatic playback recovery.
assert.match(voice, /addTransceiver\('audio',\s*\{\s*direction:\s*'sendrecv'/);
assert.match(voice, /sender\.replaceTrack\(track\)/);
assert.match(voice, /sender\.replaceTrack\(null\)/);
assert.match(voice, /recoverRemotePlayback/);
assert.match(voice, /schedulePlaybackRecovery/);
assert.match(voice, /devicechange/);
assert.match(voice, /restartIce\(\)/);
assert.match(voice, /START_VOICE_MESSAGE_RECORDING/);
assert.match(voice, /voiceMessageSourceTrack/);
assert.match(voice, /\.clone\(\)/);
assert.match(voice, /VOICE_MESSAGE_COMPLETE/);
assert.match(voice, /desiredMicEnabled/);
assert.match(voice, /track\.onmute/);
assert.match(voice, /source recovered after Windows temporarily muted/);
assert.match(voice, /Microphone track recovered after an audio-device change/);
assert.match(voice, /peerSignalChains/);
assert.match(voice, /enqueuePeerSignal\(signal\.from[\s\S]{0,160}handleDescription/);
assert.match(voice, /isMLineOrderMismatch/);
assert.match(voice, /recreatePeerForRemoteOffer/);
assert.match(voice, /remote SDP lineage changed/);
assert.match(realtime, /startVoiceMessageRecording/);
assert.match(realtime, /stopVoiceMessageRecording/);
assert.match(realtime, /readVoiceCompanionStatus/);
assert.match(realtime, /readiness resynchronized from native status/);
assert.match(realtime, /scheduleNativeSystemAudioRecovery/);
assert.match(realtime, /System broadcast audio recovered without restarting the video stream/);
assert.match(realtime, /verifyVoiceCompanionHealth/);
assert.match(realtime, /reason: 'health-probe'/);
assert.match(realtime, /voiceCompanionHealthMisses < 3/);
assert.match(realtime, /peerSignalChains/);
assert.match(realtime, /applyRemoteDescription/);
assert.match(realtime, /recreatePeerForRemoteOffer/);
assert.match(realtime, /Rebuilt peer transport immediately after remote SDP lineage changed/);
assert.match(realtime, /pendingStateRefresh/);
assert.match(app, /publishProfileAssetMutation = useMutation\([\s\S]{0,420}retry:/);
assert.match(app, /startVoiceMessageRecording/);
assert.match(app, /isolated MHTalkVoice microphone source/);
assert.match(app, /voiceRecordStartInFlightRef/);
assert.match(app, /onPointerCancel=\{stopVoiceRecordingPreview\}/);
assert.doesNotMatch(app, /roomRef\.current\s*\?\s*await roomRef\.current\.createRecordingStream/);
assert.doesNotMatch(realtime, /async createRecordingStream\(/);
assert.doesNotMatch(voice, /voice-joined[\s\S]{0,500}peers\.clear\(\)/);


// Connection lifecycle: one active signaling socket, liveness heartbeat, recoverable data channels,
// idempotent voice bootstrap and least-privilege native dialog permissions.
assert.match(realtime, /socketGeneration/);
assert.match(realtime, /startSignalingHeartbeat/);
assert.match(realtime, /SIGNALING_STALE_AFTER_MS/);
assert.match(realtime, /ensureLocalDataChannels/);
assert.match(realtime, /data-channel-recreate/);
assert.match(realtime, /Microphone restored after voice recovery/);
assert.match(voice, /sameSession/);
assert.match(voice, /VOICE_SIGNALING_STALE_AFTER_MS/);
assert.match(voice, /signalingConnected/);
assert.match(voice, /Reused the existing MHTalkVoice session after signaling recovery/);
assert.match(voice, /micActive:\s*Boolean\(this\.localStream\)/);
assert.match(worker, /supersedeIdentitySocket/);
assert.match(worker, /replacementStillOnline/);
assert.match(worker, /event:\s*'pong'/);
assert.match(capabilities, /dialog:allow-save/);
assert.doesNotMatch(capabilities, /dialog:allow-confirm/);
assert.doesNotMatch(capabilities, /dialog:allow-message/);

// Screen share: one stable stream, camera composition, track replacement and bounded recovery.
assert.match(realtime, /screenCaptureStream/);
assert.match(realtime, /replaceScreenVideoTrack/);
assert.match(realtime, /screenVideoSender\.replaceTrack/);
assert.match(realtime, /setLocalScreenAudioEnabled\(false/);
assert.match(realtime, /setLocalScreenAudioEnabled\(true/);
assert.match(realtime, /scheduleRemoteScreenRecovery/);
assert.match(realtime, /stream-refresh-request/);
assert.match(realtime, /pendingRtcSignals/);
assert.match(realtime, /flushPendingRtcSignals/);
assert.match(realtime, /Remote screen \$\{event\.track\.kind\} muted/);
assert.match(realtime, /audioSender\.replaceTrack\(audioTrack\)/);
assert.match(realtime, /track\.kind === event\.track\.kind && track\.id !== event\.track\.id/);
assert.match(app, /containsDraggedFiles/);
assert.match(app, /BoostedAudioSink[^>]+refreshToken=/);
assert.match(app, /activeScreenAudioPeerId = streamViewerOpen && activeMediaMode === 'screen' \? activePeerId : ''/);
assert.match(app, /key=\{`screen-audio-\$\{activeScreenAudioPeerId\}`\}/);
assert.match(app, /stream=\{screenStreams\[activeScreenAudioPeerId\]\}/);
assert.doesNotMatch(app, /BoostedAudioSink stream=\{screenStreams\[peer\.peerId\]\}/);
assert.match(app, /audio\.pause\(\);[\s\S]{0,80}audio\.srcObject = null;/);
assert.match(app, /document\.exitPictureInPicture\(\)/);
assert.match(realtime, /ScreenCameraCompositor\.create/);
assert.match(compositor, /captureStream/);
assert.match(compositor, /cropXPercent/);
assert.match(compositor, /cropYPercent/);
assert.match(compositor, /fitMode/);
assert.match(compositor, /snap/);

// Recorder: independent buses, meters/ducking/limiter and crash-safe chunking.
assert.match(models, /includeMic/);
assert.match(models, /includeMembers/);
assert.match(models, /includeSystem/);
assert.match(models, /micVolume/);
assert.match(models, /membersVolume/);
assert.match(models, /systemVolume/);
assert.match(models, /autoDuckSystem/);
assert.match(database, /systemVolume:\s*0\.68/);
assert.match(recorder, /recordingMicGain/);
assert.match(recorder, /recordingMembersGain/);
assert.match(recorder, /recordingSystemGain/);
assert.match(recorder, /DynamicsCompressorNode/);
assert.match(recorder, /startRecordingMeters/);
assert.match(recorder, /autoDuckSystem/);
assert.match(recorder, /start_native_recording_system_audio/);
assert.match(recorder, /start_native_recording_members_audio/);
assert.match(recorder, /getUserMedia\(\{\s*audio:/);
assert.match(recorder, /createStableRecordingVideoTrack/);
assert.match(recorder, /recorder\.start\((?:2_000|2000)\)/);
assert.match(nativeAudio, /capture_process_loop\([\s\S]*false,[\s\S]*RECORDING_EVENT_NAME/);
assert.match(nativeAudio, /capture_process_loop\([\s\S]*true,[\s\S]*RECORDING_MEMBERS_EVENT_NAME/);
assert.match(recorderRust, /MANIFEST_VERSION:\s*u32\s*=\s*3/);
assert.match(recorderRust, /\.mhtalk-recovery/);
assert.match(recorderRust, /partial\.mp4/);
assert.match(recorderRust, /stream copy/);
assert.match(recorderRust, /h264_nvenc/);
assert.match(recorderRust, /h264_qsv/);
assert.match(recorderRust, /h264_amf/);
assert.match(recorderRust, /finalize_recovered_screen_recording/);

// File messages: native safe save/copy, progress, extension preservation and traversal boundary.
assert.match(app, /Download to Desktop|downloadToDesktop/);
assert.match(app, /saveDialog/);
assert.match(app, /mhlko:\/\/file-save-progress/);
const optimisticAttachmentIndex = app.indexOf('const optimistic = queued');
const attachmentDetachIndex = app.indexOf('setPendingAttachments((current) => current.filter');
const attachmentUploadIndex = app.indexOf('const sent = await room.sendFile');
assert.ok(optimisticAttachmentIndex >= 0 && optimisticAttachmentIndex < attachmentUploadIndex, 'Outgoing file message must exist before upload starts.');
assert.ok(attachmentDetachIndex >= 0 && attachmentDetachIndex < attachmentUploadIndex, 'Composer attachment must detach before upload starts.');
assert.match(app, /messageId:\s*item\.id/);
assert.match(app, /onProgress:[\s\S]{0,180}setMessages/);
assert.match(app, /fileStatus:\s*'failed'/);
assert.doesNotMatch(app, /attachmentsUploading/);
assert.match(realtime, /messageId\?: string/);
assert.match(realtime, /const id = options\?\.messageId \|\| crypto\.randomUUID\(\)/);
assert.match(realtime, /completedChunks[\s\S]{0,180}targets\.length/);
assert.match(libRust, /safe_file_name/);
assert.match(libRust, /validated_received_file/);
assert.match(libRust, /canonical\.starts_with\(&root\)/);
assert.match(libRust, /mhtalk-part/);
assert.match(libRust, /copy_file_to_desktop/);
assert.match(libRust, /save_received_file_as/);
assert.match(libRust, /save_data_url_as/);

// Native desktop overlay with click-through/interactivity, shortcut and monitor/DPI support.
assert.match(app, /setAlwaysOnTop\?\.\(true\)/);
assert.match(app, /setIgnoreCursorEvents/);
assert.match(app, /availableMonitors/);
assert.match(app, /scaleFactor/);
assert.match(app, /registerGlobalShortcut/);
assert.match(app, /unregisterAllGlobalShortcuts/);
assert.match(app, /registeredGlobalHotkeysRef/);
assert.match(app, /hotkeyRegistrationGenerationRef/);
assert.match(app, /saveHotkeys/);
assert.match(app, /validateHotkeyMap/);
assert.match(app, /hotkeys:\s*\{\s*\.\.\.\(settings\?\.hotkeys/);
assert.match(app, /Global hotkey registered/);
assert.match(app, /setVoiceOutputDevice/);
assert.match(app, /restoreScreenRecorderOutputDevice/);
assert.match(app, /toggleOverlayMode/);
assert.match(capabilities, /core:window:allow-set-always-on-top/);
assert.match(capabilities, /core:window:allow-set-ignore-cursor-events/);
assert.match(capabilities, /global-shortcut:allow-register/);
assert.match(capabilities, /global-shortcut:allow-unregister-all/);
assert.match(cargo, /tauri-plugin-global-shortcut\s*=\s*"2"/);
assert.match(cargo, /tauri-plugin-dialog\s*=\s*"2"/);

// Server-authorized admin mute persists across reconnect/join and protects owner.
assert.match(worker, /adminMutedPeers/);
assert.match(worker, /setPeerAdminMuted/);
assert.match(worker, /applyAdministrativeMuteToJoinedSocket/);
assert.match(worker, /isOwnerIdentity\(source\)/);
assert.match(worker, /moderation-denied/);

// Release is one complete, self-verifying package.
const packageJson = JSON.parse(packageText);
const releaseVersion = packageJson.version;
assert.match(releaseVersion, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
assert.match(testCmd, /npm\.cmd run verify/);
assert.match(testCmd, /build-voice-sidecar\.ps1/);
assert.match(testCmd, /tauri:dev/);
assert.match(testCmd, /-ProjectPath "%~dp0\."/);
assert.match(publishScript, /Version = ""/);
assert.doesNotMatch(publishScript, /Rename-Item|ExpectedFolderName|TargetProjectPath/);
assert.match(publishScript, /worker run deploy/);
assert.match(publishScript, /tauri:build -- --bundles nsis/);
assert.match(publishScript, /latest\.json/);
assert.match(publishScript, /--latest/);
assert.match(publishScript, /Refusing to recursively remove a path outside the project workspace/);
assert.doesNotMatch(publishScript, /cmd\.exe \/d \/c/);
const jsonVersionCheck = publishScript.slice(
  publishScript.indexOf('function Assert-JsonVersion'),
  publishScript.indexOf('function Assert-CargoVersion')
);
assert.match(jsonVersionCheck, /& node\.exe -e \$NodeJsonReader/);
assert.doesNotMatch(jsonVersionCheck, /ConvertFrom-Json/);
const draftIndex = publishScript.indexOf('Creating or continuing the GitHub draft release');
const workerDeployIndex = publishScript.indexOf('Deploying and verifying the $Version signaling Worker');
const publishIndex = publishScript.indexOf('Publishing v$Version as the Latest release');
assert.ok(draftIndex >= 0 && draftIndex < workerDeployIndex && workerDeployIndex < publishIndex);

await Promise.all([
  exists(`CHANGELOG_${releaseVersion}_AR.md`),
  exists(`GITHUB_RELEASE_DESCRIPTION_${releaseVersion}.md`)
]);

console.log(`MHTalk ${releaseVersion} production media, connection recovery, recording, file and overlay checks passed`);
