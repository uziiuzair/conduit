import { describe, expect, it } from "vitest";
import { pasteAndSubmit } from "./terminalInput";

describe("pasteAndSubmit", () => {
  it("leaves the CR outside the paste so the TUI submits", () => {
    // Inside the brackets the CR is just another newline in the composer, which is the
    // whole bug: the message arrives but never sends.
    expect(pasteAndSubmit("ship it")).toBe("\x1b[200~ship it\x1b[201~\r");
  });

  it("keeps a multi-line message inside one paste", () => {
    const out = pasteAndSubmit("line one\nline two");
    expect(out.startsWith("\x1b[200~line one\nline two\x1b[201~")).toBe(true);
    expect(out.endsWith("\x1b[201~\r")).toBe(true);
  });

  it("refuses to let the body close the paste early", () => {
    const out = pasteAndSubmit("safe\x1b[201~rm -rf /");
    expect(out.match(/\x1b\[201~/g)).toHaveLength(1);
    expect(out).toBe("\x1b[200~safe[201~rm -rf /\x1b[201~\r");
  });
});
