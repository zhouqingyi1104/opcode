//! Read-only file preview for paths referenced inside messages.
//!
//! Assistant replies routinely link to project files with relative markdown
//! targets (`[renders/out.mp4](renders/out.mp4)`). Clicking those used to do
//! nothing, because only bash-output links had a handler. This command resolves
//! such a link against the session's project directory and returns just enough
//! for the UI to render a preview.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// Hard limits so a stray click on a multi-GB file cannot lock the app up.
const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_BINARY_BYTES: u64 = 24 * 1024 * 1024;

#[derive(Debug, Serialize)]
pub struct FilePreview {
    /// Absolute path that was actually read.
    pub path: String,
    /// File name for the panel header.
    pub display_name: String,
    /// One of: text, image, video, audio, binary.
    pub kind: String,
    pub size: u64,
    /// True when the file was larger than the preview budget.
    pub truncated: bool,
    pub text: Option<String>,
    /// `data:` URL for images / video / audio.
    pub data_url: Option<String>,
}

#[derive(Debug, PartialEq)]
enum FileKind {
    Text,
    Image,
    Video,
    Audio,
    Binary,
}

fn kind_of(extension: &str) -> FileKind {
    match extension.to_ascii_lowercase().as_str() {
        "md" | "markdown" | "txt" | "log" | "json" | "jsonl" | "yaml" | "yml" | "toml" | "ini"
        | "csv" | "tsv" | "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "py" | "rs" | "go"
        | "java" | "kt" | "c" | "h" | "cpp" | "hpp" | "cs" | "rb" | "php" | "sh" | "bash"
        | "ps1" | "sql" | "html" | "htm" | "css" | "scss" | "svg" => FileKind::Text,
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "avif" => FileKind::Image,
        "mp4" | "webm" | "mov" | "m4v" => FileKind::Video,
        "mp3" | "wav" | "m4a" | "ogg" | "flac" => FileKind::Audio,
        _ => FileKind::Binary,
    }
}

fn mime_of(extension: &str) -> &'static str {
    match extension.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        _ => "application/octet-stream",
    }
}

/// Resolves a link target to an absolute path.
///
/// Relative targets are joined onto `base_dir`. Anything that escapes
/// `base_dir` is rejected: message text comes from the model, so a click should
/// never be able to read arbitrary files on the machine.
fn resolve_target(target: &str, base_dir: Option<&str>) -> Result<PathBuf, String> {
    if target.trim().is_empty() {
        return Err("Empty path".to_string());
    }

    let candidate = Path::new(target);
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        let base = base_dir
            .ok_or_else(|| "No project directory to resolve the path against".to_string())?;
        Path::new(base).join(candidate)
    };

    let canonical = joined
        .canonicalize()
        .map_err(|_| format!("File not found: {}", target))?;

    if let Some(base) = base_dir {
        if let Ok(canonical_base) = Path::new(base).canonicalize() {
            if !canonical.starts_with(&canonical_base) {
                return Err(format!(
                    "Refusing to read {}: it is outside the project directory",
                    canonical.display()
                ));
            }
        }
    }

    if canonical.is_dir() {
        return Err("That path is a directory, not a file".to_string());
    }

    Ok(canonical)
}

