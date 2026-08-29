use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};

static NEXT_RECORDING_ID: AtomicU64 = AtomicU64::new(1);
static RECORDINGS: OnceLock<Mutex<HashMap<String, RecordingSession>>> = OnceLock::new();
static DEPENDENCY_INSTALL_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static DEPENDENCY_STATUS: OnceLock<Mutex<RecorderDependencyStatus>> = OnceLock::new();

const MANIFEST_VERSION: u32 = 3;
const FFMPEG_ZIP_URL: &str = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
const FFMPEG_SHA_URL: &str = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256";

struct RecordingSession {
    writer: BufWriter<File>,
    segment_path: PathBuf,
    manifest_path: PathBuf,
    manifest: RecordingManifest,
    segment_index: usize,
    written: u64,
    unsynced: u64,
    last_sync: Instant,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordingSegment {
    file_name: String,
    bytes: u64,
    finalized: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordingManifest {
    version: u32,
    session_id: String,
    display_name: String,
    created_at_ms: u64,
    updated_at_ms: u64,
    mime_type: String,
    output_path: String,
    #[serde(default)]
    safe_output_path: String,
    status: String,
    target_width: u32,
    target_height: u32,
    target_fps: u32,
    segments: Vec<RecordingSegment>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginRecordingResult {
    session_id: String,
    final_path: String,
    resumed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishRecordingResult {
    path: String,
    size: u64,
    finalizing_mp4: bool,
    mp4_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingFinalizationEvent {
    session_id: String,
    stage: String,
    path: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverableRecording {
    session_id: String,
    display_name: String,
    created_at_ms: u64,
    updated_at_ms: u64,
    size: u64,
    segment_count: usize,
    output_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecorderDependencyStatus {
    state: String,
    message: String,
}

fn recording_map() -> &'static Mutex<HashMap<String, RecordingSession>> {
    RECORDINGS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn dependency_install_lock() -> &'static Mutex<()> {
    DEPENDENCY_INSTALL_LOCK.get_or_init(|| Mutex::new(()))
}

fn dependency_status_store() -> &'static Mutex<RecorderDependencyStatus> {
    DEPENDENCY_STATUS.get_or_init(|| {
        Mutex::new(RecorderDependencyStatus {
            state: "missing".to_string(),
            message: String::new(),
        })
    })
}

fn set_dependency_status(state: &str, message: impl Into<String>) {
    if let Ok(mut status) = dependency_status_store().lock() {
        status.state = state.to_string();
        status.message = message.into();
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn safe_file_name(input: &str, extension: &str) -> String {
    let mut output = String::with_capacity(input.len().min(180));
    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | ' ' | '(' | ')') {
            output.push(ch);
        } else {
            output.push('_');
        }
    }
    let trimmed = output.trim().trim_matches('.').to_string();
    let fallback = format!("MHTalk_Recording.{extension}");
    let mut result: String = if trimmed.is_empty() {
        fallback
    } else {
        trimmed.chars().take(180).collect()
    };
    let expected = format!(".{extension}");
    if !result.to_ascii_lowercase().ends_with(&expected) {
        if let Some(index) = result.rfind('.') {
            result.truncate(index);
        }
        result.push_str(&expected);
    }
    result
}

fn safe_session_id(input: &str) -> Result<String, String> {
    let value = input.trim();
    if value.len() < 6
        || value.len() > 100
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        return Err("invalid recording session id".to_string());
    }
    Ok(value.to_string())
}

fn recordings_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .video_dir()
        .or_else(|_| app.path().desktop_dir())
        .map_err(|error| format!("recordings directory unavailable: {error}"))?;
    let dir = base.join("MHTalk Recordings");
    fs::create_dir_all(&dir)
        .map_err(|error| format!("could not create recordings directory: {error}"))?;
    Ok(dir)
}

fn recovery_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = recordings_dir(app)?.join(".mhtalk-recovery");
    fs::create_dir_all(&dir)
        .map_err(|error| format!("could not create recording recovery directory: {error}"))?;
    Ok(dir)
}

fn tools_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("app data directory unavailable: {error}"))?
        .join("recorder-tools");
    fs::create_dir_all(&dir)
        .map_err(|error| format!("could not create recorder tools directory: {error}"))?;
    Ok(dir)
}

fn ffmpeg_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(tools_dir(app)?.join("ffmpeg.exe"))
}

fn ffprobe_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(tools_dir(app)?.join("ffprobe.exe"))
}

fn unique_recording_path(dir: &Path, file_name: &str, extension: &str) -> Result<PathBuf, String> {
    let safe_name = safe_file_name(file_name, extension);
    let first = dir.join(&safe_name);
    if !first.exists() { return Ok(first); }
    let path = Path::new(&safe_name);
    let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or("MHTalk_Recording");
    for index in 1..10_000 {
        let candidate = dir.join(format!("{stem} ({index}).{extension}"));
        if !candidate.exists() { return Ok(candidate); }
    }
    Err("could not create a unique recording file name".to_string())
}

fn manifest_path_for(app: &tauri::AppHandle, session_id: &str) -> Result<PathBuf, String> {
    Ok(recovery_root(app)?.join(session_id).join("manifest.json"))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "manifest parent directory unavailable".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("could not create manifest directory: {error}"))?;
    let temp = path.with_extension("json.tmp");
    {
        let mut file = File::create(&temp)
            .map_err(|error| format!("could not create temporary manifest: {error}"))?;
        file.write_all(bytes)
            .map_err(|error| format!("could not write temporary manifest: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("could not sync temporary manifest: {error}"))?;
    }
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    fs::rename(&temp, path)
        .map_err(|error| format!("could not replace recording manifest: {error}"))
}

fn save_manifest(path: &Path, manifest: &RecordingManifest) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|error| format!("could not serialize recording manifest: {error}"))?;
    atomic_write(path, &bytes)
}

