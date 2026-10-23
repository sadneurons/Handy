//! Transcribe audio files dropped into the app: decode with ffmpeg, run the
//! same batch pipeline as dictation, and save labelled transcripts to disk.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Which transcript a saved file holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranscriptKind {
    /// Straight from the model plus the deterministic text pipeline.
    Raw,
    /// After LLM post-processing.
    Cleaned,
}

impl TranscriptKind {
    fn label(self) -> &'static str {
        match self {
            TranscriptKind::Raw => "RAW",
            TranscriptKind::Cleaned => "CLEANED",
        }
    }

    fn suffix(self) -> &'static str {
        match self {
            TranscriptKind::Raw => "raw.txt",
            TranscriptKind::Cleaned => "cleaned.txt",
        }
    }
}

/// Where the transcripts of one source file are written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputPaths {
    pub raw: PathBuf,
    pub cleaned: PathBuf,
    /// The source directory was not writable, so `fallback` was used instead.
    pub used_fallback: bool,
}

/// Transcripts go beside the source as `<stem>.raw.txt` / `<stem>.cleaned.txt`,
/// or into `fallback` when the source directory cannot be written to.
pub fn output_paths(
    source: &Path,
    fallback: &Path,
    dir_is_writable: impl Fn(&Path) -> bool,
) -> OutputPaths {
    let stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "transcript".to_string());
    let source_dir = source.parent().unwrap_or(Path::new("."));
    let used_fallback = !dir_is_writable(source_dir);
    let dir = if used_fallback { fallback } else { source_dir };
    let path_for = |kind: TranscriptKind| dir.join(format!("{stem}.{}", kind.suffix()));
    OutputPaths {
        raw: path_for(TranscriptKind::Raw),
        cleaned: path_for(TranscriptKind::Cleaned),
        used_fallback,
    }
}

/// A transcript file: a short labelled header, a blank line, then the text.
pub fn format_transcript(kind: TranscriptKind, source_name: &str, model: &str, text: &str) -> String {
    format!(
        "Handy transcript ({})\nSource: {}\nModel: {}\n\n{}\n",
        kind.label(),
        source_name,
        model,
        text.trim_end()
    )
}

/// Decode any audio file ffmpeg understands into 16 kHz mono f32 samples,
/// the format the transcription engines take.
pub fn decode_to_16k_mono(path: &Path) -> Result<Vec<f32>, String> {
    let output = Command::new("ffmpeg")
        .args(["-v", "error", "-i"])
        .arg(path)
        .args(["-f", "s16le", "-ac", "1", "-ar", "16000", "-"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("could not run ffmpeg: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "ffmpeg failed on {}: {}",
            path.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(output
        .stdout
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / i16::MAX as f32)
        .collect())
}

/// Can we create a file in `dir`? Probes by creating and removing a temp file,
/// which is the only reliable answer on removable media and odd mounts.
pub fn dir_is_writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".handy-write-probe-{}", std::process::id()));
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
    {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use crate::actions::process_transcription_output;
use crate::audio_toolkit::save_wav_file;
use crate::managers::history::HistoryManager;
use crate::managers::transcription::TranscriptionManager;
use crate::settings::get_settings;

/// Progress of a batch file transcription, one event per stage per file.
#[derive(Clone, Debug, Serialize, Deserialize, Type, Event)]
pub struct FileTranscribeProgress {
    pub index: usize,
    pub total: usize,
    pub file: String,
    /// "decoding" | "transcribing" | "post_processing" | "saving" | "done" | "failed"
    pub stage: String,
}

/// Outcome for one dropped file.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct FileTranscriptResult {
    pub source: String,
    pub raw_path: Option<String>,
    pub cleaned_path: Option<String>,
    pub used_fallback: bool,
    pub history_id: Option<i64>,
    pub error: Option<String>,
}

fn fallback_dir(app: &AppHandle) -> PathBuf {
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .unwrap_or_else(|_| std::env::temp_dir());
    base.join("Handy Transcripts")
}

