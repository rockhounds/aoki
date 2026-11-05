# Install T3 Code

T3 Code runs coding agents on your computer (or server) and lets you control them from the desktop app, web app, or mobile app. Install T3 Code on the machine where your agents will run first.

## Requirements

You need at least one installed, authenticated coding agent (provider) before starting a thread. You can launch T3 Code first and set up providers from the [Welcome page](./welcome-page.md) or **Settings → Providers**.

## Command line

Install the `aoki` command to `~/.local/bin`:

```bash
# macOS / Linux
curl -fsSL https://t3.codes/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://t3.codes/install.ps1 | iex
```

Set `AOKI_CHANNEL=nightly` for nightly builds or `AOKI_VERSION=<ver>` to pin a version. To try once without installing, run `npx aoki@latest` (requires Node.js; always runs the latest stable release).

| Task                          | Command                                                                 |
| ----------------------------- | ----------------------------------------------------------------------- |
| Start server and open web app | `aoki` (or `aoki ./my-project`)                                             |
| Start server without browser  | `aoki serve`                                                              |
| Set up remote access          | `aoki up` ([Remote access](./remote-access.md))                           |
| Run in the background         | `aoki service install` ([Background service](./background-service.md))    |
| Update                        | `aoki update`                                                             |
| Reclaim database space        | `aoki doctor` ([Details](./background-service.md#reclaim-database-space)) |
| Uninstall                     | `aoki uninstall`                                                          |

If `aoki` reports a server is already running, connect with `aoki pair` or pass a separate `--base-dir`. Run `aoki --help` for all commands.

### Intel Macs

There is no standalone `aoki` binary for Intel Macs—use the desktop app, or build a server from source with `vp` ([development runbook](../operations/00_development.md#first-checkout)):

```bash
git clone https://github.com/rockhounds/aoki
cd aoki && vp i && vp run build:desktop
node apps/server/dist/bin.mjs
```

## Desktop app

Download from [GitHub Releases](https://github.com/rockhounds/aoki/releases) or install via a package manager:

| Platform                | Command                                                          |
| ----------------------- | ---------------------------------------------------------------- |
| macOS                   | `brew install --cask t3-code`                                    |
| Windows                 | `winget install T3Tools.T3Code` or `scoop install extras/aoki` |
| Debian / Ubuntu         | `sudo apt install ./Aoki-*.deb`                                |
| Arch Linux              | `yay -S aoki-bin` (or `yay -S aoki-nightly-bin`)               |
| Nix (flakes, Nix 2.30+) | `nix profile add github:NixOS/nixpkgs/nixos-unstable#aoki`     |

- **Linux AppImage**: `chmod +x ./Aoki-*.AppImage && ./Aoki-*.AppImage` (x86_64 and ARM64). `.deb` self-updates with a password prompt; update AUR packages via your AUR helper (`yay -Syu`).
- **NixOS / Home Manager**: Add `pkgs.aoki` to `environment.systemPackages` or `home.packages` (`aoki-desktop` launches the app; `aoki` is included). Update via Nix rather than the in-app updater.

### The `aoki` command

The desktop app bundles `aoki` and sets it up on first launch (manage anytime under **Settings → About → aoki command**). Use **Add to PATH** if needed, then open a new terminal.

- **Open a folder in the running desktop app**: Run `aoki app` (or `aoki app ../my-project`) from a terminal, or drag folders from your file manager onto the desktop sidebar.

### Windows Subsystem for Linux

Select a WSL distro in **Settings → Sharing & access** to run agents and projects inside WSL (install provider CLIs inside that distro). T3 Code manages its own server runtime inside WSL automatically.

## Mobile app

Install from the [App Store](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) or [Google Play](https://play.google.com/store/apps/details?id=io.github.rockhounds.aoki) (QR codes are also in **Settings → About → Mobile app**). The mobile app connects to a server on another machine via [remote access](./remote-access.md).

- Store builds work with both Stable and Nightly servers. Optional Android beta APKs are under [Android beta releases](https://github.com/rockhounds/aoki/releases?q=android-beta-).
- If the mobile app crashes on launch, open **Settings → Diagnostics** on the next launch to copy recent startup crash reports.

## Providers

Open **Settings → Providers** (web or desktop), select the environment, and enable the providers you use. Installation and sign-in always happen on the **environment's machine**.

| Provider         | Install and authenticate                                                                                                 | Guide                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| **Codex**        | Connect with ChatGPT in Settings, or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. | [Codex](./providers-codex.md)             |
| **Claude**       | Install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`.                               | [Claude](./providers-claude.md)           |
| **Cursor**       | Sign in in Settings or install [Cursor CLI](https://cursor.com/cli) and run `agent login`.                               | [Cursor](./cursor.md)                     |
| **Grok Build**   | Install [Grok Build CLI](https://x.ai/cli) and run `grok login`.                                                         | [Grok](./providers-grok.md)               |
| **Antigravity**  | Install managed runtime and sign in with Google in Settings.                                                             | [Antigravity](./providers-antigravity.md) |
| **OpenCode**     | Install [OpenCode](https://opencode.ai) and run `opencode auth login`.                                                   | [OpenCode](./providers-opencode.md)       |
| **Kiro**         | Install [Kiro CLI](https://kiro.dev/docs/cli/) and run `kiro-cli login`.                                                 | [Kiro](./providers-kiro.md)               |
| **Pi**           | Install [Pi](./providers-pi.md) (Node.js 22.19+) and run `pi` → `/login`.                                                | [Pi](./providers-pi.md)                   |
| **Muse Code**    | Install [Muse Code](https://dev.meta.ai/docs/muse-code) and run `muse login`.                                            | [Muse Code](./providers-muse.md)          |
| **fx**           | Install [fx](https://fx.sh) and run `fx login`.                                                                          | [fx](./providers-fx.md)                   |
| **ACP Registry** | Add GitHub Copilot and other agents in **Settings → Providers → Add provider → Show more**.                              | [ACP](./providers-acp.md)                 |

- **Binary path**: If a CLI isn't on the server's `PATH` (common with version managers), set **Binary path** in the provider's settings.
- **Updates**: Click **Update now** on outdated provider cards (supports Homebrew, mise `latest`, npm/pnpm/Yarn/Bun/Volta/Vite+, or the CLI's own updater; update Nix, Chocolatey, or pinned mise installs manually).
- **Multiple instances**: Add extra provider instances for separate accounts, API keys, or custom endpoints (mark secret env vars as sensitive).

### Provider check timeouts

If a working CLI times out during T3 Code's readiness check, increase its probe deadline (in milliseconds) in the server's environment (or systemd override / `service.env`) and restart:

```bash
AOKI_CODEX_PROBE_TIMEOUT_MS=60000 AOKI_CLAUDE_PROBE_TIMEOUT_MS=60000 aoki serve
```

| Provider     | Environment variable                   |
| ------------ | -------------------------------------- |
| Codex        | `AOKI_CODEX_PROBE_TIMEOUT_MS`        |
| Claude       | `AOKI_CLAUDE_PROBE_TIMEOUT_MS`       |
| Cursor       | `AOKI_CURSOR_PROBE_TIMEOUT_MS`       |
| Antigravity  | `AOKI_ANTIGRAVITY_PROBE_TIMEOUT_MS`  |
| Grok         | `AOKI_GROK_PROBE_TIMEOUT_MS`         |
| Kiro         | `AOKI_KIRO_PROBE_TIMEOUT_MS`         |
| fx           | `AOKI_FX_PROBE_TIMEOUT_MS`           |
| Pi           | `AOKI_PI_PROBE_TIMEOUT_MS`           |
| Muse Code    | `AOKI_MUSE_PROBE_TIMEOUT_MS`         |
| OpenCode     | `AOKI_OPENCODE_PROBE_TIMEOUT_MS`     |
| ACP Registry | `AOKI_ACP_REGISTRY_PROBE_TIMEOUT_MS` |

## Next steps

- [User guide index](./README.md): overview of how T3 Code works.
- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): control when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Updating T3 Code](./updating.md): keep apps, servers, and providers up to date.