fn load_manifest(path: &Path) -> Result<RecordingManifest, String> {
    let temp_path = path.with_extension("json.tmp");
    let mut candidates: Vec<(RecordingManifest, Vec<u8>, bool)> = Vec::new();
    let mut last_error = String::new();
    for (candidate, is_temp) in [(path, false), (temp_path.as_path(), true)] {
        match fs::read(candidate) {
            Ok(bytes) => match serde_json::from_slice::<RecordingManifest>(&bytes) {
                Ok(manifest)
                    if manifest.version <= MANIFEST_VERSION
                        && !manifest.session_id.trim().is_empty() =>
                {
                    candidates.push((manifest, bytes, is_temp));
                }
                Ok(_) => last_error = "unsupported recording manifest".to_string(),
                Err(error) => last_error = format!("could not parse recording manifest: {error}"),
            },
            Err(error) => last_error = format!("could not read recording manifest: {error}"),
        }
    }
    let (manifest, bytes, from_temp) = candidates
        .into_iter()
        .max_by_key(|(manifest, _, _)| manifest.updated_at_ms)
        .ok_or_else(|| if last_error.is_empty() { "recording manifest unavailable".to_string() } else { last_error })?;
    if from_temp {
        // A power loss can happen after the old manifest is removed but before
        // the synced temporary manifest is renamed. Promote the newest valid
        // copy so the recovery scan can continue normally.
        let _ = atomic_write(path, &bytes);
    }
    Ok(manifest)
}

fn session_dir_from_manifest(path: &Path) -> Result<PathBuf, String> {
    path.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "recording session directory unavailable".to_string())
}

