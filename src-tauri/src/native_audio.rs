use serde::Serialize;

#[derive(Clone, Serialize)]
pub struct NativeAudioStatus {
    supported: bool,
    mode: String,
    process_id: u32,
    reason: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct NativeAudioConfig {
    sample_rate: u32,
    channels: u16,
    format: String,
    mode: String,
    process_id: u32,
    target_kind: String,
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::{NativeAudioConfig, NativeAudioStatus};
    use base64::{engine::general_purpose, Engine as _};
    use serde::Serialize;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex, OnceLock};
    use std::thread::{self, JoinHandle};
    use std::time::Duration;
    use sysinfo::{Pid, System};
    use tauri::{AppHandle, Emitter};
    use wasapi::{
        initialize_mta, AudioClient, Direction, SampleType, StreamMode,
        WaveFormat,
    };

    const SAMPLE_RATE: u32 = 48_000;
    const CHANNELS: u16 = 2;
    const BYTES_PER_SAMPLE: usize = 4; // f32le
    const BUFFER_DURATION_HNS: i64 = 200_000; // 20ms
    const BROADCAST_EVENT_NAME: &str = "mhlko://native-audio-chunk";
    const RECORDING_EVENT_NAME: &str = "mhlko://recording-system-audio-chunk";
    const RECORDING_MEMBERS_EVENT_NAME: &str = "mhlko://recording-members-audio-chunk";

    #[derive(Clone, Serialize)]
    struct NativeAudioChunk {
        sequence: u64,
        sample_rate: u32,
        channels: u16,
        format: &'static str,
        data: String,
    }

    #[derive(Clone, Serialize)]
    struct NativeAudioTarget {
        root_process_id: u32,
        target_process_id: u32,
        target_kind: String,
    }

    struct CaptureState {
        stop: Arc<AtomicBool>,
        thread: Option<JoinHandle<()>>,
    }

    impl Drop for CaptureState {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    static BROADCAST_CAPTURE_STATE: OnceLock<Mutex<Option<CaptureState>>> = OnceLock::new();
    static RECORDING_CAPTURE_STATE: OnceLock<Mutex<Option<CaptureState>>> = OnceLock::new();
    static RECORDING_MEMBERS_CAPTURE_STATE: OnceLock<Mutex<Option<CaptureState>>> = OnceLock::new();

    fn broadcast_state() -> &'static Mutex<Option<CaptureState>> {
        BROADCAST_CAPTURE_STATE.get_or_init(|| Mutex::new(None))
    }

