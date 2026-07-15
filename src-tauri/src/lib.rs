mod native_audio;
mod screen_recorder;
mod voice_engine;
mod voice_companion;

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct FileReceiveInfo {
    transfer_id: String,
    file_name: String,
    temp_path: String,
    final_path: String,
    expected_size: u64,
    written: u64,
    next_chunk_index: u32,
    mime_type: String,
    room_id: String,
}

static FILE_RECEIVES: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, FileReceiveInfo>>> = std::sync::OnceLock::new();

const MAX_ATTACHMENT_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_INLINE_DATA_BYTES: usize = 20 * 1024 * 1024;
const MAX_FILE_CHUNK_BYTES: usize = 64 * 1024;
const MAX_ACTIVE_FILE_RECEIVES: usize = 64;

fn file_receive_map() -> &'static std::sync::Mutex<std::collections::HashMap<String, FileReceiveInfo>> {
    FILE_RECEIVES.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn safe_name(input: &str) -> String {
    let mut out = String::with_capacity(input.len().min(120));
    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | ' ' | '(' | ')') { out.push(ch); }
        else { out.push('_'); }
    }
    let trimmed = out.trim().trim_matches('.').to_string();
    if trimmed.is_empty() { "mhtalk-file".to_string() } else { trimmed.chars().take(160).collect() }
}

/// Sanitize an untrusted attachment name without allowing path components, while
/// reserving room for and preserving the original extension. Windows reserved
/// trailing dots/spaces are removed and an empty/invalid name gets a safe fallback.
fn safe_file_name(input: &str) -> String {
    let leaf = std::path::Path::new(input)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(input);
    let original = std::path::Path::new(leaf);
    let extension = original
        .extension()
        .and_then(|value| value.to_str())
        .map(safe_name)
        .unwrap_or_default();
    let stem = original
        .file_stem()
        .and_then(|value| value.to_str())
        .map(safe_name)
        .unwrap_or_else(|| "mhtalk-file".to_string());

    let extension_suffix = if extension.is_empty() {
        String::new()
    } else {
        format!(".{}", extension.chars().take(24).collect::<String>())
    };
    let maximum_stem = 160usize.saturating_sub(extension_suffix.chars().count()).max(1);
    let safe_stem: String = stem
        .trim()
        .trim_matches('.')
        .chars()
        .take(maximum_stem)
        .collect();
    let mut safe_stem = if safe_stem.is_empty() { "mhtalk-file".to_string() } else { safe_stem };
    let reserved = safe_stem.trim_end_matches(['.', ' ']).to_ascii_uppercase();
    if matches!(reserved.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "COM1" | "COM2" | "COM3" | "COM4" | "COM5" | "COM6" | "COM7" | "COM8" | "COM9" | "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5" | "LPT6" | "LPT7" | "LPT8" | "LPT9") {
        safe_stem.insert(0, '_');
    }
    format!("{safe_stem}{extension_suffix}")
}

fn safe_room_id(input: &str) -> String { safe_name(input).replace(' ', "_") }

fn unique_desktop_path(app: &tauri::AppHandle, file_name: &str) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let desktop = app.path().desktop_dir().map_err(|e| format!("desktop directory unavailable: {e}"))?;
    let safe_file = safe_file_name(file_name);
    let candidate = desktop.join(&safe_file);
    if !candidate.exists() { return Ok(candidate); }
    let path = std::path::Path::new(&safe_file);
    let stem = path.file_stem().and_then(|v| v.to_str()).unwrap_or("mhtalk-file");
    let ext = path.extension().and_then(|v| v.to_str()).unwrap_or("");
    for index in 1..1000 {
        let name = if ext.is_empty() { format!("{stem} ({index})") } else { format!("{stem} ({index}).{ext}") };
        let next = desktop.join(name);
        if !next.exists() { return Ok(next); }
    }
    Err("could not create unique desktop file name".to_string())
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FileSaveProgress {
    operation_id: String,
    written: u64,
    total: u64,
    target_path: String,
}

fn attachments_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data directory unavailable: {e}"))?
        .join("attachments");
    std::fs::create_dir_all(&root)
        .map_err(|e| format!("could not create attachment directory: {e}"))?;
    root.canonicalize()
        .map_err(|e| format!("could not validate attachment directory: {e}"))
}

