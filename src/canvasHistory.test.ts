import { describe, expect, it } from "vitest";
import { HISTORY_CAP, emptyHistory, pushHistory, redo, undo } from "./canvasHistory";

describe("canvasHistory", () => {
  it("undoes to the pushed snapshot and hands the current state to redo", () => {
    const h = pushHistory(emptyHistory<string>(), "a");
    const back = undo(h, "b");
    expect(back).not.toBeNull();
    expect(back!.state).toBe("a");
    const fwd = redo(back!.history, back!.state);
    expect(fwd!.state).toBe("b");
  });

  it("returns null with nothing to undo or redo", () => {
    expect(undo(emptyHistory<string>(), "a")).toBeNull();
    expect(redo(emptyHistory<string>(), "a")).toBeNull();
  });

  it("clears the redo stack on a new push — a new edit forks the timeline", () => {
    const h = pushHistory(emptyHistory<string>(), "a");
    const back = undo(h, "b")!;
    const forked = pushHistory(back.history, "c");
    expect(forked.future).toEqual([]);
    expect(redo(forked, "d")).toBeNull();
  });

  it("caps the past, discarding the oldest", () => {
    let h = emptyHistory<number>();
    for (let i = 0; i < HISTORY_CAP + 10; i++) h = pushHistory(h, i);
    expect(h.past).toHaveLength(HISTORY_CAP);
    expect(h.past[0]).toBe(10);
  });

  it("does not push a snapshot identical to the last one", () => {
    const s = { a: 1 };
    const h = pushHistory(pushHistory(emptyHistory<object>(), s), s);
    expect(h.past).toHaveLength(1);
  });

  it("returns states in order across a multi-step undo and redo", () => {
    let h = pushHistory(pushHistory(emptyHistory<string>(), "a"), "b");
    const back1 = undo(h, "c")!;      // past [a,b] -> [a], future [c]
    const back2 = undo(back1.history, back1.state)!; // past [a] -> [], future [b,c]
    expect(back1.state).toBe("b");
    expect(back2.state).toBe("a");

    const fwd1 = redo(back2.history, back2.state)!;
    const fwd2 = redo(fwd1.history, fwd1.state)!;
    expect(fwd1.state).toBe("b");
    expect(fwd2.state).toBe("c");
  });
});
