# Live provider validation

Validated **2026-10-01** using temporary local data and a throwaway Git repository. The run used the Turing Desktop Master API on loopback and was removed after recording the result.

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
