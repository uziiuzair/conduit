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
