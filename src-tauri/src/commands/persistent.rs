//! Persistent Claude Code sessions.
//!
//! The legacy path spawns one `claude -p "<prompt>"` process per message, which
//! makes stateful built-in slash commands (`/clear`, `/compact`, `/model`, ...)
//! meaningless: there is no session for them to act on.
//!
//! This module keeps a single long-lived process per tab and talks to it over
//! the official streaming protocol:
//!
//!   claude -p --input-format stream-json --output-format stream-json --verbose
//!
//! User turns are written to stdin as JSON lines; events come back on stdout.
//! The `system/init` event also reports every slash command the CLI exposes,
//! which is what lets the UI show native commands instead of a hardcoded list.

use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::Mutex;

use super::claude::{create_command_with_env, find_claude_binary, validate_project_dir};

/// A running `claude` process plus the handles needed to drive it.
pub struct PersistentSession {
    pub key: String,
    /// Session id reported by the CLI in its init event.
    pub claude_session_id: Mutex<Option<String>>,
    pub project_path: String,
    pub model: String,
    pub stdin: Mutex<ChildStdin>,
    pub child: Mutex<Option<Child>>,
    /// True between sending a message and receiving the matching result event.
    pub busy: AtomicBool,
}

#[derive(Default)]
pub struct PersistentSessions(pub Arc<Mutex<HashMap<String, Arc<PersistentSession>>>>);

#[derive(Clone, Serialize)]
pub struct InitPayload {
    pub key: String,
    pub session_id: String,
    pub model: String,
    pub slash_commands: Vec<String>,
}

fn new_key() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("ps-{}", nanos)
}

/// Builds the argv for a persistent session.
///
/// Kept separate from spawning so the exact flag set can be unit tested.
fn build_session_args(model: &str, effort: Option<&str>, resume: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-p".to_string(),
        "--input-format".to_string(),
        "stream-json".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--dangerously-skip-permissions".to_string(),
        "--model".to_string(),
        model.to_string(),
    ];

    if let Some(level) = effort {
        let level = level.trim();
        if !level.is_empty() {
            args.push("--effort".to_string());
            args.push(level.to_string());
        }
    }

    if let Some(resume_id) = resume {
        let resume_id = resume_id.trim();
        if !resume_id.is_empty() {
            args.push("--resume".to_string());
            args.push(resume_id.to_string());
        }
    }

    args
}

/// Serialises one user turn for the streaming input protocol.
fn user_message_line(text: &str) -> String {
    let payload = json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{ "type": "text", "text": text }]
        }
    });
    format!("{}\n", payload)
}