fn validated_received_file(app: &tauri::AppHandle, path: &str) -> Result<std::path::PathBuf, String> {
    let source = std::path::PathBuf::from(path);
    let canonical = source
        .canonicalize()
        .map_err(|e| format!("attachment file is unavailable: {e}"))?;
    let root = attachments_root(app)?;
    if !canonical.starts_with(&root) || !canonical.is_file() {
        return Err("attachment path is outside MHTalk storage".to_string());
    }
    Ok(canonical)
}

fn normalized_save_target(target_path: &str, original_name: &str) -> Result<std::path::PathBuf, String> {
    let mut target = std::path::PathBuf::from(target_path);
    if !target.is_absolute() {
        return Err("save destination must be an absolute path".to_string());
    }
    if target.file_name().is_none() {
        return Err("save destination does not contain a file name".to_string());
    }
    if target.extension().is_none() {
        if let Some(extension) = std::path::Path::new(original_name).extension() {
            target.set_extension(extension);
        }
    }
    let parent = target
        .parent()
        .ok_or_else(|| "save destination directory is unavailable".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("could not create save destination: {e}"))?;
    let parent_canonical = parent
        .canonicalize()
        .map_err(|e| format!("could not validate save destination: {e}"))?;
    let file_name = target
        .file_name()
        .ok_or_else(|| "save destination file name is unavailable".to_string())?;
    Ok(parent_canonical.join(file_name))
}

fn atomic_copy_with_progress(
    app: &tauri::AppHandle,
    operation_id: &str,
    source: &std::path::Path,
    target: &std::path::Path,
    overwrite: bool,
) -> Result<String, String> {
    use std::io::{Read, Write};
    use tauri::Emitter;

    if target.exists() && !overwrite {
        return Err("a file with the same name already exists".to_string());
    }
    let total = std::fs::metadata(source)
        .map_err(|e| format!("could not read attachment metadata: {e}"))?
        .len();
    let partial = target.with_extension(format!(
        "{}.mhtalk-part",
        target.extension().and_then(|value| value.to_str()).unwrap_or("file")
    ));
    let _ = std::fs::remove_file(&partial);

    let mut input = std::fs::File::open(source)
        .map_err(|e| format!("could not open attachment: {e}"))?;
    let mut output = std::fs::File::create(&partial)
        .map_err(|e| format!("could not create destination file: {e}"))?;
    let mut buffer = vec![0_u8; 256 * 1024];
    let mut written = 0_u64;
    loop {
        let count = input
            .read(&mut buffer)
            .map_err(|e| format!("could not read attachment: {e}"))?;
        if count == 0 {
            break;
        }
        output
            .write_all(&buffer[..count])
            .map_err(|e| format!("could not write destination file: {e}"))?;
        written = written.saturating_add(count as u64);
        let _ = app.emit(
            "mhlko://file-save-progress",
            FileSaveProgress {
                operation_id: operation_id.to_string(),
                written,
                total,
                target_path: target.to_string_lossy().to_string(),
            },
        );
    }
    output
        .flush()
        .map_err(|e| format!("could not flush destination file: {e}"))?;
    output
        .sync_all()
        .map_err(|e| format!("could not sync destination file: {e}"))?;
    drop(output);

    if target.exists() {
        std::fs::remove_file(target)
            .map_err(|e| format!("could not replace existing destination: {e}"))?;
    }
    std::fs::rename(&partial, target)
        .map_err(|e| format!("could not publish destination file: {e}"))?;
    Ok(target.to_string_lossy().to_string())
}

fn decode_data_url(data_url: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let comma = data_url
        .find(',')
        .ok_or_else(|| "invalid data url".to_string())?;
    let meta = &data_url[..comma];
    if !meta.starts_with("data:") || !meta.contains(";base64") {
        return Err("unsupported data url".to_string());
    }
    let encoded = &data_url[comma + 1..];
    let maximum_encoded = MAX_INLINE_DATA_BYTES.div_ceil(3) * 4 + 4;
    if encoded.len() > maximum_encoded {
        return Err("inline file exceeds the safe size limit".to_string());
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| format!("could not decode file: {e}"))?;
    if decoded.len() > MAX_INLINE_DATA_BYTES {
        return Err("inline file exceeds the safe size limit".to_string());
    }
    Ok(decoded)
}