fn emit_progress(app: &AppHandle, index: usize, total: usize, file: &str, stage: &str) {
    let _ = FileTranscribeProgress {
        index,
        total,
        file: file.to_string(),
        stage: stage.to_string(),
    }
    .emit(app);
}

async fn transcribe_one(
    app: &AppHandle,
    index: usize,
    total: usize,
    source: &Path,
    post_process: bool,
) -> Result<FileTranscriptResult, String> {
    let name = source
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tm = app.state::<Arc<TranscriptionManager>>().inner().clone();
    let history = app.state::<Arc<HistoryManager>>().inner().clone();

    emit_progress(app, index, total, &name, "decoding");
    let src = source.to_path_buf();
    let samples = tauri::async_runtime::spawn_blocking(move || decode_to_16k_mono(&src))
        .await
        .map_err(|e| e.to_string())??;
    if samples.is_empty() {
        return Err("no audio decoded".to_string());
    }

    emit_progress(app, index, total, &name, "transcribing");
    let settings = get_settings(app);
    let model_id = settings.selected_model.clone();
    if model_id.is_empty() {
        return Err("no transcription model selected".to_string());
    }
    let tm2 = tm.clone();
    let samples2 = samples.clone();
    let raw = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        if !tm2.is_model_loaded() {
            tm2.load_model(&model_id).map_err(|e| e.to_string())?;
        }
        tm2.transcribe(samples2).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    let cleaned = if post_process {
        emit_progress(app, index, total, &name, "post_processing");
        process_transcription_output(app, &raw, true)
            .await
            .post_processed_text
    } else {
        None
    };

    emit_progress(app, index, total, &name, "saving");
    let model_name = tm.get_current_model().unwrap_or_default();
    let fallback = fallback_dir(app);
    let paths = output_paths(source, &fallback, dir_is_writable);
    if paths.used_fallback {
        std::fs::create_dir_all(&fallback).map_err(|e| e.to_string())?;
    }
    std::fs::write(
        &paths.raw,
        format_transcript(TranscriptKind::Raw, &name, &model_name, &raw),
    )
    .map_err(|e| format!("could not write {}: {e}", paths.raw.display()))?;
    let cleaned_path = match &cleaned {
        Some(text) => {
            std::fs::write(
                &paths.cleaned,
                format_transcript(TranscriptKind::Cleaned, &name, &model_name, text),
            )
            .map_err(|e| format!("could not write {}: {e}", paths.cleaned.display()))?;
            Some(paths.cleaned.to_string_lossy().into_owned())
        }
        None => None,
    };

    // A history entry with the decoded audio beside it, so it plays back like
    // a dictation and follows the normal retention rules.
    let stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "import".to_string());
    let wav_name = format!("import-{}-{}.wav", chrono::Utc::now().timestamp(), stem);
    let history_id = match save_wav_file(history.get_audio_file_path(&wav_name), &samples) {
        Ok(()) => history
            .save_entry(wav_name, raw.clone(), post_process, cleaned.clone(), None)
            .ok()
            .map(|e| e.id),
        Err(e) => {
            log::warn!("file import: could not save audio for history: {e}");
            None
        }
    };

    emit_progress(app, index, total, &name, "done");
    Ok(FileTranscriptResult {
        source: source.to_string_lossy().into_owned(),
        raw_path: Some(paths.raw.to_string_lossy().into_owned()),
        cleaned_path,
        used_fallback: paths.used_fallback,
        history_id,
        error: None,
    })
}

/// Transcribe each file in turn. Per-file failures are reported in the result
/// rather than aborting the batch.
#[tauri::command]
#[specta::specta]
pub async fn transcribe_files(
    app: AppHandle,
    paths: Vec<String>,
    post_process: bool,
) -> Result<Vec<FileTranscriptResult>, String> {
    let total = paths.len();
    let mut results = Vec::with_capacity(total);
    for (index, p) in paths.iter().enumerate() {
        let source = PathBuf::from(p);
        match transcribe_one(&app, index, total, &source, post_process).await {
            Ok(r) => results.push(r),
            Err(e) => {
                log::error!("file import failed for {p}: {e}");
                emit_progress(
                    &app,
                    index,
                    total,
                    &source.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                    "failed",
                );
                results.push(FileTranscriptResult {
                    source: p.clone(),
                    raw_path: None,
                    cleaned_path: None,
                    used_fallback: false,
                    history_id: None,
                    error: Some(e),
                });
            }
        }
    }
    Ok(results)
}