fn finalize_orphan_parts(session_dir: &Path, manifest: &mut RecordingManifest) {
    for segment in &mut manifest.segments {
        let current_path = session_dir.join(&segment.file_name);

        // An interrupted process leaves the active segment with the .part suffix.
        // Seal it before recovery so FFmpeg only sees stable files.
        if segment.file_name.ends_with(".part") {
            let final_name = segment.file_name.trim_end_matches(".part").to_string();
            let final_path = session_dir.join(&final_name);
            if !current_path.exists() {
                // The file rename can complete just before a power loss while
                // the manifest update is still pending. Recognize that sealed
                // counterpart instead of losing the segment reference.
                if final_path.exists() {
                    segment.file_name = final_name;
                    segment.bytes = fs::metadata(&final_path)
                        .map(|metadata| metadata.len())
                        .unwrap_or(segment.bytes);
                    segment.finalized = segment.bytes > 0;
                }
                continue;
            }
            let size = fs::metadata(&current_path)
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            if size == 0 {
                let _ = fs::remove_file(&current_path);
                segment.bytes = 0;
                continue;
            }
            if final_path.exists() {
                let _ = fs::remove_file(&final_path);
            }
            if fs::rename(&current_path, &final_path).is_ok() {
                segment.file_name = final_name;
                segment.bytes = size;
                segment.finalized = true;
            }
            continue;
        }

        if current_path.exists() {
            segment.bytes = fs::metadata(&current_path)
                .map(|metadata| metadata.len())
                .unwrap_or(segment.bytes);
            segment.finalized = segment.bytes > 0;
            continue;
        }

        // Compatibility with older manifests that stored the final name while
        // the active file itself still had the .part suffix.
        let part_path = session_dir.join(format!("{}.part", segment.file_name));
        if !part_path.exists() {
            continue;
        }
        let size = fs::metadata(&part_path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if size == 0 {
            let _ = fs::remove_file(part_path);
            segment.bytes = 0;
            continue;
        }
        if fs::rename(&part_path, &current_path).is_ok() {
            segment.bytes = size;
            segment.finalized = true;
        }
    }
}

fn recover_orphaned_sessions(app: &tauri::AppHandle) -> Result<(), String> {
    let active_session_ids = recording_map()
        .lock()
        .map(|recordings| recordings.keys().cloned().collect::<std::collections::HashSet<_>>())
        .unwrap_or_default();
    let root = recovery_root(app)?;
    let Ok(entries) = fs::read_dir(root) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let manifest_path = entry.path().join("manifest.json");
        let Ok(mut manifest) = load_manifest(&manifest_path) else {
            continue;
        };
        if manifest.status == "completed" || active_session_ids.contains(&manifest.session_id) {
            continue;
        }
        finalize_orphan_parts(&entry.path(), &mut manifest);
        manifest.status = "interrupted".to_string();
        manifest.updated_at_ms = now_ms();
        let _ = save_manifest(&manifest_path, &manifest);
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn hidden_command(program: &str) -> Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x00004000;
    let mut command = Command::new(program);
    // Converter/download helpers stay invisible and below normal priority so
    // they do not compete aggressively with the live call or screen stream.
    command.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
    command
}

#[cfg(not(target_os = "windows"))]
fn hidden_command(program: &str) -> Command {
    Command::new(program)
}

fn command_output(mut command: Command) -> Result<Output, String> {
    command
        .output()
        .map_err(|error| format!("could not launch media converter: {error}"))
}

fn tool_works(path: &Path) -> bool {
    if !path.exists() {
        return false;
    }
    let mut command = hidden_command(path.to_string_lossy().as_ref());
    command.arg("-version");
    command
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn install_ffmpeg_windows(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        return Err("automatic MP4 converter installation is currently supported on Windows only".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        let tools = tools_dir(app)?;
        let ffmpeg = tools.join("ffmpeg.exe");
        let ffprobe = tools.join("ffprobe.exe");
        if tool_works(&ffmpeg) && tool_works(&ffprobe) {
            return Ok(());
        }

        let zip_path = tools.join("ffmpeg-release-essentials.download.zip");
        let sha_path = tools.join("ffmpeg-release-essentials.download.sha256");
        let extract_dir = tools.join("ffmpeg-extract.tmp");
        let _ = fs::remove_file(&zip_path);
        let _ = fs::remove_file(&sha_path);
        let _ = fs::remove_dir_all(&extract_dir);
        fs::create_dir_all(&extract_dir)
            .map_err(|error| format!("could not create converter extraction directory: {error}"))?;

        let script = r#"
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if (Get-Command Start-BitsTransfer -ErrorAction SilentlyContinue) {
  Start-BitsTransfer -Source $env:MHTALK_FFMPEG_URL -Destination $env:MHTALK_FFMPEG_ZIP -Priority Low
  Start-BitsTransfer -Source $env:MHTALK_FFMPEG_SHA_URL -Destination $env:MHTALK_FFMPEG_SHA -Priority Low
} else {
  Invoke-WebRequest -UseBasicParsing -Uri $env:MHTALK_FFMPEG_URL -OutFile $env:MHTALK_FFMPEG_ZIP
  Invoke-WebRequest -UseBasicParsing -Uri $env:MHTALK_FFMPEG_SHA_URL -OutFile $env:MHTALK_FFMPEG_SHA
}
$expected = ((Get-Content -LiteralPath $env:MHTALK_FFMPEG_SHA -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
$actual = (Get-FileHash -LiteralPath $env:MHTALK_FFMPEG_ZIP -Algorithm SHA256).Hash.ToLowerInvariant()
if ([string]::IsNullOrWhiteSpace($expected) -or $expected -ne $actual) { throw 'FFmpeg SHA-256 verification failed.' }
Expand-Archive -LiteralPath $env:MHTALK_FFMPEG_ZIP -DestinationPath $env:MHTALK_FFMPEG_EXTRACT -Force
$ffmpeg = Get-ChildItem -LiteralPath $env:MHTALK_FFMPEG_EXTRACT -Recurse -Filter ffmpeg.exe | Select-Object -First 1
$ffprobe = Get-ChildItem -LiteralPath $env:MHTALK_FFMPEG_EXTRACT -Recurse -Filter ffprobe.exe | Select-Object -First 1
if ($null -eq $ffmpeg -or $null -eq $ffprobe) { throw 'FFmpeg package did not contain the required executables.' }
Copy-Item -LiteralPath $ffmpeg.FullName -Destination $env:MHTALK_FFMPEG_TARGET -Force
Copy-Item -LiteralPath $ffprobe.FullName -Destination $env:MHTALK_FFPROBE_TARGET -Force
"#;

        let mut command = hidden_command("powershell.exe");
        command
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                script,
            ])
            .env("MHTALK_FFMPEG_URL", FFMPEG_ZIP_URL)
            .env("MHTALK_FFMPEG_SHA_URL", FFMPEG_SHA_URL)
            .env("MHTALK_FFMPEG_ZIP", &zip_path)
            .env("MHTALK_FFMPEG_SHA", &sha_path)
            .env("MHTALK_FFMPEG_EXTRACT", &extract_dir)
            .env("MHTALK_FFMPEG_TARGET", &ffmpeg)
            .env("MHTALK_FFPROBE_TARGET", &ffprobe);
        let output = command_output(command)?;
        let _ = fs::remove_file(&zip_path);
        let _ = fs::remove_file(&sha_path);
        let _ = fs::remove_dir_all(&extract_dir);
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if stderr.is_empty() {
                "background MP4 converter installation failed".to_string()
            } else {
                stderr
            });
        }
        if !tool_works(&ffmpeg) || !tool_works(&ffprobe) {
            return Err("downloaded MP4 converter could not be verified".to_string());
        }
        Ok(())
    }
}

fn ensure_dependencies(app: &tauri::AppHandle) -> Result<(), String> {
    let _guard = dependency_install_lock()
        .lock()
        .map_err(|_| "screen recorder dependency lock failed".to_string())?;
    let ffmpeg = ffmpeg_path(app)?;
    let ffprobe = ffprobe_path(app)?;
    if tool_works(&ffmpeg) && tool_works(&ffprobe) {
        set_dependency_status("ready", "");
        return Ok(());
    }
    set_dependency_status("downloading", "");
    match install_ffmpeg_windows(app) {
        Ok(()) => {
            set_dependency_status("ready", "");
            Ok(())
        }
        Err(error) => {
            set_dependency_status("error", error.clone());
            Err(error)
        }
    }
}

pub fn warm_up_dependencies(app: tauri::AppHandle) {
    let _ = recover_orphaned_sessions(&app);
    std::thread::spawn(move || {
        let _ = ensure_dependencies(&app);
    });
}

#[tauri::command]
pub fn prepare_screen_recorder_dependencies(app: tauri::AppHandle) -> RecorderDependencyStatus {
    let ffmpeg_ready = ffmpeg_path(&app).map(|path| tool_works(&path)).unwrap_or(false);
    let ffprobe_ready = ffprobe_path(&app).map(|path| tool_works(&path)).unwrap_or(false);
    if ffmpeg_ready && ffprobe_ready {
        set_dependency_status("ready", "");
    } else {
        let should_start = dependency_status_store()
            .lock()
            .map(|status| status.state != "downloading")
            .unwrap_or(true);
        if should_start {
            set_dependency_status("downloading", "");
            std::thread::spawn(move || {
                let _ = ensure_dependencies(&app);
            });
        }
    }
    screen_recorder_dependency_status()
}