fn atomic_write_bytes(
    app: &tauri::AppHandle,
    operation_id: &str,
    target: &std::path::Path,
    bytes: &[u8],
    overwrite: bool,
) -> Result<String, String> {
    use std::io::Write;
    use tauri::Emitter;

    if target.exists() && !overwrite {
        return Err("a file with the same name already exists".to_string());
    }
    let partial = target.with_extension(format!(
        "{}.mhtalk-part",
        target.extension().and_then(|value| value.to_str()).unwrap_or("file")
    ));
    let _ = std::fs::remove_file(&partial);
    let mut output = std::fs::File::create(&partial)
        .map_err(|e| format!("could not create destination file: {e}"))?;
    let total = bytes.len() as u64;
    let mut written = 0_u64;
    for chunk in bytes.chunks(256 * 1024) {
        output
            .write_all(chunk)
            .map_err(|e| format!("could not write destination file: {e}"))?;
        written = written.saturating_add(chunk.len() as u64);
        let _ = app.emit(
            "mhlko://file-save-progress",
            FileSaveProgress {
                operation_id: operation_id.to_string(),
                written,
                total,
                target_path: target.to_string_lossy().to_string(),
            },
        );
    }
    output
        .flush()
        .map_err(|e| format!("could not flush destination file: {e}"))?;
    output
        .sync_all()
        .map_err(|e| format!("could not sync destination file: {e}"))?;
    drop(output);
    if target.exists() {
        std::fs::remove_file(target)
            .map_err(|e| format!("could not replace existing destination: {e}"))?;
    }
    std::fs::rename(&partial, target)
        .map_err(|e| format!("could not publish destination file: {e}"))?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
fn save_data_url_to_desktop(
    app: tauri::AppHandle,
    file_name: String,
    data_url: String,
    operation_id: Option<String>,
) -> Result<String, String> {
    let bytes = decode_data_url(&data_url)?;
    let path = unique_desktop_path(&app, &file_name)?;
    atomic_write_bytes(
        &app,
        operation_id.as_deref().unwrap_or("desktop-data"),
        &path,
        &bytes,
        false,
    )
}

#[tauri::command]
fn copy_file_to_desktop(
    app: tauri::AppHandle,
    path: String,
    file_name: String,
    operation_id: Option<String>,
) -> Result<String, String> {
    let source = validated_received_file(&app, &path)?;
    let target = unique_desktop_path(&app, &file_name)?;
    atomic_copy_with_progress(
        &app,
        operation_id.as_deref().unwrap_or("desktop-copy"),
        &source,
        &target,
        false,
    )
}

#[tauri::command]
fn save_received_file_as(
    app: tauri::AppHandle,
    source_path: String,
    target_path: String,
    original_name: String,
    operation_id: String,
    overwrite: bool,
) -> Result<String, String> {
    let source = validated_received_file(&app, &source_path)?;
    let target = normalized_save_target(&target_path, &original_name)?;
    atomic_copy_with_progress(&app, &operation_id, &source, &target, overwrite)
}

#[tauri::command]
fn save_data_url_as(
    app: tauri::AppHandle,
    data_url: String,
    target_path: String,
    original_name: String,
    operation_id: String,
    overwrite: bool,
) -> Result<String, String> {
    let bytes = decode_data_url(&data_url)?;
    let target = normalized_save_target(&target_path, &original_name)?;
    atomic_write_bytes(&app, &operation_id, &target, &bytes, overwrite)
}


#[tauri::command]
fn begin_file_receive(app: tauri::AppHandle, transfer_id: String, file_name: String, size: u64, mime_type: String, room_id: String) -> Result<String, String> {
    use std::fs;
    use tauri::Manager;
    if transfer_id.is_empty() || transfer_id.len() > 96 || !transfer_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')) {
        return Err("invalid transfer id".to_string());
    }
    if size > MAX_ATTACHMENT_BYTES { return Err("attachment exceeds the 1GB limit".to_string()); }
    if file_name.is_empty() || file_name.len() > 1024 || mime_type.len() > 160 || room_id.len() > 128 {
        return Err("invalid attachment metadata".to_string());
    }
    let mut map = file_receive_map().lock().map_err(|_| "file receive map lock failed".to_string())?;
    if map.len() >= MAX_ACTIVE_FILE_RECEIVES { return Err("too many active file receives".to_string()); }
    if map.contains_key(&transfer_id) { return Err("duplicate file transfer".to_string()); }
    let safe_file = safe_file_name(&file_name);
    let safe_room = safe_room_id(&room_id);
    let base = app.path().app_data_dir().map_err(|e| format!("app data directory unavailable: {e}"))?
        .join("attachments").join(safe_room).join(safe_name(&transfer_id));
    fs::create_dir_all(&base).map_err(|e| format!("could not create attachment directory: {e}"))?;
    let temp_path = base.join(format!("{safe_file}.part"));
    let final_path = base.join(&safe_file);
    let _ = fs::remove_file(&temp_path);
    if final_path.exists() { return Err("attachment transfer id was already finalized".to_string()); }
    fs::File::create(&temp_path).map_err(|e| format!("could not create temporary attachment: {e}"))?;
    let info = FileReceiveInfo {
        transfer_id: transfer_id.clone(), file_name: safe_file, temp_path: temp_path.to_string_lossy().to_string(),
        final_path: final_path.to_string_lossy().to_string(), expected_size: size, written: 0, next_chunk_index: 0, mime_type, room_id
    };
    map.insert(transfer_id, info.clone());
    Ok(info.temp_path)
}

