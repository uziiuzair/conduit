//! Read-only project-scoped view of continuity's decisions and messages.
//!
//! Sibling of `continuity_read` (which serves the board). Conduit only ever READS this
//! database -- continuity owns every write.

use sha2::{Digest, Sha256};

/// Continuity's session-to-checkout key: sha256 of the git toplevel, hex, first 16 chars.
///
/// Continuity salts this with `CONTINUITY_SESSION_ID` when that env var is set, and
/// `pty.rs` sets it for every Conduit spawn -- so this UNSALTED form deliberately matches
/// only sessions started outside Conduit. Conduit's own sessions are matched by
/// `agent_label` instead, which `pty.rs` pins to the Conduit session id.
pub fn cwd_hash_of(toplevel: &str) -> String {
    let digest = Sha256::digest(toplevel.as_bytes());
    let hex = digest
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    hex[..16].to_string()
}

/// Is continuity actually working? The file existing is not enough: a database that has
/// never had a session checked in has nothing to show, and the panels should stay hidden
/// rather than render an empty shell.
pub fn probe(conn: &rusqlite::Connection) -> bool {
    conn.query_row("SELECT COUNT(*) FROM agent_sessions", [], |r| {
        r.get::<_, i64>(0)
    })
    .map(|n| n > 0)
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SHA-256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    /// (the canonical FIPS-180 test vector). Pinning the first 16 hex chars proves our
    /// hash matches continuity's `createHash("sha256").update(x).digest("hex").slice(0,16)`
    /// without either side having to trust the other's implementation.
    #[test]
    fn cwd_hash_matches_the_sha256_vector() {
        assert_eq!(cwd_hash_of("abc"), "ba7816bf8f01cfea");
    }

    #[test]
    fn cwd_hash_is_sixteen_hex_chars() {
        let h = cwd_hash_of("/Users/someone/repo");
        assert_eq!(h.len(), 16);
        assert!(h.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
