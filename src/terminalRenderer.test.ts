import { describe, it, expect, vi } from "vitest";
import {
  attachRenderer,
  disposePane,
  type AddonFactories,
  type RendererAddon,
} from "./terminalRenderer";

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

  // The addon can throw on dispose for two different reasons (see the catch in
  // attachRenderer). Neither may escape into the caller's effect cleanup.
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

// Regression: deleting a session unmounted its pane, xterm disposed the WebGL addon after
// its own core, the addon threw out of Terminal.dispose(), and React's unmount commit took
// the whole window to the ErrorBoundary. The order below is the fix.
describe("disposePane", () => {
  it("disposes the renderer addon before the terminal", () => {
    const order: string[] = [];
    const webgl = fakeAddon(true);
    webgl.dispose = vi.fn(() => void order.push("addon"));
    const term = { ...fakeTerm(), dispose: vi.fn(() => void order.push("term")) };
    const factories: AddonFactories = { webgl: () => webgl, canvas: () => fakeAddon() };

    disposePane(attachRenderer(term, "webgl", factories), term);

    expect(order).toEqual(["addon", "term"]);
  });

  // The whole point: @xterm/addon-webgl 0.19 throws on dispose against @xterm/xterm 5.5.
  // Taking that throw here, inside attachRenderer's catch, is what keeps it out of React.
  it("still disposes the terminal when the addon dispose throws", () => {
    const webgl = fakeAddon(true);
    webgl.dispose = vi.fn(throwing);
    const term = { ...fakeTerm(), dispose: vi.fn() };
    const factories: AddonFactories = { webgl: () => webgl, canvas: () => fakeAddon() };

    const handle = attachRenderer(term, "webgl", factories);

    expect(() => disposePane(handle, term)).not.toThrow();
    expect(term.dispose).toHaveBeenCalled();
  });

  it("disposes a terminal that never had a renderer handle", () => {
    const term = { ...fakeTerm(), dispose: vi.fn() };

    expect(() => disposePane(null, term)).not.toThrow();
    expect(term.dispose).toHaveBeenCalled();
  });
});
