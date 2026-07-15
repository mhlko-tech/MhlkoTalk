use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

const SIDECAR_NAME: &str = "MHTalkVoice";
const EVENT_NAME: &str = "mhtalk://voice-companion-event";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCompanionBootstrap {
    pub room_id: String,
    pub signaling_url: String,
    pub parent_peer_id: String,
    pub voice_token: String,
    pub display_name: String,
    #[serde(default)]
    pub ice_servers: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCompanionCommand {
    #[serde(rename = "type")]
    pub command_type: String,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCompanionStatus {
    pub running: bool,
    pub ready: bool,
    pub process_id: u32,
    pub generation: u64,
    pub restart_count: u8,
    pub mode: &'static str,
    pub supported: bool,
    pub phase: &'static str,
    pub process_name: &'static str,
    pub note: &'static str,
    pub last_error: Option<String>,
}

#[derive(Debug)]
enum WriterCommand {
    Line(String),
    Stop,
}

#[derive(Default)]
struct VoiceCompanionRuntime {
    writer: Option<mpsc::Sender<WriterCommand>>,
    process_id: u32,
    generation: u64,
    restart_count: u8,
    running: bool,
    ready: bool,
    stopping: bool,
    last_error: Option<String>,
}

static RUNTIME: OnceLock<Mutex<VoiceCompanionRuntime>> = OnceLock::new();

fn runtime() -> &'static Mutex<VoiceCompanionRuntime> {
    RUNTIME.get_or_init(|| Mutex::new(VoiceCompanionRuntime::default()))
}

fn emit(app: &AppHandle, payload: Value) {
    let _ = app.emit(EVENT_NAME, payload);
}

fn write_json_line(sender: &mpsc::Sender<WriterCommand>, value: &Value) -> Result<(), String> {
    let mut line = serde_json::to_string(value).map_err(|e| format!("voice command encode failed: {e}"))?;
    line.push('\n');
    sender.send(WriterCommand::Line(line)).map_err(|_| "MHTalkVoice command channel is closed".to_string())
}

pub fn capture_exclusion_pid() -> u32 {
    runtime().lock().ok().and_then(|state| {
        if state.running && state.ready && state.process_id > 0 { Some(state.process_id) } else { None }
    }).unwrap_or(0)
}

#[tauri::command]
pub fn voice_companion_status() -> VoiceCompanionStatus {
    let state = runtime().lock().ok();
    VoiceCompanionStatus {
        running: state.as_ref().map(|s| s.running).unwrap_or(false),
        ready: state.as_ref().map(|s| s.ready).unwrap_or(false),
        process_id: state.as_ref().map(|s| s.process_id).unwrap_or(0),
        generation: state.as_ref().map(|s| s.generation).unwrap_or(0),
        restart_count: state.as_ref().map(|s| s.restart_count).unwrap_or(0),
        mode: "dedicated-webview2-sidecar",
        supported: true,
        phase: if state.as_ref().map(|s| s.ready).unwrap_or(false) { "ready" } else if state.as_ref().map(|s| s.running).unwrap_or(false) { "starting" } else { "stopped" },
        process_name: "MHTalkVoice.exe",
        note: "Dedicated WebRTC voice engine isolated from system broadcast audio.",
        last_error: state.and_then(|s| s.last_error.clone()),
    }
}

#[tauri::command]
pub async fn start_voice_companion(app: AppHandle, config: VoiceCompanionBootstrap) -> Result<VoiceCompanionStatus, String> {
    validate_bootstrap(&config)?;

    let existing_writer = runtime().lock().ok().and_then(|state| {
        if state.running { state.writer.clone() } else { None }
    });
    if let Some(writer) = existing_writer {
        write_json_line(&writer, &json!({ "type": "BOOTSTRAP", "payload": config }))?;
        return Ok(voice_companion_status());
    }

    let sidecar = app.shell().sidecar(SIDECAR_NAME)
        .map_err(|e| format!("could not prepare MHTalkVoice sidecar: {e}"))?;
    let (mut events, mut child) = sidecar.spawn()
        .map_err(|e| format!("could not start MHTalkVoice sidecar: {e}"))?;
    let process_id = child.pid();
    let (writer_tx, writer_rx) = mpsc::channel::<WriterCommand>();

    let generation = {
        let mut state = runtime().lock().map_err(|_| "voice companion state lock failed".to_string())?;
        state.generation = state.generation.wrapping_add(1).max(1);
        state.writer = Some(writer_tx.clone());
        state.process_id = process_id;
        state.running = true;
        state.ready = false;
        state.stopping = false;
        state.last_error = None;
        state.generation
    };

    std::thread::Builder::new()
        .name("mhtalk-voice-sidecar-writer".to_string())
        .spawn(move || {
            while let Ok(command) = writer_rx.recv() {
                match command {
                    WriterCommand::Line(line) => {
                        if child.write(line.as_bytes()).is_err() { break; }
                    }
                    WriterCommand::Stop => {
                        let _ = child.write(b"{\"type\":\"SHUTDOWN\",\"payload\":{}}\n");
                        std::thread::sleep(Duration::from_millis(250));
                        let _ = child.kill();
                        break;
                    }
                }
            }
        })
        .map_err(|e| format!("could not start MHTalkVoice writer: {e}"))?;

    let event_app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Shell stdout events are byte chunks, not guaranteed to align with JSON lines.
        // Keep an accumulator so split/combined messages are decoded exactly once.
        let mut stdout_buffer: Vec<u8> = Vec::new();
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    stdout_buffer.extend_from_slice(&bytes);
                    while let Some(newline) = stdout_buffer.iter().position(|byte| *byte == b'\n') {
                        let line: Vec<u8> = stdout_buffer.drain(..=newline).collect();
                        let raw = String::from_utf8_lossy(&line[..line.len().saturating_sub(1)]).trim().to_string();
                        if raw.is_empty() { continue; }
                        match serde_json::from_str::<Value>(&raw) {
                            Ok(payload) => {
                                let event_type = payload.get("type").and_then(Value::as_str).unwrap_or("");
                                if event_type == "VOICE_READY" {
                                    if let Ok(mut state) = runtime().lock() {
                                        if state.generation == generation {
                                            state.ready = true;
                                            state.last_error = None;
                                        }
                                    }
                                }
                                if event_type == "VOICE_DISCONNECTED" {
                                    if let Ok(mut state) = runtime().lock() {
                                        if state.generation == generation { state.ready = false; }
                                    }
                                    crate::native_audio::stop_for_voice_engine_change();
                                }
                                if event_type == "VOICE_ERROR" {
                                    if let Ok(mut state) = runtime().lock() {
                                        if state.generation == generation {
                                            state.last_error = payload.get("message").and_then(Value::as_str).map(str::to_string);
                                        }
                                    }
                                }
                                emit(&event_app, payload);
                            }
                            Err(_) => emit(&event_app, json!({ "type": "VOICE_LOG", "message": raw })),
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    let message = String::from_utf8_lossy(&bytes).trim().to_string();
                    if !message.is_empty() {
                        if let Ok(mut state) = runtime().lock() {
                            if state.generation == generation { state.last_error = Some(message.clone()); }
                        }
                        emit(&event_app, json!({ "type": "VOICE_ERROR", "message": message, "source": "sidecar-stderr" }));
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let expected = runtime().lock().ok().map(|state| state.stopping || state.generation != generation).unwrap_or(true);
                    if let Ok(mut state) = runtime().lock() {
                        if state.generation == generation {
                            state.writer = None;
                            state.running = false;
                            state.ready = false;
                            state.process_id = 0;
                            state.stopping = false;
                            if !expected { state.restart_count = state.restart_count.saturating_add(1); }
                        }
                    }
                    crate::native_audio::stop_for_voice_engine_change();
                    emit(&event_app, json!({
                        "type": "ENGINE_EXITED",
                        "expected": expected,
                        "code": payload.code,
                        "signal": payload.signal,
                        "generation": generation
                    }));
                    break;
                }
                CommandEvent::Error(message) => {
                    if let Ok(mut state) = runtime().lock() {
                        if state.generation == generation { state.last_error = Some(message.clone()); }
                    }
                    emit(&event_app, json!({ "type": "VOICE_ERROR", "message": message, "source": "sidecar-process" }));
                }
                _ => {}
            }
        }
    });

    write_json_line(&writer_tx, &json!({ "type": "BOOTSTRAP", "payload": config }))?;
    emit(&app, json!({ "type": "ENGINE_STARTED", "processId": process_id, "generation": generation }));
    Ok(voice_companion_status())
}

