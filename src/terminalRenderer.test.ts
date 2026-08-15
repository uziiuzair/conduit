import { describe, it, expect, vi } from "vitest";
import { attachRenderer, type AddonFactories, type RendererAddon } from "./terminalRenderer";

/** A stand-in addon; `onContextLoss` is present only on the WebGL-shaped one. */
function fakeAddon(withContextLoss = false): RendererAddon & { lossHandler?: () => void } {
  const addon: RendererAddon & { lossHandler?: () => void } = {
    activate: () => {},
    dispose: vi.fn(),
  };
  if (withContextLoss) {
    addon.onContextLoss = (h: () => void) => {
      addon.lossHandler = h;
    };
  }
  return addon;
}

function fakeTerm() {
  const loaded: RendererAddon[] = [];
  return { loaded, loadAddon: (a: RendererAddon) => void loaded.push(a) };
}

const throwing = () => {
  throw new Error("no context");
};

describe("attachRenderer", () => {
  it("loads WebGL when it is asked for and available", () => {
    const webgl = fakeAddon(true);
    const term = fakeTerm();
    const factories: AddonFactories = { webgl: () => webgl, canvas: () => fakeAddon() };

    const handle = attachRenderer(term, "webgl", factories);

    expect(handle.active).toBe("webgl");
    expect(term.loaded).toEqual([webgl]);
  });

  it("loads canvas when canvas is asked for, without constructing WebGL", () => {
    const webgl = vi.fn(fakeAddon);
    const term = fakeTerm();
    const factories: AddonFactories = { webgl, canvas: () => fakeAddon() };

    const handle = attachRenderer(term, "canvas", factories);

    expect(handle.active).toBe("canvas");
    expect(webgl).not.toHaveBeenCalled();
  });

  it("degrades to canvas when WebGL construction throws", () => {
    const canvas = fakeAddon();
    const term = fakeTerm();
    const factories: AddonFactories = { webgl: throwing, canvas: () => canvas };

    const handle = attachRenderer(term, "webgl", factories);

    expect(handle.active).toBe("canvas");
    expect(term.loaded).toEqual([canvas]);
  });

  it("degrades to the DOM renderer when both addons throw", () => {
    const term = fakeTerm();
    const factories: AddonFactories = { webgl: throwing, canvas: throwing };

    const handle = attachRenderer(term, "webgl", factories);

    expect(handle.active).toBe("dom");
    expect(term.loaded).toEqual([]);
  });

  // The cap on live GPU contexts is the reason canvas stays selectable: a pane that loses
  // its context has to keep painting, and it must do so without rewriting the preference.
  it("drops a pane to canvas when its WebGL context is lost, and reports the change", () => {
    const webgl = fakeAddon(true);
    const canvas = fakeAddon();
    const term = fakeTerm();
    const onChange = vi.fn();
    const factories: AddonFactories = { webgl: () => webgl, canvas: () => canvas };

    const handle = attachRenderer(term, "webgl", factories, onChange);
    expect(handle.active).toBe("webgl");
    expect(onChange).not.toHaveBeenCalled();

    webgl.lossHandler?.();

    expect(webgl.dispose).toHaveBeenCalled();
    expect(handle.active).toBe("canvas");
    expect(term.loaded).toEqual([webgl, canvas]);
    expect(onChange).toHaveBeenCalledWith("canvas");
  });

  it("disposes the addon it loaded, and only that one", () => {
    const webgl = fakeAddon(true);
    const canvas = fakeAddon();
    const term = fakeTerm();
    const factories: AddonFactories = { webgl: () => webgl, canvas: () => canvas };

    attachRenderer(term, "webgl", factories).dispose();

    expect(webgl.dispose).toHaveBeenCalled();
    expect(canvas.dispose).not.toHaveBeenCalled();
  });

  // Terminal.dispose() disposes its own addons first, so the effect cleanup that runs after
  // it is a second dispose on a dead addon. That must not throw out of the cleanup.
  it("survives a dispose that throws", () => {
    const webgl = fakeAddon(true);
    webgl.dispose = vi.fn(throwing);
    const term = fakeTerm();
    const factories: AddonFactories = { webgl: () => webgl, canvas: () => fakeAddon() };

    const handle = attachRenderer(term, "webgl", factories);

    expect(() => handle.dispose()).not.toThrow();
    expect(handle.active).toBe("dom");
  });
});