/// Starts a long-lived Claude process.
///
/// `resume_session_id` continues an existing conversation (used after an app
/// restart, when no live process is left).
#[tauri::command]
pub async fn start_persistent_session(
    app: AppHandle,
    project_path: String,
    model: String,
    effort: Option<String>,
    resume_session_id: Option<String>,
) -> Result<String, String> {
    validate_project_dir(&project_path)?;
    let claude_path = find_claude_binary(&app)?;

    let args = build_session_args(&model, effort.as_deref(), resume_session_id.as_deref());

    let mut cmd = create_command_with_env(&claude_path);
    for arg in args {
        cmd.arg(arg);
    }
    cmd.current_dir(&project_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Claude: {}", e))?;

    let stdin = child.stdin.take().ok_or("Failed to capture stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    let key = new_key();
    let session = Arc::new(PersistentSession {
        key: key.clone(),
        claude_session_id: Mutex::new(None),
        project_path: project_path.clone(),
        model: model.clone(),
        stdin: Mutex::new(stdin),
        child: Mutex::new(Some(child)),
        busy: AtomicBool::new(false),
    });

    let registry = app.state::<PersistentSessions>().0.clone();
    registry.lock().await.insert(key.clone(), session.clone());

    // --- stdout pump: drives all frontend events -------------------------
    {
        let app_handle = app.clone();
        let session_ref = session.clone();
        let registry_ref = registry.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let parsed: Option<serde_json::Value> = serde_json::from_str(&line).ok();

                if let Some(msg) = &parsed {
                    let kind = msg["type"].as_str().unwrap_or_default();

                    if kind == "system" && msg["subtype"] == "init" {
                        let sid = msg["session_id"].as_str().unwrap_or_default().to_string();
                        let commands: Vec<String> = msg["slash_commands"]
                            .as_array()
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                    .collect()
                            })
                            .unwrap_or_default();
                        let reported_model =
                            msg["model"].as_str().unwrap_or_default().to_string();

                        {
                            let mut guard = session_ref.claude_session_id.lock().await;
                            if guard.is_none() {
                                *guard = Some(sid.clone());
                            }
                        }

                        let _ = app_handle.emit(
                            "claude-init",
                            InitPayload {
                                key: session_ref.key.clone(),
                                session_id: sid.clone(),
                                model: reported_model,
                                slash_commands: commands,
                            },
                        );
                        log::info!(
                            "Persistent session {} init: id={} commands={}",
                            session_ref.key,
                            sid,
                            msg["slash_commands"]
                                .as_array()
                                .map(|a| a.len())
                                .unwrap_or(0)
                        );
                    }

                    // A turn is finished when the CLI emits its result event.
                    if kind == "result" {
                        session_ref.busy.store(false, Ordering::SeqCst);
                        let ok = msg["is_error"].as_bool().map(|e| !e).unwrap_or(true);
                        if let Some(sid) = session_ref.claude_session_id.lock().await.clone() {
                            let _ = app_handle.emit(&format!("claude-complete:{}", sid), ok);
                        }
                        let _ = app_handle.emit("claude-complete", ok);
                    }
                }

                // Same event names the one-shot path uses, so the existing
                // frontend listeners keep working unchanged.
                if let Some(sid) = session_ref.claude_session_id.lock().await.clone() {
                    let _ = app_handle.emit(&format!("claude-output:{}", sid), &line);
                }
                let _ = app_handle.emit("claude-output", &line);
            }

            // stdout closed => process is gone
            let sid = session_ref.claude_session_id.lock().await.clone();
            if let Some(sid) = sid {
                let _ = app_handle.emit(&format!("claude-complete:{}", sid), false);
            }
            let _ = app_handle.emit("claude-complete", false);
            registry_ref.lock().await.remove(&session_ref.key);
            log::info!("Persistent session {} ended", session_ref.key);
        });
    }

    // --- stderr pump -----------------------------------------------------
    {
        let app_handle = app.clone();
        let session_ref = session.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log::error!("Claude stderr: {}", line);
                if let Some(sid) = session_ref.claude_session_id.lock().await.clone() {
                    let _ = app_handle.emit(&format!("claude-error:{}", sid), &line);
                }
                let _ = app_handle.emit("claude-error", &line);
            }
        });
    }

    log::info!(
        "Started persistent session {} for {} (model {})",
        key,
        project_path,
        model
    );
    Ok(key)
}

/// Sends one user turn (plain text or a slash command) to a live session.
#[tauri::command]
pub async fn send_persistent_message(
    app: AppHandle,
    key: String,
    text: String,
) -> Result<(), String> {
    let registry = app.state::<PersistentSessions>().0.clone();
    let session = {
        let guard = registry.lock().await;
        guard
            .get(&key)
            .cloned()
            .ok_or_else(|| "Session is not running".to_string())?
    };

    let payload = user_message_line(&text);

    let mut stdin = session.stdin.lock().await;
    stdin
        .write_all(payload.as_bytes())
        .await
        .map_err(|e| format!("Failed to write to Claude: {}", e))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("Failed to flush Claude stdin: {}", e))?;

    session.busy.store(true, Ordering::SeqCst);
    Ok(())
}