    fn recording_state() -> &'static Mutex<Option<CaptureState>> {
        RECORDING_CAPTURE_STATE.get_or_init(|| Mutex::new(None))
    }

    fn recording_members_state() -> &'static Mutex<Option<CaptureState>> {
        RECORDING_MEMBERS_CAPTURE_STATE.get_or_init(|| Mutex::new(None))
    }

    fn is_descendant_of(system: &System, pid: Pid, root_process_id: u32) -> bool {
        let mut current = Some(pid);
        for _ in 0..20 {
            let Some(current_pid) = current else {
                return false;
            };
            if current_pid.as_u32() == root_process_id {
                return true;
            }
            current = system.process(current_pid).and_then(|process| process.parent());
        }
        false
    }

    fn process_command_line(process: &sysinfo::Process) -> String {
        process
            .cmd()
            .iter()
            .map(|part| part.to_string_lossy().into_owned())
            .collect::<Vec<String>>()
            .join(" ")
    }

    /// Resolve the process that really owns MHTalkVoice playback.
    ///
    /// WebView2 renders call audio in its Audio Service child process. Excluding that exact
    /// process is more reliable than asking Windows to infer the full tree from the non-audio
    /// sidecar host. If command-line inspection is unavailable, the dedicated WebView2 browser
    /// root is used; the sidecar PID remains the final fail-safe fallback.
    fn resolve_voice_playback_target() -> (u32, String) {
        let root_process_id = crate::voice_companion::capture_exclusion_pid();
        if root_process_id == 0 {
            return (0, "unavailable".to_string());
        }

        for attempt in 0..20 {
            let system = System::new_all();
            let mut browser_process_id = None;

            for (pid, process) in system.processes() {
                if !is_descendant_of(&system, *pid, root_process_id) {
                    continue;
                }

                let name = process.name().to_string_lossy();
                if !name.eq_ignore_ascii_case("msedgewebview2.exe") {
                    continue;
                }

                let command_line = process_command_line(process);
                if command_line.contains("audio.mojom.AudioService") {
                    return (pid.as_u32(), "webview2-audio-service".to_string());
                }

                let is_direct_child = process
                    .parent()
                    .map(|parent| parent.as_u32() == root_process_id)
                    .unwrap_or(false);
                let is_browser = !command_line.contains("--type=");
                if browser_process_id.is_none() && (is_direct_child || is_browser) {
                    browser_process_id = Some(pid.as_u32());
                }
            }

            if let Some(process_id) = browser_process_id {
                return (process_id, "webview2-browser-root".to_string());
            }

            if attempt < 19 {
                thread::sleep(Duration::from_millis(50));
            }
        }

        (root_process_id, "mhtalkvoice-host-fallback".to_string())
    }

    pub fn status() -> NativeAudioStatus {
        let (process_id, target_kind) = resolve_voice_playback_target();
        NativeAudioStatus {
            supported: true,
            mode: format!("wasapi-process-loopback-exclude-{target_kind}"),
            process_id,
            reason: None,
        }
    }

    pub fn start_broadcast(app: AppHandle) -> Result<NativeAudioConfig, String> {
        stop_broadcast();

        let (process_id, target_kind) = resolve_voice_playback_target();
        if process_id == 0 {
            return Err(
                "MHTalkVoice is not ready; system audio capture was blocked to prevent call echo"
                    .to_string(),
            );
        }

        let stop_flag = Arc::new(AtomicBool::new(false));
        let thread_stop = stop_flag.clone();
        let thread_app = app.clone();
        let thread_target_kind = target_kind.clone();

        let handle = thread::Builder::new()
            .name("mhlkotalk-broadcast-audio-exclude-voice".to_string())
            .spawn(move || {
                let _ = thread_app.emit(
                    "mhlko://native-audio-target",
                    NativeAudioTarget {
                        root_process_id: crate::voice_companion::capture_exclusion_pid(),
                        target_process_id: process_id,
                        target_kind: thread_target_kind,
                    },
                );
                if let Err(error) = capture_process_exclusion_loop(
                    thread_app.clone(),
                    thread_stop.clone(),
                    process_id,
                ) {
                    let _ = thread_app.emit(
                        "mhlko://native-audio-error",
                        format!("native broadcast audio capture failed: {error}"),
                    );
                }
            })
            .map_err(|error| format!("could not start native broadcast audio thread: {error}"))?;

        let mut lock = broadcast_state()
            .lock()
            .map_err(|_| "native broadcast audio state lock failed".to_string())?;
        *lock = Some(CaptureState {
            stop: stop_flag,
            thread: Some(handle),
        });

        Ok(NativeAudioConfig {
            sample_rate: SAMPLE_RATE,
            channels: CHANNELS,
            format: "f32le".to_string(),
            mode: "wasapi-process-loopback-exclude-mhtalkvoice-playback".to_string(),
            process_id,
            target_kind,
        })
    }

    pub fn start_recording(app: AppHandle) -> Result<NativeAudioConfig, String> {
        stop_recording();

        // The system/game bus deliberately excludes MHTalkVoice. Remote member audio is
        // captured by a second include-only process loopback session, which prevents
        // duplication and gives the recorder independent gain/mute controls.
        let (process_id, target_kind) = resolve_voice_playback_target();
        if process_id == 0 {
            return Err("MHTalkVoice is not ready; isolated recording buses are unavailable".to_string());
        }

        let stop_flag = Arc::new(AtomicBool::new(false));
        let thread_stop = stop_flag.clone();
        let thread_app = app.clone();
        let kind = target_kind.clone();
        let handle = thread::Builder::new()
            .name("mhlkotalk-recording-system-excluding-members".to_string())
            .spawn(move || {
                let _ = thread_app.emit(
                    "mhlko://recording-audio-target",
                    NativeAudioTarget {
                        root_process_id: crate::voice_companion::capture_exclusion_pid(),
                        target_process_id: process_id,
                        target_kind: kind,
                    },
                );
                if let Err(error) = capture_process_loop(
                    thread_app.clone(),
                    thread_stop,
                    process_id,
                    false,
                    RECORDING_EVENT_NAME,
                ) {
                    let _ = thread_app.emit(
                        "mhlko://recording-system-audio-error",
                        format!("native isolated system audio failed: {error}"),
                    );
                }
            })
            .map_err(|error| format!("could not start isolated system recording thread: {error}"))?;

        let mut lock = recording_state()
            .lock()
            .map_err(|_| "recording system audio state lock failed".to_string())?;
        *lock = Some(CaptureState { stop: stop_flag, thread: Some(handle) });

        Ok(NativeAudioConfig {
            sample_rate: SAMPLE_RATE,
            channels: CHANNELS,
            format: "f32le".to_string(),
            mode: "wasapi-process-loopback-exclude-mhtalkvoice-recording".to_string(),
            process_id,
            target_kind,
        })
    }

    pub fn start_recording_members(app: AppHandle) -> Result<NativeAudioConfig, String> {
        stop_recording_members();
        let (process_id, target_kind) = resolve_voice_playback_target();
        if process_id == 0 {
            return Err("MHTalkVoice is not ready; member voice capture is unavailable".to_string());
        }

        let stop_flag = Arc::new(AtomicBool::new(false));
        let thread_stop = stop_flag.clone();
        let thread_app = app.clone();
        let handle = thread::Builder::new()
            .name("mhlkotalk-recording-members-only".to_string())
            .spawn(move || {
                if let Err(error) = capture_process_loop(
                    thread_app.clone(),
                    thread_stop,
                    process_id,
                    true,
                    RECORDING_MEMBERS_EVENT_NAME,
                ) {
                    let _ = thread_app.emit(
                        "mhlko://recording-members-audio-error",
                        format!("native member voice capture failed: {error}"),
                    );
                }
            })
            .map_err(|error| format!("could not start member voice recording thread: {error}"))?;

        let mut lock = recording_members_state()
            .lock()
            .map_err(|_| "recording member audio state lock failed".to_string())?;
        *lock = Some(CaptureState { stop: stop_flag, thread: Some(handle) });

        Ok(NativeAudioConfig {
            sample_rate: SAMPLE_RATE,
            channels: CHANNELS,
            format: "f32le".to_string(),
            mode: "wasapi-process-loopback-include-mhtalkvoice-recording".to_string(),
            process_id,
            target_kind,
        })
    }

    fn stop_capture(state: &'static Mutex<Option<CaptureState>>) {
        if let Ok(mut lock) = state.lock() {
            if let Some(mut current) = lock.take() {
                current.stop.store(true, Ordering::SeqCst);
                if let Some(thread) = current.thread.take() {
                    let _ = thread.join();
                }
            }
        }
    }

    pub fn stop_broadcast() {
        stop_capture(broadcast_state());
    }

    pub fn stop_recording() {
        stop_capture(recording_state());
    }

    pub fn stop_recording_members() {
        stop_capture(recording_members_state());
    }

    fn emit_packet(
        app: &AppHandle,
        event_name: &str,
        sequence: &mut u64,
        bytes: &[u8],
    ) {
        let payload = NativeAudioChunk {
            sequence: *sequence,
            sample_rate: SAMPLE_RATE,
            channels: CHANNELS,
            format: "f32le",
            data: general_purpose::STANDARD.encode(bytes),
        };
        *sequence = (*sequence).wrapping_add(1);
        let _ = app.emit(event_name, payload);
    }

    fn drain_capture_client(
        app: &AppHandle,
        event_name: &str,
        capture: &wasapi::AudioCaptureClient,
        sequence: &mut u64,
    ) -> Result<(), String> {
        let frame_bytes = CHANNELS as usize * BYTES_PER_SAMPLE;
        loop {
            let frames = capture
                .get_next_packet_size()
                .map_err(|error| format!("packet size failed: {error}"))?
                .unwrap_or(0);
            if frames == 0 {
                break;
            }

            let mut bytes = vec![0_u8; frames as usize * frame_bytes];
            let (read_frames, _info) = capture
                .read_from_device(&mut bytes)
                .map_err(|error| format!("audio packet read failed: {error}"))?;
            if read_frames == 0 {
                break;
            }
            bytes.truncate(read_frames as usize * frame_bytes);
            emit_packet(app, event_name, sequence, &bytes);
        }
        Ok(())
    }

    fn capture_process_exclusion_loop(
        app: AppHandle,
        stop: Arc<AtomicBool>,
        process_id: u32,
    ) -> Result<(), String> {
        capture_process_loop(app, stop, process_id, false, BROADCAST_EVENT_NAME)
    }

    fn capture_process_loop(
        app: AppHandle,
        stop: Arc<AtomicBool>,
        process_id: u32,
        include_target_tree: bool,
        event_name: &'static str,
    ) -> Result<(), String> {
        initialize_mta()
            .ok()
            .map_err(|error| format!("COM init failed: {error}"))?;

        // `true` includes only the target process tree; `false` excludes it from
        // the full render mix. Both paths are kept independent for the recorder.
        let mut client = AudioClient::new_application_loopback_client(process_id, include_target_tree)
            .map_err(|error| format!("process loopback activation failed: {error}"))?;
        let desired_format = WaveFormat::new(32, 32, &SampleType::Float, SAMPLE_RATE as usize, CHANNELS as usize, None);
        let mode = StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: BUFFER_DURATION_HNS };
        client
            .initialize_client(&desired_format, &Direction::Capture, &mode)
            .map_err(|error| format!("process loopback initialize failed: {error}"))?;
        let event = client.set_get_eventhandle().map_err(|error| format!("audio event handle failed: {error}"))?;
        let capture = client.get_audiocaptureclient().map_err(|error| format!("audio capture client failed: {error}"))?;
        client.start_stream().map_err(|error| format!("audio capture start failed: {error}"))?;

        let mut sequence = 0_u64;
        while !stop.load(Ordering::SeqCst) {
            let _ = event.wait_for_event(100);
            drain_capture_client(&app, event_name, &capture, &mut sequence)?;
            thread::sleep(Duration::from_millis(1));
        }
        let _ = client.stop_stream();
        Ok(())
    }

}

