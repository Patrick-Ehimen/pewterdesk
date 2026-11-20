//! Dictation: hold the hotkey, speak, and let go; the words are typed where
//! the cursor is in the app (`hooks/useDictation.ts` decides where).
//!
//! macOS only: the microphone through `AVAudioEngine`, recognized by Apple's
//! Speech framework **on the device** (`requiresOnDeviceRecognition`), so
//! the audio never leaves the machine; a Mac or language that can't do it
//! on the device is refused rather than sent to Apple's servers. Nothing
//! recorded is kept: each buffer goes straight to the recognizer and is
//! dropped. What comes back reaches the page only as bounded text, in
//! `dictation` events. It types nothing itself and reaches no command.

use serde::Serialize;

/// Why dictation can't start, as the page shows it.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DictationError {
    /// Not a Mac.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    Unsupported,
    /// Speech recognition is off for the app in System Settings.
    SpeechDenied,
    /// The microphone couldn't be opened (or is off for the app).
    Microphone { detail: String },
    /// No recognizer for this Mac's language, or it isn't ready.
    Unavailable,
    /// This Mac or language can't recognize speech on the device.
    NotOnDevice,
}

/// What the recognizer heard so far, or in the end.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Heard {
    /// Which `dictation_start` this belongs to, so a late answer is ignored.
    pub session: u64,
    pub text: String,
    /// The last of this session: type it in.
    pub done: bool,
    /// A recognizer failure in words, with `done`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The most a dictation brings back: anything past it is dropped.
const MAX_TEXT: usize = 5_000;

fn bounded(text: &str) -> String {
    text.chars().take(MAX_TEXT).collect()
}

#[cfg(target_os = "macos")]
mod mac {
    use super::{bounded, DictationError, Heard};
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::AnyThread;
    use objc2_avf_audio::{AVAudioEngine, AVAudioPCMBuffer, AVAudioTime};
    use objc2_foundation::{NSError, NSLocale};
    use objc2_speech::{
        SFSpeechAudioBufferRecognitionRequest, SFSpeechRecognitionResult, SFSpeechRecognitionTask,
        SFSpeechRecognizer, SFSpeechRecognizerAuthorizationStatus,
    };
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Mutex;
    use tauri::{AppHandle, Emitter};

    /// One dictation in progress: the microphone, the request it feeds, and
    /// the recognizer's task.
    struct Session {
        id: u64,
        engine: Retained<AVAudioEngine>,
        request: Retained<SFSpeechAudioBufferRecognitionRequest>,
        task: Retained<SFSpeechRecognitionTask>,
        _recognizer: Retained<SFSpeechRecognizer>,
    }

    // The objects are only touched under the lock, and AVAudioEngine and the
    // Speech framework may be driven from any thread.
    unsafe impl Send for Session {}

    static SESSION: Mutex<Option<Session>> = Mutex::new(None);
    static NEXT: AtomicU64 = AtomicU64::new(1);

    /// Asks once for speech recognition (macOS shows its own dialog); the
    /// answer after that is remembered by macOS.
    async fn authorized() -> bool {
        match unsafe { SFSpeechRecognizer::authorizationStatus() } {
            SFSpeechRecognizerAuthorizationStatus::Authorized => return true,
            SFSpeechRecognizerAuthorizationStatus::NotDetermined => {}
            _ => return false,
        }
        let (tx, rx) = tokio::sync::oneshot::channel();
        {
            // The block is dropped before the wait: it isn't Send.
            let tx = Mutex::new(Some(tx));
            let handler = RcBlock::new(move |status: SFSpeechRecognizerAuthorizationStatus| {
                if let Some(tx) = tx.lock().ok().and_then(|mut t| t.take()) {
                    let _ = tx.send(status == SFSpeechRecognizerAuthorizationStatus::Authorized);
                }
            });
            unsafe { SFSpeechRecognizer::requestAuthorization(&handler) };
        }
        rx.await.unwrap_or(false)
    }

    /// Stops the microphone and lets the recognizer finish what it heard.
    fn end(session: &Session) {
        unsafe {
            session.engine.stop();
            session.engine.inputNode().removeTapOnBus(0);
            session.request.endAudio();
        }
    }

