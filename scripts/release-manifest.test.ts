import { describe, expect, it } from "vitest";
import {
  mergeReleaseManifests,
  type ReleaseManifest,
} from "./release-manifest";

const macOS: ReleaseManifest = {
  channel: "stable",
  version: "0.2.0",
  pub_date: "2026-11-06T00:00:00Z",
  platforms: {
    "darwin-aarch64": {
      url: "https://github.com/richpin/atte/releases/download/v0.2.0/Atte_0.2.0_aarch64.app.tar.gz",
      signature: "macos-signature",
    },
  },
};
const windows: ReleaseManifest = {
  channel: "stable",
  version: "0.2.0",
  pub_date: "2026-11-06T00:00:00Z",
  platforms: {
    "windows-x86_64": {
      url: "https://github.com/richpin/atte/releases/download/v0.2.0/Atte_0.2.0_x64-setup.exe",
      signature: "windows-signature",
    },
  },
};

describe("stable release manifest", () => {
  it("preserves both platforms and their version-pinned artifacts in either input order", () => {
    for (const parts of [
      [macOS, windows],
      [windows, macOS],
    ]) {
      expect(mergeReleaseManifests(parts)).toMatchObject({
        channel: "stable",
        version: "0.2.0",
        platforms: {
          "darwin-aarch64": {
            url: "https://github.com/richpin/atte/releases/download/v0.2.0/Atte_0.2.0_aarch64.app.tar.gz",
            signature: "macos-signature",
          },
          "windows-x86_64": {
            url: "https://github.com/richpin/atte/releases/download/v0.2.0/Atte_0.2.0_x64-setup.exe",
            signature: "windows-signature",
          },
        },
      });
    }
  });
  it.each([
    ["macOS", windows, "darwin-aarch64"],
    ["Windows", macOS, "windows-x86_64"],
  ] as const)("refuses publication without %s", (_name, fragment, target) => {
    expect(() => mergeReleaseManifests([fragment])).toThrow(
      `Missing ${target}`,
    );
  });

  it("rejects a preview fragment even when its app version is stable", () => {
    expect(() =>
      mergeReleaseManifests([macOS, { ...windows, channel: "preview" }]),
    ).toThrow("Preview metadata cannot be published to the stable channel");
  });

  it("rejects an older platform artifact under a new global version", () => {
    expect(() =>
      mergeReleaseManifests([macOS, { ...windows, version: "0.1.0" }]),
    ).toThrow("All platform artifacts must have the same version");
  });

  it("rejects prerelease versions in the stable channel", () => {
    expect(() =>
      mergeReleaseManifests([
        { ...macOS, version: "0.2.0-beta.1" },
        { ...windows, version: "0.2.0-beta.1" },
      ]),
    ).toThrow("Stable manifests require a stable version");
  });

  it("refuses duplicate platforms instead of silently overwriting an artifact", () => {
    expect(() => mergeReleaseManifests([macOS, windows, macOS])).toThrow(
      "Duplicate platform: darwin-aarch64",
    );
  });

  it.each([
    { url: "http://example.com/setup.exe", signature: "signature" },
    { url: "https://example.com/setup.exe", signature: "  " },
  ])("refuses an insecure or unsigned artifact: %j", (artifact) => {
    expect(() =>
      mergeReleaseManifests([
        macOS,
        { ...windows, platforms: { "windows-x86_64": artifact } },
      ]),
    ).toThrow("Invalid updater artifact: windows-x86_64");
  });

  it("refuses an empty release", () => {
    expect(() => mergeReleaseManifests([])).toThrow(
      "Provide macOS and Windows manifests",
    );
  });
});
