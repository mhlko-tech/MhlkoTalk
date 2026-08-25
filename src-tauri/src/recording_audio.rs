use nnnoiseless::DenoiseState;
use std::collections::VecDeque;
use std::io::Write;
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use wasapi::{DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};

const SAMPLE_RATE: usize = 48_000;
const CHANNELS: usize = 2;
const FRAMES_PER_BLOCK: usize = 480;
const SAMPLES_PER_BLOCK: usize = FRAMES_PER_BLOCK * CHANNELS;
const BYTES_PER_FRAME: usize = CHANNELS * std::mem::size_of::<f32>();
const MAX_QUEUED_FRAMES: usize = SAMPLE_RATE;

#[derive(Clone, Copy)]
enum SourceKind {
    System,
    Microphone,
}

struct AudioPacket {
    samples: Vec<f32>,
    discontinuity: bool,
}

#[derive(Default)]
struct AudioStats {
    system_level: AtomicU32,
    microphone_level: AtomicU32,
    system_discontinuities: AtomicU64,
    microphone_discontinuities: AtomicU64,
    system_underruns: AtomicU64,
    microphone_underruns: AtomicU64,
    writer_errors: AtomicU64,
}

#[derive(Debug, Clone, Copy)]
pub struct AudioPipelineStatus {
    pub system_level: f32,
    pub microphone_level: f32,
    pub system_discontinuities: u64,
    pub microphone_discontinuities: u64,
    pub system_underruns: u64,
    pub microphone_underruns: u64,
    pub writer_errors: u64,
}

pub struct AudioPipeline {
    stop: Arc<AtomicBool>,
    system_enabled: Arc<AtomicBool>,
    microphone_enabled: Arc<AtomicBool>,
    system_gain: Arc<AtomicU32>,
    microphone_gain: Arc<AtomicU32>,
    noise_cancellation: Arc<AtomicBool>,
    output: Arc<Mutex<Option<TcpStream>>>,
    stats: Arc<AudioStats>,
    handles: Vec<JoinHandle<()>>,
}

impl AudioPipeline {
    pub fn start(
        output_stream: TcpStream,
        include_system: bool,
        include_microphone: bool,
        system_gain: f32,
        microphone_gain: f32,
        noise_cancellation: bool,
    ) -> Result<Self, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let system_enabled = Arc::new(AtomicBool::new(include_system));
        let microphone_enabled = Arc::new(AtomicBool::new(include_microphone));
        let system_gain = Arc::new(AtomicU32::new(
            if include_system { system_gain } else { 0.0 }
                .clamp(0.0, 2.0)
                .to_bits(),
        ));
        let microphone_gain = Arc::new(AtomicU32::new(
            if include_microphone {
                microphone_gain
            } else {
                0.0
            }
            .clamp(0.0, 2.0)
            .to_bits(),
        ));
        let noise_cancellation = Arc::new(AtomicBool::new(noise_cancellation));
        let output = Arc::new(Mutex::new(Some(output_stream)));
        let stats = Arc::new(AudioStats::default());
        let (system_tx, system_rx) = mpsc::sync_channel(128);
        let (microphone_tx, microphone_rx) = mpsc::sync_channel(128);
        let (system_ready_tx, system_ready_rx) = mpsc::sync_channel(1);
        let (microphone_ready_tx, microphone_ready_rx) = mpsc::sync_channel(1);

        let system_stop = Arc::clone(&stop);
        let system_capture_enabled = Arc::clone(&system_enabled);
        let system_stats = Arc::clone(&stats);
        let system_handle = thread::Builder::new()
            .name("MHTalk WASAPI system capture".into())
            .spawn(move || {
                capture_source(
                    SourceKind::System,
                    system_tx,
                    system_ready_tx,
                    system_stop,
                    system_capture_enabled,
                    system_stats,
                );
            })
            .map_err(|error| format!("could not start desktop audio capture: {error}"))?;

