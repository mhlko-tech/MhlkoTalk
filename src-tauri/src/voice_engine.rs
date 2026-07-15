use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

const DEFAULT_VOICE_SOLUTION: u8 = 1; // 0.6.5 Clear Voice Priority default
static VOICE_SOLUTION: AtomicU8 = AtomicU8::new(DEFAULT_VOICE_SOLUTION);
static VOICE_ENHANCE_ENABLED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy)]
struct VoiceSolutionProfile {
    id: u8,
    name: &'static str,
    mode: &'static str,
    input_target_rate: u32,
    input_gain: f32,
    output_gain: f32,
    output_agc_target: f32,
    output_max_boost: f32,
    clarity_strength: f32,
    noise_gate: f32,
    min_buffer_ms: usize,
    target_buffer_ms: usize,
    max_buffer_ms: usize,
    underrun_refill_ms: usize,
}

#[derive(Clone, Serialize)]
pub struct NativeVoiceSolutionStatus {
    solution: u8,
    name: String,
    mode: String,
    input_sample_rate: u32,
    input_channels: u16,
    min_buffer_ms: usize,
    max_buffer_ms: usize,
    note: String,
}

fn clamp_solution(solution: u8) -> u8 {
    solution.clamp(1, 4)
}

fn current_solution_id() -> u8 {
    clamp_solution(VOICE_SOLUTION.load(Ordering::SeqCst))
}

fn voice_profile_for(solution: u8) -> VoiceSolutionProfile {
    match clamp_solution(solution) {
        2 => VoiceSolutionProfile {
            id: 2,
            name: "Solution 2 - Loud Stable",
            mode: "native-loud-stable-agc",
            input_target_rate: 48_000,
            input_gain: 1.75,
            output_gain: 1.30,
            output_agc_target: 0.22,
            output_max_boost: 2.85,
            clarity_strength: 1.18,
            noise_gate: 0.0012,
            min_buffer_ms: 65,
            target_buffer_ms: 230,
            max_buffer_ms: 680,
            underrun_refill_ms: 130,
        },
        3 => VoiceSolutionProfile {
            id: 3,
            name: "Solution 3 - Low PC",
            mode: "native-low-cpu-24k-mono",
            input_target_rate: 24_000,
            input_gain: 1.35,
            output_gain: 1.20,
            output_agc_target: 0.16,
            output_max_boost: 1.75,
            clarity_strength: 0.88,
            noise_gate: 0.0015,
            min_buffer_ms: 75,
            target_buffer_ms: 260,
            max_buffer_ms: 740,
            underrun_refill_ms: 150,
        },
        4 => VoiceSolutionProfile {
            id: 4,
            name: "Solution 4 - Network Safe",
            mode: "native-network-safe-16k-deep-buffer",
            input_target_rate: 16_000,
            input_gain: 1.45,
            output_gain: 1.25,
            output_agc_target: 0.17,
            output_max_boost: 1.95,
            clarity_strength: 0.95,
            noise_gate: 0.0020,
            min_buffer_ms: 100,
            target_buffer_ms: 340,
            max_buffer_ms: 900,
            underrun_refill_ms: 200,
        },
        _ => VoiceSolutionProfile {
            id: 1,
            name: "Clear Priority - Stable Voice",
            mode: "native-clear-priority-48k-stable-jitter",
            input_target_rate: 48_000,
            input_gain: 1.32,
            output_gain: 1.18,
            output_agc_target: 0.20,
            output_max_boost: 2.55,
            clarity_strength: 1.08,
            noise_gate: 0.0006,
            min_buffer_ms: 55,
            target_buffer_ms: 210,
            max_buffer_ms: 620,
            underrun_refill_ms: 120,
        },
    }
}

fn current_voice_profile() -> VoiceSolutionProfile {
    voice_profile_for(current_solution_id())
}

fn solution_status(profile: VoiceSolutionProfile) -> NativeVoiceSolutionStatus {
    NativeVoiceSolutionStatus {
        solution: profile.id,
        name: profile.name.to_string(),
        mode: profile.mode.to_string(),
        input_sample_rate: profile.input_target_rate,
        input_channels: 1,
        min_buffer_ms: profile.min_buffer_ms,
        max_buffer_ms: profile.max_buffer_ms,
        note: format!("{} is available for legacy PCM compatibility, microphone tests, tones, and utility audio. Current calls use WebRTC Opus RTP/SRTP.", profile.name),
    }
}

