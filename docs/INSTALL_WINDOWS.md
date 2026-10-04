# Install Turing Terminal on Windows

Turing Terminal 1.0.0-rc2 is a release candidate. Download the Windows x64 installer `Turing-Terminal-Setup-x64-1.0.0-rc2.exe` from the private repository's matching GitHub Actions build artifact.

1. Double-click the installer and follow the prompts. It installs for the current Windows user and adds **Turing Terminal** to the Start Menu.
2. Windows may show **Unknown Publisher** or a SmartScreen warning because this release candidate is unsigned. Check that the file came from the project's GitHub Actions artifact, then choose the Windows option to continue if you trust that source. Do not turn off SmartScreen globally.
3. Launch **Turing Terminal** from the Start Menu. It starts the bundled Desktop Master and opens the app when the local service is ready.
4. In **Settings → Desktop application**, review system readiness. Git, Tailscale, OpenCode, Codex, Claude Code, and Cline are detected when available. Missing optional tools do not block the app and are not installed by Turing Terminal.

The installer bundles Node.js for Turing Terminal itself. You do not need Node, npm, PowerShell, or a source checkout. Windows WebView2 is required; the installer can download its Microsoft bootstrapper if WebView2 is not already available.

## Background behavior

Closing the app window hides it and leaves the Desktop Master running by default. Change **Keep Master running when this window closes** in desktop settings to stop a Master started by the app when the window closes. A Master already running in another process is not stopped from this window.

**Start Turing Terminal when I sign in** is off by default and can be enabled in desktop settings. Startup is registered for the current user only.

## Data and logs

- User data: `%LOCALAPPDATA%\TuringTerminal\data`
- Settings: `%LOCALAPPDATA%\TuringTerminal\config`
- Logs: `%LOCALAPPDATA%\TuringTerminal\logs`

Uninstall from **Settings → Apps → Installed apps**. Ordinary uninstall removes the application but leaves user data and logs in place. Back up important project and workflow data before manually deleting those folders.

For phone access, install and sign in to Tailscale separately, then use the mobile pairing instructions in [MOBILE.md](MOBILE.md). The installer never installs Git, Tailscale, or provider tools.
