# Release process

The current version is in `package.json` (`1.0.0-rc3` at the time of writing). Keep `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `src/shared/version.ts` aligned when changing it.

## Build and validate

The `Desktop installers` workflow runs on `workflow_dispatch` and on the tags listed under `on.push.tags` in `.github/workflows/desktop-installers.yml` (currently only `v1.0.0-rc3`). Add the new tag there when the version changes. It uses native Linux and Windows runners, installs no provider credentials, and does not contact AI providers. Linux builds `.deb` and AppImage packages and runs local Master health/manifest checks. Windows builds the NSIS installer, performs a quiet install, launches the app, checks health and manifest routes, and uninstalls it.

To prepare the RC tag after those checks pass:

The tag `v1.0.0-rc3` is listed in the workflow configuration only. No RC3 has been cut: the tag does not exist, no desktop-installer run has happened for it, and the version metadata in the repository is preparation rather than a published release.

```sh
git status --short
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm audit --omit=dev
npm run docs:links
git tag v<version>
```

Push a tag only after release approval. The workflow uploads checksummed GitHub Actions artifacts; it does not publish a GitHub Release. The Windows build is unsigned and may show Unknown Publisher or SmartScreen warnings. Add a real certificate and CI signing secret only after a signing process is approved; never store a certificate in the repository.

## Artifacts

Names come from `scripts/release-artifact-names.mjs`:

- `Turing-Terminal-Setup-x64-<version>.exe`
- `turing-terminal_<version>_amd64.deb`
- `Turing-Terminal-x86_64-<version>.AppImage`
- `SHA256SUMS.txt`
- `RELEASE_NOTES.md`

For a local Linux build, use `npm run desktop:build:linux` followed by `npm run desktop:release`. On Windows, use `npm run desktop:build:windows` followed by `npm run desktop:release`. A local collection contains only the formats built on that host; CI combines both platforms.

In CI the combined bundle artifact `Turing-Terminal-<version>` is kept for seven days. The per-platform `turing-terminal-linux-<rc>` and `turing-terminal-windows-<rc>` artifacts are deleted only after the combined bundle uploads successfully; a failed or cancelled build keeps its intermediate artifacts for one day.

## Acceptance status to carry into RC notes

Do not treat CI smoke checks as physical acceptance. Still install the packages on the actual target PCs, verify Tailscale Serve and iPhone pairing, run and recover a phone-controlled job, review notifications and approval flows, and pair the second PC to verify machine isolation. The Claude subscription allowance check remains **AWAITING PROVIDER ALLOWANCE RESET** in [CLAUDE_VALIDATION.md](CLAUDE_VALIDATION.md); packaging does not spend provider allowance or change that state.