// cpal::Stream is marked !Send on some platforms because not every backend guarantees
// cross-thread movement. MHTalk targets Windows for this native voice engine; we only
// keep streams inside global state so they stay alive until explicitly stopped/dropped.
// The actual audio callbacks are owned by cpal. This wrapper lets the Windows build store
// those streams behind Mutex/OnceLock without moving them between audio callbacks.
struct NativeVoiceStream(#[allow(dead_code)] cpal::Stream);
unsafe impl Send for NativeVoiceStream {}


#[derive(Serialize)]
pub struct VoiceEngineStatus {
    pub supported: bool,
    pub ready: bool,
    pub phase: String,
    #[serde(rename = "processName")]
    pub process_name: String,
    pub note: String,
    #[serde(rename = "voiceEnhanceEnabled")]
    pub voice_enhance_enabled: bool,
}


struct NativeVoiceMicTestState {
    stop: Arc<AtomicBool>,
    _stream: NativeVoiceStream,
}

impl Drop for NativeVoiceMicTestState {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

static MIC_TEST_STATE: OnceLock<Mutex<Option<NativeVoiceMicTestState>>> = OnceLock::new();

fn mic_test_slot() -> &'static Mutex<Option<NativeVoiceMicTestState>> {
    MIC_TEST_STATE.get_or_init(|| Mutex::new(None))
}

#[derive(Default)]
struct PeerPlayback {
    samples: VecDeque<f32>,
    channels: usize,
    volume: f32,
    muted: bool,
    started: bool,
    underruns: u32,
    dc_last_input: f32,
    dc_last_output: f32,
    agc_level: f32,
    last_sequence: Option<u64>,
}

struct NativeVoiceEngine {
    peers: Arc<Mutex<HashMap<String, PeerPlayback>>>,
    _stream: NativeVoiceStream,
    sample_rate: u32,
    channels: usize,
}

static ENGINE: OnceLock<Mutex<Option<NativeVoiceEngine>>> = OnceLock::new();

fn engine_slot() -> &'static Mutex<Option<NativeVoiceEngine>> {
    ENGINE.get_or_init(|| Mutex::new(None))
}

#[derive(Clone, Default)]
struct DeviceSelection {
    id: Option<String>,
    label: Option<String>,
}

static OUTPUT_DEVICE_SELECTION: OnceLock<Mutex<DeviceSelection>> = OnceLock::new();

fn output_device_selection() -> &'static Mutex<DeviceSelection> {
    OUTPUT_DEVICE_SELECTION.get_or_init(|| Mutex::new(DeviceSelection::default()))
}

fn normalize_label(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ").trim().to_lowercase()
}

fn select_device_by_label<I>(devices: I, requested_id: &Option<String>, requested_label: &Option<String>) -> Option<cpal::Device>
where
    I: Iterator<Item = cpal::Device>,
{
    let wanted_id = requested_id.as_ref().map(|v| normalize_label(v)).filter(|v| !v.is_empty());
    let wanted_label = requested_label.as_ref().map(|v| normalize_label(v)).filter(|v| !v.is_empty());
    if wanted_id.is_none() && wanted_label.is_none() { return None; }
    let mut fallback_contains: Option<cpal::Device> = None;
    for device in devices {
        let label = device.name().unwrap_or_default();
        let normalized = normalize_label(&label);
        if let Some(wanted) = &wanted_id {
            if normalized == *wanted { return Some(device); }
            if fallback_contains.is_none() && (normalized.contains(wanted) || wanted.contains(&normalized)) { fallback_contains = Some(device.clone()); }
        }
        if let Some(wanted) = &wanted_label {
            if normalized == *wanted { return Some(device); }
            if fallback_contains.is_none() && (normalized.contains(wanted) || wanted.contains(&normalized)) { fallback_contains = Some(device.clone()); }
        }
    }
    fallback_contains
}


fn selected_output_device_exists(requested_id: &Option<String>, requested_label: &Option<String>) -> bool {
    if requested_id.as_ref().map(|v| v.trim().is_empty()).unwrap_or(true) && requested_label.as_ref().map(|v| v.trim().is_empty()).unwrap_or(true) { return true; }
    let host = cpal::default_host();
    host.output_devices().ok().and_then(|devices| select_device_by_label(devices, requested_id, requested_label)).is_some()
}

fn emit_native_voice_info(app: &AppHandle, message: impl Into<String>) {
    let _ = app.emit("mhlko://native-voice-info", message.into());
}

