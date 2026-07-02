import { describe, it, expect, beforeEach } from "vitest";
import {
  acquire,
  release,
  ensureModel,
  model,
  dirtyOf,
  setSaved,
  disposeIfUnreferenced,
  setModelFactory,
  saving,
  type RegistryModel,
  type ModelFactory,
} from "./registry";

// A fake ITextModel: version id bumps on every edit; jumpTo walks it back (undo-to-saved).
class FakeModel implements RegistryModel {
  version = 1;
  value = "";
  disposed = false;
  private listeners = new Set<() => void>();
  getValue() {
    return this.value;
  }
  getAlternativeVersionId() {
    return this.version;
  }
  onDidChangeContent(listener: () => void) {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }
  dispose() {
    this.disposed = true;
  }
  edit() {
    this.version += 1;
    this.value += "x";
    this.listeners.forEach((l) => l());
  }
  jumpTo(v: number) {
    this.version = v;
    this.listeners.forEach((l) => l());
  }
}

let last: FakeModel;
let created = 0;
const fakeFactory: ModelFactory = () => {
  last = new FakeModel();
  created += 1;
  return last;
};

const B = { mtimeMs: 1, size: 1 };
function init() {
  return { value: "seed", languageId: "plaintext", readOnly: false, baseline: B };
}

beforeEach(() => {
  setModelFactory(fakeFactory);
  saving.clear();
  created = 0;
});

describe("registry ref-counting", () => {
  it("acquire/release track the count and only dispose at zero", () => {
    expect(acquire("/a")).toBe(1);
    expect(acquire("/a")).toBe(2);
    ensureModel("/a", init());
    expect(release("/a")).toBe(1);
    expect(disposeIfUnreferenced("/a")).toBe(false); // still referenced
    expect(model("/a")).toBeDefined();
    expect(release("/a")).toBe(0);
    expect(disposeIfUnreferenced("/a")).toBe(true); // now reclaimed
    expect(last.disposed).toBe(true);
    expect(model("/a")).toBeUndefined();
  });
});

describe("registry dirty logic (version-id idiom)", () => {
  it("is clean at load, dirty after an edit, clean again after undo-to-saved", () => {
    acquire("/b");
    ensureModel("/b", init());
    expect(dirtyOf("/b")).toBe(false);
    last.edit();
    expect(dirtyOf("/b")).toBe(true);
    last.jumpTo(1); // undo back to the saved version id
    expect(dirtyOf("/b")).toBe(false);
  });

  it("setSaved marks the current version as clean", () => {
    acquire("/c");
    ensureModel("/c", init());
    last.edit();
    expect(dirtyOf("/c")).toBe(true);
    setSaved("/c", { mtimeMs: 2, size: 2 });
    expect(dirtyOf("/c")).toBe(false);
  });

  it("dirtyOf is false when there is no loaded model", () => {
    acquire("/d"); // refCount only, no ensureModel
    expect(dirtyOf("/d")).toBe(false);
  });
});

describe("registry model reuse", () => {
  it("ensureModel is a no-op when a model already exists (no double read)", () => {
    acquire("/e");
    const m1 = ensureModel("/e", init()).model;
    const m2 = ensureModel("/e", init()).model;
    expect(m2).toBe(m1);
    expect(created).toBe(1);
  });
});
