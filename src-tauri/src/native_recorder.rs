use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;

const FFMPEG_ZIP_URL: &str = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
const FFMPEG_SHA_URL: &str =
    "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256";

static ACTIVE: OnceLock<Mutex<Option<NativeRecording>>> = OnceLock::new();
static PROCESSING: OnceLock<Mutex<ProcessingState>> = OnceLock::new();
static INSTALL_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static ENCODER: OnceLock<String> = OnceLock::new();

struct NativeRecording {
    child: Child,
    audio: Option<TcpStream>,
    temporary_paths: Vec<PathBuf>,
    final_path: PathBuf,
    started: Instant,
    encoder: String,
    output_width: u32,
    output_height: u32,
}

struct ProcessingState {
    active: bool,
    progress: f64,
    estimated_remaining_ms: Option<u64>,
    estimate_updated: Instant,
}

impl Default for ProcessingState {
    fn default() -> Self {
        Self {
            active: false,
            progress: 0.0,
            estimated_remaining_ms: None,
            estimate_updated: Instant::now(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRecordingSettings {
    fps: u32,
    quality: String,
    has_audio: bool,
    source_kind: String,
    source_label: String,
    output_index: u32,
    output_width: u32,
    output_height: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRecordingStatus {
    active: bool,
    elapsed_ms: u64,
    bytes: u64,
    path: Option<String>,
    encoder: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRecordingResult {
    path: String,
    size: u64,
    encoder: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRecordingProcessingStatus {
    active: bool,
    progress: f64,
    estimated_remaining_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecorderCapabilities {
    ready: bool,
    encoder: String,
    recordings_folder: String,
    message: String,
}

fn active() -> &'static Mutex<Option<NativeRecording>> {
    ACTIVE.get_or_init(|| Mutex::new(None))
}

fn processing() -> &'static Mutex<ProcessingState> {
    PROCESSING.get_or_init(|| Mutex::new(ProcessingState::default()))
}

fn update_processing(active: bool, progress: f64, estimated_remaining_ms: Option<u64>) {
    if let Ok(mut state) = processing().lock() {
        state.active = active;
        state.progress = progress.clamp(0.0, 100.0);
        state.estimated_remaining_ms = estimated_remaining_ms;
        state.estimate_updated = Instant::now();
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn recordings_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .video_dir()
        .or_else(|_| app.path().desktop_dir())
        .map_err(|error| format!("recordings directory unavailable: {error}"))?;
    let path = base.join("MHTalk Recordings");
    fs::create_dir_all(&path)
        .map_err(|error| format!("could not create recordings directory: {error}"))?;
    Ok(path)
}

fn tools_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("app data directory unavailable: {error}"))?
        .join("recorder-tools");
    fs::create_dir_all(&path)
        .map_err(|error| format!("could not create recorder tools directory: {error}"))?;
    Ok(path)
}

fn ffmpeg_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(tools_dir(app)?.join("ffmpeg.exe"))
}

#[cfg(target_os = "windows")]
fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x00004000;
    let mut command = Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
    command
}

#[cfg(not(target_os = "windows"))]
fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    Command::new(program)
}

fn tool_works(path: &Path) -> bool {
    hidden_command(path)
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn install_ffmpeg(app: &tauri::AppHandle) -> Result<(), String> {
    let _guard = INSTALL_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "recorder installation lock failed".to_string())?;
    let target = ffmpeg_path(app)?;
    if tool_works(&target) {
        return Ok(());
    }
    let tools = tools_dir(app)?;
    let zip = tools.join("ffmpeg.download.zip");
    let sha = tools.join("ffmpeg.download.sha256");
    let extract = tools.join("ffmpeg-extract.tmp");
    let _ = fs::remove_file(&zip);
    let _ = fs::remove_file(&sha);
    let _ = fs::remove_dir_all(&extract);
    fs::create_dir_all(&extract).map_err(|error| error.to_string())?;
    let script = r#"
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -UseBasicParsing -Uri $env:MHTALK_FFMPEG_URL -OutFile $env:MHTALK_FFMPEG_ZIP
Invoke-WebRequest -UseBasicParsing -Uri $env:MHTALK_FFMPEG_SHA_URL -OutFile $env:MHTALK_FFMPEG_SHA
$expected=((Get-Content -LiteralPath $env:MHTALK_FFMPEG_SHA -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
$actual=(Get-FileHash -LiteralPath $env:MHTALK_FFMPEG_ZIP -Algorithm SHA256).Hash.ToLowerInvariant()
if ($expected -ne $actual) { throw 'FFmpeg integrity verification failed' }
Expand-Archive -LiteralPath $env:MHTALK_FFMPEG_ZIP -DestinationPath $env:MHTALK_FFMPEG_EXTRACT -Force
$ffmpeg=Get-ChildItem -LiteralPath $env:MHTALK_FFMPEG_EXTRACT -Recurse -Filter ffmpeg.exe | Select-Object -First 1
if ($null -eq $ffmpeg) { throw 'FFmpeg executable missing from package' }
Copy-Item -LiteralPath $ffmpeg.FullName -Destination $env:MHTALK_FFMPEG_TARGET -Force
"#;
    let output = hidden_command("powershell.exe")
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
        .env("MHTALK_FFMPEG_ZIP", &zip)
        .env("MHTALK_FFMPEG_SHA", &sha)
        .env("MHTALK_FFMPEG_EXTRACT", &extract)
        .env("MHTALK_FFMPEG_TARGET", &target)
        .output()
        .map_err(|error| format!("could not install recording engine: {error}"))?;
    let _ = fs::remove_file(zip);
    let _ = fs::remove_file(sha);
    let _ = fs::remove_dir_all(extract);
    if !output.status.success() || !tool_works(&target) {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if message.is_empty() {
            "recording engine installation failed".to_string()
        } else {
            message
        });
    }
    Ok(())
}

fn encoder_works(ffmpeg: &Path, encoder: &str) -> bool {
    hidden_command(ffmpeg)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=size=128x72:rate=30:duration=0.1",
            "-frames:v",
            "1",
            "-c:v",
            encoder,
            "-f",
            "null",
            "NUL",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn preferred_encoder(ffmpeg: &Path) -> String {
    ENCODER
        .get_or_init(|| {
            ["h264_nvenc", "h264_qsv", "h264_amf"]
                .into_iter()
                .find(|encoder| encoder_works(ffmpeg, encoder))
                .unwrap_or("libx264")
                .to_string()
        })
        .clone()
}

fn next_output_path(dir: &Path) -> PathBuf {
    let base = format!("MHTalk_Recording_{}.mp4", now_ms());
    let first = dir.join(&base);
    if !first.exists() {
        return first;
    }
    for index in 1..10_000 {
        let candidate = dir.join(format!("MHTalk_Recording_{}_{}.mp4", now_ms(), index));
        if !candidate.exists() {
            return candidate;
        }
    }
    first
}

fn video_input(settings: &NativeRecordingSettings) -> Vec<String> {
    let fps = settings.fps.clamp(15, 120).to_string();
    let source_label = settings.source_label.trim();
    let usable_window_title = settings.source_kind == "window"
        && !source_label.is_empty()
        && !source_label.to_ascii_lowercase().starts_with("window:")
        && !source_label.to_ascii_lowercase().starts_with("screen:");
    if usable_window_title {
        return vec![
            "-thread_queue_size".into(),
            "1024".into(),
            "-f".into(),
            "gdigrab".into(),
            "-draw_mouse".into(),
            "1".into(),
            "-framerate".into(),
            fps,
            "-i".into(),
            format!("title={source_label}"),
        ];
    }
    vec![
        "-thread_queue_size".into(),
        "1024".into(),
        "-f".into(),
        "lavfi".into(),
        "-i".into(),
        format!(
            "ddagrab=output_idx={}:framerate={}:draw_mouse=1",
            settings.output_index.min(15),
            fps
        ),
    ]
}

fn normalized_dimension(value: u32, fallback: u32) -> u32 {
    let value = value.clamp(320, 7_680);
    let even = value - value % 2;
    if even == 0 {
        fallback
    } else {
        even
    }
}

fn base_video_filter(settings: &NativeRecordingSettings) -> String {
    let width = normalized_dimension(settings.output_width, 1_920);
    let height = normalized_dimension(settings.output_height, 1_080);
    let resize = format!(
        "scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1"
    );
    if settings.source_kind == "window" {
        format!("{resize},format=bgra")
    } else {
        format!("hwdownload,format=bgra,{resize}")
    }
}

fn encoder_args(encoder: &str, quality: &str) -> Vec<String> {
    let quality_value = match quality {
        "performance" => "28",
        "balanced" => "23",
        "lossless" => "15",
        _ => "19",
    };
    match encoder {
        "h264_nvenc" => vec![
            "-preset".into(),
            "p5".into(),
            "-tune".into(),
            "hq".into(),
            "-rc".into(),
            "vbr".into(),
            "-cq".into(),
            quality_value.into(),
        ],
        "h264_qsv" => vec![
            "-preset".into(),
            "medium".into(),
            "-global_quality".into(),
            quality_value.into(),
        ],
        "h264_amf" => vec![
            "-quality".into(),
            "quality".into(),
            "-rc".into(),
            "cqp".into(),
            "-qp_i".into(),
            quality_value.into(),
            "-qp_p".into(),
            quality_value.into(),
        ],
        _ => vec![
            "-preset".into(),
            "veryfast".into(),
            "-crf".into(),
            quality_value.into(),
        ],
    }
}

fn connect_audio(port: u16, child: &mut Child) -> Result<TcpStream, String> {
    for _ in 0..120 {
        if let Ok(stream) = TcpStream::connect(("127.0.0.1", port)) {
            stream.set_nodelay(true).ok();
            return Ok(stream);
        }
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            return Err("recording engine stopped before audio connected".to_string());
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    Err("recording audio connection timed out".to_string())
}

fn spawn_capture(
    ffmpeg: &Path,
    settings: &NativeRecordingSettings,
    encoder: &str,
    temporary_path: &Path,
) -> Result<(Child, Option<TcpStream>), String> {
    let log_path = temporary_path.with_extension("ffmpeg.log");
    let log_file = fs::File::create(&log_path)
        .map_err(|error| format!("could not create recorder log: {error}"))?;
    let mut command = hidden_command(ffmpeg);
    command.args(["-y", "-hide_banner", "-loglevel", "warning"]);
    command.args(video_input(settings));
    let mut audio_port = None;
    let audio_input_index = 1;
    if settings.has_audio {
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())?;
        let port = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        drop(listener);
        audio_port = Some(port);
        command.args([
            "-thread_queue_size",
            "2048",
            "-f",
            "s16le",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-i",
            &format!("tcp://127.0.0.1:{port}?listen=1"),
        ]);
    }
    command.args(["-vf", &base_video_filter(settings)]);
    command.args(["-map", "0:v:0", "-c:v", encoder]);
    command.args(encoder_args(encoder, &settings.quality));
    command.args([
        "-pix_fmt",
        "yuv420p",
        "-g",
        &(settings.fps.clamp(15, 120) * 2).to_string(),
    ]);
    if settings.has_audio {
        command.args([
            "-map",
            &format!("{audio_input_index}:a:0"),
            "-c:a",
            "aac",
            "-b:a",
            "192k",
        ]);
    } else {
        command.arg("-an");
    }
    command
        .args(["-f", "matroska"])
        .arg(temporary_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::from(log_file));
    let mut child = command
        .spawn()
        .map_err(|error| format!("could not start recorder: {error}"))?;
    let audio = match audio_port {
        Some(port) => match connect_audio(port, &mut child) {
            Ok(stream) => Some(stream),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let details = fs::read_to_string(&log_path).unwrap_or_default();
                fs::remove_file(&log_path).ok();
                let details = details.trim();
                return Err(if details.is_empty() {
                    error
                } else {
                    format!("{error}: {details}")
                });
            }
        },
        None => None,
    };
    Ok((child, audio))
}

fn spawn_capture_resilient(
    ffmpeg: &Path,
    settings: &NativeRecordingSettings,
    encoder: &str,
    temporary_path: &Path,
) -> Result<(Child, Option<TcpStream>), String> {
    let attempts = 1;
    let mut last_error = String::new();
    for attempt in 0..attempts {
        match spawn_capture(ffmpeg, settings, encoder, temporary_path) {
            Ok(capture) => return Ok(capture),
            Err(error) => {
                last_error = error;
                fs::remove_file(temporary_path).ok();
                if attempt + 1 < attempts {
                    std::thread::sleep(Duration::from_millis(650));
                }
            }
        }
    }
    Err(last_error)
}

fn stop_capture(session: &mut NativeRecording) -> Result<(), String> {
    if let Some(stdin) = session.child.stdin.as_mut() {
        let _ = stdin.write_all(b"q\n");
        let _ = stdin.flush();
    }
    session.audio.take();
    let status = session.child.wait().map_err(|error| error.to_string())?;
    let current_path = session
        .temporary_paths
        .last()
        .ok_or_else(|| "recording segment is missing".to_string())?;
    let log_path = current_path.with_extension("ffmpeg.log");
    if !status.success() && fs::metadata(current_path).map(|m| m.len()).unwrap_or(0) == 0 {
        let details = fs::read_to_string(&log_path).unwrap_or_default();
        fs::remove_file(&log_path).ok();
        let details = details.trim();
        return Err(if details.is_empty() {
            "recording engine stopped without producing video".to_string()
        } else {
            format!("recording engine stopped: {details}")
        });
    }
    fs::remove_file(log_path).ok();
    Ok(())
}

fn remux(ffmpeg: &Path, temporary: &Path, final_path: &Path) -> Result<(), String> {
    let output = hidden_command(ffmpeg)
        .args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(temporary)
        .args(["-map", "0", "-c", "copy", "-movflags", "+faststart"])
        .arg(final_path)
        .output()
        .map_err(|error| format!("could not finalize MP4: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    fs::remove_file(temporary).ok();
    Ok(())
}

fn remux_with_progress(
    ffmpeg: &Path,
    temporary_paths: &[PathBuf],
    final_path: &Path,
    duration_ms: u64,
) -> Result<(), String> {
    if temporary_paths.is_empty() {
        return Err("recording has no video segments".to_string());
    }
    let mut command = hidden_command(ffmpeg);
    command.args(["-y", "-hide_banner", "-loglevel", "error"]);
    let concat_path = if temporary_paths.len() > 1 {
        let path = final_path.with_extension("segments.txt");
        let contents = temporary_paths
            .iter()
            .map(|segment| {
                let escaped = segment
                    .to_string_lossy()
                    .replace('\\', "/")
                    .replace('\'', "'\\''");
                format!("file '{escaped}'")
            })
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(&path, contents).map_err(|error| error.to_string())?;
        command
            .args(["-f", "concat", "-safe", "0", "-i"])
            .arg(&path);
        Some(path)
    } else {
        command.arg("-i").arg(&temporary_paths[0]);
        None
    };
    let mut child = command
        .args([
            "-map",
            "0",
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            "-progress",
            "pipe:1",
            "-nostats",
        ])
        .arg(final_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("could not finalize MP4: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "could not read video processing progress".to_string())?;
    let started = Instant::now();
    let duration_us = duration_ms.max(1).saturating_mul(1_000) as f64;
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        let Some(value) = line
            .strip_prefix("out_time_us=")
            .or_else(|| line.strip_prefix("out_time_ms="))
        else {
            continue;
        };
        let Ok(output_us) = value.parse::<f64>() else {
            continue;
        };
        let ratio = (output_us / duration_us).clamp(0.0, 1.0);
        let progress = 8.0 + ratio * 90.0;
        let estimated_remaining_ms = if ratio > 0.01 {
            let elapsed = started.elapsed().as_millis() as f64;
            Some(((elapsed / ratio - elapsed) + 250.0).max(0.0) as u64)
        } else {
            None
        };
        update_processing(true, progress, estimated_remaining_ms);
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("could not finalize MP4: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    update_processing(true, 99.0, Some(250));
    temporary_paths.iter().for_each(|path| {
        fs::remove_file(path).ok();
    });
    if let Some(path) = concat_path {
        fs::remove_file(path).ok();
    }
    Ok(())
}

fn recover_orphans(app: &tauri::AppHandle, ffmpeg: &Path) {
    let Ok(dir) = recordings_dir(app) else { return };
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !name.ends_with(".recording.mkv")
            || fs::metadata(&path).map(|m| m.len()).unwrap_or(0) == 0
        {
            continue;
        }
        let final_name = name.trim_end_matches(".recording.mkv").to_string() + ".mp4";
        let final_path = path.with_file_name(final_name);
        let _ = remux(ffmpeg, &path, &final_path);
    }
}

pub fn warm_up(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        if install_ffmpeg(&app).is_ok() {
            if let Ok(ffmpeg) = ffmpeg_path(&app) {
                let _ = preferred_encoder(&ffmpeg);
                recover_orphans(&app, &ffmpeg);
            }
        }
    });
}

#[tauri::command]
pub async fn recorder_capabilities(app: tauri::AppHandle) -> RecorderCapabilities {
    let fallback_app = app.clone();
    match tauri::async_runtime::spawn_blocking(move || recorder_capabilities_blocking(&app)).await {
        Ok(capabilities) => capabilities,
        Err(error) => RecorderCapabilities {
            ready: false,
            encoder: String::new(),
            recordings_folder: recordings_dir(&fallback_app)
                .unwrap_or_default()
                .to_string_lossy()
                .to_string(),
            message: format!("recording engine check failed: {error}"),
        },
    }
}

fn recorder_capabilities_blocking(app: &tauri::AppHandle) -> RecorderCapabilities {
    let folder = recordings_dir(&app).unwrap_or_default();
    match install_ffmpeg(&app) {
        Ok(()) => {
            let ffmpeg = ffmpeg_path(&app).unwrap_or_default();
            RecorderCapabilities {
                ready: true,
                encoder: preferred_encoder(&ffmpeg),
                recordings_folder: folder.to_string_lossy().to_string(),
                message: "Ready".into(),
            }
        }
        Err(message) => RecorderCapabilities {
            ready: false,
            encoder: String::new(),
            recordings_folder: folder.to_string_lossy().to_string(),
            message,
        },
    }
}

#[tauri::command]
pub async fn start_native_recording(
    app: tauri::AppHandle,
    settings: NativeRecordingSettings,
) -> Result<NativeRecordingStatus, String> {
    tauri::async_runtime::spawn_blocking(move || start_native_recording_blocking(&app, settings))
        .await
        .map_err(|error| format!("recording task failed: {error}"))?
}

fn start_native_recording_blocking(
    app: &tauri::AppHandle,
    settings: NativeRecordingSettings,
) -> Result<NativeRecordingStatus, String> {
    install_ffmpeg(&app)?;
    let mut guard = active()
        .lock()
        .map_err(|_| "recorder state unavailable".to_string())?;
    if guard.is_some() {
        return Err("a recording is already running".to_string());
    }
    let ffmpeg = ffmpeg_path(&app)?;
    let encoder = preferred_encoder(&ffmpeg);
    let final_path = next_output_path(&recordings_dir(&app)?);
    let temporary_path = final_path.with_extension("recording.mkv");
    let (child, audio) = spawn_capture_resilient(&ffmpeg, &settings, &encoder, &temporary_path)?;
    let status = NativeRecordingStatus {
        active: true,
        elapsed_ms: 0,
        bytes: 0,
        path: Some(final_path.to_string_lossy().to_string()),
        encoder: Some(encoder.clone()),
    };
    *guard = Some(NativeRecording {
        child,
        audio,
        temporary_paths: vec![temporary_path],
        final_path,
        started: Instant::now(),
        encoder,
        output_width: normalized_dimension(settings.output_width, 1_920),
        output_height: normalized_dimension(settings.output_height, 1_080),
    });
    Ok(status)
}

#[tauri::command]
pub async fn switch_native_recording_source(
    app: tauri::AppHandle,
    settings: NativeRecordingSettings,
) -> Result<NativeRecordingStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        switch_native_recording_source_blocking(&app, settings)
    })
    .await
    .map_err(|error| format!("scene switch task failed: {error}"))?
}

fn switch_native_recording_source_blocking(
    app: &tauri::AppHandle,
    mut settings: NativeRecordingSettings,
) -> Result<NativeRecordingStatus, String> {
    let ffmpeg = ffmpeg_path(app)?;
    let mut guard = active()
        .lock()
        .map_err(|_| "recorder state unavailable".to_string())?;
    let session = guard
        .as_mut()
        .ok_or_else(|| "recording is not active".to_string())?;
    settings.output_width = session.output_width;
    settings.output_height = session.output_height;
    let segment_number = session.temporary_paths.len() + 1;
    let temporary_path = session
        .final_path
        .with_extension(format!("scene-{segment_number}.recording.mkv"));
    let (mut new_child, new_audio) =
        spawn_capture_resilient(&ffmpeg, &settings, &session.encoder, &temporary_path)?;
    if let Err(error) = stop_capture(session) {
        let _ = new_child.kill();
        fs::remove_file(&temporary_path).ok();
        return Err(error);
    }
    session.child = new_child;
    session.audio = new_audio;
    session.temporary_paths.push(temporary_path);
    Ok(NativeRecordingStatus {
        active: true,
        elapsed_ms: session.started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        bytes: session
            .temporary_paths
            .iter()
            .filter_map(|path| fs::metadata(path).ok())
            .map(|metadata| metadata.len())
            .sum(),
        path: Some(session.final_path.to_string_lossy().to_string()),
        encoder: Some(session.encoder.clone()),
    })
}

#[tauri::command]
pub fn append_native_recording_audio(samples: Vec<i16>) -> Result<(), String> {
    let mut guard = active()
        .lock()
        .map_err(|_| "recorder state unavailable".to_string())?;
    let session = guard
        .as_mut()
        .ok_or_else(|| "recording is not active".to_string())?;
    let Some(stream) = session.audio.as_mut() else {
        return Ok(());
    };
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    stream
        .write_all(&bytes)
        .map_err(|error| format!("could not write recording audio: {error}"))
}

#[tauri::command]
pub fn native_recording_status() -> NativeRecordingStatus {
    let Ok(guard) = active().lock() else {
        return NativeRecordingStatus {
            active: false,
            elapsed_ms: 0,
            bytes: 0,
            path: None,
            encoder: None,
        };
    };
    let Some(session) = guard.as_ref() else {
        return NativeRecordingStatus {
            active: false,
            elapsed_ms: 0,
            bytes: 0,
            path: None,
            encoder: None,
        };
    };
    NativeRecordingStatus {
        active: true,
        elapsed_ms: session.started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        bytes: session
            .temporary_paths
            .iter()
            .filter_map(|path| fs::metadata(path).ok())
            .map(|metadata| metadata.len())
            .sum(),
        path: Some(session.final_path.to_string_lossy().to_string()),
        encoder: Some(session.encoder.clone()),
    }
}

#[tauri::command]
pub fn native_recording_processing_status() -> NativeRecordingProcessingStatus {
    let Ok(state) = processing().lock() else {
        return NativeRecordingProcessingStatus {
            active: false,
            progress: 0.0,
            estimated_remaining_ms: None,
        };
    };
    let estimated_remaining_ms = state.estimated_remaining_ms.map(|estimate| {
        estimate.saturating_sub(
            state
                .estimate_updated
                .elapsed()
                .as_millis()
                .min(u64::MAX as u128) as u64,
        )
    });
    NativeRecordingProcessingStatus {
        active: state.active,
        progress: state.progress,
        estimated_remaining_ms,
    }
}

#[tauri::command]
pub async fn stop_native_recording(app: tauri::AppHandle) -> Result<NativeRecordingResult, String> {
    tauri::async_runtime::spawn_blocking(move || stop_native_recording_blocking(&app))
        .await
        .map_err(|error| format!("video processing task failed: {error}"))?
}

fn stop_native_recording_blocking(app: &tauri::AppHandle) -> Result<NativeRecordingResult, String> {
    let session = active()
        .lock()
        .map_err(|_| "recorder state unavailable".to_string())?
        .take()
        .ok_or_else(|| "recording is not active".to_string())?;
    let duration_ms = session.started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    let initial_estimate = (duration_ms / 40 + 1_000).clamp(1_000, 30_000);
    update_processing(true, 2.0, Some(initial_estimate));
    let result = finalize_session(app, session, Some(duration_ms));
    match &result {
        Ok(_) => update_processing(false, 100.0, Some(0)),
        Err(_) => update_processing(false, 0.0, None),
    }
    result
}

fn finalize_session(
    app: &tauri::AppHandle,
    mut session: NativeRecording,
    progress_duration_ms: Option<u64>,
) -> Result<NativeRecordingResult, String> {
    stop_capture(&mut session)?;
    let ffmpeg = ffmpeg_path(app)?;
    if let Some(duration_ms) = progress_duration_ms {
        update_processing(true, 8.0, None);
        remux_with_progress(
            &ffmpeg,
            &session.temporary_paths,
            &session.final_path,
            duration_ms,
        )?;
    } else if session.temporary_paths.len() > 1 {
        remux_with_progress(
            &ffmpeg,
            &session.temporary_paths,
            &session.final_path,
            session.started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        )?;
    } else {
        remux(&ffmpeg, &session.temporary_paths[0], &session.final_path)?;
    }
    let size = fs::metadata(&session.final_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    Ok(NativeRecordingResult {
        path: session.final_path.to_string_lossy().to_string(),
        size,
        encoder: session.encoder,
    })
}

pub fn shutdown(app: &tauri::AppHandle) {
    let session = active().lock().ok().and_then(|mut value| value.take());
    if let Some(session) = session {
        let _ = finalize_session(app, session, None);
    }
}

#[tauri::command]
pub fn open_native_recordings_folder(app: tauri::AppHandle) -> Result<String, String> {
    let path = recordings_dir(&app)?;
    hidden_command("explorer.exe")
        .arg(&path)
        .spawn()
        .map_err(|error| error.to_string())?;
    Ok(path.to_string_lossy().to_string())
}