#[tauri::command]
pub fn screen_recorder_dependency_status() -> RecorderDependencyStatus {
    dependency_status_store()
        .lock()
        .map(|status| status.clone())
        .unwrap_or(RecorderDependencyStatus {
            state: "error".to_string(),
            message: "screen recorder dependency state unavailable".to_string(),
        })
}

#[tauri::command]
pub fn begin_screen_recording(
    app: tauri::AppHandle,
    file_name: String,
    mime_type: String,
    resume_session_id: Option<String>,
    width: u32,
    height: u32,
    fps: u32,
) -> Result<BeginRecordingResult, String> {
    let root = recovery_root(&app)?;
    let resumed = resume_session_id.as_ref().map(|value| !value.trim().is_empty()).unwrap_or(false);
    let (session_id, manifest_path, mut manifest) = if let Some(requested) = resume_session_id {
        let session_id = safe_session_id(&requested)?;
        if recording_map()
            .lock()
            .map_err(|_| "screen recorder state lock failed".to_string())?
            .contains_key(&session_id)
        {
            return Err("screen recording session is already active".to_string());
        }
        let manifest_path = manifest_path_for(&app, &session_id)?;
        let mut manifest = load_manifest(&manifest_path)?;
        if manifest.status == "completed" {
            return Err("completed recording cannot be resumed".to_string());
        }
        let session_dir = session_dir_from_manifest(&manifest_path)?;
        finalize_orphan_parts(&session_dir, &mut manifest);
        (session_id, manifest_path, manifest)
    } else {
        let session_id = format!(
            "rec-{}-{}-{}",
            std::process::id(),
            now_ms(),
            NEXT_RECORDING_ID.fetch_add(1, Ordering::Relaxed)
        );
        let recordings = recordings_dir(&app)?;
        let output_path = unique_recording_path(&recordings, &file_name, "mp4")?;
        let safe_output_path = if mime_type.to_ascii_lowercase().starts_with("video/mp4") {
            output_path.clone()
        } else {
            unique_recording_path(&recordings, &file_name, "webm")?
        };
        let manifest_path = root.join(&session_id).join("manifest.json");
        let manifest = RecordingManifest {
            version: MANIFEST_VERSION,
            session_id: session_id.clone(),
            display_name: safe_file_name(&file_name, "mp4"),
            created_at_ms: now_ms(),
            updated_at_ms: now_ms(),
            mime_type: mime_type.clone(),
            output_path: output_path.to_string_lossy().to_string(),
            safe_output_path: safe_output_path.to_string_lossy().to_string(),
            status: "recording".to_string(),
            target_width: width.max(2),
            target_height: height.max(2),
            target_fps: fps.clamp(8, 144),
            segments: Vec::new(),
        };
        (session_id, manifest_path, manifest)
    };

    let session_dir = session_dir_from_manifest(&manifest_path)?;
    fs::create_dir_all(&session_dir)
        .map_err(|error| format!("could not create recording session directory: {error}"))?;
    if manifest.safe_output_path.trim().is_empty() {
        manifest.safe_output_path = if manifest.mime_type.to_ascii_lowercase().starts_with("video/mp4") {
            manifest.output_path.clone()
        } else {
            PathBuf::from(&manifest.output_path).with_extension("webm").to_string_lossy().to_string()
        };
    }
    let segment_number = manifest.segments.len() + 1;
    let segment_ext = if manifest.mime_type.to_ascii_lowercase().starts_with("video/mp4") { "mp4" } else { "webm" };
    let segment_name = format!("segment-{segment_number:04}.{segment_ext}.part");
    let segment_path = session_dir.join(&segment_name);
    let file = File::create(&segment_path)
        .map_err(|error| format!("could not create recording segment: {error}"))?;
    manifest.status = "recording".to_string();
    manifest.updated_at_ms = now_ms();
    if manifest.mime_type.trim().is_empty() {
        manifest.mime_type = mime_type;
    }
    if manifest.target_width < 2 {
        manifest.target_width = width.max(2);
    }
    if manifest.target_height < 2 {
        manifest.target_height = height.max(2);
    }
    if manifest.target_fps < 8 {
        manifest.target_fps = fps.clamp(8, 144);
    }
    manifest.segments.push(RecordingSegment {
        file_name: segment_name,
        bytes: 0,
        finalized: false,
    });
    save_manifest(&manifest_path, &manifest)?;

    let final_path = manifest.output_path.clone();
    let session = RecordingSession {
        writer: BufWriter::with_capacity(2 * 1024 * 1024, file),
        segment_path,
        manifest_path,
        manifest,
        segment_index: segment_number - 1,
        written: 0,
        unsynced: 0,
        last_sync: Instant::now(),
    };
    recording_map()
        .lock()
        .map_err(|_| "screen recorder state lock failed".to_string())?
        .insert(session_id.clone(), session);
    Ok(BeginRecordingResult {
        session_id,
        final_path,
        resumed,
    })
}

