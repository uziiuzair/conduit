//! The time-aware rules behind the per-session agent status.
//!
//! `fleet::apply_event` is otherwise a pure event->state switch with no notion of *when* an
//! event arrived, and three separate defects follow from that: a session that dies mid-turn
//! stays `running` forever, a late tool hook resurrects a turn that just ended, and every
//! `notification` reads as "needs you" regardless of what it actually said.
//!
//! The rules live in their own module rather than inline in the match arms for one reason:
//! **the numbers must not fork.** The frontend keeps its own `live` map fed by the same hook
//! stream (`src/statusRules.ts` mirrors this file), and the moment each surface invents its
//! own timeout they disagree about whether a session is busy. One module, one number, one
//! decider.

/// How long a `running` session may go without any event before it is presumed gone.
///
/// A session leaves `running` only when something says so, and several exits say nothing at
/// all: Esc during a tool call (Claude aborts the tool and never runs its `Stop` hook), a
/// killed CLI, a slept machine. Twenty minutes is well past Claude's own ~10-minute Bash
/// timeout, and every tool event refreshes the entry, so a genuinely long turn is never
/// swept. The rule is self-healing either way: one later event puts the session straight
/// back to `running`.
pub const WORKING_STALE_MS: u64 = 20 * 60_000;

/// How long a freshly `done` session ignores tool-level `running` signals.
///
/// Claude runs hooks in parallel, so a `PostToolUse` POST for the last tool of a turn can
/// land *after* that turn's `Stop`. Without a holdoff the finished session flips back to
/// `running` and nothing ever clears it. A real new turn (`prompt`) is never held off --
/// only the tool chatter is.
pub const DONE_HOLDOFF_MS: u64 = 3_000;

/// Has a `running` session gone quiet for longer than the window?
pub fn is_stale_working(status: &str, updated_at: u64, now: u64) -> bool {
    is_stale_working_within(status, updated_at, now, WORKING_STALE_MS)
}

/// `is_stale_working` with an explicit window, so tests need not wait 20 minutes.
pub fn is_stale_working_within(status: &str, updated_at: u64, now: u64, stale_ms: u64) -> bool {
    status == "running" && now.saturating_sub(updated_at) > stale_ms
}

/// Should a tool-level `running` signal be ignored because the turn just ended?
pub fn holds_off_working(status: &str, updated_at: u64, now: u64) -> bool {
    status == "done" && now.saturating_sub(updated_at) < DONE_HOLDOFF_MS
}

/// What a `notification` event means for a session currently at `current`.
///
/// `None` = leave the status alone. Claude's `Notification` payload carries a
/// `notification_type` that separates four quite different situations, and collapsing them
/// into one "needs input" badge is wrong in both directions:
///
/// - `permission_prompt` / `elicitation_dialog` / `agent_needs_input` genuinely want you.
/// - `idle_prompt` means the CLI is sitting at its prompt. It fires after a *normally
///   finished* turn too, so treating it as "needs input" leaves a permanent false alarm on
///   every completed session. It also cannot be true while a turn runs, which makes it the
///   one signal that rescues a session stuck on `running` when no turn-end hook ever fired
///   -- the Esc-during-a-tool-call case. So it may only move a session that is still
///   `running`, and it moves it to `idle`: nothing was accomplished, so there is nothing to
///   go and read, and `done` would be a lie.
/// - Everything else (`auth_success`, `elicitation_complete`, `agent_completed`, and any
///   type a future release adds) is informational. Unknown types are a no-op by design: a
///   new Claude notification kind should not grow a badge here until we decide it should.
///
/// A payload with **no** `notification_type` at all keeps the legacy behavior (`needsInput`)
/// rather than falling into the unknown-type no-op -- that is exactly what shipped before
/// this rule existed, so a Claude build that omits the field cannot lose its badge.
pub fn notification_status(notification_type: Option<&str>, current: &str) -> Option<&'static str> {
    match notification_type {
        None => Some("needsInput"),
        Some("permission_prompt" | "elicitation_dialog" | "agent_needs_input") => {
            Some("needsInput")
        }
        Some("idle_prompt") => (current == "running").then_some("idle"),
        Some(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: u64 = 60_000;

    #[test]
    fn only_running_goes_stale_and_only_past_the_window() {
        let now = 100 * MIN;
        assert!(is_stale_working("running", now - 21 * MIN, now));
        assert!(!is_stale_working("running", now - 19 * MIN, now));
        // A long turn that keeps firing tool events refreshes updated_at, so it never trips.
        assert!(!is_stale_working("running", now, now));
        for other in ["idle", "done", "needsInput"] {
            assert!(
                !is_stale_working(other, 0, now),
                "{other} is not a working state and must never be swept"
            );
        }
    }

    #[test]
    fn a_clock_that_jumps_backwards_never_sweeps() {
        // now < updated_at (NTP step, or a stored timestamp from the future) must saturate to
        // zero elapsed rather than wrap to a huge one and sweep every live session.
        assert!(!is_stale_working("running", 100 * MIN, 1));
    }

    #[test]
    fn done_holds_off_tool_chatter_for_three_seconds() {
        let now = 10 * MIN;
        assert!(holds_off_working("done", now - 1_000, now));
        assert!(!holds_off_working("done", now - 4_000, now));
        // Only `done` holds off -- an idle or needsInput session takes the signal immediately.
        assert!(!holds_off_working("idle", now, now));
        assert!(!holds_off_working("needsInput", now, now));
    }

    #[test]
    fn notifications_that_want_you_say_so() {
        for t in [
            "permission_prompt",
            "elicitation_dialog",
            "agent_needs_input",
        ] {
            assert_eq!(notification_status(Some(t), "running"), Some("needsInput"));
            assert_eq!(notification_status(Some(t), "done"), Some("needsInput"));
        }
    }

    #[test]
    fn idle_prompt_rescues_a_stuck_turn_and_never_disturbs_a_finished_one() {
        // The Esc-during-a-tool-call case: no Stop hook ever ran, so this is the way out.
        assert_eq!(
            notification_status(Some("idle_prompt"), "running"),
            Some("idle")
        );
        // The same event also fires after a normal turn end. Touching `done` here is what
        // made every completed session bounce back to a "needs input" badge.
        assert_eq!(notification_status(Some("idle_prompt"), "done"), None);
        assert_eq!(notification_status(Some("idle_prompt"), "idle"), None);
        assert_eq!(notification_status(Some("idle_prompt"), "needsInput"), None);
    }

    #[test]
    fn informational_and_unknown_types_are_a_no_op() {
        for t in [
            "auth_success",
            "elicitation_complete",
            "agent_completed",
            "some_future_kind",
        ] {
            assert_eq!(notification_status(Some(t), "running"), None, "{t}");
            assert_eq!(notification_status(Some(t), "done"), None, "{t}");
        }
    }

    #[test]
    fn a_payload_with_no_type_keeps_the_legacy_badge() {
        assert_eq!(notification_status(None, "running"), Some("needsInput"));
        assert_eq!(notification_status(None, "done"), Some("needsInput"));
    }
}
