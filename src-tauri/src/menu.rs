//! Native application menu (macOS-focused).
//!
//! Built once at startup from `lib.rs`'s `setup` closure via [`build`], then wired to
//! [`on_event`] through `app.on_menu_event`. Custom items carry stable string ids and
//! forward to the React frontend as a single `"menu"` event whose payload is the id
//! string (e.g. `"new-session"`, `"theme:warm-dim"`). Native behaviors (services, hide,
//! clipboard, window ops) use `PredefinedMenuItem`s and need no frontend handling.
//!
//! Quit is intentionally a *custom* item: `PredefinedMenuItem::quit` maps to the platform
//! native terminate, which does not reliably route through `RunEvent::ExitRequested`.
//! The custom handler kills every PTY first (mirroring the `ExitRequested` cleanup in
//! `lib.rs`) and only then exits, so no `claude` PTY is ever orphaned.

use std::sync::Arc;

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::pty::PtyManager;

/// Build the full application menu tree (Conduit · File · Edit · View · Window · Help).
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    // ---- Conduit (app) menu — first submenu, shown under the app name on macOS ----
    let about = MenuItemBuilder::with_id("about", "About Conduit").build(app)?;
    let settings = MenuItemBuilder::with_id("settings", "Settings…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit Conduit")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, "Conduit")
        .item(&about)
        .item(&settings)
        .separator()
        .services()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(&quit)
        .build()?;

    // ---- File ----
    let new_session = MenuItemBuilder::with_id("new-session", "New Session")
        .accelerator("CmdOrCtrl+T")
        .build(app)?;
    let open_project = MenuItemBuilder::with_id("open-project", "Open Project…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let save = MenuItemBuilder::with_id("save", "Save")
        .accelerator("CmdOrCtrl+S")
        .build(app)?;
    let close_tab = MenuItemBuilder::with_id("close-tab", "Close Tab")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_session)
        .item(&open_project)
        .separator()
        .item(&save)
        .item(&close_tab)
        .build()?;

    // ---- Edit ----
    let find = MenuItemBuilder::with_id("find", "Find")
        .accelerator("CmdOrCtrl+F")
        .build(app)?;
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&find)
        .build()?;

    // ---- View (with nested Theme submenu) ----
    let toggle_sidebar = MenuItemBuilder::with_id("toggle-sidebar", "Toggle Sidebar")
        .accelerator("CmdOrCtrl+B")
        .build(app)?;
    let toggle_right = MenuItemBuilder::with_id("toggle-right", "Toggle Right Panel")
        .accelerator("CmdOrCtrl+Alt+B")
        .build(app)?;
    let theme_auto = MenuItemBuilder::with_id("theme:auto", "Auto").build(app)?;
    let theme_warm_light = MenuItemBuilder::with_id("theme:warm-light", "Warm Light").build(app)?;
    let theme_warm_dim = MenuItemBuilder::with_id("theme:warm-dim", "Warm Dim").build(app)?;
    let theme_near_black =
        MenuItemBuilder::with_id("theme:warm-near-black", "Warm Near-Black").build(app)?;
    let theme_menu = SubmenuBuilder::new(app, "Theme")
        .item(&theme_auto)
        .item(&theme_warm_light)
        .item(&theme_warm_dim)
        .item(&theme_near_black)
        .build()?;
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&toggle_sidebar)
        .item(&toggle_right)
        .separator()
        .item(&theme_menu)
        .build()?;

    // ---- Window ----
    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .fullscreen()
        .separator()
        .close_window()
        .build()?;

    // ---- Help ----
    let github = MenuItemBuilder::with_id("github", "Conduit on GitHub").build(app)?;
    let help_menu = SubmenuBuilder::new(app, "Help").item(&github).build()?;

    MenuBuilder::new(app)
        .item(&app_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&window_menu)
        .item(&help_menu)
        .build()
}

/// Handle a menu selection by its item id.
///
/// `github` opens the homepage natively (shelling out to macOS `open`, matching the
/// app's existing no-HTTP-client ethos). `quit` kills all PTYs then exits. Every other
/// custom id is forwarded to the frontend as the `"menu"` event payload. Predefined
/// items (clipboard, hide, window ops) never reach here — the OS handles them.
pub fn on_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        "github" => {
            let _ = std::process::Command::new("open")
                .arg("https://ooozzy.com")
                .spawn();
        }
        "quit" => {
            // Guarantee PTYs die before exit, mirroring `RunEvent::ExitRequested`.
            app.state::<Arc<PtyManager>>().kill_all();
            app.exit(0);
        }
        other => {
            let _ = app.emit("menu", other);
        }
    }
}
