use tauri::Manager;

const AUTH_VAULT_SERVICE: &str = "MHTalk";
const CONNECTION_TOKEN_ENDPOINT: &str =
    "https://mhtalk-token-service.mhlkotalk.workers.dev/livekit/token";
const AUTH_CHUNK_MANIFEST_PREFIX: &str = "mhtalk-chunks:v1:";
// Windows Credential Manager allows a maximum 2560-byte credential blob.
// keyring stores passwords as UTF-16, so stay comfortably below that limit.
const AUTH_CHUNK_UTF16_LIMIT: usize = 1000;

#[derive(Clone)]
struct AuthChunkManifest {
    generation: String,
    count: usize,
}

fn auth_entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(AUTH_VAULT_SERVICE, key).map_err(|error| error.to_string())
}

fn auth_raw_get(key: &str) -> Result<Option<String>, String> {
    match auth_entry(key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn auth_raw_delete(key: &str) -> Result<(), String> {
    match auth_entry(key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn auth_chunk_key(key: &str, generation: &str, index: usize) -> String {
    format!("{key}--mhtalk-chunk--{generation}--{index}")
}

fn parse_auth_chunk_manifest(value: &str) -> Option<AuthChunkManifest> {
    let remainder = value.strip_prefix(AUTH_CHUNK_MANIFEST_PREFIX)?;
    let (generation, count) = remainder.rsplit_once(':')?;
    let count = count.parse::<usize>().ok()?;
    if generation.is_empty()
        || generation.len() > 64
        || !generation
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || value == '-')
        || !(1..=128).contains(&count)
    {
        return None;
    }
    Some(AuthChunkManifest {
        generation: generation.to_string(),
        count,
    })
}

fn split_auth_secret(value: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut current_utf16 = 0;
    for character in value.chars() {
        let character_utf16 = character.len_utf16();
        if current_utf16 + character_utf16 > AUTH_CHUNK_UTF16_LIMIT && !current.is_empty() {
            chunks.push(std::mem::take(&mut current));
            current_utf16 = 0;
        }
        current.push(character);
        current_utf16 += character_utf16;
    }
    if !current.is_empty() || chunks.is_empty() {
        chunks.push(current);
    }
    chunks
}

fn delete_auth_chunks(key: &str, manifest: &AuthChunkManifest) {
    for index in 0..manifest.count {
        auth_raw_delete(&auth_chunk_key(key, &manifest.generation, index)).ok();
    }
}

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

#[cfg(target_os = "windows")]
#[tauri::command]
fn switch_input_language(window: tauri::WebviewWindow) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        PostMessageW, INPUTLANGCHANGE_FORWARD, WM_INPUTLANGCHANGEREQUEST,
    };

    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let posted = unsafe {
        PostMessageW(
            hwnd.0 as *mut _,
            WM_INPUTLANGCHANGEREQUEST,
            INPUTLANGCHANGE_FORWARD as usize,
            1,
        )
    };
    if posted == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn switch_input_language() -> Result<(), String> {
    Ok(())
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionServiceResponse {
    status: u16,
    body: String,
}

// Token acquisition uses native networking so a broken WebView2 cache,
// extension, or per-WebView network policy cannot prevent room connections.
// The destination is fixed to MHTalk's service to avoid exposing a generic
// native HTTP proxy to renderer content.
#[tauri::command]
async fn fetch_connection_token(
    request_body: serde_json::Value,
    access_token: Option<String>,
) -> Result<ConnectionServiceResponse, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|_| "Could not initialize the native connection service".to_string())?;
    let mut request = client.post(CONNECTION_TOKEN_ENDPOINT).json(&request_body);
    if let Some(token) = access_token.filter(|value| !value.is_empty()) {
        if token.len() > 16_384 {
            return Err("The stored account session is invalid".to_string());
        }
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "The native connection service could not be reached".to_string())?;
    let status = response.status().as_u16();
    if response
        .content_length()
        .is_some_and(|length| length > 131_072)
    {
        return Err("The connection service returned an invalid response".to_string());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "The connection service response was interrupted".to_string())?;
    if bytes.len() > 131_072 {
        return Err("The connection service returned an invalid response".to_string());
    }
    Ok(ConnectionServiceResponse {
        status,
        body: String::from_utf8(bytes.to_vec())
            .map_err(|_| "The connection service returned invalid text".to_string())?,
    })
}

#[tauri::command]
fn auth_secret_get(key: String) -> Result<Option<String>, String> {
    let Some(value) = auth_raw_get(&key)? else {
        return Ok(None);
    };
    let Some(manifest) = parse_auth_chunk_manifest(&value) else {
        return Ok(Some(value));
    };
    let mut secret = String::new();
    for index in 0..manifest.count {
        let chunk_key = auth_chunk_key(&key, &manifest.generation, index);
        let chunk = auth_raw_get(&chunk_key)?.ok_or_else(|| {
            "Secure session storage is incomplete. Please sign in again.".to_string()
        })?;
        secret.push_str(&chunk);
    }
    Ok(Some(secret))
}

#[tauri::command]
fn auth_secret_set(key: String, value: String) -> Result<(), String> {
    let previous_manifest = auth_raw_get(&key)?
        .as_deref()
        .and_then(parse_auth_chunk_manifest);
    let chunks = split_auth_secret(&value);
    if chunks.len() == 1 {
        auth_entry(&key)?
            .set_password(&value)
            .map_err(|error| error.to_string())?;
    } else {
        let generation = format!(
            "{:x}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|error| error.to_string())?
                .as_nanos(),
            std::process::id(),
        );
        let manifest = AuthChunkManifest {
            generation,
            count: chunks.len(),
        };
        for (index, chunk) in chunks.iter().enumerate() {
            if let Err(error) = auth_entry(&auth_chunk_key(&key, &manifest.generation, index))
                .and_then(|entry| entry.set_password(chunk).map_err(|error| error.to_string()))
            {
                delete_auth_chunks(&key, &manifest);
                return Err(error);
            }
        }
        let manifest_value = format!(
            "{}{}:{}",
            AUTH_CHUNK_MANIFEST_PREFIX, manifest.generation, manifest.count
        );
        if let Err(error) = auth_entry(&key)?
            .set_password(&manifest_value)
            .map_err(|error| error.to_string())
        {
            delete_auth_chunks(&key, &manifest);
            return Err(error);
        }
    }
    if let Some(previous) = previous_manifest {
        delete_auth_chunks(&key, &previous);
    }
    Ok(())
}

#[tauri::command]
fn auth_secret_delete(key: String) -> Result<(), String> {
    let manifest = auth_raw_get(&key)?
        .as_deref()
        .and_then(parse_auth_chunk_manifest);
    if let Some(manifest) = manifest {
        delete_auth_chunks(&key, &manifest);
    }
    auth_raw_delete(&key)
}

#[cfg(test)]
mod auth_storage_tests {
    use super::*;

    #[test]
    fn chunks_large_unicode_sessions_below_the_windows_limit() {
        let value = format!("{}{}", "a".repeat(2200), "𐍈".repeat(250));
        let chunks = split_auth_secret(&value);
        assert!(chunks.len() >= 3);
        assert_eq!(chunks.concat(), value);
        assert!(chunks
            .iter()
            .all(|chunk| chunk.encode_utf16().count() <= AUTH_CHUNK_UTF16_LIMIT));
    }

    #[test]
    fn parses_only_valid_chunk_manifests() {
        let value = format!("{}abc-123:4", AUTH_CHUNK_MANIFEST_PREFIX);
        let manifest = parse_auth_chunk_manifest(&value).expect("valid manifest");
        assert_eq!(manifest.generation, "abc-123");
        assert_eq!(manifest.count, 4);
        assert!(parse_auth_chunk_manifest("mhtalk-chunks:v1:bad/path:2").is_none());
        assert!(parse_auth_chunk_manifest("mhtalk-chunks:v1:abc:0").is_none());
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "requires the Windows Credential Manager"]
    fn round_trips_a_large_session_through_windows_credentials() {
        let key = format!("mhtalk-auth-storage-test-{}", std::process::id());
        let value = format!(
            "{{\"access_token\":\"{}\",\"name\":\"{}\"}}",
            "x".repeat(6000),
            "محمد".repeat(200)
        );
        let result = (|| -> Result<(), String> {
            auth_secret_set(key.clone(), value.clone())?;
            let stored = auth_secret_get(key.clone())?
                .ok_or_else(|| "stored test session is missing".to_string())?;
            if stored != value {
                return Err("stored test session did not round-trip".to_string());
            }
            Ok(())
        })();
        auth_secret_delete(key).ok();
        result.expect("large secure session round-trip");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    migrate_previous_windows_identity();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                window.unminimize().ok();
                window.show().ok();
                window.set_focus().ok();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
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
            fetch_connection_token,
            apply_window_icon,
            switch_input_language,
            auth_secret_get,
            auth_secret_set,
            auth_secret_delete,
            native_recorder::recorder_capabilities,
            native_recorder::start_native_recording,
            native_recorder::switch_native_recording_source,
            native_recorder::update_native_recording_mix,
            native_recorder::native_recording_audio_status,
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
mod recording_audio;
