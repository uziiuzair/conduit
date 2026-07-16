import { describe, it, expect } from "vitest";
import { validateMatrixSession } from "../src/credential-source.js";
import { GenericMatrixProvider } from "../src/credential-source.js";

describe("validateMatrixSession", () => {
  it("accepts a complete session", () => {
    expect(() =>
      validateMatrixSession({
        homeserver: "https://matrix.org",
        userId: "@me:matrix.org",
        accessToken: "syt_abc",
        deviceId: "DEV1",
      }),
    ).not.toThrow();
  });
  it("rejects a non-https homeserver", () => {
    expect(() =>
      validateMatrixSession({ homeserver: "matrix.org", userId: "@me:matrix.org", accessToken: "t", deviceId: null }),
    ).toThrow(/homeserver must be an https/i);
  });
  it("rejects a userId without a leading @", () => {
    expect(() =>
      validateMatrixSession({ homeserver: "https://matrix.org", userId: "me:matrix.org", accessToken: "t", deviceId: null }),
    ).toThrow(/user id/i);
  });
});

describe("GenericMatrixProvider", () => {
  it("returns Credentials from validated input", async () => {
    const p = new GenericMatrixProvider({
      homeserver: "https://matrix.org",
      userId: "@me:matrix.org",
      accessToken: "syt_abc",
      deviceId: "DEV1",
    });
    expect(p.provider).toBe("matrix");
    const creds = await p.acquire();
    expect(creds).toMatchObject({ homeserver: "https://matrix.org", userId: "@me:matrix.org", accessToken: "syt_abc", deviceId: "DEV1", botId: null });
  });
  it("throws on invalid input before returning", async () => {
    const p = new GenericMatrixProvider({ homeserver: "http://x", userId: "@a:b", accessToken: "t", deviceId: null });
    await expect(p.acquire()).rejects.toThrow(/https/i);
  });
});
