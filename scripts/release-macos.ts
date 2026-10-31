import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
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

const startedAt = Date.now();
console.log("Building signed macOS DMG...");
run("pnpm", ["tauri", "build", "--bundles", "dmg"], {
  ...process.env,
  APPLE_SIGNING_IDENTITY: identity,
});

const dmgDirectory = join(root, "src-tauri", "target", "release", "bundle", "dmg");
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
console.log(`Ready to distribute: ${dmg}`);