fn configure_output_selection(output_device_id: Option<String>, output_device_label: Option<String>) {
    if let Ok(mut guard) = output_device_selection().lock() {
        *guard = DeviceSelection { id: output_device_id.filter(|v| !v.trim().is_empty()), label: output_device_label.filter(|v| !v.trim().is_empty()) };
    }
    if let Ok(mut engine) = engine_slot().lock() {
        *engine = None;
    }
}

fn init_engine() -> Result<(), String> {
    let slot = engine_slot();
    let mut guard = slot.lock().map_err(|_| "Voice engine lock failed".to_string())?;
    if guard.is_some() {
        return Ok(());
    }

    let host = cpal::default_host();
    let selection = output_device_selection().lock().ok().map(|guard| guard.clone()).unwrap_or_default();
    let device = match host.output_devices().ok().and_then(|devices| select_device_by_label(devices, &selection.id, &selection.label)) {
        Some(device) => device,
        None => host.default_output_device().ok_or_else(|| "No default output audio device".to_string())?,
    };
    let supported = device
        .default_output_config()
        .map_err(|e| format!("Output config failed: {e}"))?;
    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let channels = config.channels as usize;
    let sample_rate = config.sample_rate.0;
    let peers: Arc<Mutex<HashMap<String, PeerPlayback>>> = Arc::new(Mutex::new(HashMap::new()));
    let callback_peers = peers.clone();
    let err_fn = |err| eprintln!("MHTalk native voice output error: {err}");

    let stream = match sample_format {
        cpal::SampleFormat::F32 => device
            .build_output_stream(
                &config,
                move |data: &mut [f32], _| write_output_f32(data, channels, &callback_peers, sample_rate),
                err_fn,
                None,
            )
            .map_err(|e| format!("Build f32 output stream failed: {e}"))?,
        cpal::SampleFormat::I16 => device
            .build_output_stream(
                &config,
                move |data: &mut [i16], _| write_output_i16(data, channels, &callback_peers, sample_rate),
                err_fn,
                None,
            )
            .map_err(|e| format!("Build i16 output stream failed: {e}"))?,
        cpal::SampleFormat::U16 => device
            .build_output_stream(
                &config,
                move |data: &mut [u16], _| write_output_u16(data, channels, &callback_peers, sample_rate),
                err_fn,
                None,
            )
            .map_err(|e| format!("Build u16 output stream failed: {e}"))?,
        other => return Err(format!("Unsupported output sample format: {other:?}")),
    };

    stream.play().map_err(|e| format!("Start output stream failed: {e}"))?;
    *guard = Some(NativeVoiceEngine { peers, _stream: NativeVoiceStream(stream), sample_rate, channels });
    Ok(())
}

fn adaptive_min_samples(peer: &PeerPlayback, output_rate: u32) -> usize {
    let profile = current_voice_profile();
    let mut ms = profile.min_buffer_ms;
    if peer.underruns >= 2 {
        ms = ms.max(profile.underrun_refill_ms);
    }
    ((output_rate as usize * ms) / 1_000).max(256)
}

fn next_peer_mono_sample(peer: &mut PeerPlayback, output_rate: u32) -> f32 {
    if peer.muted || peer.volume <= 0.0 {
        return 0.0;
    }

    if peer.samples.is_empty() {
        peer.started = false;
        peer.underruns = peer.underruns.saturating_add(1);
        return 0.0;
    }

    let refill_samples = adaptive_min_samples(peer, output_rate);
    if !peer.started {
        if peer.samples.len() < refill_samples {
            return 0.0;
        }
        peer.started = true;
    }

    let profile = current_voice_profile();
    let raw = peer.samples.pop_front().unwrap_or(0.0);
    let sample = if VOICE_ENHANCE_ENABLED.load(Ordering::SeqCst) {
        let enhanced = enhance_remote_voice_output(peer, raw, profile);
        enhanced * peer.volume * profile.output_gain
    } else {
        // Voice Enhance OFF keeps the original 0.5.4 native playback path: no AGC,
        // no clarity processing, no extra compression. The Native engine and echo isolation
        // stay exactly the same; only the optional output processing is bypassed.
        raw.clamp(-1.0, 1.0) * peer.volume * profile.output_gain
    };
    if VOICE_ENHANCE_ENABLED.load(Ordering::SeqCst) { speech_limit(sample) } else { soft_limit(sample) }
}