#[tauri::command]
fn append_file_chunk(request: tauri::ipc::Request) -> Result<u64, String> {
    use std::io::Write;
    let transfer_id = request
        .headers()
        .get("x-mhtalk-transfer-id")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "missing file transfer header".to_string())?;
    let chunk_index = request
        .headers()
        .get("x-mhtalk-chunk-index")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u32>().ok())
        .ok_or_else(|| "invalid file chunk index".to_string())?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("file chunk must use a raw binary body".to_string());
    };
    if bytes.is_empty() { return Ok(0); }
    if bytes.len() > MAX_FILE_CHUNK_BYTES { return Err("file chunk exceeds the safe size limit".to_string()); }

    let mut map = file_receive_map().lock().map_err(|_| "file receive map lock failed".to_string())?;
    let info = map.get_mut(transfer_id).ok_or_else(|| "unknown file transfer".to_string())?;
    if chunk_index != info.next_chunk_index { return Err("file chunk arrived out of order".to_string()); }
    let next_written = info.written.checked_add(bytes.len() as u64).ok_or_else(|| "attachment size overflow".to_string())?;
    if next_written > info.expected_size { return Err("received attachment exceeds declared size".to_string()); }
    let mut file = std::fs::OpenOptions::new().append(true).open(&info.temp_path).map_err(|e| format!("could not open temporary attachment: {e}"))?;
    file.write_all(bytes).map_err(|e| format!("could not write attachment chunk: {e}"))?;
    info.written = next_written;
    info.next_chunk_index = info.next_chunk_index.checked_add(1).ok_or_else(|| "file chunk index overflow".to_string())?;
    Ok(info.written)
}

#[tauri::command]
fn complete_file_receive(transfer_id: String) -> Result<String, String> {
    use std::fs;
    let mut map = file_receive_map().lock().map_err(|_| "file receive map lock failed".to_string())?;
    let info = map.remove(&transfer_id).ok_or_else(|| "unknown file transfer".to_string())?;
    let metadata = fs::metadata(&info.temp_path).map_err(|e| format!("received attachment is missing: {e}"))?;
    if metadata.len() != info.expected_size {
        let _ = fs::remove_file(&info.temp_path);
        return Err(format!("received attachment size mismatch: got {}, expected {}", metadata.len(), info.expected_size));
    }
    fs::rename(&info.temp_path, &info.final_path).map_err(|e| format!("could not finalize attachment: {e}"))?;
    Ok(info.final_path)
}