/// Open the folder that holds a saved transcript in the system file manager.
#[tauri::command]
#[specta::specta]
pub fn open_transcript_folder(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = Path::new(&path)
        .parent()
        .ok_or_else(|| "path has no parent directory".to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<String>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    #[test]
    fn output_paths_sit_beside_the_source_with_raw_and_cleaned_suffixes() {
        let source = Path::new("/recordings/FOLDER01/230114_1733.mp3");
        let fallback = Path::new("/home/me/Documents/Handy Transcripts");
        let paths = output_paths(source, fallback, |_| true);
        assert_eq!(
            paths.raw,
            PathBuf::from("/recordings/FOLDER01/230114_1733.raw.txt")
        );
        assert_eq!(
            paths.cleaned,
            PathBuf::from("/recordings/FOLDER01/230114_1733.cleaned.txt")
        );
        assert!(!paths.used_fallback);
    }

    #[test]
    fn output_paths_fall_back_when_the_source_directory_is_not_writable() {
        let source = Path::new("/media/recorder/REC_FILE/take.wav");
        let fallback = Path::new("/home/me/Documents/Handy Transcripts");
        let paths = output_paths(source, fallback, |dir| dir != Path::new("/media/recorder/REC_FILE"));
        assert_eq!(
            paths.raw,
            PathBuf::from("/home/me/Documents/Handy Transcripts/take.raw.txt")
        );
        assert!(paths.used_fallback);
    }

    #[test]
    fn transcript_file_is_labelled_with_kind_source_and_model() {
        let text = format_transcript(
            TranscriptKind::Raw,
            "230114_1733.mp3",
            "whisper-large-v3-turbo",
            "Hello world.",
        );
        let header = text.lines().next().unwrap();
        assert!(header.contains("RAW"), "header was: {header}");
        assert!(text.contains("Source: 230114_1733.mp3"));
        assert!(text.contains("Model: whisper-large-v3-turbo"));
        assert!(text.ends_with("Hello world.\n"));
    }

    #[test]
    fn cleaned_transcript_header_says_cleaned() {
        let text = format_transcript(TranscriptKind::Cleaned, "a.mp3", "m", "x");
        assert!(text.lines().next().unwrap().contains("CLEANED"));
    }

    #[test]
    fn ffmpeg_decodes_any_audio_to_16k_mono_f32() {
        if std::process::Command::new("ffmpeg").arg("-version").output().is_err() {
            eprintln!("ffmpeg not installed; skipping");
            return;
        }
        let dir = std::env::temp_dir().join(format!("handy-ft-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("tone.mp3");
        // 2 s, stereo, 44.1 kHz sine at 440 Hz, as an mp3
        let ok = std::process::Command::new("ffmpeg")
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-ac", "2", "-ar", "44100"])
            .arg(&src)
            .status()
            .unwrap()
            .success();
        assert!(ok);
        let samples = decode_to_16k_mono(&src).unwrap();
        let secs = samples.len() as f64 / 16_000.0;
        assert!((secs - 2.0).abs() < 0.1, "got {secs} s");
        assert!(samples.iter().all(|s| (-1.0..=1.0).contains(s)));
        assert!(samples.iter().any(|s| s.abs() > 0.02), "decoded audio is silent");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn writable_probe_distinguishes_writable_from_readonly_dirs() {
        let dir = std::env::temp_dir().join(format!("handy-wp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(dir_is_writable(&dir));
        assert!(!dir_is_writable(&dir.join("does-not-exist")));
        assert!(!dir_is_writable(Path::new("/proc")));
        // the probe must not leave anything behind
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        std::fs::remove_dir_all(&dir).ok();
    }
}