#[tauri::command]
pub fn append_screen_recording_chunk(request: tauri::ipc::Request) -> Result<u64, String> {
    let session_id = request
        .headers()
        .get("x-mhtalk-recording-id")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "missing recording session header".to_string())?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("screen recording chunk must use a raw binary body".to_string());
    };
    if bytes.is_empty() {
        return Ok(0);
    }
    let mut recordings = recording_map()
        .lock()
        .map_err(|_| "screen recorder state lock failed".to_string())?;
    let session = recordings
        .get_mut(session_id)
        .ok_or_else(|| "unknown screen recording session".to_string())?;
    session
        .writer
        .write_all(bytes)
        .map_err(|error| format!("could not write recording chunk: {error}"))?;
    session
        .writer
        .flush()
        .map_err(|error| format!("could not flush recording chunk: {error}"))?;
    session.written = session.written.saturating_add(bytes.len() as u64);
    session.unsynced = session.unsynced.saturating_add(bytes.len() as u64);
    if session.last_sync.elapsed() >= Duration::from_secs(4) || session.unsynced >= 16 * 1024 * 1024 {
        session
            .writer
            .get_ref()
            .sync_data()
            .map_err(|error| format!("could not sync recording chunk: {error}"))?;
        session.unsynced = 0;
        session.last_sync = Instant::now();
    }
    if let Some(segment) = session.manifest.segments.get_mut(session.segment_index) {
        segment.bytes = session.written;
    }
    session.manifest.updated_at_ms = now_ms();
    save_manifest(&session.manifest_path, &session.manifest)?;
    Ok(session.written)
}

fn seal_active_session(session_id: &str, interrupted: bool) -> Result<RecordingManifest, String> {
    let mut session = recording_map()
        .lock()
        .map_err(|_| "screen recorder state lock failed".to_string())?
        .remove(session_id)
        .ok_or_else(|| "unknown screen recording session".to_string())?;

    session
        .writer
        .flush()
        .map_err(|error| format!("could not flush recording: {error}"))?;
    session
        .writer
        .get_ref()
        .sync_all()
        .map_err(|error| format!("could not sync recording: {error}"))?;
    drop(session.writer);

    if let Some(segment) = session.manifest.segments.get_mut(session.segment_index) {
        segment.bytes = fs::metadata(&session.segment_path)
            .map(|metadata| metadata.len())
            .unwrap_or(session.written);
        if segment.bytes > 0 {
            let final_name = segment.file_name.trim_end_matches(".part").to_string();
            let final_path = session.segment_path.with_file_name(&final_name);
            fs::rename(&session.segment_path, &final_path)
                .map_err(|error| format!("could not finalize recording segment: {error}"))?;
            segment.file_name = final_name;
            segment.finalized = true;
        } else {
            let _ = fs::remove_file(&session.segment_path);
        }
    }
    session.manifest.segments.retain(|segment| segment.bytes > 0);
    session.manifest.status = if interrupted { "interrupted" } else { "ready" }.to_string();
    session.manifest.updated_at_ms = now_ms();
    save_manifest(&session.manifest_path, &session.manifest)?;
    Ok(session.manifest)
}

fn load_recovery_manifest(app: &tauri::AppHandle, session_id: &str) -> Result<(PathBuf, RecordingManifest), String> {
    let session_id = safe_session_id(session_id)?;
    let manifest_path = manifest_path_for(app, &session_id)?;
    let mut manifest = load_manifest(&manifest_path)?;
    let session_dir = session_dir_from_manifest(&manifest_path)?;
    finalize_orphan_parts(&session_dir, &mut manifest);
    manifest.segments.retain(|segment| segment.bytes > 0 || session_dir.join(&segment.file_name).exists());
    manifest.updated_at_ms = now_ms();
    save_manifest(&manifest_path, &manifest)?;
    Ok((manifest_path, manifest))
}

fn run_ffmpeg(ffmpeg: &Path, args: &[String]) -> Result<(), String> {
    let mut command = hidden_command(ffmpeg.to_string_lossy().as_ref());
    command.args(args);
    let output = command_output(command)?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        "FFmpeg conversion failed".to_string()
    } else {
        stderr
    })
}

fn concat_quote(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    normalized.replace('\'', "'\\''")
}

fn converter_thread_count() -> usize {
    std::thread::available_parallelism()
        .map(|count| (count.get() / 2).clamp(1, 8))
        .unwrap_or(2)
}