        let microphone_stop = Arc::clone(&stop);
        let microphone_capture_enabled = Arc::clone(&microphone_enabled);
        let microphone_stats = Arc::clone(&stats);
        let microphone_handle = match thread::Builder::new()
            .name("MHTalk WASAPI microphone capture".into())
            .spawn(move || {
                capture_source(
                    SourceKind::Microphone,
                    microphone_tx,
                    microphone_ready_tx,
                    microphone_stop,
                    microphone_capture_enabled,
                    microphone_stats,
                );
            }) {
            Ok(handle) => handle,
            Err(error) => {
                stop.store(true, Ordering::Release);
                let _ = system_handle.join();
                return Err(format!("could not start microphone capture: {error}"));
            }
        };

        let system_ready = system_ready_rx
            .recv_timeout(Duration::from_secs(4))
            .unwrap_or_else(|_| Err("desktop audio capture timed out".into()));
        let microphone_ready = microphone_ready_rx
            .recv_timeout(Duration::from_secs(4))
            .unwrap_or_else(|_| Err("microphone capture timed out".into()));
        let startup_error = if include_system {
            system_ready.err()
        } else {
            None
        }
        .or_else(|| {
            if include_microphone {
                microphone_ready.err()
            } else {
                None
            }
        });
        if let Some(error) = startup_error {
            stop.store(true, Ordering::Release);
            let _ = system_handle.join();
            let _ = microphone_handle.join();
            return Err(error);
        }

        let mixer_stop = Arc::clone(&stop);
        let mixer_system_enabled = Arc::clone(&system_enabled);
        let mixer_microphone_enabled = Arc::clone(&microphone_enabled);
        let mixer_system_gain = Arc::clone(&system_gain);
        let mixer_microphone_gain = Arc::clone(&microphone_gain);
        let mixer_noise_cancellation = Arc::clone(&noise_cancellation);
        let mixer_output = Arc::clone(&output);
        let mixer_stats = Arc::clone(&stats);
        let mixer_handle = thread::Builder::new()
            .name("MHTalk recording audio mixer".into())
            .spawn(move || {
                mix_and_write(
                    system_rx,
                    microphone_rx,
                    mixer_stop,
                    mixer_system_enabled,
                    mixer_microphone_enabled,
                    mixer_system_gain,
                    mixer_microphone_gain,
                    mixer_noise_cancellation,
                    mixer_output,
                    mixer_stats,
                );
            })
            .map_err(|error| format!("could not start recording audio mixer: {error}"))?;

        Ok(Self {
            stop,
            system_enabled,
            microphone_enabled,
            system_gain,
            microphone_gain,
            noise_cancellation,
            output,
            stats,
            handles: vec![system_handle, microphone_handle, mixer_handle],
        })
    }

    pub fn update_mix(
        &self,
        include_system: bool,
        include_microphone: bool,
        system_gain: f32,
        microphone_gain: f32,
        noise_cancellation: bool,
    ) {
        self.system_enabled.store(include_system, Ordering::Release);
        self.microphone_enabled
            .store(include_microphone, Ordering::Release);
        self.system_gain.store(
            (if include_system { system_gain } else { 0.0 })
                .clamp(0.0, 2.0)
                .to_bits(),
            Ordering::Relaxed,
        );
        self.microphone_gain.store(
            (if include_microphone {
                microphone_gain
            } else {
                0.0
            })
            .clamp(0.0, 2.0)
            .to_bits(),
            Ordering::Relaxed,
        );
        self.noise_cancellation
            .store(noise_cancellation, Ordering::Relaxed);
    }

    pub fn replace_output(&self, stream: TcpStream) -> Result<(), String> {
        let mut output = self
            .output
            .lock()
            .map_err(|_| "recording audio output unavailable".to_string())?;
        *output = Some(stream);
        Ok(())
    }

    pub fn status(&self) -> AudioPipelineStatus {
        AudioPipelineStatus {
            system_level: f32::from_bits(self.stats.system_level.load(Ordering::Relaxed)),
            microphone_level: f32::from_bits(self.stats.microphone_level.load(Ordering::Relaxed)),
            system_discontinuities: self.stats.system_discontinuities.load(Ordering::Relaxed),
            microphone_discontinuities: self
                .stats
                .microphone_discontinuities
                .load(Ordering::Relaxed),
            system_underruns: self.stats.system_underruns.load(Ordering::Relaxed),
            microphone_underruns: self.stats.microphone_underruns.load(Ordering::Relaxed),
            writer_errors: self.stats.writer_errors.load(Ordering::Relaxed),
        }
    }

    pub fn stop(mut self) {
        self.stop.store(true, Ordering::Release);
        for handle in self.handles.drain(..) {
            let _ = handle.join();
        }
        if let Ok(mut output) = self.output.lock() {
            output.take();
        }
    }
}