/// Last-resort lookup for links whose relative base is not the project root.
///
/// The model writes paths relative to whatever directory it was working in, so
/// `renders/out.mp4` may really live at `published/2026-10-20/renders/out.mp4`.
/// When the direct join misses, walk the project and match by path suffix,
/// preferring the most recently modified candidate.
fn find_by_suffix(base: &Path, target: &str) -> Option<PathBuf> {
    let needle: Vec<String> = target
        .split(['/', '\\'])
        .filter(|part| !part.is_empty() && *part != ".")
        .map(|part| part.to_lowercase())
        .collect();

    if needle.is_empty() {
        return None;
    }
    let suffix = needle.join("/");

    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    // Bounded so a click cannot hang on a huge tree (video projects here have
    // thousands of files); 20k entries is plenty for a suffix lookup.
    const MAX_ENTRIES: usize = 20_000;
    let mut visited = 0usize;

    for entry in walkdir::WalkDir::new(base)
        .max_depth(10)
        .into_iter()
        .filter_map(|entry| entry.ok())
    {
        visited += 1;
        if visited > MAX_ENTRIES {
            log::warn!("Suffix search capped at {} entries under {:?}", MAX_ENTRIES, base);
            break;
        }

        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path();
        let normalized = path.to_string_lossy().replace('\\', "/").to_lowercase();
        if !normalized.ends_with(&suffix) {
            continue;
        }
        // Skip noise that would only produce wrong matches.
        if normalized.contains("/node_modules/") || normalized.contains("/.git/") {
            continue;
        }

        let mtime = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);

        let is_newer = match &best {
            Some((best_time, _)) => mtime > *best_time,
            None => true,
        };
        if is_newer {
            best = Some((mtime, path.to_path_buf()));
        }
    }

    best.map(|(_, path)| path)
}

/// Resolves a link target, falling back to a suffix search inside the project.
///
/// Three attempts, in order of confidence:
///   1. join the target onto the project root and canonicalise
///   2. match the full relative path as a suffix anywhere in the project
///   3. match just the file name (the model often drops intermediate folders)
fn preview_target_path(target: &str, base_dir: Option<&str>) -> Result<PathBuf, String> {
    let direct = resolve_target(target, base_dir);
    if direct.is_ok() {
        return direct;
    }
    let err = direct.unwrap_err();

    if !err.starts_with("File not found") {
        return Err(err);
    }

    if let Some(base) = base_dir {
        let base_path = Path::new(base);

        if let Some(found) = find_by_suffix(base_path, target) {
            return Ok(found);
        }

        if let Some(file_name) = target
            .rsplit(['/', '\\'])
            .find(|part| !part.is_empty() && *part != ".")
        {
            if let Some(found) = find_by_suffix(base_path, file_name) {
                return Ok(found);
            }
        }
    }

    Err(err)
}

/// Opens the system file manager with the target selected.
///
/// Uses the same three-tier resolution as the preview panel, so a link written
/// relative to the agent's working directory still lands on the right file
/// rather than on a path that merely looks plausible.
#[tauri::command]
pub async fn reveal_file_location(path: String, base_dir: Option<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || reveal_in_file_manager(path, base_dir))
        .await
        .map_err(|e| format!("Reveal task failed: {}", e))?
}

/// Opens Explorer with `path` selected, via the Shell API.
///
/// `explorer /select,<path>` looks simpler but cannot be made reliable from
/// Rust: Explorer parses its own command line, while std quotes any argument
/// that contains spaces or quotes. The result is a mangled argument, and
/// Explorer silently falls back to opening the default folder.
#[cfg(target_os = "windows")]
fn open_and_select(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::System::Com::{
        CoInitializeEx, CoTaskMemFree, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };
    use windows::Win32::UI::Shell::{ILCreateFromPathW, SHOpenFolderAndSelectItems};

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        // The command runs on a Tokio blocking thread without COM initialised.
        // An already-initialised apartment returns S_FALSE, which is fine.
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);

        let pidl = ILCreateFromPathW(PCWSTR(wide.as_ptr()));
        if pidl.is_null() {
            return Err(format!("Cannot resolve shell item for: {}", path.display()));
        }

        let result = SHOpenFolderAndSelectItems(pidl, None, 0);
        CoTaskMemFree(Some(pidl as *const _));

        result.map_err(|e| format!("Failed to open Explorer: {}", e))
    }
}

