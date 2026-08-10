//! Cold-restore scrollback: what a terminal shows when tmux is gone.
//!
//! Session persistence made an app restart a *warm* reattach -- tmux is still running, so it
//! redraws the pane and the terminal comes back exactly as it was. A machine reboot is
//! different: the tmux server died with it, and the session comes back completely empty even
//! though the conversation is intact. So does a session the reaper retired under memory
//! pressure (see `session_budget`), which is deliberately indistinguishable from a reboot.
//!
//! This keeps a byte-capped snapshot of each terminal's recent output on disk and replays it
//! into xterm on a COLD start only. A warm reattach ignores it entirely: tmux is about to
//! paint the same content, and replaying would simply print it twice.

use std::fs;
use std::path::PathBuf;

/// Trailing bytes retained per session.
///
/// A few screens of context -- enough to see where you left off, small enough that a dozen
/// sessions cost a few megabytes of disk and a write nobody notices.
pub const MAX_BYTES: usize = 256 * 1024;

/// Where snapshots live: `<data dir>/scrollback/`.
pub fn dir() -> PathBuf {
    crate::store::data_dir().join("scrollback")
}

/// Snapshot path for a session.
///
/// The id is sanitized rather than hashed: Conduit's ids are uuids (plus a `::term` suffix
/// for a companion shell), so the readable name is worth more during debugging than the
/// collision resistance of a digest -- and the sanitization is the same total mapping the
/// tmux session name uses.
pub fn path_for(session_id: &str) -> PathBuf {
    let safe: String = session_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    dir().join(format!("{safe}.bin"))
}

/// Keep only the trailing `MAX_BYTES`, without splitting a UTF-8 sequence at the cut.
///
/// A torn multi-byte character at the head of a replay is not a cosmetic problem: the bytes
/// go straight into a terminal emulator, which resynchronizes only after eating whatever
/// follows. Advancing past continuation bytes costs three comparisons and removes the whole
/// class of "the first line came back as garbage".
pub fn trailing(data: &[u8]) -> &[u8] {
    if data.len() <= MAX_BYTES {
        return data;
    }
    let mut start = data.len() - MAX_BYTES;
    // 0b10xxxxxx is a UTF-8 continuation byte; skip forward to a real code-point start.
    while start < data.len() && (data[start] & 0b1100_0000) == 0b1000_0000 {
        start += 1;
    }
    &data[start..]
}

/// Write a session's snapshot. Best-effort: a failed write costs a cold restore its
/// scrollback, which is a worse terminal, not a broken one.
pub fn save(session_id: &str, data: &[u8]) {
    let path = path_for(session_id);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(path, trailing(data));
}

/// Read a session's snapshot, if any.
pub fn load(session_id: &str) -> Option<Vec<u8>> {
    fs::read(path_for(session_id)).ok()
}

/// Delete a session's snapshot.
///
/// Called when a session is DESTROYED, never when its tmux session is merely killed --
/// that distinction is the whole safety contract of the reaper: a reaped session must come
/// back looking like it survived a reboot, which it cannot do without its snapshot.
pub fn remove(session_id: &str) {
    let _ = fs::remove_file(path_for(session_id));
}

/// Delete snapshots for sessions that no longer exist. Called at boot with every live id.
pub fn sweep(live_session_ids: &[String]) {
    let Ok(entries) = fs::read_dir(dir()) else {
        return; // no snapshots yet
    };
    let live: std::collections::HashSet<PathBuf> =
        live_session_ids.iter().map(|id| path_for(id)).collect();
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().is_some_and(|e| e == "bin") && !live.contains(&p) {
            let _ = fs::remove_file(p);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_data_is_returned_whole() {
        let data = b"hello";
        assert_eq!(trailing(data), data);
    }

    #[test]
    fn long_data_is_cut_to_the_cap() {
        let data = vec![b'x'; MAX_BYTES + 5_000];
        assert_eq!(trailing(&data).len(), MAX_BYTES);
    }

    #[test]
    fn the_cut_never_lands_inside_a_utf8_sequence() {
        // Fill with a 3-byte character so almost every cut point is mid-sequence.
        let unit = "☃".as_bytes(); // E2 98 83
        let mut data = Vec::new();
        while data.len() < MAX_BYTES + 3_000 {
            data.extend_from_slice(unit);
        }
        let cut = trailing(&data);
        assert!(cut.len() <= MAX_BYTES);
        // The whole point: the result decodes cleanly with no replacement characters.
        let s = std::str::from_utf8(cut).expect("cut must land on a code-point boundary");
        assert!(s.starts_with('☃'));
        assert!(!s.contains('\u{FFFD}'));
    }

    #[test]
    fn a_cut_that_lands_exactly_on_a_boundary_keeps_every_byte_it_may() {
        let mut data = vec![b'a'; MAX_BYTES];
        data.insert(0, b'b'); // one byte over, cut lands on an ASCII boundary
        assert_eq!(trailing(&data).len(), MAX_BYTES);
        assert!(trailing(&data).iter().all(|&b| b == b'a'));
    }

    #[test]
    fn the_path_is_readable_and_total() {
        // A companion shell's id carries `::`, which is not filename-safe everywhere.
        let p = path_for("abc-123::term");
        assert_eq!(p.file_name().unwrap(), "abc-123__term.bin");
        // Total: no input produces a path outside the directory.
        for id in ["../../etc/passwd", "", "a/b", "."] {
            let p = path_for(id);
            assert_eq!(p.parent(), Some(dir().as_path()), "for {id:?}");
        }
    }
}