fn high_pass_voice(peer: &mut PeerPlayback, sample: f32) -> f32 {
    // Very light DC/rumble removal. This does not change the transport path; it only cleans
    // the native playback sample before mixing so voices sound less muddy.
    const R: f32 = 0.995;
    let out = sample - peer.dc_last_input + R * peer.dc_last_output;
    peer.dc_last_input = sample;
    peer.dc_last_output = out;
    out.clamp(-1.0, 1.0)
}

fn enhance_remote_voice_output(peer: &mut PeerPlayback, sample: f32, profile: VoiceSolutionProfile) -> f32 {
    let cleaned = high_pass_voice(peer, sample.clamp(-1.0, 1.0));
    let abs = cleaned.abs();

    // Smooth per-peer AGC: raises quiet members without touching the WebView/audio routing.
    // It is deliberately slow and capped so it cannot pump loudly or break the echo-safe native path.
    let tracking = if abs > profile.noise_gate * 1.5 { abs } else { 0.0 };
    peer.agc_level = (peer.agc_level * 0.996 + tracking * 0.004).clamp(0.0, 1.0);
    let level = peer.agc_level.max(0.012);
    let mut agc_gain = profile.output_agc_target / level;
    agc_gain = agc_gain.clamp(1.0, profile.output_max_boost);

    // Do not amplify near-silence/noise as aggressively.
    if abs < profile.noise_gate * 2.5 {
        agc_gain = agc_gain.min(1.15);
    }

    let boosted = cleaned * agc_gain * profile.clarity_strength;
    voice_compress(boosted)
}

fn voice_compress(value: f32) -> f32 {
    let sign = value.signum();
    let abs = value.abs();
    let compressed = if abs <= 0.58 {
        abs
    } else {
        0.58 + (abs - 0.58) * 0.34
    };
    speech_limit(sign * compressed)
}

fn speech_limit(value: f32) -> f32 {
    let v = value.clamp(-3.2, 3.2);
    (v / (1.0 + v.abs() * 0.34)).clamp(-0.985, 0.985)
}

fn mix_frame(peers: &mut HashMap<String, PeerPlayback>, output_rate: u32) -> f32 {
    let mut mixed = 0.0f32;
    let mut active = 0usize;
    for peer in peers.values_mut() {
        let value = next_peer_mono_sample(peer, output_rate);
        if value != 0.0 { active += 1; }
        mixed += value;
    }
    if active > 1 {
        mixed *= (1.0 / (active as f32).sqrt()).clamp(0.45, 1.0);
    }
    speech_limit(mixed)
}

// Realtime audio path: keep this callback allocation-light and avoid long locks to prevent glitches.
fn write_output_f32(data: &mut [f32], channels: usize, peers: &Arc<Mutex<HashMap<String, PeerPlayback>>>, output_rate: u32) {
    let ch = channels.max(1);
    if let Ok(mut peers) = peers.lock() {
        for frame in data.chunks_mut(ch) {
            let value = mix_frame(&mut peers, output_rate);
            for sample in frame.iter_mut() {
                *sample = value;
            }
        }
    } else {
        for sample in data.iter_mut() { *sample = 0.0; }
    }
}

fn write_output_i16(data: &mut [i16], channels: usize, peers: &Arc<Mutex<HashMap<String, PeerPlayback>>>, output_rate: u32) {
    let ch = channels.max(1);
    if let Ok(mut peers) = peers.lock() {
        for frame in data.chunks_mut(ch) {
            let value = mix_frame(&mut peers, output_rate);
            let converted = (value * i16::MAX as f32) as i16;
            for sample in frame.iter_mut() {
                *sample = converted;
            }
        }
    } else {
        for sample in data.iter_mut() { *sample = 0; }
    }
}

fn write_output_u16(data: &mut [u16], channels: usize, peers: &Arc<Mutex<HashMap<String, PeerPlayback>>>, output_rate: u32) {
    let ch = channels.max(1);
    if let Ok(mut peers) = peers.lock() {
        for frame in data.chunks_mut(ch) {
            let normalized = (mix_frame(&mut peers, output_rate) + 1.0) * 0.5;
            let converted = (normalized.clamp(0.0, 1.0) * u16::MAX as f32) as u16;
            for sample in frame.iter_mut() {
                *sample = converted;
            }
        }
    } else {
        for sample in data.iter_mut() { *sample = u16::MAX / 2; }
    }
}