fn write_concat_list(session_dir: &Path, manifest: &RecordingManifest, extension: &str) -> Result<PathBuf, String> {
    let list_path = session_dir.join(format!("concat-{extension}.txt"));
    let mut list = String::from("ffconcat version 1.0\n");
    let mut found = 0usize;
    for segment in &manifest.segments {
        let path = session_dir.join(&segment.file_name);
        if path.exists() && fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > 0 {
            list.push_str(&format!("file '{}'
", concat_quote(&path)));
            found += 1;
        }
    }
    if found == 0 { return Err("recording produced no recoverable media data".to_string()); }
    fs::write(&list_path, list).map_err(|error| format!("could not create recording concat list: {error}"))?;
    Ok(list_path)
}

fn finalize_safe_container(
    app: &tauri::AppHandle,
    manifest_path: &Path,
    mut manifest: RecordingManifest,
) -> Result<(FinishRecordingResult, RecordingManifest), String> {
    if manifest.segments.is_empty() { return Err("recording produced no recoverable media data".to_string()); }
    let session_dir = session_dir_from_manifest(manifest_path)?;
    finalize_orphan_parts(&session_dir, &mut manifest);
    manifest.segments.retain(|segment| segment.bytes > 0 && session_dir.join(&segment.file_name).exists());
    if manifest.segments.is_empty() { return Err("recording produced no recoverable media data".to_string()); }

    let direct_mp4 = manifest.mime_type.to_ascii_lowercase().starts_with("video/mp4");
    let safe_path = if manifest.safe_output_path.trim().is_empty() {
        if direct_mp4 { PathBuf::from(&manifest.output_path) } else { PathBuf::from(&manifest.output_path).with_extension("webm") }
    } else { PathBuf::from(&manifest.safe_output_path) };
    if let Some(parent) = safe_path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("could not create recording output directory: {error}"))?;
    }
    let extension = if direct_mp4 { "mp4" } else { "webm" };
    let partial = safe_path.with_extension(format!("partial.{extension}"));
    let _ = fs::remove_file(&partial);

    // Never publish the raw MediaRecorder fragment, even for a one-segment
    // recording. Browser fragments can retain live/fragmented metadata and some
    // players then report an unknown duration or disable seeking. Passing every
    // recording through FFmpeg rebuilds timestamps, the MP4 moov index or WebM
    // cues, and only then publishes the stable file.
    ensure_dependencies(app)?;
    let ffmpeg = ffmpeg_path(app)?;
    let list_path = write_concat_list(&session_dir, &manifest, extension)?;
    let mut finalize_args = vec![
        "-y".to_string(), "-hide_banner".to_string(), "-loglevel".to_string(), "error".to_string(),
        "-fflags".to_string(), "+genpts+discardcorrupt".to_string(),
        "-f".to_string(), "concat".to_string(), "-safe".to_string(), "0".to_string(),
        "-i".to_string(), list_path.to_string_lossy().to_string(),
        "-map".to_string(), "0:v:0".to_string(), "-map".to_string(), "0:a?".to_string(),
        "-c".to_string(), "copy".to_string(),
        "-avoid_negative_ts".to_string(), "make_zero".to_string(),
    ];
    if direct_mp4 {
        finalize_args.extend(["-movflags".to_string(), "+faststart".to_string()]);
    }
    finalize_args.push(partial.to_string_lossy().to_string());
    run_ffmpeg(&ffmpeg, &finalize_args)?;
    let size = fs::metadata(&partial).map_err(|error| format!("could not read finalized recording: {error}"))?.len();
    if size == 0 { return Err("recording finalization produced an empty file".to_string()); }
    if safe_path.exists() { let _ = fs::remove_file(&safe_path); }
    fs::rename(&partial, &safe_path).map_err(|error| format!("could not publish finalized recording: {error}"))?;
    manifest.safe_output_path = safe_path.to_string_lossy().to_string();
    manifest.status = if direct_mp4 { "completed" } else { "safe-saved" }.to_string();
    manifest.updated_at_ms = now_ms();
    save_manifest(manifest_path, &manifest)?;
    if direct_mp4 {
        let _ = fs::remove_dir_all(&session_dir);
    }
    Ok((FinishRecordingResult {
        path: safe_path.to_string_lossy().to_string(),
        size,
        finalizing_mp4: !direct_mp4,
        mp4_path: if direct_mp4 { Some(safe_path.to_string_lossy().to_string()) } else { Some(manifest.output_path.clone()) },
    }, manifest))
}

fn available_encoder_names(ffmpeg: &Path) -> String {
    let mut command = hidden_command(ffmpeg.to_string_lossy().as_ref());
    command.args(["-hide_banner", "-encoders"]);
    command.output().map(|output| String::from_utf8_lossy(&output.stdout).into_owned()).unwrap_or_default()
}

fn encoder_attempts(ffmpeg: &Path) -> Vec<(String, Vec<String>)> {
    let encoders = available_encoder_names(ffmpeg);
    let mut attempts = Vec::new();
    if encoders.contains("h264_nvenc") {
        attempts.push(("NVIDIA NVENC".to_string(), vec!["-c:v".into(), "h264_nvenc".into(), "-preset".into(), "p4".into(), "-cq".into(), "23".into()]));
    }
    if encoders.contains("h264_qsv") {
        attempts.push(("Intel Quick Sync".to_string(), vec!["-c:v".into(), "h264_qsv".into(), "-preset".into(), "veryfast".into(), "-global_quality".into(), "23".into()]));
    }
    if encoders.contains("h264_amf") {
        attempts.push(("AMD AMF".to_string(), vec!["-c:v".into(), "h264_amf".into(), "-quality".into(), "speed".into(), "-qp_i".into(), "23".into(), "-qp_p".into(), "23".into()]));
    }
    attempts.push(("software x264".to_string(), vec!["-c:v".into(), "libx264".into(), "-preset".into(), "veryfast".into(), "-crf".into(), "22".into(), "-threads".into(), converter_thread_count().to_string()]));
    attempts
}

