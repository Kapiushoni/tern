//! Voice input: records the microphone, then turns the speech into text with whisper.cpp,
//! entirely on this computer. The speech model is downloaded once, on request.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SizedSample};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// The speech models Tern offers: (id, file, approximate size in bytes).
const MODELS: &[(&str, &str, u64)] = &[
    ("small", "ggml-small.bin", 487_601_967),
    ("large-v3-turbo", "ggml-large-v3-turbo-q5_0.bin", 574_041_195),
];
const MODEL_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";
/// whisper works on 16 kHz mono.
const RATE: u32 = 16_000;
/// A loaded model takes hundreds of MB, so it is dropped after this long without use.
const KEEP_LOADED: Duration = Duration::from_secs(180);
/// Longest recording kept; anything past it is dropped.
const MAX_SECONDS: usize = 600;

struct Recording {
    stop: mpsc::Sender<()>,
    samples: Arc<Mutex<Vec<f32>>>,
    rate: u32,
    thread: std::thread::JoinHandle<()>,
}

struct Loaded {
    id: String,
    ctx: Arc<WhisperContext>,
    used: Instant,
}

#[derive(Default)]
pub struct VoiceState {
    rec: Mutex<Option<Recording>>,
    model: Arc<Mutex<Option<Loaded>>>,
    downloading: Mutex<Option<Arc<AtomicBool>>>,
}

#[derive(Serialize)]
pub struct Mic {
    id: String,
    name: String,
    default: bool,
}

#[derive(Serialize)]
pub struct ModelInfo {
    id: &'static str,
    size: u64,
    installed: bool,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DownloadEvent {
    Progress { done: u64, total: u64 },
}

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("models");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn model_file(id: &str) -> Result<&'static str, String> {
    MODELS.iter().find(|m| m.0 == id).map(|m| m.1).ok_or_else(|| "unknown-model".into())
}

#[tauri::command]
pub fn voice_models(app: AppHandle) -> Result<Vec<ModelInfo>, String> {
    let dir = models_dir(&app)?;
    Ok(MODELS
        .iter()
        .map(|&(id, file, size)| ModelInfo { id, size, installed: dir.join(file).is_file() })
        .collect())
}

#[tauri::command]
pub fn voice_mics() -> Vec<Mic> {
    let host = cpal::default_host();
    let default = host.default_input_device().and_then(|d| d.id().ok()).map(|id| id.to_string());
    let Ok(devices) = host.input_devices() else { return Vec::new() };
    devices
        .filter_map(|d| {
            let id = d.id().ok()?.to_string();
            let name = d.description().map(|n| n.name().to_string()).unwrap_or_else(|_| id.clone());
            Some(Mic { default: Some(&id) == default.as_ref(), id, name })
        })
        .collect()
}