#[tauri::command]
pub fn native_voice_engine_status() -> VoiceEngineStatus {
    let ready = init_engine().is_ok();
    let (sample_rate, channels) = engine_slot()
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|engine| (engine.sample_rate, engine.channels)))
        .unwrap_or((0, 0));

    let enhance_enabled = VOICE_ENHANCE_ENABLED.load(Ordering::SeqCst);

    VoiceEngineStatus {
        supported: cfg!(windows),
        ready,
        phase: format!("0.8.5-utility-audio-only-{}-enhance-{}", current_voice_profile().mode, if enhance_enabled { "on" } else { "off" }),
        process_name: "MHTalk WebRTC voice + native legacy utility engine".to_string(),
        note: if ready {
            format!("0.8.5: live call audio runs only in the isolated MHTalkVoice WebRTC sidecar. The Rust/cpal module remains for microphone tests, tones, and utility audio. Utility output: {sample_rate} Hz / {channels} ch. Voice Enhance is {}.", if enhance_enabled { "ON" } else { "OFF" })
        } else {
            "The optional native legacy/utility engine is not ready. Current-client WebRTC Opus calls remain available.".to_string()
        },
        voice_enhance_enabled: enhance_enabled,
    }
}

#[tauri::command]
pub fn native_voice_engine_planned_process_name() -> String {
    "MHTalkVoice.exe".to_string()
}

#[tauri::command]
pub fn native_voice_set_enhance_enabled(enabled: bool) -> bool {
    VOICE_ENHANCE_ENABLED.store(enabled, Ordering::SeqCst);

    // Clear only enhancer memory so toggling does not leave old AGC/DC state behind.
    // PCM queues and stream lifetime stay untouched.
    if let Ok(guard) = engine_slot().lock() {
        if let Some(engine) = guard.as_ref() {
            if let Ok(mut peers) = engine.peers.lock() {
                for peer in peers.values_mut() {
                    peer.dc_last_input = 0.0;
                    peer.dc_last_output = 0.0;
                    peer.agc_level = 0.05;
                    peer.last_sequence = None;
                }
            }
        }
    }

    VOICE_ENHANCE_ENABLED.load(Ordering::SeqCst)
}

#[tauri::command]
pub fn native_voice_enhance_enabled() -> bool {
    VOICE_ENHANCE_ENABLED.load(Ordering::SeqCst)
}


#[tauri::command]
pub fn native_voice_current_solution() -> NativeVoiceSolutionStatus {
    solution_status(current_voice_profile())
}

#[tauri::command]
pub fn native_voice_apply_solution(solution: u8) -> Result<NativeVoiceSolutionStatus, String> {
    let profile = voice_profile_for(solution);
    VOICE_SOLUTION.store(profile.id, Ordering::SeqCst);

    // Flush old queued PCM so a bad/fast buffer from the previous mode does not keep playing.
    if let Ok(guard) = engine_slot().lock() {
        if let Some(engine) = guard.as_ref() {
            if let Ok(mut peers) = engine.peers.lock() {
                for peer in peers.values_mut() {
                    peer.samples.clear();
                    peer.started = false;
                    peer.underruns = 0;
                    peer.dc_last_input = 0.0;
                    peer.dc_last_output = 0.0;
                    peer.agc_level = 0.05;
                    peer.last_sequence = None;
                }
            }
        }
    }

    Ok(solution_status(profile))
}

fn soft_limit(value: f32) -> f32 {
    let v = value.clamp(-3.0, 3.0);
    // Smooth speech limiter: louder than linear, but avoids digital clipping.
    (v / (1.0 + v.abs() * 0.42)).clamp(-0.98, 0.98)
}

fn process_input_sample(sample: f32, profile: VoiceSolutionProfile) -> f32 {
    let amplified = sample.clamp(-1.0, 1.0) * profile.input_gain;
    if amplified.abs() < profile.noise_gate { return 0.0; }
    soft_limit(amplified)
}

fn mono_from_f32(data: &[f32], channels: usize, profile: VoiceSolutionProfile) -> Vec<f32> {
    downmix_to_mono_profile(data.iter().copied(), channels, profile)
}

fn mono_from_i16(data: &[i16], channels: usize, profile: VoiceSolutionProfile) -> Vec<f32> {
    downmix_to_mono_profile(data.iter().map(|v| (*v as f32 / i16::MAX as f32).clamp(-1.0, 1.0)), channels, profile)
}

fn mono_from_u16(data: &[u16], channels: usize, profile: VoiceSolutionProfile) -> Vec<f32> {
    downmix_to_mono_profile(data.iter().map(|v| ((*v as f32 / u16::MAX as f32) * 2.0 - 1.0).clamp(-1.0, 1.0)), channels, profile)
}

