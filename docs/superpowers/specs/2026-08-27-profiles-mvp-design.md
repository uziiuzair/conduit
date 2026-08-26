# Profiles (MVP) — design

**Date:** 2026-08-27 · **Status:** shipped with this branch (`feat/profiles`)

## Why

The user streams their screen. Projects and HQ chats carry client names and
work-in-progress that must not be visible on camera. A *profile* is a named
workspace the sidebar filters to: switch to a "Streaming" profile and every
project and root chat belonging to other profiles disappears from view.

This is a **visibility filter, not an isolation boundary**: hidden projects'
sessions keep running, their terminals stay mounted (keep-alive rule), and the
command palette can still reach them. MVP scope only.

## Data model (state.json, all `#[serde(default)]` so legacy state loads)

- `Profile { id, name }` — plain record, `profiles: Vec<Profile>` on `PersistState`.
- `active_profile_id: Option<String>` on `PersistState` — persisted so the app
  reopens in the profile you left it in. `None` = the implicit **Default**
  profile, which always exists and is never stored as a record.
- `Project.profile_id: Option<String>` and `RootChat.profile_id: Option<String>`
  — `None` = Default. Assigned **at creation** from the active profile (the Rust
  `add_project` / `add_root_chat` read the store's own active id; no frontend
  parameter). No move-between-profiles UI in MVP.

### Dangling ids

A `profile_id` that matches no known profile (deleted profile, hand-edited
state) is treated as Default by the frontend's pure `normalizeProfileId`
helper. Nothing can be filtered out of existence.

## Commands

`list_profiles`, `add_profile(name)`, `remove_profile(id)`,
`get_active_profile`, `set_active_profile(id: Option<String>)`.
`remove_profile` clears matching `profile_id`s on projects/chats (they fall
back to Default) and resets the active id if it pointed at the removed profile.
No UI for remove/rename in MVP — commands exist for the follow-on.

## Frontend

- `src/profiles.ts` — `Profile` type + pure `normalizeProfileId` / `inProfile`
  helpers, colocated vitest.
- `store.ts` — `profiles`, `activeProfileId`, `addProfile`, `setActiveProfile`.
  `setActiveProfile` persists, then repairs selection: if the selected project
  or open root chat is not in the new profile, select the first visible project
  (or none) and drop the chat layer.
- `Sidebar.tsx` — filters the Projects list and HQ list by the active profile.
  A **profile bar** below the add-project row: a `<select>` (Default + each
  profile) and a `+` button that flips to an inline name input (same
  `session-rename-input` pattern as renames — `window.prompt` is unreliable in
  WKWebView).
- `RootChatView.tsx` — HQ home "Recent" list filters by profile too (that list
  is on screen while streaming).
- **`WorkspaceCenter` / `RightColumn` keep the FULL projects array.** Filtering
  there would unmount TerminalViews and kill PTYs.

## Out of scope (deliberate)

Per-profile accounts/settings, moving items between profiles, palette scoping,
profile rename/delete UI, per-profile layout state.
