import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export type ReleaseManifest = {
  channel: "stable" | "preview";
  version: string;
  pub_date: string;
  notes?: string;
  platforms: Record<string, { url: string; signature: string }>;
};

// Tauri has one version for the entire static manifest. Mixing versions would
// advertise an older artifact as a new update and fail signed-version validation.
export function mergeReleaseManifests(parts: ReleaseManifest[]): ReleaseManifest {
  if (!parts.length) throw new Error("Provide macOS and Windows manifests for the same stable version.");
  const version = parts[0].version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Stable manifests require a stable version.");
  const platforms: ReleaseManifest["platforms"] = {};
  for (const part of parts) {
    if (part.channel !== "stable") throw new Error("Preview metadata cannot be published to the stable channel.");
    if (part.version !== version) throw new Error("All platform artifacts must have the same version. Build both platforms before publishing.");
    for (const [target, artifact] of Object.entries(part.platforms)) {
      if (platforms[target]) throw new Error(`Duplicate platform: ${target}`);
      const url = new URL(artifact.url);
      if (url.protocol !== "https:" || !artifact.signature.trim()) throw new Error(`Invalid updater artifact: ${target}`);
      platforms[target] = artifact;
    }
  }
  for (const target of ["darwin-aarch64", "windows-x86_64"]) {
    if (!platforms[target]) throw new Error(`Missing ${target}; a stable manifest must preserve both platforms.`);
  }
  return { channel: "stable", version, pub_date: new Date().toISOString(), platforms };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [destination, ...sources] = process.argv.slice(2);
  if (!destination) throw new Error("Usage: pnpm release:manifest <latest.json output> <macOS fragment> <Windows fragment>");
  const manifest = mergeReleaseManifests(sources.map((path) => JSON.parse(readFileSync(path, "utf8"))));
  writeFileSync(destination, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Stable manifest ready: ${destination}. Upload only with both platform artifacts to v${manifest.version}.`);
}
