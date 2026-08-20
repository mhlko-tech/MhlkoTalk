use tauri::Manager;

#[cfg(target_os = "windows")]
fn copy_missing_tree(source: &std::path::Path, destination: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(source) else {
        return;
    };
    std::fs::create_dir_all(destination).ok();
    for entry in entries.flatten() {
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if source_path.is_dir() {
            copy_missing_tree(&source_path, &destination_path);
        } else if !destination_path.exists() {
            std::fs::copy(source_path, destination_path).ok();
        }
    }
}

#[cfg(target_os = "windows")]
fn migrate_previous_windows_identity() {
    for variable in ["LOCALAPPDATA", "APPDATA"] {
        let Some(base) = std::env::var_os(variable).map(std::path::PathBuf::from) else {
            continue;
        };
        let destination = base.join("com.mhlko.talk");
        for source_name in ["com.mhlko.talk.desktop", "com.mhlko.talk.remake"] {
            let source = base.join(source_name);
            if source.exists() {
                copy_missing_tree(&source, &destination);
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn migrate_previous_windows_identity() {}

#[tauri::command]
fn save_attachment(default_name: String, bytes: Vec<u8>) -> Result<bool, String> {
    let Some(path) = rfd::FileDialog::new()
        .set_file_name(&default_name)
        .save_file()
    else {
        return Ok(false);
    };
    std::fs::write(path, bytes)
        .map(|_| true)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn apply_window_icon(app: tauri::AppHandle, label: String) -> Result<(), String> {
    let icon = app
        .default_window_icon()
        .ok_or_else(|| "MHTalk window icon is unavailable".to_string())?
        .clone();
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("Window '{label}' was not found"))?;
    window.set_icon(icon).map_err(|error| error.to_string())
}

#[tauri::command]
fn read_dropped_file(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|error| error.to_string())
}

#[tauri::command]
fn open_report_bug() -> Result<(), String> {
    std::process::Command::new("explorer.exe")
        .arg("https://www.instagram.com/m.ed1t/")
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    migrate_previous_windows_identity();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            native_recorder::warm_up(app.handle().clone());
            if let (Some(window), Some(icon)) =
                (app.get_webview_window("main"), app.default_window_icon())
            {
                window.set_icon(icon.clone())?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            save_attachment,
            read_dropped_file,
            open_report_bug,
            apply_window_icon,
            native_recorder::recorder_capabilities,
            native_recorder::start_native_recording,
            native_recorder::switch_native_recording_source,
            native_recorder::append_native_recording_audio,
            native_recorder::native_recording_status,
            native_recorder::native_recording_processing_status,
            native_recorder::stop_native_recording,
            native_recorder::open_native_recordings_folder,
        ])
        .build(tauri::generate_context!())
        .expect("error while building MHTalk");
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            native_recorder::shutdown(handle);
        }
    });
}
mod native_recorder;