/// Kills the process and forgets the session.
#[tauri::command]
pub async fn stop_persistent_session(app: AppHandle, key: String) -> Result<(), String> {
    let registry = app.state::<PersistentSessions>().0.clone();
    let session = {
        let mut guard = registry.lock().await;
        guard.remove(&key)
    };

    if let Some(session) = session {
        if let Some(mut child) = session.child.lock().await.take() {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
        log::info!(
            "Stopped persistent session {} ({}, model {})",
            key,
            session.project_path,
            session.model
        );
    }
    Ok(())
}

/// Reads the CLI's slash-command list without touching a real conversation.
///
/// The list only exists inside the `system/init` event, and the CLI emits that
/// event once it receives its first message - so "just ask for the command list"
/// is not possible; a turn has to be opened. This opens a throwaway session in
/// the temp directory on the cheapest model with a one-character prompt, reads
/// init, and kills the process.
///
/// Cost is a few thousand input tokens on haiku (well under a cent), which is
/// why the caller should cache the result rather than probe on every launch.
/// The session id is chosen up front so the transcript it leaves behind can be
/// removed exactly, instead of guessing which file is "the new one".
#[tauri::command]
pub async fn probe_slash_commands(app: AppHandle) -> Result<Vec<String>, String> {
    let claude_path = find_claude_binary(&app)?;
    let session_id = uuid::Uuid::new_v4().to_string();

    let work_dir = std::env::temp_dir().join("opcode-command-probe");
    std::fs::create_dir_all(&work_dir)
        .map_err(|e| format!("Failed to create probe directory: {}", e))?;

    let mut args = build_session_args("haiku", None, None);
    args.push("--session-id".to_string());
    args.push(session_id.clone());

    let mut cmd = create_command_with_env(&claude_path);
    for arg in args {
        cmd.arg(arg);
    }
    cmd.current_dir(&work_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start claude: {}", e))?;

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(user_message_line(".").as_bytes()).await;
        let _ = stdin.flush().await;
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Probe process produced no stdout".to_string())?;
    let mut lines = BufReader::new(stdout).lines();

    let read_init = async {
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if value.get("type").and_then(|t| t.as_str()) != Some("system")
                || value.get("subtype").and_then(|t| t.as_str()) != Some("init")
            {
                continue;
            }
            let commands = value
                .get("slash_commands")
                .and_then(|c| c.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(str::to_string))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            return Some(commands);
        }
        None
    };

    let outcome = tokio::time::timeout(std::time::Duration::from_secs(30), read_init).await;

    let _ = child.start_kill();
    let _ = child.wait().await;
    cleanup_probe_transcript(&session_id);

    match outcome {
        Ok(Some(commands)) if !commands.is_empty() => {
            log::info!("Probed {} slash commands from the CLI", commands.len());
            Ok(commands)
        }
        Ok(_) => Err("CLI finished without reporting slash commands".to_string()),
        Err(_) => Err("Timed out waiting for the CLI command list".to_string()),
    }
}

/// Deletes the throwaway transcript created by `probe_slash_commands`.
fn cleanup_probe_transcript(session_id: &str) {
    let Ok(claude_dir) = super::claude::get_claude_dir() else {
        return;
    };
    let projects = claude_dir.join("projects");
    let Ok(entries) = std::fs::read_dir(&projects) else {
        return;
    };

    for entry in entries.flatten() {
        let file = entry.path().join(format!("{}.jsonl", session_id));
        if file.is_file() {
            match std::fs::remove_file(&file) {
                Ok(()) => log::info!("Removed probe transcript: {:?}", file),
                Err(e) => log::warn!("Could not remove probe transcript {:?}: {}", file, e),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{build_session_args, user_message_line};

    fn has_pair(args: &[String], flag: &str, value: &str) -> bool {
        args.windows(2).any(|w| w[0] == flag && w[1] == value)
    }

    #[test]
    fn always_uses_streaming_protocol() {
        let args = build_session_args("claude-opus-5-5", None, None);
        assert!(has_pair(&args, "--input-format", "stream-json"));
        assert!(has_pair(&args, "--output-format", "stream-json"));
        assert!(has_pair(&args, "--model", "claude-opus-5-5"));
        assert!(args.contains(&"-p".to_string()));
    }

    #[test]
    fn effort_is_optional_and_trimmed() {
        let without = build_session_args("m", None, None);
        assert!(!without.contains(&"--effort".to_string()));

        let blank = build_session_args("m", Some("   "), None);
        assert!(!blank.contains(&"--effort".to_string()));

        let with = build_session_args("m", Some(" high "), None);
        assert!(has_pair(&with, "--effort", "high"));
    }

    #[test]
    fn resume_is_optional() {
        let without = build_session_args("m", None, None);
        assert!(!without.contains(&"--resume".to_string()));

        let with = build_session_args("m", None, Some("abc-123"));
        assert!(has_pair(&with, "--resume", "abc-123"));
    }

    #[test]
    fn user_message_matches_stream_json_shape() {
        let line = user_message_line("/clear");
        assert!(line.ends_with('\n'), "each message must be one line");
        let parsed: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(parsed["type"], "user");
        assert_eq!(parsed["message"]["role"], "user");
        assert_eq!(parsed["message"]["content"][0]["type"], "text");
        assert_eq!(parsed["message"]["content"][0]["text"], "/clear");
    }

    #[test]
    fn message_text_is_json_escaped() {
        // Quotes/newlines in user input must not break the protocol framing.
        let line = user_message_line("he said \"hi\"\nand left");
        assert_eq!(line.matches('\n').count(), 1, "only the trailing newline");
        let parsed: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(parsed["message"]["content"][0]["text"], "he said \"hi\"\nand left");
    }

    /// End-to-end handshake against the real CLI. Ignored by default because it
    /// spawns a process and makes one tiny request.
    /// Run with: cargo test --lib e2e_session_handshake -- --ignored --nocapture
    #[test]
    #[ignore]
    fn e2e_session_handshake() {
        use std::io::{BufRead, BufReader, Write};
        use std::process::{Command, Stdio};
        use std::sync::mpsc;

        // On Windows the CLI is `claude.cmd`, which Rust's Command cannot
        // resolve on its own (CreateProcess only appends .exe).
        fn resolve_claude() -> std::path::PathBuf {
            for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
                for name in ["claude.exe", "claude.cmd", "claude.bat"] {
                    let candidate = dir.join(name);
                    if candidate.is_file() {
                        return candidate;
                    }
                }
            }
            panic!("claude CLI not found on PATH");
        }

        let args = build_session_args("claude-haiku-5-5", None, None);
        let mut child = Command::new(resolve_claude())
            .args(&args)
            .current_dir(std::env::temp_dir())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("claude binary should be on PATH");

        {
            let stdin = child.stdin.as_mut().expect("stdin");
            stdin
                .write_all(user_message_line("reply with just: ok").as_bytes())
                .expect("write");
            stdin.flush().expect("flush");
        }

        let stdout = child.stdout.take().expect("stdout");
        let (tx, rx) = mpsc::channel::<String>();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });

        let deadline = std::time::Duration::from_secs(120);
        let mut saw_init = false;
        while let Ok(line) = rx.recv_timeout(deadline) {
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if msg["type"] == "system" && msg["subtype"] == "init" {
                let count = msg["slash_commands"].as_array().map(|a| a.len()).unwrap_or(0);
                println!("[e2e] init received, slash_commands = {}", count);
                assert!(count > 0, "CLI must report slash commands at init");
                saw_init = true;
                break;
            }
        }

        let _ = child.kill();
        let _ = child.wait();
        assert!(saw_init, "never received the init event");
    }
}
