# Install Turing Terminal on Linux

Turing Terminal 1.0.0-rc2 is a release candidate. The packaged desktop app targets x86_64 Ubuntu, Debian, and Linux Mint.

## Ubuntu, Debian, or Linux Mint (`.deb`)

1. Download `turing-terminal_1.0.0-rc2_amd64.deb` from the repository's matching GitHub Actions build artifact. Downloading artifacts requires signing in to GitHub.
2. Double-click the downloaded file and install it with the distribution's software installer.
3. Launch **Turing Terminal** from the application menu.
4. In **Settings → Desktop application**, review system readiness. Git, Tailscale, OpenCode, Codex, Claude Code, and Cline are detected when available. Missing optional tools do not block the app and are not installed by Turing Terminal.

The package includes the Node.js runtime and app dependencies needed by the Desktop Master. It declares WebKitGTK 4.1 and GTK 3 as system dependencies so the desktop shell can run.

## Portable AppImage

1. Download `Turing-Terminal-x86_64-1.0.0-rc2.AppImage`.
2. In the file manager, open **Properties → Permissions** and allow the file to run as a program.
3. Double-click the AppImage to launch it.

If your file manager does not provide an executable permission toggle, run `chmod +x Turing-Terminal-x86_64-1.0.0-rc2.AppImage` once, then launch the file. The AppImage bundles the desktop libraries; compatibility still depends on the host glibc baseline and graphics drivers. See [PACKAGING.md](PACKAGING.md) for the build baseline.

## Background behavior and data

Closing the window hides it and leaves the Master running by default. Change **Keep Master running when this window closes** in desktop settings to stop a Master started by this app when its window closes. A Master already running in another process is not stopped from this window.

**Start Turing Terminal when I sign in** is off by default and can be enabled in desktop settings. It creates a per-user startup entry.

- Data: `${XDG_DATA_HOME:-~/.local/share}/turing-terminal/data`
- Settings: `${XDG_CONFIG_HOME:-~/.config}/turing-terminal`
- Logs: `${XDG_STATE_HOME:-~/.local/state}/turing-terminal/logs`

Removing the `.deb` leaves user data intact. The AppImage does not create a system installation; both formats store application data in the same user locations.

For phone access, install and sign in to Tailscale separately, then use the mobile pairing instructions in [MOBILE.md](MOBILE.md). Turing Terminal does not install Git, Tailscale, or provider tools.
