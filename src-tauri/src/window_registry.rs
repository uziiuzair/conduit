//! Which window shows which profile. One registry, managed state; the label is the
//! Tauri window label ("main", "profile-<id>", "profile-default"). `None` = Default.
//!
//! Consumed by the `window_profile`/`open_profile_window`/`close_window` commands
//! (Task 3); further consumers land in Tasks 4, 6, 7.

use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Default)]
pub struct WindowRegistry {
    map: Mutex<HashMap<String, Option<String>>>,
}

/// Outcome of `WindowRegistry::claim`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Claim {
    /// `profile` was already claimed by this label before the call.
    Existing(String),
    /// This call is the one that inserted `label -> profile`.
    Claimed(String),
}

/// Label a secondary window for `profile` gets. Pure; "main" is never produced here.
pub fn profile_window_label(profile: &Option<String>) -> String {
    match profile {
        Some(id) => format!("profile-{id}"),
        None => "profile-default".to_string(),
    }
}

impl WindowRegistry {
    pub fn register(&self, label: &str, profile: Option<String>) {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        map.insert(label.to_string(), profile);
    }

    pub fn remove(&self, label: &str) {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        map.remove(label);
    }

    /// Outer None = unknown label; inner None = Default profile.
    pub fn profile_of(&self, label: &str) -> Option<Option<String>> {
        let map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        map.get(label).cloned()
    }

    /// First label currently showing `profile` ("main" counts).
    ///
    /// Read-only lookup, kept separate from `claim` for a future consumer that wants to
    /// know whether a profile has a window without also claiming one (Tasks 4/6/7).
    /// `open_profile_window`'s own check-and-claim now goes through `claim` instead, so
    /// this is currently only exercised by this module's own tests.
    #[allow(dead_code)]
    pub fn label_for(&self, profile: &Option<String>) -> Option<String> {
        let map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        map.iter()
            .find(|(_, p)| p == &profile)
            .map(|(label, _)| label.clone())
    }

    /// Atomically: if a window already claims `profile`, return `Existing` with its
    /// label; else insert `label -> profile` and return `Claimed(label)`. One lock
    /// acquisition covers the whole check-then-insert, which is what closes the race
    /// `open_profile_window` used to have between its separate `label_for` read and
    /// `register` write — two concurrent calls for the same profile could otherwise both
    /// see nothing registered and both try to build a window under the same label.
    pub fn claim(&self, label: &str, profile: &Option<String>) -> Claim {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((existing_label, _)) = map.iter().find(|(_, p)| *p == profile) {
            return Claim::Existing(existing_label.clone());
        }
        map.insert(label.to_string(), profile.clone());
        Claim::Claimed(label.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_profile_window_label_default() {
        assert_eq!(profile_window_label(&None), "profile-default");
    }

    #[test]
    fn test_profile_window_label_with_id() {
        assert_eq!(profile_window_label(&Some("a".to_string())), "profile-a");
    }

    #[test]
    fn test_register_and_label_for_main_default() {
        let registry = WindowRegistry::default();
        registry.register("main", None);
        assert_eq!(registry.label_for(&None), Some("main".to_string()));
    }

    #[test]
    fn test_register_and_profile_of_secondary_window() {
        let registry = WindowRegistry::default();
        registry.register("profile-a", Some("a".to_string()));
        assert_eq!(
            registry.profile_of("profile-a"),
            Some(Some("a".to_string()))
        );
    }

    #[test]
    fn test_remove_makes_profile_of_return_none() {
        let registry = WindowRegistry::default();
        registry.register("profile-b", Some("b".to_string()));
        assert_eq!(
            registry.profile_of("profile-b"),
            Some(Some("b".to_string()))
        );
        registry.remove("profile-b");
        assert_eq!(registry.profile_of("profile-b"), None);
    }

    /// Pins the capability file the way `cli_shim.rs` pins `release.yml`: a secondary
    /// profile window opened without a matching `windows` entry gets zero permissions.
    #[test]
    fn capability_covers_profile_windows() {
        let raw = include_str!("../capabilities/default.json");
        assert!(
            raw.contains("\"profile-*\""),
            "secondary windows would have zero permissions"
        );
        assert!(raw.contains("\"main\""));
    }

    #[test]
    fn test_two_windows_different_profiles() {
        let registry = WindowRegistry::default();
        registry.register("main", None);
        registry.register("profile-a", Some("a".to_string()));

        assert_eq!(registry.label_for(&None), Some("main".to_string()));
        assert_eq!(
            registry.label_for(&Some("a".to_string())),
            Some("profile-a".to_string())
        );
    }

    /// The TOCTOU this exists to close: two concurrent `open_profile_window` calls for
    /// the same profile must not both believe they won. The first claim wins and
    /// inserts; the second sees the same profile already claimed and gets told the
    /// existing label back instead of being allowed to insert a duplicate.
    #[test]
    fn claim_first_caller_claims_second_caller_finds_existing() {
        let registry = WindowRegistry::default();
        let first = registry.claim("profile-a", &Some("a".to_string()));
        assert_eq!(first, Claim::Claimed("profile-a".to_string()));

        let second = registry.claim("profile-a", &Some("a".to_string()));
        assert_eq!(second, Claim::Existing("profile-a".to_string()));
    }

    #[test]
    fn claim_different_profiles_each_claim_their_own_label() {
        let registry = WindowRegistry::default();
        let a = registry.claim("profile-a", &Some("a".to_string()));
        let b = registry.claim("profile-b", &Some("b".to_string()));
        assert_eq!(a, Claim::Claimed("profile-a".to_string()));
        assert_eq!(b, Claim::Claimed("profile-b".to_string()));
    }

    /// The case `open_profile_window(None)` actually hits on a live app: "main" is
    /// registered (not claimed) with the Default profile at setup, and a later
    /// `open_profile_window(None)` claim-checks the same profile under a different
    /// candidate label ("profile-default"). It must find "main" as the existing owner
    /// rather than claiming "profile-default" and opening a second Default window.
    #[test]
    fn claim_finds_main_already_registered_for_default_profile() {
        let registry = WindowRegistry::default();
        registry.register("main", None);
        let claim = registry.claim("profile-default", &None);
        assert_eq!(claim, Claim::Existing("main".to_string()));
    }
}
