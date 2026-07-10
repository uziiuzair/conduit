import { describe, expect, it } from "vitest";
import {
  attachFrame,
  inputFrame,
  parseServerFrame,
  promptToInsert,
  SUBMIT_KEY,
  typingForStatus,
} from "../src/protocol.js";

describe("frame building", () => {
  it("matches bridge.rs's serde shapes (snake_case session_id)", () => {
    expect(JSON.parse(attachFrame("s1"))).toEqual({ type: "attach", session_id: "s1" });
    expect(JSON.parse(inputFrame("s1", "ls\r"))).toEqual({
      type: "input",
      session_id: "s1",
      data: "ls\r",
    });
  });
});

describe("parseServerFrame", () => {
  it("parses known frames and rejects garbage", () => {
    expect(parseServerFrame('{"type":"size","cols":80,"rows":24}')).toEqual({
      type: "size",
      cols: 80,
      rows: 24,
    });
    expect(parseServerFrame('{"type":"chat","item":{"kind":"bubble","role":"assistant","text":"hi"}}'))
      .toMatchObject({ type: "chat" });
    expect(parseServerFrame("not json")).toBeNull();
    expect(parseServerFrame('{"type":"explode"}')).toBeNull();
    expect(parseServerFrame("42")).toBeNull();
  });
});

describe("promptToInsert", () => {
  it("single line: text only, no submit (Enter is sent separately)", () => {
    expect(promptToInsert("fix the bug")).toBe("fix the bug");
    expect(SUBMIT_KEY).toBe("\r");
  });

  it("multi-line: bracketed paste, still no trailing Enter", () => {
    expect(promptToInsert("line one\nline two")).toBe("\x1b[200~line one\nline two\x1b[201~");
  });

  it("normalizes CRLF and strips trailing newlines", () => {
    expect(promptToInsert("a\r\nb\n")).toBe("\x1b[200~a\nb\x1b[201~");
    expect(promptToInsert("solo\n\n")).toBe("solo");
  });
});

describe("controlKeyBytes", () => {
  it("maps friendly names to bytes; y/n include submit", async () => {
    const { controlKeyBytes, INTERRUPT_KEY } = await import("../src/protocol.js");
    expect(controlKeyBytes("esc")).toBe("\x1b");
    expect(controlKeyBytes("Enter")).toBe("\r");
    expect(controlKeyBytes("up")).toBe("\x1b[A");
    expect(controlKeyBytes("ctrl-c")).toBe("\x03");
    expect(controlKeyBytes("y")).toBe("y\r");
    expect(controlKeyBytes("n")).toBe("n\r");
    expect(controlKeyBytes("bogus")).toBeNull();
    expect(INTERRUPT_KEY).toBe("\x03");
  });
});

describe("typingForStatus", () => {
  it("maps hook events to presence", () => {
    expect(typingForStatus("prompt")).toBe(true);
    expect(typingForStatus("pretool")).toBe(true);
    expect(typingForStatus("stop")).toBe(false);
    expect(typingForStatus("notification")).toBe(false);
    expect(typingForStatus("todos")).toBeNull();
    expect(typingForStatus("sessionstart")).toBeNull();
  });
});