    pub async fn start(app: AppHandle) -> Result<u64, DictationError> {
        if !authorized().await {
            return Err(DictationError::SpeechDenied);
        }
        // Whatever was still running goes first.
        cancel();
        let session_id = NEXT.fetch_add(1, Ordering::Relaxed);

        let recognizer = unsafe {
            SFSpeechRecognizer::initWithLocale(
                SFSpeechRecognizer::alloc(),
                &NSLocale::autoupdatingCurrentLocale(),
            )
        }
        .ok_or(DictationError::Unavailable)?;
        if !unsafe { recognizer.isAvailable() } {
            return Err(DictationError::Unavailable);
        }
        if !unsafe { recognizer.supportsOnDeviceRecognition() } {
            return Err(DictationError::NotOnDevice);
        }

        let request = unsafe { SFSpeechAudioBufferRecognitionRequest::new() };
        unsafe {
            request.setShouldReportPartialResults(true);
            request.setRequiresOnDeviceRecognition(true);
            request.setAddsPunctuation(true);
        }

        // The microphone: every buffer straight into the request.
        let engine = unsafe { AVAudioEngine::new() };
        let input = unsafe { engine.inputNode() };
        let format = unsafe { input.outputFormatForBus(0) };
        let feed = request.clone();
        let tap = RcBlock::new(move |buffer: NonNull<AVAudioPCMBuffer>, _: NonNull<AVAudioTime>| {
            unsafe { feed.appendAudioPCMBuffer(buffer.as_ref()) };
        });
        unsafe {
            input.installTapOnBus_bufferSize_format_block(
                0,
                1024,
                Some(&format),
                RcBlock::as_ptr(&tap),
            );
            engine.prepare();
        }
        if let Err(e) = unsafe { engine.startAndReturnError() } {
            unsafe { input.removeTapOnBus(0) };
            return Err(DictationError::Microphone {
                detail: e.localizedDescription().to_string(),
            });
        }

        // What it hears, as it hears it; the last answer with `done`.
        let handler = RcBlock::new(
            move |result: *mut SFSpeechRecognitionResult, error: *mut NSError| {
                let result = unsafe { result.as_ref() };
                let text = result
                    .map(|r| bounded(&unsafe { r.bestTranscription().formattedString() }.to_string()))
                    .unwrap_or_default();
                let finished = result.is_some_and(|r| unsafe { r.isFinal() });
                let failed = unsafe { error.as_ref() }.map(|e| e.localizedDescription().to_string());
                let done = finished || failed.is_some();
                let _ = app.emit(
                    "dictation",
                    Heard {
                        session: session_id,
                        text,
                        done,
                        // An error with words already heard still types them in.
                        error: if finished { None } else { failed },
                    },
                );
                if done {
                    // This session is over (the microphone was stopped by `stop`);
                    // a newer one in its place is left alone. Never waits on the lock.
                    if let Ok(mut s) = SESSION.try_lock() {
                        if s.as_ref().is_some_and(|s| s.id == session_id) {
                            if let Some(s) = s.take() {
                                end(&s);
                            }
                        }
                    }
                }
            },
        );
        let task = unsafe { recognizer.recognitionTaskWithRequest_resultHandler(&request, &handler) };

        if let Ok(mut s) = SESSION.lock() {
            *s = Some(Session {
                id: session_id,
                engine,
                request,
                task,
                _recognizer: recognizer,
            });
        }
        Ok(session_id)
    }

    /// The key was let go: stop listening; the final words follow as an event.
    pub fn stop() {
        if let Ok(s) = SESSION.lock() {
            if let Some(s) = s.as_ref() {
                end(s);
                unsafe { s.task.finish() };
            }
        }
    }

    /// Stops and throws away what was heard.
    pub fn cancel() {
        if let Ok(mut s) = SESSION.lock() {
            if let Some(s) = s.take() {
                end(&s);
                unsafe { s.task.cancel() };
            }
        }
    }
}

/// Starts listening; returns the session's id, which its `dictation` events carry.
#[tauri::command]
pub async fn dictation_start(app: tauri::AppHandle) -> Result<u64, DictationError> {
    #[cfg(target_os = "macos")]
    {
        mac::start(app).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err(DictationError::Unsupported)
    }
}

/// Stops listening; the final text follows as a `dictation` event with `done`.
#[tauri::command]
pub fn dictation_stop() {
    #[cfg(target_os = "macos")]
    mac::stop();
}

/// Stops listening and drops what was heard.
#[tauri::command]
pub fn dictation_cancel() {
    #[cfg(target_os = "macos")]
    mac::cancel();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_what_comes_back() {
        let long = "word ".repeat(2_000);
        assert_eq!(bounded(&long).chars().count(), MAX_TEXT);
        assert_eq!(bounded("hi"), "hi");
    }

    #[test]
    fn says_why_in_a_shape_the_page_reads() {
        let e = serde_json::to_value(DictationError::Microphone { detail: "off".into() }).unwrap();
        assert_eq!(e["kind"], "microphone");
        assert_eq!(e["detail"], "off");
        let e = serde_json::to_value(DictationError::NotOnDevice).unwrap();
        assert_eq!(e["kind"], "notOnDevice");
    }
}
