# Provider setup and limits

Turing launches the provider's installed command line program. Sign in through that provider's own supported flow first. The stage editor requires an explicit backend, provider identifier, and model identifier; it does not choose a fallback model. Install and update provider tools using their official instructions.

## OpenCode

Install OpenCode, then use `opencode auth` to connect the provider. Turing reads `opencode models` and uses the selected model with `opencode run --format json`. The discovered model list is refreshed once per minute. An empty list means the backend is detected but the model catalog could not be read; check `opencode models` in a terminal.

OpenCode documents ChatGPT Plus as a supported OAuth provider. OpenCode Go is a separate OpenCode subscription and gives OpenCode its own credential; it is not an OpenAI API key. OpenCode's provider documentation says Claude Pro/Max credentials may not be used through the Anthropic plugin. Turing does not route Claude subscription credentials through OpenCode.

## OpenAI Codex CLI

Install Codex CLI and sign in with ChatGPT using `codex login`. Select `OpenAI Codex CLI`; Turing checks `codex login status`, then reads visible models from the authenticated local app server. The provider field is fixed to `openai-codex`. Turing forces ChatGPT login, clears OpenAI API-key/provider overrides from the child environment, disables Codex shell, apps, plugins, web search, and other MCP servers, and supplies only the per-run Turing broker. Codex approves that sole MCP transport call so Turing can evaluate it; the Turing broker makes and records the actual permission decision. Turing does not query remaining ChatGPT allowance or reset time.

This adapter requires Codex CLI 0.155 or later for its broker configuration. `codex exec --json` is parsed for response text and token events; Turing validates structured review output after receipt rather than asking Codex for schema-constrained output.

## Claude Code

Install Claude Code and authenticate through its official CLI flow. Select `Claude Code`, set provider to `anthropic-subscription`, then enter the exact model alias accepted by the installed CLI. Turing does not discover the full Claude model catalog or query plan allowance. It removes sensitive credential-shaped environment variables and Anthropic base URLs from child processes; authenticate in Claude Code's own CLI credential store.

The adapter uses `claude -p` with streaming JSON output, `--restricted`, no built-in tools, and the strict Turing MCP configuration. Each exposed read/write/delete/build/test request goes through the per-run broker and Turing permission engine. Supervised pauses before routine broker operations; Normal permits routine project operations and gates consequential commands. Tool mediation requires Claude Code 2.1.248 or later.

## Cline

Install the official Cline CLI and sign in through its documented provider or OAuth flow. Enter the provider and model IDs that Cline accepts, such as `openai-codex`. Turing does not infer a Cline model catalog or verify an account's subscription tier.

The current adapter launches Cline in JSON mode with automatic approval disabled and bridges its documented file-based approval IPC to Turing's permission engine. Each request is authorized by the Turing broker policy before a decision file is written. Cline does not return per-tool stdout/stderr through that approval interface, so the audit record cannot claim a specific tool result. ClinePass availability and remaining allowance belong to Cline's own dashboard; Turing does not query them.

## Capability and billing boundaries

Provider detection means only that the CLI can be launched and returns a version. `authentication: unknown` means Turing cannot confirm the active account. A locally observed run duration is not provider usage. Token counts appear only when the provider emits them in a parseable event; quota, reset time, and cost remain unavailable when no documented source supplies them.

Provider support changes over time. The [capability matrix](PROVIDER_CAPABILITY_MATRIX.md) lists the official documentation reviewed for this release. Check those sources again when updating a CLI adapter. Turing does not scrape subscription websites or reuse credentials from provider-owned stores.

## Official sources

- [Codex CLI authentication](https://learn.chatgpt.com/docs/auth)
- [Codex CLI developer commands](https://learn.chatgpt.com/docs/developer-commands)
- [Codex CLI configuration](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Codex local app server](https://learn.chatgpt.com/docs/app-server)
- [OpenCode providers](https://opencode.ai/docs/providers/)
- [OpenCode CLI commands](https://opencode.ai/v2/docs/cli/commands/)
- [Claude Code CLI usage](https://code.claude.com/docs/en/cli-usage)
- [Cline CLI](https://github.com/cline/cline/blob/main/apps/cli/README.md)
- [ClinePass](https://github.com/cline/cline/blob/main/docs/getting-started/clinepass.mdx)
