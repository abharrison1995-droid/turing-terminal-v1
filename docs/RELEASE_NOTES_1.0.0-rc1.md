# Turing Terminal v1.0.0-rc1

This is a release candidate for physical acceptance testing, not a final 1.0.0 release.

- Windows x64 installer: `Turing-Terminal-Setup-x64-1.0.0-rc1.exe`
- Linux x64 Debian package: `turing-terminal_1.0.0-rc1_amd64.deb`
- Portable Linux x64 package: `Turing-Terminal-x86_64-1.0.0-rc1.AppImage`
- `SHA256SUMS.txt` accompanies the built packages.

The bundled Desktop Master remains the source of truth and continues serving the mobile PWA through Tailscale Serve. QR/manual pairing, device approval, expiry, revocation, API routing, and notifications remain on the existing Master endpoints.

The Windows installer is unsigned. Windows may display Unknown Publisher or a SmartScreen warning. No bypass is included. Git, Tailscale, OpenCode, Codex, Claude Code, and Cline are optional external tools; Turing Terminal detects them but does not install them.

Physical acceptance on Windows/Linux PCs, iPhone pairing and remote-run checks, second-machine isolation, and notification checks remain pending. Claude subscription allowance validation is still **AWAITING PROVIDER ALLOWANCE RESET**; this packaging work does not perform a provider call.
