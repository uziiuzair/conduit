// Framework-agnostic, path-keyed Monaco model registry — the one source of truth for
// buffers, dirty state, view state, and ref-counts. NO static monaco import, so vitest
// exercises this with a fake model (no DOM). The real model factory is injected by
// monaco/setup.ts initMonaco via setModelFactory.

export interface RegistryModel {
  getValue(): string;
  getAlternativeVersionId(): number;
  onDidChangeContent(listener: () => void): { dispose(): void };
  dispose(): void;
}

export type ModelFactory = (path: string, value: string, languageId: string) => RegistryModel;

export interface Baseline {
  mtimeMs: number;
  size: number;
}

export interface RegistryEntry {
  model: RegistryModel | null;
  savedVersionId: number;
  viewStates: Map<string, unknown>;
  baseline: Baseline;
  refCount: number;
  readOnly: boolean;
}

const entries = new Map<string, RegistryEntry>();

/** In-flight write guard: saveFile add()s before write_file and delete()s after;
 *  the Phase 2 watcher skips any path in this set (closes the save-vs-poll race). */
export const saving: Set<string> = new Set();

let modelFactory: ModelFactory = () => {
  throw new Error("registry: model factory not configured — call initMonaco/setModelFactory first");
};

export function setModelFactory(factory: ModelFactory): void {
  modelFactory = factory;
}

function blankEntry(baseline: Baseline, readOnly: boolean): RegistryEntry {
  return { model: null, savedVersionId: 0, viewStates: new Map(), baseline, refCount: 0, readOnly };
}

export function acquire(path: string): number {
  let e = entries.get(path);
  if (!e) {
    e = blankEntry({ mtimeMs: 0, size: 0 }, false);
    entries.set(path, e);
  }
  e.refCount += 1;
  return e.refCount;
}

export function release(path: string): number {
  const e = entries.get(path);
  if (!e) return 0;
  e.refCount -= 1;
  return e.refCount;
}

export function ensureModel(
  path: string,
  init: { value: string; languageId: string; readOnly: boolean; baseline: Baseline },
): RegistryEntry {
  let e = entries.get(path);
  if (!e) {
    e = blankEntry(init.baseline, init.readOnly);
    entries.set(path, e);
  }
  if (!e.model) {
    e.model = modelFactory(path, init.value, init.languageId);
    e.savedVersionId = e.model.getAlternativeVersionId();
    e.baseline = init.baseline;
    e.readOnly = init.readOnly;
    e.viewStates = new Map();
  }
  return e;
}

export function model(path: string): RegistryEntry | undefined {
  return entries.get(path);
}

/** Canonical dirty check: reports CLEAN after undo back to the saved state. */
export function dirtyOf(path: string): boolean {
  const e = entries.get(path);
  if (!e || !e.model) return false;
  return e.model.getAlternativeVersionId() !== e.savedVersionId;
}

export function setSaved(path: string, baseline: Baseline): void {
  const e = entries.get(path);
  if (!e || !e.model) return;
  e.savedVersionId = e.model.getAlternativeVersionId();
  e.baseline = baseline;
}

export function baseline(path: string): Baseline | undefined {
  return entries.get(path)?.baseline;
}

export function setBaseline(path: string, baseline: Baseline): void {
  const e = entries.get(path);
  if (e) e.baseline = baseline;
}

export function getViewState(path: string, groupId: string): unknown | undefined {
  return entries.get(path)?.viewStates.get(`${groupId}::${path}`);
}

export function setViewState(path: string, groupId: string, state: unknown): void {
  const e = entries.get(path);
  if (e) e.viewStates.set(`${groupId}::${path}`, state);
}

/** THE only place a model is ever disposed. No-op unless refCount<=0. */
export function disposeIfUnreferenced(path: string): boolean {
  const e = entries.get(path);
  if (!e) return false;
  if (e.refCount <= 0) {
    e.model?.dispose();
    entries.delete(path);
    return true;
  }
  return false;
}