#[tauri::command]
pub fn send_voice_companion_command(command: VoiceCompanionCommand) -> Result<(), String> {
    let state = runtime().lock().map_err(|_| "voice companion state lock failed".to_string())?;
    let writer = state.writer.as_ref().ok_or_else(|| "MHTalkVoice is not running".to_string())?;
    write_json_line(writer, &json!({ "type": command.command_type, "payload": command.payload }))
}

#[tauri::command]
pub fn stop_voice_companion() -> Result<(), String> {
    let sender = {
        let mut state = runtime().lock().map_err(|_| "voice companion state lock failed".to_string())?;
        state.stopping = true;
        state.ready = false;
        state.writer.clone()
    };
    if let Some(writer) = sender {
        writer.send(WriterCommand::Stop).map_err(|_| "MHTalkVoice stop channel is closed".to_string())?;
    }
    Ok(())
}

fn validate_bootstrap(config: &VoiceCompanionBootstrap) -> Result<(), String> {
    if config.room_id.trim().is_empty() { return Err("voice room id is missing".to_string()); }
    if config.parent_peer_id.trim().is_empty() { return Err("voice parent peer id is missing".to_string()); }
    if config.voice_token.len() < 24 { return Err("voice companion token is invalid".to_string()); }
    if !(config.signaling_url.starts_with("wss://") || config.signaling_url.starts_with("ws://127.0.0.1") || config.signaling_url.starts_with("ws://localhost")) {
        return Err("voice signaling URL must use WSS".to_string());
    }
    Ok(())
}
