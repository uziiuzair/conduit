// Profiles pure logic (MVP, 2026-08-27): named sidebar workspaces. The active profile
// filters which projects and root chats the SIDEBAR shows — it is a visibility filter,
// never an isolation boundary. WorkspaceCenter/RightColumn must keep the full projects
// array (filtering there would unmount TerminalViews and kill PTYs).

/** Mirrors the Rust serde struct (camelCase). */
export interface Profile {
  id: string;
  name: string;
}

/** This OS window's own profile identity. Mirrors the Rust `WindowProfileInfo` serde
 *  struct (camelCase) returned by the `window_profile` command. `isMain` is `label ===
 *  "main"`; every other window is permanently pinned to `profileId` for its lifetime. */
export interface WindowProfile {
  label: string;
  profileId: string | null;
  isMain: boolean;
}

/**
 * Resolve an item's stored profile id against the known profiles. A dangling id (its
 * profile was removed, or state was hand-edited) normalizes to the Default profile
 * (null) so nothing can be filtered out of existence.
 */
export function normalizeProfileId(
  profileId: string | null | undefined,
  knownIds: ReadonlySet<string>,
): string | null {
  return profileId && knownIds.has(profileId) ? profileId : null;
}

/** Whether an item tagged `itemProfileId` is visible under `activeProfileId`. */
export function inProfile(
  itemProfileId: string | null | undefined,
  activeProfileId: string | null,
  knownIds: ReadonlySet<string>,
): boolean {
  return (
    normalizeProfileId(itemProfileId, knownIds) === normalizeProfileId(activeProfileId, knownIds)
  );
}

/**
 * Whether an item tagged `itemProfileId` belongs in a window pinned to
 * `windowProfileId` (multi-window profiles mode). Delegates to `inProfile` today — it
 * exists as its own name so window-mode call sites read as "does this event belong in
 * THIS window" rather than "is this visible under the active profile", and so a future
 * divergence between the two questions has one home to change instead of every call
 * site. The test pins the semantics, not the delegation.
 */
export function eventInWindow(
  itemProfileId: string | null | undefined,
  windowProfileId: string | null,
  knownIds: ReadonlySet<string>,
): boolean {
  return inProfile(itemProfileId, windowProfileId, knownIds);
}

/**
 * Whether a project's terminals should be MOUNTED in this OS window — the keep-alive
 * gate, not a visibility filter. In switch mode (`windowed=false`) every project is
 * mounted everywhere, matching the one shared window that existed before multi-window
 * profiles: hidden profiles keep their terminals mounted, they're just not shown. In
 * window mode (`windowed=true`) each window mounts only its own pinned profile's
 * projects — a dangling `project.profileId` normalizes to Default via `inProfile`, so a
 * removed profile's projects surface in the Default window rather than mounting nowhere.
 *
 * `windowed` and `windowProfileId` are both boot-stable for the life of a window (see
 * `WINDOWED`/`windowProfile` in store.ts — a project's profile never changes at runtime),
 * so the mount set this decides is boot-stable too and can never unmount a live terminal.
 */
export function mountedInWindow(
  project: { profileId?: string | null },
  windowed: boolean,
  windowProfileId: string | null,
  knownIds: ReadonlySet<string>,
): boolean {
  return !windowed || inProfile(project.profileId, windowProfileId, knownIds);
}
