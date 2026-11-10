import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
function fail(message: string): never { throw new Error(message); }
function run(command: string, args: string[], quiet = false): string {
  const result = spawnSync(command, args, { cwd: root, env: process.env, encoding: "utf8", stdio: quiet ? "pipe" : "inherit" });
  // Captured signing output is deliberately never included in errors.
  if (result.error || result.status !== 0) fail(`${command} failed. Check the required tools and updater key configuration in docs/releases/windows.md.`);
  return result.stdout ?? "";
}
if (process.platform !== "darwin") fail("Run this cross-build release command on macOS.");
const stable = process.argv.includes("--stable");
if (process.argv.slice(2).some((arg) => arg !== "--stable")) fail("Usage: pnpm release:windows [--stable]");
const envFile = join(root, ".env.release.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);
for (const [command, args, advice] of [
  ["makensis", ["-VERSION"], "brew install nsis"],
  ["clang-cl", ["--version"], 'brew install llvm; add $(brew --prefix llvm)/bin to PATH'],
  ["lld-link", ["--version"], 'brew install lld; add $(brew --prefix lld)/bin to PATH'],
  ["cargo", ["xwin", "--version"], "cargo install --locked cargo-xwin"],
] as const) {
  const result = spawnSync(command, [...args], { encoding: "utf8" });
  if (result.error || result.status !== 0) fail(`Missing ${command}: ${advice}`);
}
if (!run("rustup", ["target", "list", "--installed"], true).includes("x86_64-pc-windows-msvc")) fail("Run rustup target add x86_64-pc-windows-msvc.");
const keyPath = process.env.ATTE_UPDATER_PUBLIC_KEY_PATH;
const privateKey = process.env.TAURI_SIGNING_PRIVATE_KEY;
if (!keyPath || !privateKey) fail("Set ATTE_UPDATER_PUBLIC_KEY_PATH and TAURI_SIGNING_PRIVATE_KEY in .env.release.local. See .env.release.example.");
const publicKey = readFileSync(keyPath, "utf8").trim();
if (!publicKey) fail("Updater public key is empty.");
process.env.TAURI_SIGNING_PRIVATE_KEY = existsSync(privateKey) ? readFileSync(privateKey, "utf8").trim() : privateKey;
const config = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const version: string = config.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) fail("Use an aligned stable numeric version; preview distribution is selected independently of the app version.");
if (JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version !== version || readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8").match(/^version = "([^"]+)"/m)?.[1] !== version) fail("Align package.json, Cargo.toml and Tauri versions first.");
const tag = stable ? `v${version}` : `windows-v${version}`;
const endpoint = stable
  ? "https://github.com/richpin/atte/releases/latest/download/latest.json"
  : "https://github.com/richpin/atte/releases/download/windows-preview/preview.json";
const releaseConfig = JSON.stringify({ bundle: { createUpdaterArtifacts: true }, plugins: { updater: { pubkey: publicKey, endpoints: [endpoint] } } });
const startedAt = Date.now();
console.log(`Building Windows ${stable ? "stable candidate" : "preview"}; no Windows code signature. Updater integrity signing is enabled.`);
run("pnpm", ["tauri", "build", "--runner", "cargo-xwin", "--target", "x86_64-pc-windows-msvc", "--bundles", "nsis", "--config", releaseConfig]);
const bundle = join(root, "src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis");
const installers = readdirSync(bundle).filter((name) => name.endsWith("-setup.exe") && statSync(join(bundle, name)).mtimeMs >= startedAt - 2000);
if (installers.length !== 1) fail("Expected exactly one newly generated NSIS Setup.exe.");
const name = installers[0];
const installer = join(bundle, name);
// Explicitly bind the version, including when the bundler's signer changes.
run("pnpm", ["tauri", "signer", "sign", "--app-version", version, installer], true);
const signature = readFileSync(`${installer}.sig`, "utf8").trim();
const destination = join(root, ".scratch/releases/windows", stable ? "stable" : "preview", version);
mkdirSync(destination, { recursive: true });
copyFileSync(installer, join(destination, name));
copyFileSync(`${installer}.sig`, join(destination, `${name}.sig`));
const metadataName = stable ? "update-windows.json" : "preview.json";
writeFileSync(join(destination, metadataName), `${JSON.stringify({ channel: stable ? "stable" : "preview", version, pub_date: new Date().toISOString(), platforms: { "windows-x86_64": { url: `https://github.com/richpin/atte/releases/download/${tag}/${name}`, signature } } }, null, 2)}\n`);
const sha256 = createHash("sha256").update(readFileSync(installer)).digest("hex");
writeFileSync(join(destination, "SHA256SUMS"), `${sha256}  ${name}\n`);
console.log(`Local release files: ${destination}\nSHA-256: ${sha256}\nManual publication only. Follow docs/releases/windows.md; Windows execution remains unverified.`);
