import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const envFile = join(root, ".env.release.local");

function fail(message: string): never {
  throw new Error(message);
}

function run(command: string, args: string[], env = process.env): void {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: "inherit",
  });
  if (result.error) fail(`${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} exited with status ${result.status}`);
}

function output(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error) fail(`${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command}: ${result.stderr.trim()}`);
  return `${result.stdout}\n${result.stderr}`;
}

if (process.platform !== "darwin") fail("macOS is required for this release.");
if (!existsSync(envFile)) fail(`Missing ${envFile}. Copy .env.release.example first.`);
process.loadEnvFile(envFile);

const identity = process.env.APPLE_SIGNING_IDENTITY;
const teamId = process.env.APPLE_TEAM_ID;
const profile = process.env.ATTE_NOTARY_PROFILE;
if (!identity || !teamId || !profile) {
  fail("Set APPLE_SIGNING_IDENTITY, APPLE_TEAM_ID and ATTE_NOTARY_PROFILE in .env.release.local.");
}

const identities = output("security", ["find-identity", "-v", "-p", "codesigning"]);
if (!identities.includes(`"${identity}"`)) fail(`Signing identity not found in Keychain: ${identity}`);

const publicKeyPath = process.env.ATTE_UPDATER_PUBLIC_KEY_PATH;
const privateKey = process.env.TAURI_SIGNING_PRIVATE_KEY;
if (!publicKeyPath || !privateKey) {
  fail("Set ATTE_UPDATER_PUBLIC_KEY_PATH and TAURI_SIGNING_PRIVATE_KEY in .env.release.local.");
}
const publicKey = readFileSync(publicKeyPath, "utf8").trim();
if (!publicKey) fail("Updater public key is empty.");
// Both the bundler and signer receive the key contents, never a command-line secret.
process.env.TAURI_SIGNING_PRIVATE_KEY = existsSync(privateKey)
  ? readFileSync(privateKey, "utf8").trim()
  : privateKey;
const config = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const version: string = config.version;
const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const cargoVersion = readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8").match(/^version = "([^"]+)"/m)?.[1];
if (version !== packageVersion || version !== cargoVersion) fail("Keep Tauri, package.json and Cargo.toml versions aligned.");
if (version.includes("-")) fail("This command publishes stable update metadata; use a stable version.");
const releaseConfig = JSON.stringify({
  bundle: { createUpdaterArtifacts: true },
  plugins: { updater: { pubkey: publicKey } },
});
const startedAt = Date.now();
console.log("Building signed macOS DMG...");
run("pnpm", ["tauri", "build", "--target", "aarch64-apple-darwin", "--bundles", "dmg", "--config", releaseConfig], {
  ...process.env,
  APPLE_SIGNING_IDENTITY: identity,
});

const dmgDirectory = join(root, "src-tauri", "target", "aarch64-apple-darwin", "release", "bundle", "dmg");
const dmgs = readdirSync(dmgDirectory)
  .filter((name) => name.endsWith(".dmg"))
  .map((name) => join(dmgDirectory, name))
  .filter((path) => statSync(path).mtimeMs >= startedAt - 2000);
if (dmgs.length !== 1) fail(`Expected one newly built DMG in ${dmgDirectory}; found ${dmgs.length}.`);
const dmg = dmgs[0];

console.log(`Verifying ${dmg}...`);
run("codesign", ["--verify", "--verbose=2", dmg]);

const signature = output("codesign", ["-d", "--verbose=4", dmg]);
if (!signature.includes(`TeamIdentifier=${teamId}`)) fail(`DMG is not signed by team ${teamId}.`);

console.log("Submitting DMG to Apple Notary Service...");
run("xcrun", ["notarytool", "submit", dmg, "--keychain-profile", profile, "--wait"]);
run("xcrun", ["stapler", "staple", dmg]);
run("xcrun", ["stapler", "validate", dmg]);

const gatekeeper = output("spctl", [
  "--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=4", dmg,
]);
if (!gatekeeper.includes("source=Notarized Developer ID")) {
  fail(`Gatekeeper did not accept a notarized Developer ID: ${gatekeeper.trim()}`);
}
console.log(gatekeeper.trim());
// Tauri consumes the intermediate .app when bundling a DMG. Recover the exact
// notarized app from that DMG before creating the updater archive.
const macosDirectory = join(dmgDirectory, "..", "macos");
const app = join(macosDirectory, `${config.productName}.app`);
const mountPoint = mkdtempSync(join(tmpdir(), "atte-release-dmg-"));
let attached = false;
try {
  run("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mountPoint, dmg]);
  attached = true;
  const mountedApp = join(mountPoint, `${config.productName}.app`);
  if (!existsSync(mountedApp)) fail(`DMG is missing ${config.productName}.app.`);
  rmSync(app, { recursive: true, force: true });
  run("ditto", [mountedApp, app]);
} finally {
  if (attached) run("hdiutil", ["detach", mountPoint]);
  rmdirSync(mountPoint);
}
run("xcrun", ["stapler", "staple", app]);
run("xcrun", ["stapler", "validate", app]);
run("codesign", ["--verify", "--deep", "--strict", app]);
run("spctl", ["--assess", "--type", "execute", "--verbose=4", app]);
const archiveName = `${config.productName}_${version}_aarch64.app.tar.gz`;
const archive = join(dmgDirectory, archiveName);
run("tar", ["-czf", archive, "-C", macosDirectory, `${config.productName}.app`], {
  ...process.env,
  COPYFILE_DISABLE: "1",
});
run("pnpm", ["tauri", "signer", "sign", "--app-version", version, archive]);
const updaterSignature = readFileSync(`${archive}.sig`, "utf8").trim();
const url = `https://github.com/richpin/atte/releases/download/v${version}/${archiveName}`;
writeFileSync(join(dmgDirectory, "update-darwin.json"), JSON.stringify({
  channel: "stable",
  version,
  pub_date: new Date().toISOString(),
  platforms: {
    "darwin-aarch64": { url, signature: updaterSignature },
  },
}, null, 2) + "\n");
console.log(`Ready to distribute: ${dmg}`);
console.log(`macOS fragment: ${join(dmgDirectory, "update-darwin.json")}. Build the matching Windows stable candidate and run pnpm release:manifest to create the combined latest.json. Upload ${archive}, ${archive}.sig and the combined latest.json with both platform artifacts to v${version}.`);
