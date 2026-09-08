//! Dispatch proposals: work root chat wants to start, waiting on a human decision.
//!
//! Deliberately NOT `broker.rs`. That registry hands its caller a receiver to block on
//! and forgets the entry the moment it is answered -- right for a 45s tool-approval hook.
//! A dispatch proposal is the opposite shape: the MCP call returns immediately, the human
//! may answer an hour later from a phone, and the outcome must still be readable
//! afterwards so a later chat turn can ask `dispatch_status`. One struct serving both
//! lifetimes would have to lie to one of them; the UI merges the two queues instead.
//!
//! `now` is always a parameter -- never a clock read -- so expiry is testable.
//!
//! Task 3's `root_mcp::dispatch_work_inner`/`dispatch_status_inner` are this module's
//! first non-test callers (`register` via `dispatch_work`, `get` via `dispatch_status`).
//! Task 4's `lib.rs` commands (`list_pending_decisions`, `approve_root_proposal`,
//! `deny_root_proposal`) are what call `pending` and `resolve`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// Pending proposals one chat may hold at once. A confused loop queues ten cards, not
/// five hundred.
pub const MAX_PENDING_PER_CHAT: usize = 10;

/// How long an unanswered proposal stays actionable. An approval you never got to must
/// not spawn work next week.
pub const EXPIRY_SECS: u64 = 86_400;

#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    Pending,
    // Constructed by `lib.rs`'s `approve_root_proposal`/`deny_root_proposal` (Task 4) with
    // the human's answer.
    Approved { session_id: String },
    Denied { reason: Option<String> },
    Expired,
}

#[derive(Clone, Debug)]
pub struct Proposal {
    pub id: String,
    pub chat_id: String,
    pub project_id: String,
    pub task: String,
    /// Task kind for routing (planning|implementation|review|research|bulk). The concrete
    /// agent is resolved at APPROVE time by the frontend's `pickTarget`, which is the only
    /// place that knows which accounts still have quota.
    pub kind: Option<String>,
    /// An explicit agent the chat named, overriding routing.
    pub agent: Option<String>,
    pub model: Option<String>,
    pub created_at: u64,
    pub outcome: Outcome,
}

#[derive(Default)]
pub struct Proposals {
    inner: Mutex<Vec<Proposal>>,
    seq: AtomicU64,
}

impl Proposals {
    #[allow(clippy::too_many_arguments)]
    pub fn register(
        &self,
        chat_id: &str,
        project_id: &str,
        task: &str,
        kind: Option<String>,
        agent: Option<String>,
        model: Option<String>,
        now: u64,
    ) -> Result<Proposal, String> {
        self.sweep(now);
        let mut list = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let open = list
            .iter()
            .filter(|p| p.chat_id == chat_id && p.outcome == Outcome::Pending)
            .count();
        if open >= MAX_PENDING_PER_CHAT {
            return Err(format!(
                "too many pending proposals for this chat ({open}); resolve some first"
            ));
        }
        let proposal = Proposal {
            id: format!("dp-{}", self.seq.fetch_add(1, Ordering::SeqCst)),
            chat_id: chat_id.to_string(),
            project_id: project_id.to_string(),
            task: task.to_string(),
            kind,
            agent,
            model,
            created_at: now,
            outcome: Outcome::Pending,
        };
        list.push(proposal.clone());
        Ok(proposal)
    }

    pub fn get(&self, id: &str) -> Option<Proposal> {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .find(|p| p.id == id)
            .cloned()
    }

