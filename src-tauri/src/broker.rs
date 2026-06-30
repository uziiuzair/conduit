//! Pending tool-approval requests. The `/approve` hook handler registers a request
//! and blocks on its receiver; the bridge (phone) or a desktop card resolves it.
//! First responder wins (resolve removes the entry; a second resolve is a no-op).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::Mutex;

/// The decision returned to Claude's PreToolUse hook.
#[derive(Clone, Debug, PartialEq)]
pub enum Decision {
    Allow,
    Deny { reason: String },
}

/// A surfaced approval request (forwarded to the phone / desktop card).
#[derive(Clone, Debug, PartialEq)]
pub struct ApprovalRequest {
    pub id: String,
    pub session: String,
    pub tool: String,
    pub input: serde_json::Value,
}

/// Which sessions currently have at least one bridge client (phone) attached.
/// Refcounted so multiple viewers / reconnects don't prematurely clear a session.
/// The broker uses this for "no phone watching → don't intercept" (desktop default
/// stays the native prompt until you pair).
#[derive(Default)]
pub struct Presence {
    attached: Mutex<HashMap<String, u32>>,
}

impl Presence {
    pub fn attach(&self, session: &str) {
        if let Ok(mut m) = self.attached.lock() {
            *m.entry(session.to_string()).or_insert(0) += 1;
        }
    }

    pub fn detach(&self, session: &str) {
        if let Ok(mut m) = self.attached.lock() {
            if let Some(c) = m.get_mut(session) {
                *c = c.saturating_sub(1);
                if *c == 0 {
                    m.remove(session);
                }
            }
        }
    }

    pub fn is_attached(&self, session: &str) -> bool {
        self.attached
            .lock()
            .map(|m| m.contains_key(session))
            .unwrap_or(false)
    }
}

#[derive(Default)]
pub struct Broker {
    pending: Mutex<HashMap<String, (ApprovalRequest, SyncSender<Decision>)>>,
    seq: AtomicU64,
}

impl Broker {
    /// Register a pending request; returns its id and a receiver the caller blocks on.
    pub fn register(
        &self,
        session: String,
        tool: String,
        input: serde_json::Value,
    ) -> (String, Receiver<Decision>) {
        let id = format!("ap-{}", self.seq.fetch_add(1, Ordering::SeqCst));
        let (tx, rx) = sync_channel(1);
        let req = ApprovalRequest {
            id: id.clone(),
            session,
            tool,
            input,
        };
        if let Ok(mut p) = self.pending.lock() {
            p.insert(id.clone(), (req, tx));
        }
        (id, rx)
    }

    /// Resolve a pending request (first responder wins). No-op if already gone.
    pub fn resolve(&self, id: &str, decision: Decision) {
        let entry = self.pending.lock().ok().and_then(|mut p| p.remove(id));
        if let Some((_, tx)) = entry {
            let _ = tx.try_send(decision);
        }
    }

    /// Open requests for a session (so a freshly-attached phone can catch up).
    pub fn pending_for(&self, session: &str) -> Vec<ApprovalRequest> {
        self.pending
            .lock()
            .map(|p| {
                p.values()
                    .filter(|(r, _)| r.session == session)
                    .map(|(r, _)| r.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    #[cfg(test)]
    pub fn pending_count(&self) -> usize {
        self.pending.lock().map(|p| p.len()).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn register_then_resolve_delivers_decision() {
        let b = Broker::default();
        let (id, rx) = b.register("s1".into(), "Bash".into(), json!({ "command": "ls" }));
        b.resolve(&id, Decision::Allow);
        assert_eq!(rx.recv().unwrap(), Decision::Allow);
        assert_eq!(b.pending_count(), 0);
    }

    #[test]
    fn resolve_deny_carries_reason() {
        let b = Broker::default();
        let (id, rx) = b.register("s1".into(), "Bash".into(), json!({}));
        b.resolve(&id, Decision::Deny { reason: "nope".into() });
        assert_eq!(rx.recv().unwrap(), Decision::Deny { reason: "nope".into() });
    }

    #[test]
    fn resolve_unknown_id_is_noop() {
        let b = Broker::default();
        b.resolve("missing", Decision::Allow); // must not panic
        assert_eq!(b.pending_count(), 0);
    }

    #[test]
    fn second_resolve_is_noop_first_responder_wins() {
        let b = Broker::default();
        let (id, rx) = b.register("s1".into(), "Bash".into(), json!({}));
        b.resolve(&id, Decision::Allow);
        b.resolve(&id, Decision::Deny { reason: "late".into() }); // entry already gone
        assert_eq!(rx.recv().unwrap(), Decision::Allow);
    }

    #[test]
    fn pending_for_lists_by_session() {
        let b = Broker::default();
        let (_i1, _r1) = b.register("s1".into(), "Bash".into(), json!({}));
        let (_i2, _r2) = b.register("s2".into(), "Write".into(), json!({}));
        let (_i3, _r3) = b.register("s1".into(), "Edit".into(), json!({}));
        let s1 = b.pending_for("s1");
        assert_eq!(s1.len(), 2);
        assert!(s1.iter().all(|r| r.session == "s1"));
        assert_eq!(b.pending_for("s2").len(), 1);
    }

    #[test]
    fn presence_tracks_attachment_with_refcount() {
        let pr = Presence::default();
        assert!(!pr.is_attached("s1"));
        pr.attach("s1");
        pr.attach("s1"); // two viewers
        assert!(pr.is_attached("s1"));
        pr.detach("s1");
        assert!(pr.is_attached("s1"), "still one viewer");
        pr.detach("s1");
        assert!(!pr.is_attached("s1"), "last viewer gone");
        pr.detach("s1"); // underflow is a no-op
        assert!(!pr.is_attached("s1"));
    }
}
