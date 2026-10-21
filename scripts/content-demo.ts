import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Match Tauri's macOS app_data_dir, using a dedicated bundle identifier.
if (process.platform !== "darwin") {
  throw new Error("이 수동 검증 명령은 현재 macOS에서 지원합니다.");
}
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = join(project, "src-tauri/Cargo.toml");
function runCargo(command: string, args: string[]) {
  const result = spawnSync(
    "cargo",
    [command, "--manifest-path", manifest, ...args],
    {
      cwd: project,
      stdio: ["inherit", "pipe", "inherit"],
      encoding: "utf8",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout;
}
const build = runCargo("build", [
  "--locked",
  "--example",
  "acp-agent-fixture",
  "--message-format=json",
]);
const fixture = build
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .find(
    (message) =>
      message.reason === "compiler-artifact" &&
      message.target.name === "acp-agent-fixture" &&
      message.executable,
  )?.executable as string | undefined;
if (!fixture) throw new Error("테스트 에이전트 실행 파일을 찾지 못했습니다.");
const identifier = "com.atte.content-demo";
const root = join(homedir(), "Library/Application Support", identifier);
process.stdout.write(
  runCargo("run", [
    "--locked",
    "--example",
    "prepare-content-demo",
    "--",
    root,
    fixture,
  ]),
);
const temporary = mkdtempSync(join(tmpdir(), "atte-content-demo-"));
const config = join(temporary, "tauri.conf.json");
writeFileSync(
  config,
  JSON.stringify({
    identifier,
    productName: "Atte Content Test",
    build: {
      beforeDevCommand: "pnpm dev --port 1424",
      devUrl: "http://localhost:1424",
    },
    app: {
      windows: [
        {
          title: "Atte Content Test",
          width: 1200,
          height: 850,
          dragDropEnabled: false,
          titleBarStyle: "Overlay",
          hiddenTitle: true,
          trafficLightPosition: { x: 14, y: 22 },
        },
      ],
    },
  }),
);
const app = spawn("pnpm", ["tauri", "dev", "--config", config], {
  cwd: project,
  stdio: "inherit",
});
app.on("error", (error) => {
  console.error(error);
  rmSync(temporary, { recursive: true, force: true });
  process.exitCode = 1;
});
app.on("exit", (code) => {
  rmSync(temporary, { recursive: true, force: true });
  process.exitCode = code ?? 0;
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => app.kill(signal));
}
