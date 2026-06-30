//! In-process fan-out of Claude hook events to the mobile bridge. `hooks.rs`
//! publishes each event here; bridge connections subscribe to receive the live
//! status stream. Drop-oldest backpressure (a slow phone never stalls the hook
//! server), pruning disconnected receivers — mirrors `pty::broadcast`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::Mutex;

/// Buffered hook events per subscriber before events start dropping.
const BUS_BUFFER: usize = 256;

/// One forwarded hook event: routed session, Conduit verb, and the raw body JSON.
#[derive(Clone, Debug)]
pub struct HookEvent {
    pub session: String,
    pub event: String,
    pub body: serde_json::Value,
}

#[derive(Default)]
pub struct HookBus {
    subscribers: Mutex<Vec<(u64, SyncSender<HookEvent>)>>,
    next_id: AtomicU64,
}

impl HookBus {
    /// Attach a subscriber. Returns its id (for `unsubscribe`) and the receiver.
    pub fn subscribe(&self) -> (u64, Receiver<HookEvent>) {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = sync_channel(BUS_BUFFER);
        if let Ok(mut subs) = self.subscribers.lock() {
            subs.push((id, tx));
        }
        (id, rx)
    }

    pub fn unsubscribe(&self, id: u64) {
        if let Ok(mut subs) = self.subscribers.lock() {
            subs.retain(|(i, _)| *i != id);
        }
    }

    /// Fan one event to every subscriber. A full buffer drops the event (never
    /// blocks the hook server); a hung-up receiver is pruned.
    pub fn publish(&self, ev: HookEvent) {
        if let Ok(mut subs) = self.subscribers.lock() {
            subs.retain(|(_, tx)| match tx.try_send(ev.clone()) {
                Ok(()) => true,
                Err(TrySendError::Full(_)) => true,
                Err(TrySendError::Disconnected(_)) => false,
            });
        }
    }

    #[cfg(test)]
    pub fn subscriber_count(&self) -> usize {
        self.subscribers.lock().map(|s| s.len()).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ev(session: &str) -> HookEvent {
        HookEvent {
            session: session.into(),
            event: "pretool".into(),
            body: json!({ "tool_name": "Bash" }),
        }
    }

    #[test]
    fn subscriber_receives_published_event() {
        let bus = HookBus::default();
        let (_id, rx) = bus.subscribe();
        bus.publish(ev("s1"));
        let got = rx.recv().unwrap();
        assert_eq!(got.session, "s1");
        assert_eq!(got.event, "pretool");
    }

    #[test]
    fn unsubscribe_stops_delivery() {
        let bus = HookBus::default();
        let (id, rx) = bus.subscribe();
        bus.unsubscribe(id);
        bus.publish(ev("s1"));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn disconnected_subscriber_is_pruned() {
        let bus = HookBus::default();
        let (_id, rx) = bus.subscribe();
        drop(rx);
        bus.publish(ev("s1")); // prunes the dead receiver
        assert_eq!(bus.subscriber_count(), 0);
    }

    #[test]
    fn full_subscriber_drops_not_blocks() {
        let bus = HookBus::default();
        let (_id, rx) = bus.subscribe();
        for _ in 0..(BUS_BUFFER + 5) {
            bus.publish(ev("s1")); // must not block or panic when the buffer fills
        }
        let mut n = 0;
        while rx.try_recv().is_ok() {
            n += 1;
        }
        assert!(n <= BUS_BUFFER, "buffer overflowed: {n}");
    }
}
