<div align="center">
  <img src="src-tauri/icons/128x128@2x.png" alt="Atte app icon" width="112" height="112" style="display: block; margin: 0 auto;">

<h1 align="center">Atte</h1>

<p align="center">
  Your coding agents, one consistent interface.
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#getting-started">Getting started</a> ·
  <a href="#development">Development</a>
</p>

</div>

---

Atte is a desktop app that brings coding agents into a consistent interface. Choose an agent, open a local folder, and start a thread—all in one place.

Currently in development, with macOS as the first target.

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

## Features

- **Your choice of agent.** Browse and install agents from the Agent Client Protocol (ACP) registry.
- **Work across projects.** Keep threads organized by working folder and run multiple threads at once.
- **Follow the work.** Read streaming responses, inspect tool calls and file changes, and respond to permission requests.
- **Keep the conversation going.** Queue follow-up messages and resume threads with agents that support it.
- **Make it yours.** Light, dark, and system themes, with English and Korean interfaces.

## Getting started

To run from source, install Node.js (22.12+), pnpm, Rust, and the [Tauri prerequisites for macOS](https://v2.tauri.app/start/prerequisites/#macos).

```sh
git clone https://github.com/richpin/atte.git
cd atte
pnpm install
pnpm tauri dev
```

In the app, open **Settings → Agents** to install an agent. Create a new thread, choose a working folder and an agent, and complete sign-in when prompted.

## Development

Built with **Tauri 2**, **SolidJS**, and **Rust**.

```sh
pnpm validate
cargo test --manifest-path src-tauri/Cargo.toml --all-features --locked
```

Build the macOS app with `pnpm tauri build`.

## License

Atte is licensed under the [MIT License](https://opensource.org/license/mit). Third-party agents retain their own licenses and terms.