fn convert_safe_recording_to_mp4(
    app: &tauri::AppHandle,
    manifest_path: &Path,
    mut manifest: RecordingManifest,
) -> Result<FinishRecordingResult, String> {
    ensure_dependencies(app)?;
    let ffmpeg = ffmpeg_path(app)?;
    let safe_path = PathBuf::from(&manifest.safe_output_path);
    if !safe_path.exists() { return Err("safe recording container is missing".to_string()); }
    let output_path = PathBuf::from(&manifest.output_path);
    let partial_output = output_path.with_extension("partial.mp4");
    let _ = fs::remove_file(&partial_output);
    manifest.status = "converting-mp4".to_string();
    manifest.updated_at_ms = now_ms();
    save_manifest(manifest_path, &manifest)?;

    let mut errors = Vec::new();
    let mut selected = String::new();

    // First try a true remux. When the browser already produced MP4-compatible
    // H.264/AAC streams this completes near-instantly and does not alter quality.
    let remux_args = vec![
        "-y".to_string(), "-hide_banner".to_string(), "-loglevel".to_string(), "error".to_string(),
        "-fflags".to_string(), "+genpts+discardcorrupt".to_string(),
        "-i".to_string(), safe_path.to_string_lossy().to_string(),
        "-map".to_string(), "0:v:0".to_string(), "-map".to_string(), "0:a?".to_string(),
        "-c".to_string(), "copy".to_string(), "-movflags".to_string(), "+faststart".to_string(),
        partial_output.to_string_lossy().to_string(),
    ];
    match run_ffmpeg(&ffmpeg, &remux_args) {
        Ok(()) if partial_output.exists() && fs::metadata(&partial_output).map(|m| m.len()).unwrap_or(0) > 0 => {
            selected = "stream copy".to_string();
        }
        Ok(()) => {
            errors.push("stream copy: empty output".to_string());
            let _ = fs::remove_file(&partial_output);
        }
        Err(error) => {
            errors.push(format!("stream copy: {error}"));
            let _ = fs::remove_file(&partial_output);
        }
    }

    for (label, encoder_args) in encoder_attempts(&ffmpeg) {
        if !selected.is_empty() { break; }
        let mut args = vec![
            "-y".to_string(), "-hide_banner".to_string(), "-loglevel".to_string(), "error".to_string(),
            "-fflags".to_string(), "+genpts+discardcorrupt".to_string(),
            "-i".to_string(), safe_path.to_string_lossy().to_string(),
            "-map".to_string(), "0:v:0".to_string(), "-map".to_string(), "0:a?".to_string(),
        ];
        args.extend(encoder_args);
        args.extend([
            "-pix_fmt".to_string(), "yuv420p".to_string(),
            "-c:a".to_string(), "aac".to_string(), "-b:a".to_string(), "160k".to_string(),
            "-ar".to_string(), "48000".to_string(), "-ac".to_string(), "2".to_string(),
            "-movflags".to_string(), "+faststart".to_string(),
            partial_output.to_string_lossy().to_string(),
        ]);
        match run_ffmpeg(&ffmpeg, &args) {
            Ok(()) if partial_output.exists() && fs::metadata(&partial_output).map(|m| m.len()).unwrap_or(0) > 0 => { selected = label; break; }
            Ok(()) => errors.push(format!("{label}: empty output")),
            Err(error) => { errors.push(format!("{label}: {error}")); let _ = fs::remove_file(&partial_output); }
        }
    }
    if selected.is_empty() { return Err(errors.join(" | ")); }
    if output_path.exists() { let _ = fs::remove_file(&output_path); }
    fs::rename(&partial_output, &output_path).map_err(|error| format!("could not finalize MP4 recording: {error}"))?;
    let size = fs::metadata(&output_path).map_err(|error| format!("could not read final MP4 size: {error}"))?.len();
    manifest.status = "completed".to_string();
    manifest.updated_at_ms = now_ms();
    save_manifest(manifest_path, &manifest)?;
    if let Ok(session_dir) = session_dir_from_manifest(manifest_path) { let _ = fs::remove_dir_all(session_dir); }
    Ok(FinishRecordingResult {
        path: output_path.to_string_lossy().to_string(),
        size,
        finalizing_mp4: false,
        mp4_path: Some(output_path.to_string_lossy().to_string()),
    })
}

