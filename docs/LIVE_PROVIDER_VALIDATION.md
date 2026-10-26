# Live provider validation

Evidence is dated per provider below. The original Codex/Claude records are from **2026-10-01**; the current-master OpenCode Go record is from **2026-10-25**. Each uses temporary local data and a throwaway Git repository through the Turing Desktop Master API on loopback. None is a physical-device or full Goal-workflow qualification.

## OpenAI Codex CLI subscription path

- **Machine:** `alex-MS-7C02`, Linux.
- **Backend:** OpenAI Codex CLI 0.155.0-alpha.16.3.
- **Provider/model:** `openai-codex` / `gpt-5.6-luna`, selected from the account-visible model catalog returned by the authenticated local Codex app server.
- **Authentication:** `codex login status` reported ChatGPT sign-in. The child process forced ChatGPT login and removed OpenAI API credential and provider override environment variables. No API-key fallback was configured.
- **Workflow:** Planner → Implementer → Reviewer in Normal mode. Automatic handoff completed without manual copy/paste. The implementer created `broker-smoke.txt` and read it back using only the five Turing MCP broker tools; the reviewer passed with zero findings. The file contained exactly `Turing subscription broker handoff passed.`
- **Turing audit:** Two completed operations: one `file_write` and one `file_read`. Both were project-relative, had `approvalRequired: false` under Normal mode, and exited successfully. The broker accepted both with the active per-run token.
- **Usage:** Codex reported 49,388 input tokens and 562 output tokens across the three stages. This is provider-reported data; Turing did not infer quota, reset time, or cost.
- **API billing:** None. The verified ChatGPT subscription login was used. Turing supplied no OpenAI API key or API endpoint override and has no API fallback in this adapter.

An earlier three-stage attempt exposed a Codex CLI approval interaction: the non-interactive CLI rejected MCP calls before they reached Turing, so no broker operations occurred. Turing now approves the Codex transport call only for its single enabled MCP server; the broker still checks and audits every actual operation using Turing's selected permission mode. The CLI host is read-only, its shell tool is disabled, and no other MCP servers, apps, plugins, web search, or multi-agent tools are available to the run.

## Anthropic Claude Code subscription path

- **Backend/model:** Claude Code using Claude Haiku 4.5 (`claude-haiku-4-5-20251001`).
- **Authentication:** Claude Code reported first-party Claude.ai subscription sign-in.
- **Result:** The smoke run stopped in the Planner before any provider tokens or Turing broker operations. Claude returned HTTP 429 with a weekly subscription limit and a reset time; reported input/output tokens and cost were both zero. Turing did not fall back to API billing.

The Codex path provides the completed live subscription-backed broker validation. The Claude path remains unvalidated beyond authentication discovery and its quota-exhaustion failure.

## Phase 3.6 provider/model configuration status — 2026-10-02

The Phase 3.6 OpenCode Go and ClinePass subscription-only cases are deterministic automated tests, not live account runs. That historical test record did not contain live OpenCode Go/ClinePass billing or catalog validation; the current OpenCode Go result follows below. ClinePass remains live-unvalidated. Turing cannot inspect or disable OpenCode's account-side overflow to Console PAYG; Run Preview reports that provider-side fallback status cannot be verified. See [Phase 3.6 provider, model, and context configuration](history/phase3.6-provider-model-context.md) for the saved route and context guarantees covered by tests.

## OpenCode Go current-master validation — 2026-10-25

- **Code:** merged master `6e5119f7e59220f8a825cefecf9b28b578e8bbb0`; OpenCode CLI `1.19.3`, Node `v22.23.1`, Linux x86_64. Actual provider calls, not fixtures or mocked HTTP.
- **Isolation:** disposable repository and SQLite database under `/tmp/turing-live-20261025-pVPjdR`; Master bound only to `127.0.0.1:45191`. The in-process production `createApp`, `RunEngine` and `executeProvider` paths were used. No live Master database, user project, provider credential or Tailscale configuration was changed. The temporary Master was closed after evidence collection.
- **Route and authentication:** catalogue refresh reported a Go credential entry and exact `opencode-go/beam-free` at zero catalogue price. The successful real requests establish access for this route. All three stage snapshots and usage rows retain backend `opencode`, provider `opencode-go`, model `opencode-go/beam-free`, no variant, and lane `opencode-go-subscription`. `evaluateBillingLane({mode: 'subscriptions-only', lane: 'opencode-go-subscription', workload: 'generative'})` returned allowed and non-metered. No metered lane or alternative model was selected; neither Flash fallback was used.
- **Billing limit:** this confirms Turing's exact subscription route and billing evaluator, not account-side invoice, allowance or overflow policy. Preview retained `Provider-side PAYG fallback status cannot be verified by Turing Terminal.` The catalogue's zero price is not an invoice. No quota error was observed or induced; quota-exhaustion behavior remains unmeasured.
- **Bounds:** Normal permission mode; Planner → Implementer → Reviewer; one minute per stage, five-minute workflow ceiling, no retries, no remediation, one agent. Run `3f428feb-c029-485f-912b-8832387da4ce` started at 20:11:41 UTC and completed at 20:12:08 UTC with all three stages passed and zero recorded review findings.
- **Broker evidence:** completed `file_write` operation `f5aa2733-b678-40ea-889d-dbbc525c4a2d`, implementer `file_read` `51f28d77-df48-458d-8bee-bb578581a752`, and reviewer `file_read` `dadea1a3-36b9-4a06-a6e4-ba829bf6dfaf`. Each used the disposable project root, required no approval in Normal mode, and exited 0. The file `broker-smoke.txt` matched exactly `Turing Go subscription broker handoff passed.` plus one newline (46 bytes).
- **Usage provenance:** adapter token counts and actual cost were unavailable. The shared ledger retained three successful request rows with preflight input estimates 268, 391 and 432, null output/actual cost, and `locally_estimated` reconciliation. These estimates are not provider-reported consumption or a zero-cost claim.
- **Evidence:** local command `node --import tsx /tmp/turing-v1-qualification-20261025/live.mjs`; persistent [sanitized run evidence](qualification/2026-10-25-opencode-go.json) and summary in [qualification evidence](V1_QUALIFICATION_2026-10-25.md). Raw local capture remains `/tmp/turing-v1-qualification-20261025/live-evidence.json` (temporary, not a distributed artifact). An initial harness attempt omitted the required event callback and stopped before provider work; correcting the harness required no product change.

Codex's historical success does not qualify current code. Claude remains post-reset unvalidated, ClinePass remains live-unvalidated, and optional OpenRouter/Jev remain mocked-only. The successful Go run is a bounded ordinary workflow, not Goal authoring, Goal recovery, physical installation or remote-phone acceptance.