fn reveal_in_file_manager(path: String, base_dir: Option<String>) -> Result<(), String> {    let resolved = preview_target_path(&path, base_dir.as_deref())?;
    let shown = resolved.display().to_string();

    #[cfg(target_os = "windows")]
    {
        open_and_select(&resolved)?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&resolved)
            .spawn()
            .map_err(|e| format!("Failed to open Finder: {}", e))?;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = resolved.parent().unwrap_or(resolved.as_path());
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("Failed to open file manager: {}", e))?;
    }

    log::info!("Revealed in file manager: {}", shown);
    Ok(())
}

#[tauri::command]
pub async fn read_file_preview(
    path: String,
    base_dir: Option<String>,
) -> Result<FilePreview, String> {
    tokio::task::spawn_blocking(move || read_file_preview_blocking(path, base_dir))
        .await
        .map_err(|e| format!("Preview task failed: {}", e))?
}

fn read_file_preview_blocking(path: String, base_dir: Option<String>) -> Result<FilePreview, String> {
    let resolved = preview_target_path(&path, base_dir.as_deref())?;

    let metadata = fs::metadata(&resolved).map_err(|e| format!("Cannot stat file: {}", e))?;
    let size = metadata.len();
    let extension = resolved
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string();

    let display_name = resolved
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(&path)
        .to_string();

    let kind = kind_of(&extension);

    let mut preview = FilePreview {
        path: resolved.to_string_lossy().to_string(),
        display_name,
        kind: match kind {
            FileKind::Text => "text",
            FileKind::Image => "image",
            FileKind::Video => "video",
            FileKind::Audio => "audio",
            FileKind::Binary => "binary",
        }
        .to_string(),
        size,
        truncated: false,
        text: None,
        data_url: None,
    };

    match kind {
        FileKind::Text => {
            let bytes = fs::read(&resolved).map_err(|e| format!("Cannot read file: {}", e))?;
            let slice = if bytes.len() as u64 > MAX_TEXT_BYTES {
                preview.truncated = true;
                &bytes[..MAX_TEXT_BYTES as usize]
            } else {
                &bytes[..]
            };
            preview.text = Some(String::from_utf8_lossy(slice).to_string());
        }
        FileKind::Image | FileKind::Video | FileKind::Audio => {
            if size > MAX_BINARY_BYTES {
                // Too large to inline: report metadata only.
                return Ok(preview);
            }
            let bytes = fs::read(&resolved).map_err(|e| format!("Cannot read file: {}", e))?;
            let encoded = base64_encode(&bytes);
            preview.data_url = Some(format!("data:{};base64,{}", mime_of(&extension), encoded));
        }
        FileKind::Binary => {}
    }

    Ok(preview)
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    STANDARD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    fn write_file(dir: &Path, name: &str, contents: &[u8]) -> PathBuf {
        let path = dir.join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut f = fs::File::create(&path).unwrap();
        f.write_all(contents).unwrap();
        path
    }

    #[test]
    fn resolves_relative_paths_against_the_project() {
        let tmp = TempDir::new().unwrap();
        write_file(tmp.path(), "renders/out.mp4", b"fake");
        let base = tmp.path().to_str().unwrap();

        let resolved = resolve_target("renders/out.mp4", Some(base)).unwrap();
        assert!(resolved.ends_with("out.mp4"));
    }

    #[test]
    fn rejects_escape_from_the_project() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().join("project");
        fs::create_dir_all(&base).unwrap();
        write_file(tmp.path(), "outside.txt", b"secret");

        let err = resolve_target("../outside.txt", Some(base.to_str().unwrap())).unwrap_err();
        assert!(err.contains("outside the project directory"), "{}", err);
    }

    #[test]
    fn rejects_absolute_paths_outside_the_project() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().join("project");
        fs::create_dir_all(&base).unwrap();
        let outside = write_file(tmp.path(), "elsewhere.txt", b"secret");

        let err =
            resolve_target(outside.to_str().unwrap(), Some(base.to_str().unwrap())).unwrap_err();
        assert!(err.contains("outside the project directory"), "{}", err);
    }

    #[test]
    fn reports_missing_files() {
        let tmp = TempDir::new().unwrap();
        let err = resolve_target("nope.md", Some(tmp.path().to_str().unwrap())).unwrap_err();
        assert!(err.contains("File not found"), "{}", err);
    }

    #[test]
    fn classifies_kinds_by_extension() {
        assert_eq!(kind_of("md"), FileKind::Text);
        assert_eq!(kind_of("MP4"), FileKind::Video);
        assert_eq!(kind_of("png"), FileKind::Image);
        assert_eq!(kind_of("mp3"), FileKind::Audio);
        assert_eq!(kind_of("exe"), FileKind::Binary);
    }

    #[test]
    fn returns_text_for_markdown() {
        let tmp = TempDir::new().unwrap();
        write_file(tmp.path(), "notes.md", "# 标题\n正文".as_bytes());

        let preview = read_file_preview_blocking(
            "notes.md".to_string(),
            Some(tmp.path().to_str().unwrap().to_string()),
        )
        .unwrap();

        assert_eq!(preview.kind, "text");
        assert!(preview.text.unwrap().contains("标题"));
        assert!(!preview.truncated);
    }

    #[test]
    fn inlines_images_as_data_urls() {
        let tmp = TempDir::new().unwrap();
        write_file(tmp.path(), "shot.png", &[0x89, 0x50, 0x4E, 0x47]);

        let preview = read_file_preview_blocking(
            "shot.png".to_string(),
            Some(tmp.path().to_str().unwrap().to_string()),
        )
        .unwrap();

        assert_eq!(preview.kind, "image");
        assert!(preview.data_url.unwrap().starts_with("data:image/png;base64,"));
    }

    #[test]
    fn falls_back_to_suffix_search_for_nested_targets() {
        let tmp = TempDir::new().unwrap();
        write_file(tmp.path(), "published/2026-10-20/renders/out.md", b"# nested");
        let base = tmp.path().to_str().unwrap();

        // Direct join misses...
        assert!(resolve_target("renders/out.md", Some(base)).is_err());
        // ...but the suffix search finds the nested file.
        let found = preview_target_path("renders/out.md", Some(base)).unwrap();
        assert!(found.ends_with("renders/out.md"), "{:?}", found);
        assert!(found.starts_with(tmp.path()));
    }

    #[test]
    fn suffix_search_never_leaves_the_project() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().join("project");
        fs::create_dir_all(&base).unwrap();
        write_file(tmp.path(), "outside/secret.md", b"secret");

        assert!(preview_target_path("outside/secret.md", Some(base.to_str().unwrap())).is_err());
    }

    #[test]
    fn falls_back_to_file_name_when_folders_were_dropped() {
        // Real case: link says `renders/文案.md`, the file actually lives in
        // `published/2026-10-20/文案.md` with no `renders` segment at all.
        let tmp = TempDir::new().unwrap();
        write_file(tmp.path(), "published/2026-10-20/文案.md", b"# body");
        let base = tmp.path().to_str().unwrap();

        let found = preview_target_path("renders/文案.md", Some(base)).unwrap();
        assert!(found.ends_with("文案.md"), "{:?}", found);
    }

    #[test]
    fn reveal_reports_missing_files_instead_of_opening_anything() {
        // Guards must run before any process is spawned: with a missing target
        // this returns an error, so no Explorer window is opened.
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().to_str().unwrap();

        let err = super::reveal_in_file_manager(
            "nested/missing.md".to_string(),
            Some(base.to_string()),
        )
        .unwrap_err();
        assert!(err.to_lowercase().contains("not found"), "{}", err);
    }

    #[test]
    fn reveal_refuses_targets_outside_the_project() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().join("project");
        fs::create_dir_all(&base).unwrap();
        write_file(tmp.path(), "outside/secret.md", b"secret");

        let err = super::reveal_in_file_manager(
            "outside/secret.md".to_string(),
            Some(base.to_str().unwrap().to_string()),
        )
        .unwrap_err();
        assert!(!err.is_empty());
    }
}