#[tauri::command]
pub async fn finish_screen_recording(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<FinishRecordingResult, String> {
    let manifest = seal_active_session(&session_id, false)?;
    let manifest_path = manifest_path_for(&app, &session_id)?;
    let app_for_finalize = app.clone();
    let path_for_finalize = manifest_path.clone();
    let (safe_result, safe_manifest) = tauri::async_runtime::spawn_blocking(move || {
        finalize_safe_container(&app_for_finalize, &path_for_finalize, manifest)
    }).await.map_err(|error| format!("recording finalization task failed: {error}"))??;

    if safe_result.finalizing_mp4 {
        let background_app = app.clone();
        let background_path = manifest_path.clone();
        let background_manifest = safe_manifest.clone();
        let background_session = session_id.clone();
        let safe_fallback_path = safe_result.path.clone();
        tauri::async_runtime::spawn(async move {
            let _ = background_app.emit("mhlko://recording-finalization-stage", RecordingFinalizationEvent {
                session_id: background_session.clone(), stage: "converting-mp4".to_string(), path: Some(background_manifest.safe_output_path.clone()), message: None,
            });
            let worker_app = background_app.clone();
            let result = tauri::async_runtime::spawn_blocking(move || convert_safe_recording_to_mp4(&worker_app, &background_path, background_manifest)).await;
            match result {
                Ok(Ok(final_result)) => { let _ = background_app.emit("mhlko://recording-finalization-complete", final_result); }
                Ok(Err(error)) => { let _ = background_app.emit("mhlko://recording-finalization-error", RecordingFinalizationEvent { session_id: background_session, stage: "mp4-failed".to_string(), path: Some(safe_fallback_path.clone()), message: Some(error) }); }
                Err(error) => { let _ = background_app.emit("mhlko://recording-finalization-error", RecordingFinalizationEvent { session_id: background_session, stage: "mp4-failed".to_string(), path: Some(safe_fallback_path), message: Some(error.to_string()) }); }
            }
        });
    }
    Ok(safe_result)
}

#[tauri::command]
pub fn preserve_screen_recording(session_id: String) -> Result<(), String> {
    let _ = seal_active_session(&session_id, true)?;
    Ok(())
}

#[tauri::command]
pub fn cancel_screen_recording(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    let session = recording_map()
        .lock()
        .map_err(|_| "screen recorder state lock failed".to_string())?
        .remove(&session_id);
    if let Some(mut session) = session {
        let _ = session.writer.flush();
        let _ = session.writer.get_ref().sync_data();
        drop(session.writer);
        let prior_data = session
            .manifest
            .segments
            .iter()
            .enumerate()
            .any(|(index, segment)| index != session.segment_index && segment.bytes > 0);
        if session.written == 0 {
            let _ = fs::remove_file(&session.segment_path);
            if session.segment_index < session.manifest.segments.len() {
                session.manifest.segments.remove(session.segment_index);
            }
        }
        if prior_data || session.written > 0 {
            session.manifest.status = "interrupted".to_string();
            session.manifest.updated_at_ms = now_ms();
            save_manifest(&session.manifest_path, &session.manifest)?;
        } else if let Some(dir) = session.manifest_path.parent() {
            let _ = fs::remove_dir_all(dir);
        }
    } else {
        let manifest_path = manifest_path_for(&app, &safe_session_id(&session_id)?)?;
        if let Ok(manifest) = load_manifest(&manifest_path) {
            if manifest.segments.iter().all(|segment| segment.bytes == 0) {
                if let Some(dir) = manifest_path.parent() {
                    let _ = fs::remove_dir_all(dir);
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn list_recoverable_screen_recordings(app: tauri::AppHandle) -> Result<Vec<RecoverableRecording>, String> {
    recover_orphaned_sessions(&app)?;
    let active_session_ids = recording_map()
        .lock()
        .map_err(|_| "screen recorder state lock failed".to_string())?
        .keys()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    let root = recovery_root(&app)?;
    let mut recordings = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return Ok(recordings);
    };
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let manifest_path = entry.path().join("manifest.json");
        let Ok(mut manifest) = load_manifest(&manifest_path) else {
            continue;
        };
        if manifest.status == "completed" || active_session_ids.contains(&manifest.session_id) {
            continue;
        }
        finalize_orphan_parts(&entry.path(), &mut manifest);
        let size = manifest.segments.iter().map(|segment| segment.bytes).sum::<u64>();
        let segment_count = manifest.segments.iter().filter(|segment| segment.bytes > 0).count();
        if size == 0 || segment_count == 0 {
            continue;
        }
        if manifest.status == "recording" {
            manifest.status = "interrupted".to_string();
            manifest.updated_at_ms = now_ms();
            let _ = save_manifest(&manifest_path, &manifest);
        }
        recordings.push(RecoverableRecording {
            session_id: manifest.session_id,
            display_name: manifest.display_name,
            created_at_ms: manifest.created_at_ms,
            updated_at_ms: manifest.updated_at_ms,
            size,
            segment_count,
            output_path: manifest.output_path,
        });
    }
    recordings.sort_by(|left, right| right.updated_at_ms.cmp(&left.updated_at_ms));
    Ok(recordings)
}

#[tauri::command]
pub async fn finalize_recovered_screen_recording(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<FinishRecordingResult, String> {
    if recording_map()
        .lock()
        .map_err(|_| "screen recorder state lock failed".to_string())?
        .contains_key(&session_id)
    {
        return Err("active recording must be stopped before repair".to_string());
    }
    let (manifest_path, mut manifest) = load_recovery_manifest(&app, &session_id)?;
    manifest.status = "ready".to_string();
    save_manifest(&manifest_path, &manifest)?;
    let app_for_finalize = app.clone();
    let path_for_finalize = manifest_path.clone();
    let (safe_result, safe_manifest) = tauri::async_runtime::spawn_blocking(move || {
        finalize_safe_container(&app_for_finalize, &path_for_finalize, manifest)
    }).await.map_err(|error| format!("recording recovery task failed: {error}"))??;
    if safe_result.finalizing_mp4 {
        let background_app = app.clone();
        let background_session = session_id.clone();
        let fallback_path = safe_result.path.clone();
        tauri::async_runtime::spawn(async move {
            let _ = background_app.emit("mhlko://recording-finalization-stage", RecordingFinalizationEvent {
                session_id: background_session.clone(),
                stage: "converting-mp4".to_string(),
                path: Some(safe_manifest.safe_output_path.clone()),
                message: None,
            });
            let worker_app = background_app.clone();
            match tauri::async_runtime::spawn_blocking(move || convert_safe_recording_to_mp4(&worker_app, &manifest_path, safe_manifest)).await {
                Ok(Ok(result)) => { let _ = background_app.emit("mhlko://recording-finalization-complete", result); }
                Ok(Err(error)) => {
                    let _ = background_app.emit("mhlko://recording-finalization-error", RecordingFinalizationEvent {
                        session_id: background_session,
                        stage: "mp4-failed".to_string(),
                        path: Some(fallback_path),
                        message: Some(error),
                    });
                }
                Err(error) => {
                    let _ = background_app.emit("mhlko://recording-finalization-error", RecordingFinalizationEvent {
                        session_id: background_session,
                        stage: "mp4-failed".to_string(),
                        path: Some(fallback_path),
                        message: Some(error.to_string()),
                    });
                }
            }
        });
    }
    Ok(safe_result)
}

#[tauri::command]
pub fn open_screen_recordings_folder(app: tauri::AppHandle) -> Result<String, String> {
    let dir = recordings_dir(&app)?;
    #[cfg(target_os = "windows")]
    hidden_command("explorer.exe")
        .arg(&dir)
        .spawn()
        .map_err(|error| format!("could not open recordings folder: {error}"))?;
    #[cfg(target_os = "macos")]
    Command::new("open")
        .arg(&dir)
        .spawn()
        .map_err(|error| format!("could not open recordings folder: {error}"))?;
    #[cfg(all(unix, not(target_os = "macos")))]
    Command::new("xdg-open")
        .arg(&dir)
        .spawn()
        .map_err(|error| format!("could not open recordings folder: {error}"))?;
    Ok(dir.to_string_lossy().to_string())
}