fn capture_source(
    kind: SourceKind,
    sender: mpsc::SyncSender<AudioPacket>,
    ready: mpsc::SyncSender<Result<(), String>>,
    stop: Arc<AtomicBool>,
    enabled: Arc<AtomicBool>,
    stats: Arc<AudioStats>,
) {
    let mut ready = Some(ready);
    while !stop.load(Ordering::Acquire) {
        if !enabled.load(Ordering::Acquire) {
            if let Some(ready) = ready.take() {
                let _ = ready.send(Ok(()));
            }
            thread::sleep(Duration::from_millis(25));
            continue;
        }
        if let Err(error) = capture_source_inner(kind, &sender, &mut ready, &stop, &enabled, &stats)
        {
            if let Some(ready) = ready.take() {
                let _ = ready.send(Err(error));
            }
            thread::sleep(Duration::from_millis(250));
        }
    }
}

fn capture_source_inner(
    kind: SourceKind,
    sender: &mpsc::SyncSender<AudioPacket>,
    ready: &mut Option<mpsc::SyncSender<Result<(), String>>>,
    stop: &AtomicBool,
    enabled: &AtomicBool,
    stats: &AudioStats,
) -> Result<(), String> {
    wasapi::initialize_mta()
        .ok()
        .map_err(|error| format!("could not initialize Windows audio: {error}"))?;
    let enumerator = DeviceEnumerator::new().map_err(|error| error.to_string())?;
    let endpoint_direction = match kind {
        SourceKind::System => Direction::Render,
        SourceKind::Microphone => Direction::Capture,
    };
    let device = enumerator
        .get_default_device(&endpoint_direction)
        .map_err(|error| error.to_string())?;
    let mut audio_client = device
        .get_iaudioclient()
        .map_err(|error| error.to_string())?;
    let desired_format = WaveFormat::new(32, 32, &SampleType::Float, SAMPLE_RATE, CHANNELS, None);
    let (default_period, _) = audio_client
        .get_device_period()
        .map_err(|error| error.to_string())?;
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: default_period,
    };
    audio_client
        .initialize_client(&desired_format, &Direction::Capture, &mode)
        .map_err(|error| error.to_string())?;
    let event = audio_client
        .set_get_eventhandle()
        .map_err(|error| error.to_string())?;
    let capture = audio_client
        .get_audiocaptureclient()
        .map_err(|error| error.to_string())?;
    audio_client
        .start_stream()
        .map_err(|error| error.to_string())?;
    if let Some(ready) = ready.take() {
        let _ = ready.send(Ok(()));
    }

    while !stop.load(Ordering::Acquire) && enabled.load(Ordering::Acquire) {
        if event.wait_for_event(100).is_err() {
            continue;
        }
        loop {
            let frames = capture
                .get_next_packet_size()
                .map_err(|error| error.to_string())?
                .unwrap_or(0);
            if frames == 0 {
                break;
            }
            let mut bytes = vec![0u8; frames as usize * BYTES_PER_FRAME];
            let (frames_read, info) = capture
                .read_from_device(&mut bytes)
                .map_err(|error| error.to_string())?;
            bytes.truncate(frames_read as usize * BYTES_PER_FRAME);
            let samples = if info.flags.silent {
                vec![0.0; frames_read as usize * CHANNELS]
            } else {
                bytes
                    .chunks_exact(4)
                    .map(|value| f32::from_le_bytes([value[0], value[1], value[2], value[3]]))
                    .collect()
            };
            if info.flags.data_discontinuity {
                match kind {
                    SourceKind::System => {
                        stats.system_discontinuities.fetch_add(1, Ordering::Relaxed);
                    }
                    SourceKind::Microphone => {
                        stats
                            .microphone_discontinuities
                            .fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
            if sender
                .try_send(AudioPacket {
                    samples,
                    discontinuity: info.flags.data_discontinuity,
                })
                .is_err()
            {
                match kind {
                    SourceKind::System => {
                        stats.system_underruns.fetch_add(1, Ordering::Relaxed);
                    }
                    SourceKind::Microphone => {
                        stats.microphone_underruns.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
        }
    }
    let _ = audio_client.stop_stream();
    wasapi::deinitialize();
    Ok(())
}

fn drain_packets(receiver: &mpsc::Receiver<AudioPacket>, queue: &mut VecDeque<f32>) {
    while let Ok(packet) = receiver.try_recv() {
        if packet.discontinuity && !queue.len().is_multiple_of(CHANNELS) {
            queue.pop_back();
        }
        queue.extend(packet.samples);
    }
    let max_samples = MAX_QUEUED_FRAMES * CHANNELS;
    while queue.len() > max_samples {
        queue.pop_front();
    }
}

fn take_block(
    queue: &mut VecDeque<f32>,
    underruns: &AtomicU64,
    enabled: bool,
) -> [f32; SAMPLES_PER_BLOCK] {
    let mut block = [0.0; SAMPLES_PER_BLOCK];
    if !enabled {
        queue.clear();
        return block;
    }
    let available = queue.len().min(SAMPLES_PER_BLOCK);
    for sample in block.iter_mut().take(available) {
        *sample = queue.pop_front().unwrap_or(0.0);
    }
    if available < SAMPLES_PER_BLOCK {
        underruns.fetch_add(1, Ordering::Relaxed);
    }
    block
}

fn smooth_gain(block: &mut [f32], current: &mut f32, target: f32) {
    let start = *current;
    for frame in 0..FRAMES_PER_BLOCK {
        let amount = (frame + 1) as f32 / FRAMES_PER_BLOCK as f32;
        let gain = start + (target - start) * amount;
        block[frame * 2] *= gain;
        block[frame * 2 + 1] *= gain;
    }
    *current = target;
}

fn level(block: &[f32]) -> f32 {
    let energy = block.iter().map(|sample| sample * sample).sum::<f32>();
    ((energy / block.len().max(1) as f32).sqrt() * 2.4).clamp(0.0, 1.0)
}

fn denoise_microphone(block: &mut [f32; SAMPLES_PER_BLOCK], state: &mut DenoiseState<'static>) {
    let mut input = [0.0f32; FRAMES_PER_BLOCK];
    let mut output = [0.0f32; FRAMES_PER_BLOCK];
    for frame in 0..FRAMES_PER_BLOCK {
        input[frame] = (block[frame * 2] + block[frame * 2 + 1]) * 0.5 * i16::MAX as f32;
    }
    state.process_frame(&mut output, &input);
    for frame in 0..FRAMES_PER_BLOCK {
        let sample = (output[frame] / i16::MAX as f32).clamp(-1.0, 1.0);
        block[frame * 2] = sample;
        block[frame * 2 + 1] = sample;
    }
}

fn apply_noise_cancellation(
    block: &mut [f32; SAMPLES_PER_BLOCK],
    state: &mut DenoiseState<'static>,
    current_mix: &mut f32,
    enabled: bool,
) {
    let target_mix = if enabled { 1.0 } else { 0.0 };
    if target_mix == 0.0 && *current_mix == 0.0 {
        return;
    }
    let original = *block;
    denoise_microphone(block, state);
    let start_mix = *current_mix;
    for frame in 0..FRAMES_PER_BLOCK {
        let amount = (frame + 1) as f32 / FRAMES_PER_BLOCK as f32;
        let mix = start_mix + (target_mix - start_mix) * amount;
        for channel in 0..CHANNELS {
            let index = frame * CHANNELS + channel;
            block[index] = original[index] * (1.0 - mix) + block[index] * mix;
        }
    }
    *current_mix = target_mix;
}

#[allow(clippy::too_many_arguments)]
fn mix_and_write(
    system_receiver: mpsc::Receiver<AudioPacket>,
    microphone_receiver: mpsc::Receiver<AudioPacket>,
    stop: Arc<AtomicBool>,
    system_enabled: Arc<AtomicBool>,
    microphone_enabled: Arc<AtomicBool>,
    system_gain: Arc<AtomicU32>,
    microphone_gain: Arc<AtomicU32>,
    noise_cancellation: Arc<AtomicBool>,
    output: Arc<Mutex<Option<TcpStream>>>,
    stats: Arc<AudioStats>,
) {
    let mut system_queue = VecDeque::with_capacity(SAMPLES_PER_BLOCK * 16);
    let mut microphone_queue = VecDeque::with_capacity(SAMPLES_PER_BLOCK * 16);
    let mut current_system_gain = f32::from_bits(system_gain.load(Ordering::Relaxed));
    let mut current_microphone_gain = f32::from_bits(microphone_gain.load(Ordering::Relaxed));
    let mut denoise = DenoiseState::new();
    let mut current_noise_mix = 0.0f32;
    let started = Instant::now();
    let mut block_index = 0u64;

    // A short native pre-roll absorbs normal device scheduling jitter while FFmpeg
    // still timestamps the first raw PCM frame at zero.
    while started.elapsed() < Duration::from_millis(60) && !stop.load(Ordering::Acquire) {
        drain_packets(&system_receiver, &mut system_queue);
        drain_packets(&microphone_receiver, &mut microphone_queue);
        thread::sleep(Duration::from_millis(2));
    }
    let clock = Instant::now();

    while !stop.load(Ordering::Acquire) {
        drain_packets(&system_receiver, &mut system_queue);
        drain_packets(&microphone_receiver, &mut microphone_queue);
        let system_is_enabled = system_enabled.load(Ordering::Acquire);
        let microphone_is_enabled = microphone_enabled.load(Ordering::Acquire);
        let system_should_drain = system_is_enabled || current_system_gain > 0.0001;
        let microphone_should_drain = microphone_is_enabled || current_microphone_gain > 0.0001;
        let mut system = take_block(
            &mut system_queue,
            &stats.system_underruns,
            system_should_drain,
        );
        let mut microphone = take_block(
            &mut microphone_queue,
            &stats.microphone_underruns,
            microphone_should_drain,
        );

        if microphone_should_drain {
            apply_noise_cancellation(
                &mut microphone,
                &mut denoise,
                &mut current_noise_mix,
                noise_cancellation.load(Ordering::Relaxed),
            );
        } else if current_noise_mix != 0.0 {
            current_noise_mix = 0.0;
            denoise = DenoiseState::new();
        }
        smooth_gain(
            &mut system,
            &mut current_system_gain,
            f32::from_bits(system_gain.load(Ordering::Relaxed)).clamp(0.0, 2.0),
        );
        smooth_gain(
            &mut microphone,
            &mut current_microphone_gain,
            f32::from_bits(microphone_gain.load(Ordering::Relaxed)).clamp(0.0, 2.0),
        );
        stats
            .system_level
            .store(level(&system).to_bits(), Ordering::Relaxed);
        stats
            .microphone_level
            .store(level(&microphone).to_bits(), Ordering::Relaxed);

        let mut bytes = Vec::with_capacity(SAMPLES_PER_BLOCK * 2);
        for index in 0..SAMPLES_PER_BLOCK {
            let mixed = (system[index] + microphone[index]).clamp(-1.0, 1.0);
            let sample = if mixed < 0.0 {
                (mixed * 32768.0).round() as i16
            } else {
                (mixed * 32767.0).round() as i16
            };
            bytes.extend_from_slice(&sample.to_le_bytes());
        }

        let write_result = output.lock().map_err(|_| ()).and_then(|mut stream| {
            stream
                .as_mut()
                .ok_or(())
                .and_then(|s| s.write_all(&bytes).map_err(|_| ()))
        });
        if write_result.is_err() {
            stats.writer_errors.fetch_add(1, Ordering::Relaxed);
        }

        block_index += 1;
        let deadline = clock + Duration::from_millis(block_index * 10);
        let now = Instant::now();
        if deadline > now {
            thread::sleep(deadline - now);
        }
    }
    stats
        .system_level
        .store(0.0f32.to_bits(), Ordering::Relaxed);
    stats
        .microphone_level
        .store(0.0f32.to_bits(), Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;

    #[test]
    fn gain_changes_are_smoothed_across_a_block() {
        let mut samples = [1.0; SAMPLES_PER_BLOCK];
        let mut current = 1.0;
        smooth_gain(&mut samples, &mut current, 0.0);
        assert!(samples[0] > 0.99);
        assert!(samples[SAMPLES_PER_BLOCK - 1].abs() < f32::EPSILON);
        assert_eq!(current, 0.0);
    }

    #[test]
    fn missing_capture_samples_become_timeline_preserving_silence() {
        let mut queue = VecDeque::from(vec![0.25; 100]);
        let underruns = AtomicU64::new(0);
        let block = take_block(&mut queue, &underruns, true);
        assert!(block[..100].iter().all(|sample| *sample == 0.25));
        assert!(block[100..].iter().all(|sample| *sample == 0.0));
        assert_eq!(underruns.load(Ordering::Relaxed), 1);
    }

    #[test]
    #[ignore = "requires active Windows playback and microphone endpoints"]
    fn wasapi_pipeline_produces_continuous_pcm() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let reader = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut audio = Vec::new();
            let mut buffer = [0u8; 16_384];
            while let Ok(read) = stream.read(&mut buffer) {
                if read == 0 {
                    break;
                }
                audio.extend_from_slice(&buffer[..read]);
            }
            audio
        });
        let stream = TcpStream::connect(address).unwrap();
        let pipeline = AudioPipeline::start(stream, true, true, 1.0, 1.0, true).unwrap();
        thread::sleep(Duration::from_secs(3));
        pipeline.stop();
        let audio = reader.join().unwrap();
        assert!(
            audio.len() > 480_000,
            "only received {} bytes of PCM",
            audio.len()
        );
        assert_eq!(audio.len() % (FRAMES_PER_BLOCK * 4), 0);

        let left: Vec<i16> = audio
            .chunks_exact(4)
            .map(|frame| i16::from_le_bytes([frame[0], frame[1]]))
            .collect();
        let mut boundary_sum = 0.0f64;
        let mut boundary_count = 0usize;
        let mut regular_sum = 0.0f64;
        let mut regular_count = 0usize;
        for frame in 1..left.len() {
            let derivative = (left[frame] as i32 - left[frame - 1] as i32).unsigned_abs() as f64;
            if frame.is_multiple_of(FRAMES_PER_BLOCK) {
                boundary_sum += derivative;
                boundary_count += 1;
            } else {
                regular_sum += derivative;
                regular_count += 1;
            }
        }
        let boundary_mean = boundary_sum / boundary_count.max(1) as f64;
        let regular_mean = regular_sum / regular_count.max(1) as f64;
        let ratio = boundary_mean / regular_mean.max(1.0);
        eprintln!(
            "captured {} bytes; boundary derivative ratio {:.3}",
            audio.len(),
            ratio
        );
        assert!(ratio < 2.0, "periodic block-boundary impulses detected");
    }
}
