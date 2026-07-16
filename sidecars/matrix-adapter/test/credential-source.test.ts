import { describe, it, expect } from "vitest";
import { validateMatrixSession } from "../src/credential-source.js";
import { GenericMatrixProvider } from "../src/credential-source.js";
import { BadgerClawProvider } from "../src/credential-source.js";
import { resolveMatrixLoginOwner } from "../src/credential-source.js";
import type { Credentials } from "../src/config.js";

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

describe("BadgerClawProvider", () => {
  it("delegates to the injected mint fn and tags provider", async () => {
    const fake: Credentials = { homeserver: "https://badger.signout.io", userId: "@bot:badger.signout.io", accessToken: "t", deviceId: "D", botName: "b", botId: "id" };
    const p = new BadgerClawProvider(async () => fake);
    expect(p.provider).toBe("badgerclaw");
    expect(await p.acquire()).toBe(fake);
  });
});

describe("resolveMatrixLoginOwner", () => {
  it("uses the explicit owner when given, distinct from the bot", () => {
    expect(resolveMatrixLoginOwner("@bot:hs", "@me:hs")).toEqual({ owner: "@me:hs", selfOwner: false });
  });
  it("defaults to the bot userId and flags selfOwner when no owner given", () => {
    expect(resolveMatrixLoginOwner("@bot:hs", null)).toEqual({ owner: "@bot:hs", selfOwner: true });
  });
  it("flags selfOwner when the explicit owner equals the bot", () => {
    expect(resolveMatrixLoginOwner("@bot:hs", "@bot:hs")).toEqual({ owner: "@bot:hs", selfOwner: true });
  });
});
