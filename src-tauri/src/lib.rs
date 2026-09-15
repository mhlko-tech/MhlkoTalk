use tauri::Manager;

const AUTH_VAULT_SERVICE: &str = "MHTalk";
const SERVICE_BASE_URL: &str = "https://mhtalk-token-service.mhlkotalk.workers.dev";
const CONNECTION_TOKEN_ENDPOINT: &str =
    "https://mhtalk-token-service.mhlkotalk.workers.dev/livekit/token";
const MEMBERSHIP_BACKEND_URL: &str = "https://mvdownloader-lava-staging.mhlkotalk.workers.dev";
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

// Account and presence requests use the same fixed native transport as room
// token acquisition. Only explicitly approved MHTalk paths are accepted, so
// renderer content cannot turn this into an arbitrary HTTP proxy.
fn service_api_path_allowed(path: &str) -> bool {
    let lowercase = path.to_ascii_lowercase();
    (path.starts_with("/social/") || path == "/presence/ticket" || path == "/auth/onboarding")
        && !path.starts_with("//")
        && !path.contains("..")
        && !lowercase.contains("%2e")
        && !path.contains('#')
        && !path
            .chars()
            .any(|value| matches!(value, '\r' | '\n' | '\\'))
        && path.len() <= 4096
}

#[tauri::command]
async fn fetch_service_api(
    path: String,
    method: String,
    body: Option<String>,
    access_token: String,
) -> Result<ConnectionServiceResponse, String> {
    if !service_api_path_allowed(&path) {
        return Err("The requested MHTalk service path is not allowed".to_string());
    }
    let method = method.to_ascii_uppercase();
    if !matches!(method.as_str(), "GET" | "POST" | "PATCH" | "DELETE") {
        return Err("The requested MHTalk service method is not allowed".to_string());
    }
    if access_token.is_empty() || access_token.len() > 16_384 {
        return Err("The stored account session is invalid".to_string());
    }
    if body.as_ref().is_some_and(|value| value.len() > 262_144) {
        return Err("The MHTalk service request is too large".to_string());
    }

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|_| "Could not initialize the native MHTalk service".to_string())?;
    let request_method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| "The requested MHTalk service method is invalid".to_string())?;
    let mut request = client
        .request(request_method, format!("{SERVICE_BASE_URL}{path}"))
        .bearer_auth(access_token)
        .header(reqwest::header::CONTENT_TYPE, "application/json");
    if let Some(body) = body {
        request = request.body(body);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "The MHTalk service could not be reached".to_string())?;
    let status = response.status().as_u16();
    if response
        .content_length()
        .is_some_and(|length| length > 2_097_152)
    {
        return Err("The MHTalk service returned an invalid response".to_string());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "The MHTalk service response was interrupted".to_string())?;
    if bytes.len() > 2_097_152 {
        return Err("The MHTalk service returned an invalid response".to_string());
    }
    Ok(ConnectionServiceResponse {
        status,
        body: String::from_utf8(bytes.to_vec())
            .map_err(|_| "The MHTalk service returned invalid text".to_string())?,
    })
}

fn auth_secret_get_sync(key: String) -> Result<Option<String>, String> {
    let Some(value) = auth_raw_get(&key)? else {
        return Ok(None);
    };
    let Some(manifest) = parse_auth_chunk_manifest(&value) else {
        return Ok(Some(value));
    };
    let mut secret = String::new();
    for index in 0..manifest.count {
        let chunk_key = auth_chunk_key(&key, &manifest.generation, index);
        let Some(chunk) = auth_raw_get(&chunk_key)? else {
            // A previous process may have stopped halfway through deletion.
            // The incomplete value cannot be restored, so remove its public
            // manifest first and clean up any remaining private chunks.
            auth_raw_delete(&key).ok();
            delete_auth_chunks(&key, &manifest);
            return Ok(None);
        };
        secret.push_str(&chunk);
    }
    Ok(Some(secret))
}

#[tauri::command]
async fn auth_secret_get(key: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || auth_secret_get_sync(key))
        .await
        .map_err(|error| format!("Secure session storage task failed: {error}"))?
}

#[tauri::command]
async fn auth_secret_set(key: String, value: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || auth_secret_set_sync(key, value))
        .await
        .map_err(|error| format!("Secure session storage task failed: {error}"))?
}