fn downmix_to_mono_profile(samples: impl IntoIterator<Item = f32>, channels: usize, profile: VoiceSolutionProfile) -> Vec<f32> {
    let ch = channels.max(1);
    let values: Vec<f32> = samples.into_iter().map(|s| s.clamp(-1.0, 1.0)).collect();
    if values.is_empty() { return Vec::new(); }
    let frame_count = values.len() / ch;
    let mut mono = Vec::with_capacity(frame_count.max(1));
    for frame in 0..frame_count {
        let mut sum = 0.0f32;
        for channel in 0..ch {
            sum += values[frame * ch + channel];
        }
        mono.push(process_input_sample(sum / ch as f32, profile));
    }
    mono
}

#[tauri::command]
pub fn native_voice_set_peer_volume(peer_id: String, volume: f32, muted: bool) -> Result<(), String> {
    init_engine()?;
    let slot = engine_slot();
    let guard = slot.lock().map_err(|_| "Voice engine lock failed".to_string())?;
    let Some(engine) = guard.as_ref() else { return Err("Voice engine not ready".to_string()); };
    let mut peers = engine.peers.lock().map_err(|_| "Voice peer lock failed".to_string())?;
    let entry = peers.entry(peer_id).or_insert_with(|| PeerPlayback { channels: 1, volume: 1.0, muted: false, samples: VecDeque::new(), started: false, underruns: 0, dc_last_input: 0.0, dc_last_output: 0.0, agc_level: 0.05, last_sequence: None });
    entry.volume = volume.clamp(0.0, 2.0);
    entry.muted = muted;
    Ok(())
}


fn sanitize_voice_sample(value: f32) -> f32 {
    let profile = current_voice_profile();
    let v = value.clamp(-1.0, 1.0);
    if v.abs() < profile.noise_gate { return 0.0; }
    soft_limit(v)
}

fn downmix_to_mono(samples: impl IntoIterator<Item = f32>, channels: usize) -> Vec<f32> {
    let ch = channels.max(1);
    let values: Vec<f32> = samples.into_iter().map(|s| s.clamp(-1.0, 1.0)).collect();
    if values.is_empty() { return Vec::new(); }
    let frame_count = values.len() / ch;
    let mut mono = Vec::with_capacity(frame_count.max(1));
    for frame in 0..frame_count {
        let mut sum = 0.0f32;
        for channel in 0..ch {
            sum += values[frame * ch + channel];
        }
        mono.push(sanitize_voice_sample(sum / ch as f32));
    }
    mono
}

fn resample_mono_linear(mono: &[f32], input_rate: u32, output_rate: u32) -> Vec<f32> {
    if mono.is_empty() { return Vec::new(); }
    if input_rate == 0 || output_rate == 0 || input_rate == output_rate {
        return mono.to_vec();
    }
    if mono.len() == 1 { return mono.to_vec(); }
    let ratio = input_rate as f64 / output_rate as f64;
    let out_len = ((mono.len() as f64) * (output_rate as f64 / input_rate as f64)).ceil().max(1.0) as usize;
    let mut out = Vec::with_capacity(out_len);
    for out_idx in 0..out_len {
        let src_pos = out_idx as f64 * ratio;
        let left = src_pos.floor() as usize;
        let right = (left + 1).min(mono.len() - 1);
        let frac = (src_pos - left as f64) as f32;
        let sample = mono[left] * (1.0 - frac) + mono[right] * frac;
        out.push(sanitize_voice_sample(sample));
    }
    out
}

fn prepare_voice_samples_for_output(samples: impl IntoIterator<Item = f32>, input_rate: u32, input_channels: usize, output_rate: u32) -> Vec<f32> {
    let mono = downmix_to_mono(samples, input_channels.max(1));
    resample_mono_linear(&mono, input_rate, output_rate)
}

