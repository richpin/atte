<div align="center">
  <img src="src-tauri/icons/128x128@2x.png" alt="Atte app icon" width="112" height="112">

<h1 align="center">Atte</h1>

<p align="center">
  A minimal, lightweight coding agent app for developers tired of complex ADEs.
</p>

<p align="center">
  <a href="#download">Download</a> ·
  <a href="#features">Features</a> ·
  <a href="#development">Development</a>
</p>

</div>

![Atte in light mode with sample projects, multiple coding agents, and the changes panel open in a macOS window](docs/images/atte-light-window.jpg)

Atte brings your coding agents together in a minimal desktop interface. Choose an agent, open a local folder, and start a thread.

## Download

**[Download the latest release for macOS →](https://github.com/richpin/atte/releases/latest)**

Currently available for **Apple Silicon Macs (ARM64) only**.

1. Download the `.dmg` file from the latest release.
2. Open it and drag Atte to **Applications**.
3. Launch Atte and open **Settings → Agents** to install an agent. Complete sign-in when prompted.
4. Create a thread, choose a working folder and an agent, and start working.

Check for updates in **Settings → General**.

## Features

- Work across projects with multiple agents and parallel threads.
- Keep tasks separate with Git worktrees.
- Review Git changes and create commits in the side panel.
- Browse files, edit code, and open web pages beside your conversation.
- Queue follow-ups and add context with file mentions and attachments.
- Light, dark, and system themes, with English and Korean interfaces.

## Supported agents

Atte connects to agents through the **Agent Client Protocol (ACP)**. Available agents include:

<p align="center">
  <kbd><img src="src/shared/ui/agent-icon/assets/agoragentic-acp.svg" alt="" width="16" height="16" valign="middle"> Agoragentic</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/amp-acp.svg" alt="" width="16" height="16" valign="middle"> Amp</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/antigravity-acp.svg" alt="" width="16" height="16" valign="middle"> Google&nbsp;Antigravity</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/auggie.svg" alt="" width="16" height="16" valign="middle"> Auggie&nbsp;CLI</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/autohand.svg" alt="" width="16" height="16" valign="middle"> Autohand&nbsp;Code</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/claude-acp.svg" alt="" width="16" height="16" valign="middle"> Claude&nbsp;Agent</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/cline.svg" alt="" width="16" height="16" valign="middle"> Cline</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/codebuddy-code.svg" alt="" width="16" height="16" valign="middle"> Codebuddy&nbsp;Code</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/codex-acp.svg" alt="" width="16" height="16" valign="middle"> Codex</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/cortex-code.svg" alt="" width="16" height="16" valign="middle"> Cortex&nbsp;Code</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/corust-agent.svg" alt="" width="16" height="16" valign="middle"> Corust&nbsp;Agent</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/crow-cli.svg" alt="" width="16" height="16" valign="middle"> crow-cli</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/cursor.svg" alt="" width="16" height="16" valign="middle"> Cursor</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/deepagents.svg" alt="" width="16" height="16" valign="middle"> DeepAgents</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/devin.svg" alt="" width="16" height="16" valign="middle"> Devin</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/dimcode.svg" alt="" width="16" height="16" valign="middle"> DimCode</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/dirac.svg" alt="" width="16" height="16" valign="middle"> Dirac</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/factory-droid.svg" alt="" width="16" height="16" valign="middle"> Factory&nbsp;Droid</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/gemini.svg" alt="" width="16" height="16" valign="middle"> Gemini&nbsp;CLI</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/github-copilot-cli.svg" alt="" width="16" height="16" valign="middle"> Copilot</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/glm-acp-agent.svg" alt="" width="16" height="16" valign="middle"> GLM&nbsp;Agent</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/goose.svg" alt="" width="16" height="16" valign="middle"> goose</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/grok-build.svg" alt="" width="16" height="16" valign="middle"> Grok&nbsp;Build</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/harn.svg" alt="" width="16" height="16" valign="middle"> Harn</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/junie.svg" alt="" width="16" height="16" valign="middle"> Junie</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/kilo.svg" alt="" width="16" height="16" valign="middle"> Kilo</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/kimchi.svg" alt="" width="16" height="16" valign="middle"> Kimchi</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/kimi.svg" alt="" width="16" height="16" valign="middle"> Kimi&nbsp;CLI</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/minimax-code.svg" alt="" width="16" height="16" valign="middle"> MiniMax&nbsp;Code</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/mistral-vibe.svg" alt="" width="16" height="16" valign="middle"> Mistral&nbsp;Vibe</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/nova.svg" alt="" width="16" height="16" valign="middle"> Nova</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/opencode.svg" alt="" width="16" height="16" valign="middle"> OpenCode</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/pi-acp.svg" alt="" width="16" height="16" valign="middle"> pi&nbsp;ACP</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/poolside.svg" alt="" width="16" height="16" valign="middle"> Poolside</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/qoder.svg" alt="" width="16" height="16" valign="middle"> Qoder&nbsp;CLI</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/qwen-code.svg" alt="" width="16" height="16" valign="middle"> Qwen&nbsp;Code</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/sigit.svg" alt="" width="16" height="16" valign="middle"> siGit&nbsp;Code</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/stakpak.svg" alt="" width="16" height="16" valign="middle"> Stakpak</kbd> &nbsp;
  <kbd><img src="src/shared/ui/agent-icon/assets/vtcode.svg" alt="" width="16" height="16" valign="middle"> VT&nbsp;Code</kbd>
</p>

Install agents in **Settings → Agents**, powered by the [ACP registry](https://github.com/agentclientprotocol/registry). Availability depends on your platform and the agent's distribution; features and sign-in requirements vary by agent.

## Development

Built with **Tauri 2**, **SolidJS**, and **Rust**. Active development happens on `develop`; `main` tracks releases.

To run from source, install Node.js (22.12+), pnpm, Rust, and the [Tauri prerequisites for macOS](https://v2.tauri.app/start/prerequisites/#macos).

```sh
git clone https://github.com/richpin/atte.git
cd atte
git switch develop
pnpm install
pnpm tauri dev
```

Run the checks:

```sh
pnpm validate
cargo test --manifest-path src-tauri/Cargo.toml --all-features --locked
```

Build locally with `pnpm tauri build`. For signed and notarized distribution builds, see the [macOS release guide](docs/release-macos.md).

## License

Atte is licensed under the [MIT License](https://opensource.org/license/mit). Third-party agents retain their own licenses and terms.