#[cfg(not(target_os = "windows"))]
mod non_windows_impl {
    use super::{NativeAudioConfig, NativeAudioStatus};
    use tauri::AppHandle;

    pub fn status() -> NativeAudioStatus {
        NativeAudioStatus {
            supported: false,
            mode: "unsupported".to_string(),
            process_id: crate::voice_companion::capture_exclusion_pid(),
            reason: Some("Native audio routing is Windows-only.".to_string()),
        }
    }

    pub fn start_broadcast(_app: AppHandle) -> Result<NativeAudioConfig, String> {
        Err("Native process audio exclusion is Windows-only.".to_string())
    }

    pub fn start_recording(_app: AppHandle) -> Result<NativeAudioConfig, String> {
        Err("Native system recording audio is Windows-only.".to_string())
    }

    pub fn start_recording_members(_app: AppHandle) -> Result<NativeAudioConfig, String> {
        Err("Native member audio recording is Windows-only.".to_string())
    }
    pub fn stop_broadcast() {}
    pub fn stop_recording() {}
    pub fn stop_recording_members() {}
}

#[tauri::command]
pub fn native_audio_exclusion_status() -> NativeAudioStatus {
    #[cfg(target_os = "windows")]
    {
        windows_impl::status()
    }
    #[cfg(not(target_os = "windows"))]
    {
        non_windows_impl::status()
    }
}

