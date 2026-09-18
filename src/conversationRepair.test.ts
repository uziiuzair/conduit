import { describe, expect, it } from "vitest";
import {
  DISMISSED_KEY,
  describeConversation,
  describeOffer,
  formatBytes,
  offerKey,
  pendingOffers,
  readDismissed,
  writeDismissed,
  type DriftCandidate,
} from "./conversationRepair";

const offer = (over: Partial<DriftCandidate> = {}): DriftCandidate => ({
  projectId: "p",
  projectName: "Proj",
  sessionId: "s",
  sessionName: "Session",
  currentConversation: "old",
  latestConversation: "new",
  clears: 1,
  latestUpdatedAt: 1_000,
  latestTitle: "",
  latestBytes: 0,
  otherBranches: [],
  ...over,
});

describe("pendingOffers", () => {
  it("drops dismissed offers and sorts the most recently active first", () => {
    const a = offer({ sessionId: "a", latestUpdatedAt: 1 });
    const b = offer({ sessionId: "b", latestUpdatedAt: 3 });
    const c = offer({ sessionId: "c", latestUpdatedAt: 2 });
    const out = pendingOffers([a, b, c], new Set([offerKey(c)]));
    expect(out.map((o) => o.sessionId)).toEqual(["b", "a"]);
  });

  it("re-offers a session that moved on again after a dismissal", () => {
    const dismissed = new Set([offerKey(offer({ latestConversation: "first" }))]);
    expect(pendingOffers([offer({ latestConversation: "second" })], dismissed)).toHaveLength(1);
  });
});

describe("describeOffer", () => {
  it("names the clear count and how fresh the conversation is", () => {
    const now = 10 * 3_600_000;
    expect(describeOffer(offer({ clears: 1, latestUpdatedAt: now - 5 * 60_000 }), now)).toBe(
      "1 clear later · active 5m ago",
    );
    expect(describeOffer(offer({ clears: 3, latestUpdatedAt: now - 3 * 3_600_000 }), now)).toBe(
      "3 clears later · active 3h ago",
    );
    expect(describeOffer(offer({ clears: 2, latestUpdatedAt: 0 }), now)).toBe("2 clears later");
  });
});

describe("describeConversation", () => {
  it("includes the size when known, so a day's work stands out from a false start", () => {
    const now = 3_600_000;
    expect(describeConversation({ clears: 2, bytes: 2_300_000, updatedAt: now }, now)).toBe(
      "2 clears later · 2.2 MB · active just now",
    );
    expect(describeOffer(offer({ latestBytes: 6 * 1024, latestUpdatedAt: 0 }), now)).toBe(
      "1 clear later · 6 KB",
    );
  });

  it("formats sizes across units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(51 * 1024)).toBe("51 KB");
    expect(formatBytes(5.5 * 1024 * 1024)).toBe("5.5 MB");
  });
});

describe("dismissed storage", () => {
  it("round-trips and survives unreadable or throwing storage", () => {
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
    };
    writeDismissed(storage, new Set(["s:new"]));
    expect([...readDismissed(storage)]).toEqual(["s:new"]);

    mem.set(DISMISSED_KEY, "{not json");
    expect(readDismissed(storage).size).toBe(0);
    mem.set(DISMISSED_KEY, JSON.stringify({ not: "an array" }));
    expect(readDismissed(storage).size).toBe(0);

    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readDismissed(throwing).size).toBe(0);
    expect(() => writeDismissed(throwing, new Set(["x"]))).not.toThrow();
    expect(readDismissed(undefined).size).toBe(0);
  });
});