fn push_pcm_samples(peer_id: &str, sample_rate: u32, channels: u16, sequence: Option<u64>, samples: impl IntoIterator<Item = f32>) -> Result<(), String> {
    init_engine()?;

    let incoming_channels = usize::from(channels.max(1).min(8));
    let (output_rate, peers_arc) = {
        let slot = engine_slot();
        let guard = slot.lock().map_err(|_| "Voice engine lock failed".to_string())?;
        let Some(engine) = guard.as_ref() else { return Err("Voice engine not ready".to_string()); };
        (engine.sample_rate, engine.peers.clone())
    };

    // 0.5.6: call audio is fed from Native Voice DataChannel frames.
    // Resample/downmix outside the playback lock so the output callback is not blocked by CPU work.
    let prepared = prepare_voice_samples_for_output(samples, sample_rate, incoming_channels, output_rate);
    if prepared.is_empty() { return Ok(()); }

    let mut peers = peers_arc.lock().map_err(|_| "Voice peer lock failed".to_string())?;
    let playback_channels = 1usize;
    let entry = peers.entry(peer_id.to_string()).or_insert_with(|| PeerPlayback { channels: playback_channels, volume: 1.0, muted: false, samples: VecDeque::new(), started: false, underruns: 0, dc_last_input: 0.0, dc_last_output: 0.0, agc_level: 0.05, last_sequence: None });
    entry.channels = playback_channels;

    if let Some(seq) = sequence {
        if let Some(last) = entry.last_sequence {
            if seq <= last {
                if last.saturating_sub(seq) < 1_000 {
                    // Low-latency unordered voice can deliver an older packet after a newer one.
                    // Drop it instead of playing speech out of order and adding delay.
                    return Ok(());
                }
                // A very large backward jump means the mic capture was restarted.
                entry.samples.clear();
            }
        }
        entry.last_sequence = Some(seq);
    }

    let profile = current_voice_profile();
    let max_samples = ((output_rate as usize * profile.max_buffer_ms) / 1_000).max(2048);
    let target_samples = ((output_rate as usize * profile.target_buffer_ms) / 1_000).max(1024);
    for sample in prepared {
        entry.samples.push_back(sample);
    }
    if entry.samples.len() > max_samples {
        // Keep voice live. If the network/data channel ever builds a backlog, drop old audio
        // down to the target jitter buffer instead of letting delay grow to seconds.
        while entry.samples.len() > target_samples {
            entry.samples.pop_front();
        }
        entry.started = false;
    }
    Ok(())
}


fn rms_level_from_f32(samples: &[f32]) -> f32 {
    if samples.is_empty() { return 0.0; }
    let sum = samples.iter().map(|v| v.clamp(-1.0, 1.0).powi(2)).sum::<f32>();
    (sum / samples.len() as f32).sqrt().clamp(0.0, 1.0)
}

fn emit_mic_test_level(app: &AppHandle, sequence: &Arc<Mutex<u64>>, samples: &[f32]) {
    let should_emit = if let Ok(mut guard) = sequence.lock() {
        *guard = (*guard).wrapping_add(1);
        *guard % 5 == 0
    } else { false };
    if should_emit {
        let _ = app.emit("mhlko://native-voice-mic-test-level", rms_level_from_f32(samples));
    }
}