#[tauri::command]
pub fn start_native_system_audio_excluding_self(
    app: tauri::AppHandle,
) -> Result<NativeAudioConfig, String> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::start_broadcast(app)
    }
    #[cfg(not(target_os = "windows"))]
    {
        non_windows_impl::start_broadcast(app)
    }
}

#[tauri::command]
pub fn stop_native_system_audio_excluding_self() {
    #[cfg(target_os = "windows")]
    {
        windows_impl::stop_broadcast()
    }
    #[cfg(not(target_os = "windows"))]
    {
        non_windows_impl::stop_broadcast()
    }
}

#[tauri::command]
pub fn start_native_recording_system_audio(
    app: tauri::AppHandle,
) -> Result<NativeAudioConfig, String> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::start_recording(app)
    }
    #[cfg(not(target_os = "windows"))]
    {
        non_windows_impl::start_recording(app)
    }
}

#[tauri::command]
pub fn stop_native_recording_system_audio() {
    #[cfg(target_os = "windows")]
    {
        windows_impl::stop_recording()
    }
    #[cfg(not(target_os = "windows"))]
    {
        non_windows_impl::stop_recording()
    }
}

#[tauri::command]
pub fn start_native_recording_members_audio(
    app: tauri::AppHandle,
) -> Result<NativeAudioConfig, String> {
    #[cfg(target_os = "windows")]
    { windows_impl::start_recording_members(app) }
    #[cfg(not(target_os = "windows"))]
    { non_windows_impl::start_recording_members(app) }
}

#[tauri::command]
pub fn stop_native_recording_members_audio() {
    #[cfg(target_os = "windows")]
    { windows_impl::stop_recording_members() }
    #[cfg(not(target_os = "windows"))]
    { non_windows_impl::stop_recording_members() }
}

pub fn stop_for_voice_engine_change() {
    // A voice-process restart invalidates only the broadcast exclusion target.
    // The independent full-system recorder must keep running.
    #[cfg(target_os = "windows")]
    {
        windows_impl::stop_broadcast()
    }
    #[cfg(not(target_os = "windows"))]
    {
        non_windows_impl::stop_broadcast()
    }
}