fn auth_secret_set_sync(key: String, value: String) -> Result<(), String> {
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
async fn auth_secret_delete(key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || auth_secret_delete_sync(key))
        .await
        .map_err(|error| format!("Secure session storage task failed: {error}"))?
}

fn auth_secret_delete_sync(key: String) -> Result<(), String> {
    let manifest = auth_raw_get(&key)?
        .as_deref()
        .and_then(parse_auth_chunk_manifest);
    // Remove the public manifest before its chunks. If Windows rejects the
    // root deletion, the complete session remains readable and can be
    // retried. Once the root is gone, leftover chunks are unreachable.
    auth_raw_delete(&key)?;
    if let Some(manifest) = manifest {
        delete_auth_chunks(&key, &manifest);
    }
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PatreonLinkResult {
    status: String,
    plan: String,
    provider: String,
}

#[tauri::command]
async fn link_patreon_desktop(
    app: tauri::AppHandle,
    options: patreon_connection::Options,
) -> Result<PatreonLinkResult, String> {
    patreon_connection::with_private_connection(app, options, false)
        .await?
        .ok_or_else(|| "Patreon linking was cancelled".into())
}

#[tauri::command]
async fn open_patreon_plans(
    app: tauri::AppHandle,
    options: patreon_connection::Options,
) -> Result<(), String> {
    patreon_connection::with_private_connection(app, options, true)
        .await
        .map(|_| ())
}

async fn create_patreon_authorization(
    client: &reqwest::Client,
) -> Result<(url::Url, String, String), String> {
    let device_key = "mhtalk.membership.device-id".to_string();
    let device_id = match auth_secret_get_sync(device_key.clone())? {
        Some(value) if !value.is_empty() => value,
        _ => {
            let value = format!(
                "mhtalk-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|error| error.to_string())?
                    .as_nanos()
            );
            auth_secret_set_sync(device_key, value.clone())?;
            value
        }
    };
    let created = client
        .post(format!(
            "{MEMBERSHIP_BACKEND_URL}/v1/patreon/desktop-link-sessions"
        ))
        .json(&serde_json::json!({ "appId": "mhtalk", "deviceId": device_id }))
        .send()
        .await
        .map_err(|_| "The Patreon membership service could not be reached".to_string())?;
    if !created.status().is_success() {
        return Err("Patreon linking is temporarily unavailable".to_string());
    }
    let created: serde_json::Value = created
        .json()
        .await
        .map_err(|_| "Patreon returned an invalid link".to_string())?;
    let authorization_url = created
        .get("authorizationUrl")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Patreon returned an invalid link".to_string())?
        .to_string();
    let desktop_token = created
        .get("desktopToken")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Patreon returned an invalid session".to_string())?
        .to_string();

    let url =
        url::Url::parse(&authorization_url).map_err(|_| "Invalid Patreon authorization URL")?;
    let state = url
        .query_pairs()
        .find(|(k, _)| k == "state")
        .map(|(_, v)| v.into_owned())
        .ok_or("Missing Patreon state")?;
    let redirect = url
        .query_pairs()
        .find(|(k, _)| k == "redirect_uri")
        .map(|(_, v)| v.into_owned())
        .ok_or("Missing Patreon redirect")?;
    if url.scheme() != "https"
        || url.host_str() != Some("www.patreon.com")
        || url.path() != "/oauth2/authorize"
        || redirect != "http://127.0.0.1:8766/patreon/callback"
        || state.is_empty()
    {
        return Err("Unexpected Patreon authorization configuration".into());
    }
    Ok((url, desktop_token, state))
}

async fn complete_patreon_authorization(
    client: &reqwest::Client,
    desktop_token: String,
    code: String,
    state: String,
) -> Result<PatreonLinkResult, String> {
    let completed = client
        .post(format!(
            "{MEMBERSHIP_BACKEND_URL}/v1/patreon/desktop-link/complete"
        ))
        .bearer_auth(&desktop_token)
        .json(&serde_json::json!({ "code": code, "state": state }))
        .send()
        .await
        .map_err(|_| "Could not complete Patreon linking".to_string())?;
    if !completed.status().is_success() {
        let status = completed.status().as_u16();
        let error = completed
            .json::<serde_json::Value>()
            .await
            .unwrap_or_default();
        return Err(
            patreon_completion_error(status, error.get("error").and_then(|v| v.as_str())).into(),
        );
    }
    let payload: serde_json::Value = completed
        .json()
        .await
        .map_err(|_| "Patreon returned an invalid membership".to_string())?;
    let membership = payload
        .get("membership")
        .ok_or_else(|| "Patreon returned an invalid membership".to_string())?;
    auth_secret_set_sync("mhtalk.membership.token".to_string(), desktop_token)?;
    Ok(PatreonLinkResult {
        status: membership
            .get("status")
            .and_then(|value| value.as_str())
            .unwrap_or("active")
            .to_string(),
        plan: membership
            .get("plan")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string(),
        provider: "patreon".to_string(),
    })
}

fn patreon_completion_error(status: u16, code: Option<&str>) -> &'static str {
    match (status, code) {
        (403, Some("no_eligible_membership")) => "No eligible Patreon tier was found for this account. Check that you signed in to the account with your paid or gifted membership.",
        (_, Some("invalid_or_expired_link" | "link_already_used")) => "Your Patreon link expired or was already used. Please start again.",
        (401 | 410, _) => "Your Patreon link expired. Please start again.",
        (429, _) => "Patreon is busy. Please wait before trying again.",
        _ => "The membership service could not confirm your Patreon link. Please try again.",
    }
}

