// Profiles pure logic (MVP, 2026-08-27): named sidebar workspaces. The active profile
// filters which projects and root chats the SIDEBAR shows — it is a visibility filter,
// never an isolation boundary. WorkspaceCenter/RightColumn must keep the full projects
// array (filtering there would unmount TerminalViews and kill PTYs).

/** Mirrors the Rust serde struct (camelCase). */
export interface Profile {
  id: string;
  name: string;
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