    /// Still-actionable proposals. Sweeps first, so reading the queue is also what
    /// retires anything past the window.
    ///
    /// Called by `lib.rs`'s `list_pending_decisions` (Task 4), the pending-decisions UI
    /// panel's data source.
    pub fn pending(&self, now: u64) -> Vec<Proposal> {
        self.sweep(now);
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|p| p.outcome == Outcome::Pending)
            .cloned()
            .collect()
    }

    /// Record an answer. Returns false if the proposal is unknown or already answered --
    /// first responder wins, so a desktop card and a phone racing cannot double-spawn.
    ///
    /// Called by `lib.rs`'s `approve_root_proposal`/`deny_root_proposal` (Task 4).
    pub fn resolve(&self, id: &str, outcome: Outcome) -> bool {
        let mut list = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        match list.iter_mut().find(|p| p.id == id) {
            Some(p) if p.outcome == Outcome::Pending => {
                p.outcome = outcome;
                true
            }
            _ => false,
        }
    }

    pub fn sweep(&self, now: u64) {
        let mut list = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        for p in list.iter_mut() {
            if p.outcome == Outcome::Pending && now.saturating_sub(p.created_at) > EXPIRY_SECS {
                p.outcome = Outcome::Expired;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: u64 = 1_700_000_000;

    fn reg(p: &Proposals, chat: &str, now: u64) -> Proposal {
        p.register(chat, "proj-1", "ship the thing", None, None, None, now)
            .expect("registers")
    }

    #[test]
    fn register_starts_pending_and_ids_are_unique() {
        let p = Proposals::default();
        let a = reg(&p, "chat-1", T0);
        let b = reg(&p, "chat-1", T0);
        assert!(matches!(a.outcome, Outcome::Pending));
        assert_ne!(a.id, b.id);
        assert_eq!(p.get(&a.id).unwrap().task, "ship the thing");
        assert_eq!(p.pending(T0).len(), 2);
    }

    #[test]
    fn approve_records_the_session_and_first_responder_wins() {
        let p = Proposals::default();
        let a = reg(&p, "chat-1", T0);
        assert!(p.resolve(
            &a.id,
            Outcome::Approved {
                session_id: "s-9".into()
            }
        ));
        match p.get(&a.id).unwrap().outcome {
            Outcome::Approved { session_id } => assert_eq!(session_id, "s-9"),
            other => panic!("expected approved, got {other:?}"),
        }
        // A second resolve must not overwrite the first answer.
        assert!(!p.resolve(&a.id, Outcome::Denied { reason: None }));
        assert!(matches!(
            p.get(&a.id).unwrap().outcome,
            Outcome::Approved { .. }
        ));
        // Resolved proposals leave the pending queue but stay readable.
        assert!(p.pending(T0).is_empty());
    }

    #[test]
    fn deny_keeps_the_reason() {
        let p = Proposals::default();
        let a = reg(&p, "chat-1", T0);
        p.resolve(
            &a.id,
            Outcome::Denied {
                reason: Some("not now".into()),
            },
        );
        match p.get(&a.id).unwrap().outcome {
            Outcome::Denied { reason } => assert_eq!(reason.as_deref(), Some("not now")),
            other => panic!("expected denied, got {other:?}"),
        }
    }

    #[test]
    fn pending_expires_past_the_window_and_cannot_be_approved_after() {
        let p = Proposals::default();
        let a = reg(&p, "chat-1", T0);
        assert_eq!(p.pending(T0 + EXPIRY_SECS - 1).len(), 1);
        assert!(p.pending(T0 + EXPIRY_SECS + 1).is_empty());
        // Reading pending past the window is what marks it — the outcome sticks.
        assert!(matches!(p.get(&a.id).unwrap().outcome, Outcome::Expired));
        assert!(!p.resolve(
            &a.id,
            Outcome::Approved {
                session_id: "s-1".into()
            }
        ));
    }

    /// The existing test above checks `EXPIRY_SECS - 1` (still pending) and
    /// `EXPIRY_SECS + 1` (expired), but never the exact boundary -- so a `>` -> `>=`
    /// regression in `sweep` would pass unnoticed. At exactly `now - created_at ==
    /// EXPIRY_SECS`, the current `>` semantics keep the proposal pending.
    #[test]
    fn pending_is_still_pending_at_exactly_the_expiry_boundary() {
        let p = Proposals::default();
        let a = reg(&p, "chat-1", T0);
        assert_eq!(p.pending(T0 + EXPIRY_SECS).len(), 1);
        assert!(matches!(p.get(&a.id).unwrap().outcome, Outcome::Pending));
    }

    #[test]
    fn the_cap_is_per_chat_and_freed_by_resolving() {
        let p = Proposals::default();
        let mut ids = Vec::new();
        for _ in 0..MAX_PENDING_PER_CHAT {
            ids.push(reg(&p, "chat-1", T0).id);
        }
        // Chat 1 is full…
        let err = p
            .register("chat-1", "proj-1", "one more", None, None, None, T0)
            .unwrap_err();
        assert!(err.contains("too many"), "{err}");
        // …but another chat is unaffected, and resolving frees a slot.
        assert!(p
            .register("chat-2", "proj-1", "fine", None, None, None, T0)
            .is_ok());
        p.resolve(&ids[0], Outcome::Denied { reason: None });
        assert!(p
            .register("chat-1", "proj-1", "now ok", None, None, None, T0)
            .is_ok());
    }

    #[test]
    fn expired_proposals_free_cap_slots_too() {
        let p = Proposals::default();
        for _ in 0..MAX_PENDING_PER_CHAT {
            reg(&p, "chat-1", T0);
        }
        let later = T0 + EXPIRY_SECS + 1;
        assert!(
            p.register("chat-1", "proj-1", "after expiry", None, None, None, later)
                .is_ok(),
            "a full queue of expired proposals must not block forever"
        );
    }
}
