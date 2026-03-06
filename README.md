# ⚡ Shadow Accept

**Auto-accept AI agent prompts in VS Code, Cursor, Antigravity and Windsurf.**

by **[NakedoMedia](https://nakedo.ai)** — MIT License — Free forever, no limits, no telemetry.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-1.2.0-blue.svg)](https://github.com/NakedoMedia/shadow-accept/releases)
[![Tests](https://img.shields.io/badge/tests-119%20passed-brightgreen.svg)](#testing)
[![Open Source](https://img.shields.io/badge/open%20source-%E2%9D%A4-red.svg)](https://github.com/NakedoMedia/shadow-accept)

[nakedo.ai](https://nakedo.ai) · [GitHub](https://github.com/NakedoMedia/shadow-accept) · [Issues](https://github.com/NakedoMedia/shadow-accept/issues)

---

## Why Shadow Accept?

AI coding agents like **Claude Code**, **Aider**, **Cody** and **GitHub Copilot** constantly ask for permission to run commands, edit files, or execute scripts. Each prompt breaks your flow.

**Shadow Accept** eliminates that friction — it auto-accepts safe prompts while blocking dangerous commands. One click to enable, zero config required.

| Problem | Shadow Accept |
|---------|---------------|
| Constant "Allow?" / "[Y/n]" interruptions | Auto-accepts instantly |
| Lost flow when switching to terminal | Works silently in background |
| Fear of auto-accepting `rm -rf /` | Smart banned command safety net |
| Works only in VS Code | VS Code + Cursor + Antigravity + Windsurf |
| Paid extensions with limits | **100% free, no limits, forever** |

---

## Features

- **Zero config** — works out of the box with the Terminal Monitor engine
- **Dual-engine architecture** — Terminal Monitor (primary, zero-config) + CDP Handler (fallback)
- **Universal IDE support** — VS Code, Cursor, Antigravity, Windsurf (and Electron forks)
- **Smart safety** — 11 default banned patterns, supports regex, blocks dangerous commands
- **User-aware** — pauses during user keyboard/mouse activity
- **Quick Accept** — `Ctrl+Shift+Y` sends Y to the active terminal instantly
- **Beautiful settings panel** — toggle, sliders, live stats, engine status cards
- **Real-time stats** — session accepts, all-time accepts, blocked commands counter
- **No telemetry** — zero network requests, zero data collection, 100% local
- **Lightweight** — only 2 dependencies (ws, esbuild)

---

## Quick Start

### Install from VSIX
```bash
code --install-extension shadow-accept-1.2.0.vsix

# For other IDEs:
cursor --install-extension shadow-accept-1.2.0.vsix
antigravity --install-extension shadow-accept-1.2.0.vsix
```

### Manual install
Copy the `shadow-accept/` folder into your extensions directory:

| IDE | Path |
|-----|------|
| VS Code | `~/.vscode/extensions/` |
| Cursor | `~/.cursor/extensions/` |
| Antigravity | `~/.antigravity/extensions/` |
| Windsurf | `~/.windsurf/extensions/` |

### Enable
Click **⚡ Shadow** in the status bar — that's it.

---

## How it works

### Dual-Engine Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Shadow Accept Extension                                │
│                                                         │
│  ┌─ Engine Manager ──────────────────────────────────┐  │
│  │                                                    │  │
│  │  ┌─ Terminal Monitor (Primary) ─────────────────┐ │  │
│  │  │  Zero-config · Instant response              │ │  │
│  │  │  Detects [Y/n] prompts in terminal output    │ │  │
│  │  │  Checks banned commands before responding    │ │  │
│  │  └──────────────────────────────────────────────┘ │  │
│  │                                                    │  │
│  │  ┌─ CDP Handler (Fallback) ─────────────────────┐ │  │
│  │  │  DOM button scanning · Smart port discovery  │ │  │
│  │  │  Word-boundary regex · Shadow DOM support    │ │  │
│  │  └──────────────────────────────────────────────┘ │  │
│  └────────────────────────────────────────────────────┘  │
│                                                         │
│  Status Bar · Settings Panel · Quick Accept (Ctrl+⇧+Y) │
└─────────────────────────────────────────────────────────┘
```

**Terminal Monitor** (zero-config): Listens to terminal output via VS Code's proposed API. Detects permission prompts (`[Y/n]`, `(yes/no)`, etc.) and auto-responds. No setup needed.

**CDP Handler** (fallback): Connects via Chrome DevTools Protocol on `127.0.0.1`. Scans DOM for accept/approve/allow buttons using word-boundary regex. Requires `--remote-debugging-port=9222` flag.

---

## Configuration

Open settings via `Ctrl+Shift+P` → `Shadow Accept: Settings`, or use `File > Preferences > Settings` → search "Shadow Accept".

| Setting | Default | Description |
|---------|---------|-------------|
| `shadowAccept.engineMode` | `auto` | Engine mode: auto, terminal-only, cdp-only |
| `shadowAccept.pollInterval` | `800` | CDP scan frequency in ms (300–3000) |
| `shadowAccept.bannedCommands` | *(11 patterns)* | Patterns that block auto-accept |
| `shadowAccept.enableOnStartup` | `false` | Auto-enable when IDE starts |
| `shadowAccept.debugPort` | `0` | Custom CDP port (0 = auto-scan) |
| `shadowAccept.terminalPatterns` | `[]` | Additional regex for terminal prompts |

### Banned commands

Supports plain substrings **and** `/regex/flags`:
```
rm -rf /
rm -rf ~
/sudo\s+rm/i
format c:
dd if=
```

---

## Security

Shadow Accept is designed with security as a first principle:

- **Local only** — connects exclusively to `127.0.0.1` (loopback)
- **No network** — zero external requests, zero telemetry, zero data collection
- **Safe injection** — scripts loaded from disk, no eval of remote strings
- **Banned commands** — 11 destructive patterns blocked by default
- **User priority** — pauses during mouse/keyboard activity
- **Page filtering** — excludes DevTools UI pages from CDP scanning
- **Word boundaries** — prevents false positives ("book" ≠ "ok", "running" ≠ "run")

---

## Supported AI Tools

Shadow Accept works with any AI agent that prompts in the terminal or via IDE dialogs:

| Tool | Terminal prompts | IDE buttons |
|------|:---:|:---:|
| Claude Code | ✅ | ✅ |
| Aider | ✅ | — |
| Cody | ✅ | ✅ |
| GitHub Copilot | — | ✅ |
| Continue | ✅ | ✅ |
| Cursor AI | ✅ | ✅ |
| Any `[Y/n]` prompt | ✅ | — |

---

## Testing

119 tests covering all critical paths:

```bash
npm run test
```

| Suite | Tests | Coverage |
|-------|:-----:|----------|
| CDP Handler | 15 | Port discovery, filtering, backoff |
| Pattern Matching | 43 | Accept/reject regex, word boundaries, false positives |
| Terminal Monitor | 23 | ANSI stripping, prompt detection, banned commands |
| Engine Manager | 6 | Mode selection, stats aggregation |
| File Integrity | 13 | Version checks, code presence |
| Mock Server | 4 | Real port listening |
| **Total** | **119** | **All passed** |

---

## Build from source

```bash
git clone https://github.com/NakedoMedia/shadow-accept.git
cd shadow-accept
npm install
npm run compile    # Bundle with esbuild
npm run package    # Create .vsix
npm run test       # Run test suite
```

---

## About

**Shadow Accept** is built by [NakedoMedia](https://nakedo.ai), the team behind the **Nakedo AI** ecosystem — a suite of open-source AI tools for developers.

We believe developer tools should be **free**, **open**, and **privacy-first**. Shadow Accept embodies these values: no telemetry, no paywalls, no tracking. Just pure productivity.

- **Website**: [nakedo.ai](https://nakedo.ai)
- **GitHub**: [NakedoMedia](https://github.com/NakedoMedia)
- **License**: MIT — use it, fork it, improve it

---

## Contributing

PRs and issues welcome! See the [issues page](https://github.com/NakedoMedia/shadow-accept/issues).

```bash
git clone https://github.com/NakedoMedia/shadow-accept
cd shadow-accept
npm install
npm run compile
# Make your changes, then run tests:
npm run test
```

---

## License

MIT © 2026 [NakedoMedia](https://nakedo.ai)
