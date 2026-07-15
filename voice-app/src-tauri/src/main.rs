#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::Value;
use std::io::{BufRead, Write};
use std::sync::{atomic::{AtomicBool, Ordering}, Mutex, OnceLock};
use tauri::{Emitter, LogicalSize, Manager, Size};

static PENDING: OnceLock<Mutex<Vec<Value>>> = OnceLock::new();
static STDOUT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static FRONTEND_READY: AtomicBool = AtomicBool::new(false);

fn pending() -> &'static Mutex<Vec<Value>> { PENDING.get_or_init(|| Mutex::new(Vec::new())) }

#[tauri::command]
fn voice_mark_ready_and_take_pending() -> Vec<Value> {
    // The listener is installed before this command is invoked. From this point onward,
    // commands are emitted live instead of being queued, preventing duplicate dispatch.
    FRONTEND_READY.store(true, Ordering::Release);
    pending().lock().map(|mut queue| std::mem::take(&mut *queue)).unwrap_or_default()
}

#[tauri::command]
fn voice_notify_main(payload: Value) -> Result<(), String> {
    let _guard = STDOUT_LOCK.get_or_init(|| Mutex::new(())).lock().map_err(|_| "stdout lock failed".to_string())?;
    let mut out = std::io::stdout().lock();
    serde_json::to_writer(&mut out, &payload).map_err(|e| format!("event encode failed: {e}"))?;
    out.write_all(b"\n").map_err(|e| format!("event write failed: {e}"))?;
    out.flush().map_err(|e| format!("event flush failed: {e}"))
}


#[tauri::command]
fn voice_show_interaction_window(app: tauri::AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("voice").ok_or_else(|| "voice window is unavailable".to_string())?;
    window.set_size(Size::Logical(LogicalSize::new(430.0, 300.0))).map_err(|e| e.to_string())?;
    let _ = window.center();
    let _ = window.set_skip_taskbar(true);
    window.show().map_err(|e| e.to_string())?;
    let _ = window.set_focus();
    Ok(())
}

#[tauri::command]
fn voice_hide_interaction_window(app: tauri::AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("voice").ok_or_else(|| "voice window is unavailable".to_string())?;
    window.hide().map_err(|e| e.to_string())?;
    let _ = window.set_size(Size::Logical(LogicalSize::new(1.0, 1.0)));
    Ok(())
}

#[tauri::command]
fn voice_process_id() -> u32 { std::process::id() }

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::Builder::new().name("mhtalk-voice-stdin".to_string()).spawn(move || {
                let stdin = std::io::stdin();
                for line in stdin.lock().lines() {
                    let Ok(line) = line else { break; };
                    let trimmed = line.trim();
                    if trimmed.is_empty() { continue; }
                    let Ok(value) = serde_json::from_str::<Value>(trimmed) else { continue; };
                    if FRONTEND_READY.load(Ordering::Acquire) {
                        let _ = handle.emit("mhtalk://voice-command", value.clone());
                    } else if let Ok(mut queue) = pending().lock() {
                        queue.push(value.clone());
                    }
                    if value.get("type").and_then(Value::as_str) == Some("SHUTDOWN") {
                        std::thread::sleep(std::time::Duration::from_millis(80));
                        handle.exit(0);
                        return;
                    }
                }
                let _ = handle.emit("mhtalk://voice-command", serde_json::json!({"type":"SHUTDOWN","payload":{}}));
                std::thread::sleep(std::time::Duration::from_millis(80));
                handle.exit(0);
            })?;
            if let Some(window) = app.get_webview_window("voice") {
                let _ = window.set_skip_taskbar(true);
                let _ = window.hide();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![voice_mark_ready_and_take_pending, voice_notify_main, voice_process_id, voice_show_interaction_window, voice_hide_interaction_window])
        .run(tauri::generate_context!())
        .expect("error while running MHTalkVoice");
}