#[tauri::command]
pub fn native_voice_start_mic_test(app: AppHandle, input_device_id: Option<String>, output_device_id: Option<String>, input_device_label: Option<String>, output_device_label: Option<String>) -> Result<(), String> {
    let _ = native_voice_stop_mic_test();
    if !selected_output_device_exists(&output_device_id, &output_device_label) {
        emit_native_voice_info(&app, "Voice output device fallback: selected mic-test speaker was not found, using default output device.");
    }
    configure_output_selection(output_device_id, output_device_label);
    init_engine()?;
    native_voice_set_peer_volume("__mic_test__".to_string(), 0.35, false)?;

    let host = cpal::default_host();
    let device = match host.input_devices().ok().and_then(|devices| select_device_by_label(devices, &input_device_id, &input_device_label)) {
        Some(device) => device,
        None => {
            emit_native_voice_info(&app, "Voice device fallback: selected mic-test microphone was not found, using default input device.");
            host.default_input_device().ok_or_else(|| "No default input audio device".to_string())?
        }
    };
    let supported = device.default_input_config().map_err(|e| format!("Input config failed: {e}"))?;
    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let sample_rate = config.sample_rate.0;
    let channels = config.channels;
    let stop = Arc::new(AtomicBool::new(false));
    let sequence = Arc::new(Mutex::new(0_u64));
    let err_app = app.clone();
    let err_fn = move |err| {
        let _ = err_app.emit("mhlko://native-voice-mic-test-error", format!("native mic test error: {err}"));
    };

    let stream = match sample_format {
        cpal::SampleFormat::F32 => {
            let cb_app = app.clone();
            let cb_stop = stop.clone();
            let cb_sequence = sequence.clone();
            device.build_input_stream(&config, move |data: &[f32], _| {
                if cb_stop.load(Ordering::SeqCst) { return; }
                let profile = current_voice_profile();
                let samples = mono_from_f32(data, channels as usize, profile);
                emit_mic_test_level(&cb_app, &cb_sequence, &samples);
                let _ = push_pcm_samples("__mic_test__", sample_rate, 1, None, samples);
            }, err_fn, None).map_err(|e| format!("Build f32 mic-test input stream failed: {e}"))?
        }
        cpal::SampleFormat::I16 => {
            let cb_app = app.clone();
            let cb_stop = stop.clone();
            let cb_sequence = sequence.clone();
            device.build_input_stream(&config, move |data: &[i16], _| {
                if cb_stop.load(Ordering::SeqCst) { return; }
                let profile = current_voice_profile();
                let samples = mono_from_i16(data, channels as usize, profile);
                emit_mic_test_level(&cb_app, &cb_sequence, &samples);
                let _ = push_pcm_samples("__mic_test__", sample_rate, 1, None, samples);
            }, err_fn, None).map_err(|e| format!("Build i16 mic-test input stream failed: {e}"))?
        }
        cpal::SampleFormat::U16 => {
            let cb_app = app.clone();
            let cb_stop = stop.clone();
            let cb_sequence = sequence.clone();
            device.build_input_stream(&config, move |data: &[u16], _| {
                if cb_stop.load(Ordering::SeqCst) { return; }
                let profile = current_voice_profile();
                let samples = mono_from_u16(data, channels as usize, profile);
                emit_mic_test_level(&cb_app, &cb_sequence, &samples);
                let _ = push_pcm_samples("__mic_test__", sample_rate, 1, None, samples);
            }, err_fn, None).map_err(|e| format!("Build u16 mic-test input stream failed: {e}"))?
        }
        other => return Err(format!("Unsupported input sample format: {other:?}")),
    };

    stream.play().map_err(|e| format!("Start mic test stream failed: {e}"))?;
    let mut guard = mic_test_slot().lock().map_err(|_| "Native voice mic-test lock failed".to_string())?;
    *guard = Some(NativeVoiceMicTestState { stop, _stream: NativeVoiceStream(stream) });
    Ok(())
}

#[tauri::command]
pub fn native_voice_stop_mic_test() -> Result<(), String> {
    if let Ok(mut guard) = mic_test_slot().lock() {
        if let Some(state) = guard.take() { state.stop.store(true, Ordering::SeqCst); }
    }
    let _ = native_voice_stop_peer("__mic_test__".to_string());
    Ok(())
}

#[tauri::command]
pub fn native_voice_play_tone(kind: String) -> Result<(), String> {
    init_engine()?;
    let (sample_rate, channels) = engine_slot()
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|engine| (engine.sample_rate, engine.channels)))
        .unwrap_or((48_000, 2));
    let primary = match kind.as_str() {
        "screen-on" => 780.0,
        "screen-off" => 380.0,
        "join" => 660.0,
        "leave" => 330.0,
        _ => 520.0,
    };
    let secondary = match kind.as_str() {
        "join" => 880.0,
        "leave" => 260.0,
        _ => primary,
    };
    let frames = (sample_rate as f32 * 0.34) as usize;
    let channels_u16 = channels.max(1).min(2) as u16;
    let mut samples = Vec::with_capacity(frames * usize::from(channels_u16));
    for frame in 0..frames {
        let t = frame as f32 / sample_rate as f32;
        let envelope = if t < 0.025 { (t / 0.025).clamp(0.0, 1.0) } else { ((0.34 - t) / 0.315).clamp(0.0, 1.0) };
        let amp = if kind == "join" || kind == "leave" { 0.32 } else { 0.14 };
        let value = ((t * primary * std::f32::consts::TAU).sin() * 0.65 + (t * secondary * std::f32::consts::TAU).sin() * 0.35) * amp * envelope;
        for _ in 0..channels_u16 { samples.push(value); }
    }
    native_voice_set_peer_volume("__ui_tone__".to_string(), 1.0, false)?;
    push_pcm_samples("__ui_tone__", sample_rate, channels_u16, None, samples)
}

#[tauri::command]
pub fn native_voice_stop_peer(peer_id: String) -> Result<(), String> {
    let slot = engine_slot();
    let guard = slot.lock().map_err(|_| "Voice engine lock failed".to_string())?;
    if let Some(engine) = guard.as_ref() {
        let mut peers = engine.peers.lock().map_err(|_| "Voice peer lock failed".to_string())?;
        peers.remove(&peer_id);
    }
    Ok(())
}
