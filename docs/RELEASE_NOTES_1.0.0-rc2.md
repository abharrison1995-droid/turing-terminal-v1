# Turing Terminal v1.0.0-rc2

This is a release candidate for physical acceptance testing, not a final 1.0.0 release. It completes the Phase 3.6 provider, billing, decision, context, and usage architecture on top of rc1.

- Windows x64 installer: `Turing-Terminal-Setup-x64-1.0.0-rc2.exe`
- Linux x64 Debian package: `turing-terminal_1.0.0-rc2_amd64.deb`
- Portable Linux x64 package: `Turing-Terminal-x86_64-1.0.0-rc2.AppImage`
- `SHA256SUMS.txt` accompanies the built packages.

## What changed since rc1

- **Provider independence.** Workflows run entirely on OpenCode Go, ClinePass, a ChatGPT subscription, a Claude subscription, or any explicit mix. Only providers a workflow uses are checked.
- **Billing modes.** Subscriptions Only (default), Subscriptions + Decision Budget, or Custom. No API, PAYG, or OpenRouter fallback exists. Provider-side PAYG fallback is reported as unknown for every subscription lane. See [Billing safety](BILLING_SAFETY.md).
- **OpenRouter (optional, metered).** Desktop-only key storage, metered generative stages with Turing-mediated tools, provider price ceilings, and key/account telemetry without generation. See [OpenRouter](OPENROUTER.md).
- **Metered budgets.** Per-run, daily, and monthly hard caps enforced by atomic reservation before each request, reconciled to provider-measured cost.
- **Decision Layer (optional, off by default).** Decision Gate node with Deterministic Rules, Jev via OpenRouter Decisions, and judge engines; separate probability/confidence/score fields; UNCERTAIN escalation; versioned configuration; external-data consent. See [Decision Layer](DECISION_LAYER.md).
- **Model configuration.** Capability-driven reasoning/variant and advanced settings, model refresh with Last Known / Unavailable / Deprecated status, pinned vs floating identity. See [Model configuration](MODEL_CONFIGURATION.md).
- **Usage analytics.** Canonical, reconciled usage events with cached/cache-write/reasoning tokens, actual spend, upstream provider, and decision workload; timezone-correct charts, provider/model/role/project breakdowns, drill-down, and CSV/JSON export. See [Usage accounting](USAGE_ACCOUNTING.md).
- **Database migration 014** runs automatically on first start and keeps existing history.

## Unchanged

The bundled Desktop Master remains the source of truth and continues serving the mobile PWA through Tailscale Serve. The Windows installer is unsigned; Windows may show Unknown Publisher or SmartScreen warnings. Git, Tailscale, OpenCode, Codex, Claude Code, and Cline are optional external tools that Turing detects but does not install.

## Pending

Physical acceptance on Windows/Linux PCs, iPhone pairing and remote-run checks over Tailscale, second-machine isolation, notification checks, and Claude subscription validation after the provider allowance reset. No live OpenRouter or Jev request was made for this release; those paths are covered by deterministic tests with mocked responses.
