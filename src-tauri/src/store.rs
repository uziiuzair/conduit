//! Project/session tree + JSON persistence. Ports AppStore.swift + Models.swift.
//!
//! Persists to ~/Library/Application Support/ConduitTauri/state.json — deliberately
//! namespaced away from the Swift app's `Conduit/state.json` so the two apps can run
//! side by side without trampling each other's (different-shaped) state.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Whether a session is a normal worker or the project's orchestrating Conductor.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum SessionRole {
    #[default]
    Worker,
    Conductor,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub use_worktree: bool,
    #[serde(default)]
    pub worktree_path: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub agent: crate::agent::AgentId,
    #[serde(default)]
    pub role: SessionRole,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WsTab {
    pub kind: String, // "session" | "file"
    #[serde(rename = "ref")]
    pub r#ref: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EditorGroup {
    pub id: String,
    #[serde(default)]
    pub tabs: Vec<WsTab>,
    #[serde(default)]
    pub active_ref: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLayout {
    #[serde(default)]
    pub groups: Vec<EditorGroup>,
    #[serde(default)]
    pub active_group_id: Option<String>,
    #[serde(default)]
    pub weights: Vec<f64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub sessions: Vec<Session>,
    #[serde(default)]
    pub layout: Option<ProjectLayout>,
}

pub struct Store {
    projects: Mutex<Vec<Project>>,
    save_path: PathBuf,
}

/// A read-only view of the project that owns a given Conductor, plus its sessions.
/// Used by the fleet MCP server to answer `fleet_list` / scope `fleet_spawn`.
pub struct FleetSnapshot {
    pub project_id: String,
    pub project_path: String,
    pub sessions: Vec<Session>,
}

impl Store {
    pub fn new() -> Self {
        // Namespace override so a dev/test build can run alongside the installed app
        // without trampling its state.json (set CONDUIT_DATA_DIR_NAME=ConduitTauri-dev).
        let dir_name =
            std::env::var("CONDUIT_DATA_DIR_NAME").unwrap_or_else(|_| "ConduitTauri".to_string());
        let base = dirs::data_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join(dir_name);
        let _ = fs::create_dir_all(&base);
        let save_path = base.join("state.json");

        let projects = fs::read(&save_path)
            .ok()
            .and_then(|data| serde_json::from_slice::<Vec<Project>>(&data).ok())
            .unwrap_or_default();

        Store {
            projects: Mutex::new(projects),
            save_path,
        }
    }

    fn save(&self, projects: &[Project]) {
        // Atomic write: serialize, write a temp file, then rename over the target so
        // a crash mid-write can't corrupt state.json. Errors are surfaced to stderr.
        let data = match serde_json::to_vec_pretty(projects) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("conduit: failed to serialize state: {e}");
                return;
            }
        };
        let tmp = self.save_path.with_extension("json.tmp");
        if let Err(e) = fs::write(&tmp, &data) {
            eprintln!("conduit: failed to write state: {e}");
            return;
        }
        if let Err(e) = fs::rename(&tmp, &self.save_path) {
            eprintln!("conduit: failed to persist state: {e}");
        }
    }

    pub fn list(&self) -> Vec<Project> {
        self.projects
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn add_project(&self, path: String) -> Project {
        let name = PathBuf::from(&path)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone());
        let project = Project {
            id: Uuid::new_v4().to_string(),
            name,
            path,
            sessions: Vec::new(),
            layout: None,
        };
        let mut projects = self.projects.lock().unwrap_or_else(|e| e.into_inner());
        projects.push(project.clone());
        self.save(&projects);
        project
    }

    pub fn remove_project(&self, project_id: &str) {
        let mut projects = self.projects.lock().unwrap_or_else(|e| e.into_inner());
        projects.retain(|p| p.id != project_id);
        self.save(&projects);
    }

    pub fn add_session(
        &self,
        project_id: &str,
        name: String,
        use_worktree: bool,
        agent: crate::agent::AgentId,
        role: SessionRole,
    ) -> Option<Session> {
        let mut projects = self.projects.lock().unwrap_or_else(|e| e.into_inner());
        let project = projects.iter_mut().find(|p| p.id == project_id)?;
        // At most one Conductor per project.
        if role == SessionRole::Conductor
            && project.sessions.iter().any(|s| s.role == SessionRole::Conductor)
        {
            return None;
        }
        let id = Uuid::new_v4().to_string();
        // The Conductor runs in the project root (it orchestrates, it doesn't edit code),
        // so it never gets a worktree even if `use_worktree` is passed.
        let (worktree_path, branch) = if use_worktree && role != SessionRole::Conductor {
            let slug = crate::worktree::slug(&name, &id);
            (
                Some(crate::worktree::worktree_path(&project.path, &slug)),
                Some(crate::worktree::branch_name(&slug)),
            )
        } else {
            (None, None)
        };
        let session = Session {
            id,
            name,
            use_worktree,
            worktree_path,
            branch,
            agent,
            role,
        };
        project.sessions.push(session.clone());
        self.save(&projects);
        Some(session)
    }

    /// The agent for a session id, searching all projects. Defaults to Claude for an
    /// unknown id (back-compat / shell-only companions that were never persisted).
    pub fn session_agent(&self, session_id: &str) -> crate::agent::AgentId {
        let projects = self.projects.lock().unwrap_or_else(|e| e.into_inner());
        projects
            .iter()
            .flat_map(|p| &p.sessions)
            .find(|s| s.id == session_id)
            .map(|s| s.agent)
            .unwrap_or_default()
    }

    pub fn set_layout(&self, project_id: &str, layout: ProjectLayout) {
        let mut projects = self.projects.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(p) = projects.iter_mut().find(|p| p.id == project_id) {
            p.layout = Some(layout);
            self.save(&projects);
        }
    }

    pub fn rename_session(&self, project_id: &str, session_id: &str, name: String) {
        let mut projects = self.projects.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(project) = projects.iter_mut().find(|p| p.id == project_id) {
            if let Some(session) = project.sessions.iter_mut().find(|s| s.id == session_id) {
                session.name = name;
            }
        }
        self.save(&projects);
    }

    pub fn remove_session(&self, project_id: &str, session_id: &str) {
        let mut projects = self.projects.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(project) = projects.iter_mut().find(|p| p.id == project_id) {
            project.sessions.retain(|s| s.id != session_id);
        }
        self.save(&projects);
    }

    /// Resolve the project that owns `conductor_id` and return its sessions.
    pub fn fleet_snapshot(&self, conductor_id: &str) -> Option<FleetSnapshot> {
        let projects = self.projects.lock().unwrap_or_else(|e| e.into_inner());
        let project = projects
            .iter()
            .find(|p| p.sessions.iter().any(|s| s.id == conductor_id))?;
        Some(FleetSnapshot {
            project_id: project.id.clone(),
            project_path: project.path.clone(),
            sessions: project.sessions.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    impl Store {
        fn for_test(dir: &std::path::Path) -> Self {
            Store {
                projects: Mutex::new(Vec::new()),
                save_path: dir.join("state.json"),
            }
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("conduit_store_{tag}_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn add_session_without_worktree_leaves_fields_empty() {
        let dir = temp_dir("plain");
        let store = Store::for_test(&dir);
        let p = store.add_project("/repo".into());
        let s = store
            .add_session(
                &p.id,
                "Session 1".into(),
                false,
                crate::agent::AgentId::Claude,
                SessionRole::Worker,
            )
            .unwrap();
        assert!(!s.use_worktree);
        assert!(s.worktree_path.is_none());
        assert!(s.branch.is_none());
    }

    #[test]
    fn add_session_with_worktree_computes_path_and_branch() {
        let dir = temp_dir("wt");
        let store = Store::for_test(&dir);
        let p = store.add_project("/repo".into());
        let s = store
            .add_session(
                &p.id,
                "My Feature".into(),
                true,
                crate::agent::AgentId::Claude,
                SessionRole::Worker,
            )
            .unwrap();
        assert!(s.use_worktree);
        let path = s.worktree_path.unwrap();
        assert!(path.starts_with("/repo/.claude/worktrees/"), "got {path}");
        assert!(s.branch.unwrap().starts_with("worktree-"));
    }

    #[test]
    fn session_agent_returns_stored_agent_else_claude() {
        let dir = temp_dir("lookup");
        let store = Store::for_test(&dir);
        let p = store.add_project("/repo".into());
        let s = store
            .add_session(
                &p.id,
                "S".into(),
                false,
                crate::agent::AgentId::Codex,
                SessionRole::Worker,
            )
            .unwrap();
        assert_eq!(store.session_agent(&s.id), crate::agent::AgentId::Codex);
        assert_eq!(
            store.session_agent("missing"),
            crate::agent::AgentId::Claude
        );
    }

    #[test]
    fn add_session_defaults_agent_to_claude() {
        let dir = temp_dir("agent_default");
        let store = Store::for_test(&dir);
        let p = store.add_project("/repo".into());
        let s = store
            .add_session(
                &p.id,
                "Session 1".into(),
                false,
                crate::agent::AgentId::Claude,
                SessionRole::Worker,
            )
            .unwrap();
        assert_eq!(s.agent, crate::agent::AgentId::Claude);
    }

    #[test]
    fn old_state_json_without_agent_deserializes_as_claude() {
        let json = r#"{"id":"x","name":"n","useWorktree":false}"#;
        let s: Session = serde_json::from_str(json).unwrap();
        assert_eq!(s.agent, crate::agent::AgentId::Claude);
    }

    #[test]
    fn session_role_defaults_to_worker_for_old_state() {
        // A persisted session from before `role` existed must load as Worker.
        let json = r#"{"id":"s1","name":"old","useWorktree":false}"#;
        let s: Session = serde_json::from_str(json).expect("deserialize");
        assert_eq!(s.role, SessionRole::Worker, "missing role must default to Worker");
    }

    #[test]
    fn fleet_snapshot_returns_project_and_sessions() {
        let dir = temp_dir("fleet_snap");
        let store = Store::for_test(&dir);
        let p = store.add_project("/repo".into());
        let c = store.add_session(
            &p.id, "Conductor".into(), false, crate::agent::AgentId::Claude, SessionRole::Conductor,
        ).unwrap();
        store.add_session(
            &p.id, "w1".into(), false, crate::agent::AgentId::Claude, SessionRole::Worker,
        );
        let snap = store.fleet_snapshot(&c.id).expect("snapshot for conductor id");
        assert_eq!(snap.project_path, "/repo");
        assert_eq!(snap.sessions.len(), 2, "conductor + 1 worker");
        assert!(store.fleet_snapshot("nope").is_none());
    }

    #[test]
    fn add_session_rejects_second_conductor() {
        let dir = temp_dir("conductor_unique");
        let store = Store::for_test(&dir);
        let p = store.add_project("/repo".into());
        let c1 = store.add_session(
            &p.id, "Conductor".into(), false, crate::agent::AgentId::Claude, SessionRole::Conductor,
        );
        assert!(c1.is_some(), "first conductor should be created");
        let c2 = store.add_session(
            &p.id, "Conductor2".into(), false, crate::agent::AgentId::Claude, SessionRole::Conductor,
        );
        assert!(c2.is_none(), "second conductor must be rejected");
        let w = store.add_session(
            &p.id, "w".into(), false, crate::agent::AgentId::Claude, SessionRole::Worker,
        );
        assert!(w.is_some(), "workers are unaffected");
    }

    #[test]
    fn conductor_never_gets_a_worktree() {
        let dir = temp_dir("conductor_no_wt");
        let store = Store::for_test(&dir);
        let p = store.add_project("/repo".into());
        // use_worktree=true is ignored for a Conductor.
        let c = store.add_session(
            &p.id, "Conductor".into(), true, crate::agent::AgentId::Claude, SessionRole::Conductor,
        ).unwrap();
        assert!(c.worktree_path.is_none(), "conductor must run in project root");
        assert!(c.branch.is_none());
    }

    #[test]
    fn session_role_serializes_camel_lowercase() {
        let s = Session {
            id: "c1".into(),
            name: "cond".into(),
            use_worktree: false,
            worktree_path: None,
            branch: None,
            agent: crate::agent::AgentId::Claude,
            role: SessionRole::Conductor,
        };
        let v = serde_json::to_string(&s).unwrap();
        assert!(v.contains(r#""role":"conductor""#), "got {v}");
    }
}