/// Downloads a model to the models folder, reporting progress. A `.part` file is renamed into
/// place only once complete, so a broken download never looks installed.
#[tauri::command]
pub async fn voice_download(
    app: AppHandle,
    state: State<'_, VoiceState>,
    model: String,
    on_event: Channel<DownloadEvent>,
) -> Result<(), String> {
    let file = model_file(&model)?;
    let dir = models_dir(&app)?;
    let cancel = Arc::new(AtomicBool::new(false));
    *state.downloading.lock().unwrap() = Some(cancel.clone());
    let result = tauri::async_runtime::spawn_blocking(move || {
        let part = dir.join(format!("{file}.part"));
        let result = download(&format!("{MODEL_URL}{file}"), &part, &cancel, &on_event);
        match result {
            Ok(()) => std::fs::rename(&part, dir.join(file)).map_err(|e| e.to_string()),
            Err(e) => {
                let _ = std::fs::remove_file(&part);
                Err(e)
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    *state.downloading.lock().unwrap() = None;
    result
}

fn download(url: &str, to: &PathBuf, cancel: &AtomicBool, events: &Channel<DownloadEvent>) -> Result<(), String> {
    let mut resp = ureq::get(url).call().map_err(|e| format!("network: {e}"))?;
    let total = resp
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let mut reader = resp.body_mut().as_reader();
    let mut out = std::io::BufWriter::new(std::fs::File::create(to).map_err(|e| e.to_string())?);
    let mut buf = vec![0u8; 1 << 16];
    let (mut done, mut last) = (0u64, Instant::now());
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let n = reader.read(&mut buf).map_err(|e| format!("network: {e}"))?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        done += n as u64;
        if last.elapsed() > Duration::from_millis(150) {
            last = Instant::now();
            let _ = events.send(DownloadEvent::Progress { done, total });
        }
    }
    out.flush().map_err(|e| e.to_string())?;
    if total > 0 && done != total {
        return Err("network: download incomplete".into());
    }
    let _ = events.send(DownloadEvent::Progress { done, total: total.max(done) });
    Ok(())
}

#[tauri::command]
pub fn voice_download_cancel(state: State<'_, VoiceState>) {
    if let Some(c) = state.downloading.lock().unwrap().as_ref() {
        c.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn voice_delete_model(app: AppHandle, state: State<'_, VoiceState>, model: String) -> Result<(), String> {
    let file = model_file(&model)?;
    let mut loaded = state.model.lock().unwrap();
    if loaded.as_ref().is_some_and(|l| l.id == model) {
        *loaded = None;
    }
    std::fs::remove_file(models_dir(&app)?.join(file)).map_err(|e| e.to_string())
}

/// Starts recording. `on_level` gets the loudness (0..1) about 20 times a second, for the
/// indicator. The model starts loading at the same time, so it is ready when the speech ends.
#[tauri::command]
pub fn voice_start(
    app: AppHandle,
    state: State<'_, VoiceState>,
    mic: Option<String>,
    model: String,
    on_level: Channel<f32>,
) -> Result<(), String> {
    let path = models_dir(&app)?.join(model_file(&model)?);
    if !path.is_file() {
        return Err("no-model".into());
    }
    let mut rec = state.rec.lock().unwrap();
    if let Some(old) = rec.take() {
        let _ = old.stop.send(());
    }

    let samples = Arc::new(Mutex::new(Vec::<f32>::new()));
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, String>>();
    let buf = samples.clone();
    // cpal streams cannot move between threads, so one thread owns it until told to stop.
    let thread = std::thread::spawn(move || {
        match open_stream(mic.as_deref(), buf, on_level) {
            Ok((stream, rate)) => {
                let _ = ready_tx.send(Ok(rate));
                let _ = stop_rx.recv();
                drop(stream);
            }
            Err(e) => {
                let _ = ready_tx.send(Err(e));
            }
        }
    });
    let rate = ready_rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "mic: no response".to_string())??;
    *rec = Some(Recording { stop: stop_tx, samples, rate, thread });
    drop(rec);

    let cache = state.model.clone();
    std::thread::spawn(move || {
        let _ = load_model(&cache, &model, &path);
    });
    Ok(())
}

fn open_stream(mic: Option<&str>, buf: Arc<Mutex<Vec<f32>>>, level: Channel<f32>) -> Result<(cpal::Stream, u32), String> {
    let host = cpal::default_host();
    let chosen = mic.and_then(|id| id.parse().ok()).and_then(|id| host.device_by_id(&id));
    let device = chosen.or_else(|| host.default_input_device()).ok_or("mic: none")?;
    let config = device.default_input_config().map_err(|e| format!("mic: {e}"))?;
    let rate = config.sample_rate();
    let channels = config.channels() as usize;
    let stream_config: cpal::StreamConfig = config.clone().into();
    use cpal::SampleFormat as F;
    let stream = match config.sample_format() {
        F::F32 => build::<f32>(&device, &stream_config, channels, rate, buf, level),
        F::I16 => build::<i16>(&device, &stream_config, channels, rate, buf, level),
        F::I32 => build::<i32>(&device, &stream_config, channels, rate, buf, level),
        F::U16 => build::<u16>(&device, &stream_config, channels, rate, buf, level),
        F::U8 => build::<u8>(&device, &stream_config, channels, rate, buf, level),
        F::I8 => build::<i8>(&device, &stream_config, channels, rate, buf, level),
        other => Err(format!("mic: unsupported format {other}")),
    }?;
    stream.play().map_err(|e| format!("mic: {e}"))?;
    Ok((stream, rate))
}

fn build<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    rate: u32,
    buf: Arc<Mutex<Vec<f32>>>,
    level: Channel<f32>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let max = rate as usize * MAX_SECONDS;
    let every = (rate / 20) as usize;
    let (mut peak, mut since) = (0f32, 0usize);
    device
        .build_input_stream(
            config.clone(),
            move |data: &[T], _: &_| {
                let mut out = buf.lock().unwrap();
                for frame in data.chunks(channels.max(1)) {
                    let s = frame.iter().map(|&v| f32::from_sample(v)).sum::<f32>() / frame.len() as f32;
                    if out.len() < max {
                        out.push(s);
                    }
                    peak = peak.max(s.abs());
                    since += 1;
                    if since >= every {
                        let _ = level.send(peak.min(1.0));
                        peak = 0.0;
                        since = 0;
                    }
                }
            },
            |e| eprintln!("mic: {e}"),
            None,
        )
        .map_err(|e| format!("mic: {e}"))
}

fn load_model(cache: &Mutex<Option<Loaded>>, id: &str, path: &PathBuf) -> Result<Arc<WhisperContext>, String> {
    let mut slot = cache.lock().unwrap();
    if let Some(l) = slot.as_mut().filter(|l| l.id == id) {
        l.used = Instant::now();
        return Ok(l.ctx.clone());
    }
    *slot = None;
    let ctx = WhisperContext::new_with_params(path, WhisperContextParameters::default())
        .map_err(|e| format!("model: {e}"))?;
    let ctx = Arc::new(ctx);
    *slot = Some(Loaded { id: id.to_string(), ctx: ctx.clone(), used: Instant::now() });
    Ok(ctx)
}

/// Stops recording and returns what was said ("" for silence). `lang` is a whisper language code,
/// or None to detect it.
#[tauri::command]
pub async fn voice_stop(
    app: AppHandle,
    state: State<'_, VoiceState>,
    model: String,
    lang: Option<String>,
) -> Result<String, String> {
    let rec = state.rec.lock().unwrap().take().ok_or("not-recording")?;
    let _ = rec.stop.send(());
    let _ = rec.thread.join();
    let raw = std::mem::take(&mut *rec.samples.lock().unwrap());
    let path = models_dir(&app)?.join(model_file(&model)?);
    let cache = state.model.clone();
    let text = tauri::async_runtime::spawn_blocking(move || {
        let audio = resample(&raw, rec.rate);
        if !has_speech(&audio) {
            return Ok(String::new());
        }
        let ctx = load_model(&cache, &model, &path)?;
        let text = transcribe(&ctx, &audio, lang.as_deref());
        if let Some(l) = cache.lock().unwrap().as_mut() {
            l.used = Instant::now();
        }
        text
    })
    .await
    .map_err(|e| e.to_string())??;
    schedule_unload(state.model.clone());
    Ok(text)
}

#[tauri::command]
pub fn voice_cancel(state: State<'_, VoiceState>) {
    if let Some(rec) = state.rec.lock().unwrap().take() {
        let _ = rec.stop.send(());
    }
    schedule_unload(state.model.clone());
}

fn schedule_unload(cache: Arc<Mutex<Option<Loaded>>>) {
    std::thread::spawn(move || {
        std::thread::sleep(KEEP_LOADED + Duration::from_secs(1));
        let mut slot = cache.lock().unwrap();
        if slot.as_ref().is_some_and(|l| l.used.elapsed() >= KEEP_LOADED) {
            *slot = None;
        }
    });
}

fn transcribe(ctx: &WhisperContext, audio: &[f32], lang: Option<&str>) -> Result<String, String> {
    // whisper wants at least a second of audio.
    let mut padded;
    let audio = if audio.len() < RATE as usize + RATE as usize / 10 {
        padded = audio.to_vec();
        padded.resize(RATE as usize + RATE as usize / 5, 0.0);
        &padded[..]
    } else {
        audio
    };
    let mut state = ctx.create_state().map_err(|e| format!("model: {e}"))?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(8);
    params.set_n_threads(threads as i32);
    params.set_language(Some(lang.unwrap_or("auto")));
    // No re-runs at higher temperatures when unsure: they multiply the time for little gain here.
    params.set_temperature_inc(0.0);
    // whisper always encodes a 30 s window; shrinking it to the clip's length makes short
    // dictation several times faster.
    let secs = audio.len() as f32 / RATE as f32;
    params.set_audio_ctx(((secs / 30.0 * 1500.0) as i32 + 128).min(1500));
    params.set_no_context(true);
    params.set_no_timestamps(true);
    params.set_suppress_blank(true);
    params.set_suppress_nst(true);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    state.full(params, audio).map_err(|e| format!("model: {e}"))?;
    let mut text = String::new();
    for seg in state.as_iter() {
        text.push_str(&seg.to_string());
    }
    Ok(text.split_whitespace().collect::<Vec<_>>().join(" "))
}

/// Mono audio at any rate → 16 kHz, averaging over each output sample's span (a simple low-pass,
/// enough for speech).
fn resample(input: &[f32], rate: u32) -> Vec<f32> {
    if rate == RATE || input.is_empty() {
        return input.to_vec();
    }
    let step = rate as f64 / RATE as f64;
    let n = (input.len() as f64 / step) as usize;
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let a = (i as f64 * step) as usize;
        let b = (((i + 1) as f64 * step) as usize).clamp(a + 1, input.len());
        out.push(input[a..b].iter().sum::<f32>() / (b - a) as f32);
    }
    out
}

/// Whether anything louder than room noise was recorded; whisper invents words for silence.
fn has_speech(audio: &[f32]) -> bool {
    let win = (RATE / 50) as usize; // 20 ms
    let loud = audio
        .chunks(win)
        .filter(|c| (c.iter().map(|s| s * s).sum::<f32>() / c.len() as f32).sqrt() > 0.012)
        .count();
    loud >= 8 // about 160 ms of voice
}

pub fn init() {
    // Route whisper.cpp's own logging into `log` (unused here), so it does not flood stderr.
    whisper_rs::install_logging_hooks();
}