#[tauri::command]
fn cancel_file_receive(transfer_id: String) -> Result<(), String> {
    let mut map = file_receive_map().lock().map_err(|_| "file receive map lock failed".to_string())?;
    if let Some(info) = map.remove(&transfer_id) {
        let _ = std::fs::remove_file(info.temp_path);
    }
    Ok(())
}

#[tauri::command]
fn open_received_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let safe_path = validated_received_file(&app, &path)?;
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg(&safe_path)
            .spawn()
            .map_err(|e| format!("could not open attachment: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&safe_path)
            .spawn()
            .map_err(|e| format!("could not open attachment: {e}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&safe_path)
            .spawn()
            .map_err(|e| format!("could not open attachment: {e}"))?;
    }
    Ok(())
}


#[tauri::command]
fn save_text_file_with_dialog(default_name: String, contents: String) -> Result<Option<String>, String> {
    use std::io::Write;
    use std::process::Command;

    let script = r#"
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$dialog = New-Object System.Windows.Forms.SaveFileDialog
$dialog.Title = 'Save MHTalk log'
$dialog.Filter = 'Text files (*.txt)|*.txt|All files (*.*)|*.*'
$dialog.FileName = $env:MHLKO_LOG_DEFAULT_NAME
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.FileName
}
"#;

    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script])
        .env("MHLKO_LOG_DEFAULT_NAME", default_name)
        .output()
        .map_err(|e| format!("Could not open save dialog: {e}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        return Ok(None);
    }

    let mut file = std::fs::File::create(&path).map_err(|e| format!("Could not create log file: {e}"))?;
    file.write_all(contents.as_bytes()).map_err(|e| format!("Could not write log file: {e}"))?;
    Ok(Some(path))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            native_audio::native_audio_exclusion_status,
            native_audio::start_native_system_audio_excluding_self,
            native_audio::stop_native_system_audio_excluding_self,
            native_audio::start_native_recording_system_audio,
            native_audio::stop_native_recording_system_audio,
            native_audio::start_native_recording_members_audio,
            native_audio::stop_native_recording_members_audio,
            voice_companion::voice_companion_status,
            voice_companion::start_voice_companion,
            voice_companion::send_voice_companion_command,
            voice_companion::stop_voice_companion,
            screen_recorder::begin_screen_recording,
            screen_recorder::append_screen_recording_chunk,
            screen_recorder::finish_screen_recording,
            screen_recorder::preserve_screen_recording,
            screen_recorder::cancel_screen_recording,
            screen_recorder::list_recoverable_screen_recordings,
            screen_recorder::finalize_recovered_screen_recording,
            screen_recorder::prepare_screen_recorder_dependencies,
            screen_recorder::screen_recorder_dependency_status,
            screen_recorder::open_screen_recordings_folder,
            voice_engine::native_voice_engine_status,
            voice_engine::native_voice_engine_planned_process_name,
            voice_engine::native_voice_current_solution,
            voice_engine::native_voice_apply_solution,
            voice_engine::native_voice_set_enhance_enabled,
            voice_engine::native_voice_enhance_enabled,
            voice_engine::native_voice_start_mic_test,
            voice_engine::native_voice_stop_mic_test,
            voice_engine::native_voice_play_tone,
            save_text_file_with_dialog,
            save_data_url_to_desktop,
            copy_file_to_desktop,
            save_received_file_as,
            save_data_url_as,
            begin_file_receive,
            append_file_chunk,
            complete_file_receive,
            cancel_file_receive,
            open_received_file
        ])
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            screen_recorder::warm_up_dependencies(app.handle().clone());
            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
            use tauri::{Emitter, Manager};

            let show = MenuItem::with_id(app, "show", "Show MHTalk", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            let mut tray_builder = TrayIconBuilder::new()
                .tooltip("MHTalk")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.emit("mhlko://tray-quit-requested", ());
                        } else {
                            app.exit(0);
                        }
                    },
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        if let Some(app) = tray.app_handle().get_webview_window("main") {
                            let _ = app.show();
                            let _ = app.set_focus();
                        }
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            } else {
                eprintln!("MHTalk tray icon fallback: default window icon was unavailable.");
            }
            tray_builder.build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running MHTalk");
}
