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
        self.projects.lock().unwrap_or_else(|e| e.into_inner()).clone()
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

    pub fn add_session(&self, project_id: &str, name: String) -> Option<Session> {
        let mut projects = self.projects.lock().unwrap_or_else(|e| e.into_inner());
        let project = projects.iter_mut().find(|p| p.id == project_id)?;
        let session = Session {
            id: Uuid::new_v4().to_string(),
            name,
            use_worktree: false,
            worktree_path: None,
            branch: None,
        };
        project.sessions.push(session.clone());
        self.save(&projects);
        Some(session)
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
}