#[cfg(test)]
mod auth_storage_tests {
    use super::*;

    #[test]
    fn patreon_errors_distinguish_entitlement_from_transport_failures() {
        assert!(
            patreon_completion_error(403, Some("no_eligible_membership"))
                .contains("paid or gifted")
        );
        assert!(
            !patreon_completion_error(503, Some("patreon_request_failed")).contains("No eligible")
        );
        assert!(patreon_completion_error(400, Some("invalid_or_expired_link")).contains("expired"));
        assert!(patreon_completion_error(409, Some("link_already_used")).contains("already used"));
    }

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

    #[test]
    fn native_service_proxy_accepts_only_mhtalk_social_paths() {
        assert!(service_api_path_allowed("/social/friends"));
        assert!(service_api_path_allowed("/social/search?q=test"));
        assert!(service_api_path_allowed("/presence/ticket"));
        assert!(service_api_path_allowed("/auth/onboarding"));
        assert!(!service_api_path_allowed("https://example.com"));
        assert!(!service_api_path_allowed("//example.com/social/friends"));
        assert!(!service_api_path_allowed("/social/../service/capabilities"));
        assert!(!service_api_path_allowed(
            "/social/%2e%2e/service/capabilities"
        ));
        assert!(!service_api_path_allowed("/social/friends#ignored"));
        assert!(!service_api_path_allowed("/livekit/token"));
        assert!(!service_api_path_allowed(
            "/social/friends\r\nmalicious: true"
        ));
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
            auth_secret_set_sync(key.clone(), value.clone())?;
            let stored = auth_secret_get_sync(key.clone())?
                .ok_or_else(|| "stored test session is missing".to_string())?;
            if stored != value {
                return Err("stored test session did not round-trip".to_string());
            }
            Ok(())
        })();
        auth_secret_delete_sync(key).ok();
        result.expect("large secure session round-trip");
    }

    #[test]
    #[ignore = "requires the Windows Credential Manager"]
    fn incomplete_chunked_session_self_heals_to_signed_out() {
        let key = format!("mhtalk.auth-storage-incomplete-test.{}", std::process::id());
        let value = format!(
            "{{\"access_token\":\"{}\",\"refresh_token\":\"{}\"}}",
            "token".repeat(500),
            "refresh".repeat(500)
        );
        auth_secret_set_sync(key.clone(), value).expect("store chunked test session");
        let manifest = auth_raw_get(&key)
            .expect("read test manifest")
            .as_deref()
            .and_then(parse_auth_chunk_manifest)
            .expect("test value should be chunked");
        auth_raw_delete(&auth_chunk_key(&key, &manifest.generation, 0))
            .expect("remove one test chunk");

        assert_eq!(
            auth_secret_get_sync(key.clone()).expect("self-heal incomplete session"),
            None
        );
        assert_eq!(auth_raw_get(&key).expect("read healed root"), None);
        auth_secret_delete_sync(key).ok();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    initialize_tls();
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
        .manage(patreon_connection::PatreonConnectionState::default())
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
            fetch_service_api,
            apply_window_icon,
            switch_input_language,
            auth_secret_get,
            auth_secret_set,
            auth_secret_delete,
            link_patreon_desktop,
            open_patreon_plans,
            patreon_connection::cancel_patreon_connection,
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

mod patreon_connection;
fn initialize_tls() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}
