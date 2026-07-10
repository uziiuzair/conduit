import { describe, expect, it } from "vitest";
import {
  attachFrame,
  inputFrame,
  parseServerFrame,
  promptToKeystrokes,
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

describe("promptToKeystrokes", () => {
  it("single line: text + carriage return", () => {
    expect(promptToKeystrokes("fix the bug")).toBe("fix the bug\r");
  });

  it("multi-line: bracketed paste then submit", () => {
    expect(promptToKeystrokes("line one\nline two")).toBe(
      "\x1b[200~line one\nline two\x1b[201~\r",
    );
  });

  it("normalizes CRLF and strips trailing newlines", () => {
    expect(promptToKeystrokes("a\r\nb\n")).toBe("\x1b[200~a\nb\x1b[201~\r");
    expect(promptToKeystrokes("solo\n\n")).toBe("solo\r");
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
