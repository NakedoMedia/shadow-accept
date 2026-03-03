# ⚡ Shadow Accept

**Auto-accept AI agent prompts in VS Code, Antigravity and Cursor.**
by **Nakedo Corp** — MIT License — Free forever, no limits, no telemetry.

---

## Features

- **Zero friction** — one click to enable, runs silently in the background
- **Universal** — works with VS Code, Antigravity, Cursor (and forks)
- **Smart safety** — banned command list prevents clicking dangerous shell commands
- **User-aware** — pauses automatically when you interact with the IDE
- **Stats** — tracks session and all-time auto-accepted counts
- **Beautiful settings** — slider, live preview, toast confirmations
- **No limits** — 100% free, no account, no API keys, no subscriptions

---

## Installation

### From VSIX
```bash
code --install-extension shadow-accept-1.0.0.vsix
# or for Antigravity:
antigravity --install-extension shadow-accept-1.0.0.vsix
```

### Manual (copy folder)
Copy the `shadow-accept/` folder into:
- **VS Code:** `~/.vscode/extensions/`
- **Antigravity:** `~/.antigravity/extensions/`
- **Cursor:** `~/.cursor/extensions/`

---

## Usage

| Action | How |
|--------|-----|
| Toggle ON/OFF | Click `⚡ Shadow` in the status bar |
| Open settings | `Ctrl+Shift+P` → `Shadow Accept: Settings` |
| View log | Settings panel → **View log** |

---

## Configuration

Settings are available via `File > Preferences > Settings` → search **Shadow Accept**,
or via the built-in settings panel.

| Setting | Default | Description |
|---------|---------|-------------|
| `shadowAccept.pollInterval` | `800` | Scan frequency in ms (300–3000) |
| `shadowAccept.bannedCommands` | *(list)* | Patterns that block auto-accept of run/execute buttons |
| `shadowAccept.enableOnStartup` | `false` | Auto-enable when IDE starts |

### Banned command patterns

Supports plain substrings **and** `/regex/flags` syntax:
```
rm -rf /
/sudo\s+rm/i
format c:
```

---

## How it works

Shadow Accept uses the **Chrome DevTools Protocol (CDP)** built into Electron-based IDEs.
It connects locally (127.0.0.1 only) to the IDE's debug port, injects a lightweight DOM script,
and polls for accept buttons using text-pattern matching.

No network requests. No data collection. All processing is local.

---

## Security

- Connects **only** to `127.0.0.1` (loopback, never remote)
- Targets only `page` / `webview` type pages — DevTools UI is excluded
- Injected script is read from disk — no eval of external strings
- Banned command list checked before any `run`/`execute` button click
- Pauses during user mouse/keyboard activity to avoid interference

---

## Contributing

PRs welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) or open an issue.

```bash
git clone https://github.com/NakedoCorp/shadow-accept
cd shadow-accept
npm install
npm run compile
```

---

## License

MIT © 2026 Nakedo Corp
