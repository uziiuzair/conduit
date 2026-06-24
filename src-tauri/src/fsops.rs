//! Read-only filesystem access for the Files tab + file viewer. Never writes.

use std::fs;

use serde::Serialize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// List a directory's entries (dirs first, then files; alphabetical). Hidden
/// dotfiles are included (like the screenshot) but `.git` is skipped as noise.
pub fn list_dir(dir: &str) -> Vec<DirEntry> {
    let mut entries: Vec<DirEntry> = Vec::new();
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name == ".git" {
                continue;
            }
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            entries.push(DirEntry {
                name,
                path: e.path().to_string_lossy().into_owned(),
                is_dir,
            });
        }
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub content: String,
    pub truncated: bool,
    pub binary: bool,
}

/// Read a file for the read-only viewer. Caps at 1 MB and refuses binaries.
pub fn read_file(path: &str) -> FileContent {
    const CAP: usize = 1024 * 1024;
    let data = match fs::read(path) {
        Ok(d) => d,
        Err(e) => {
            return FileContent {
                content: format!("(could not read file: {e})"),
                truncated: false,
                binary: false,
            }
        }
    };
    // Crude binary sniff: a NUL byte in the first 8 KB.
    let sniff = &data[..data.len().min(8192)];
    if sniff.contains(&0) {
        return FileContent {
            content: "(binary file — not shown)".into(),
            truncated: false,
            binary: true,
        };
    }
    let truncated = data.len() > CAP;
    let slice = &data[..data.len().min(CAP)];
    FileContent {
        content: String::from_utf8_lossy(slice).into_owned(),
        truncated,
        binary: false,
    }
}
