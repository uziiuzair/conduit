//! Which window shows which profile. One registry, managed state; the label is the
//! Tauri window label ("main", "profile-<id>", "profile-default"). `None` = Default.

use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Default)]
pub struct WindowRegistry {
    map: Mutex<HashMap<String, Option<String>>>,
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
    pub fn label_for(&self, profile: &Option<String>) -> Option<String> {
        let map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        map.iter()
            .find(|(_, p)| p == &profile)
            .map(|(label, _)| label.clone())
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
}
