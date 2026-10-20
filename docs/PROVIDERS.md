# Provider setup and limits

Turing launches the provider's installed command line program (OpenCode, Cline, Codex CLI, Claude Code) or, for the optional metered OpenRouter connection, calls OpenRouter's HTTP API with a key stored on the desktop. Sign in through that provider's own supported flow first. Each stage resolves an execution backend, optional connection profile, provider/billing lane, and exact model configuration through workflow defaults, stage-kind defaults, and node overrides. Turing does not choose fallback models. Connection profiles and presets store references/configuration, not provider credentials. Install and update provider tools using their official instructions.

## Providers & connections (Settings)

Connections are created in one place: **Settings → Providers & connections**. Workflow screens only _select_ a saved connection and link back here; they have no separate creation form. A connection is a reusable reference to a route (backend, provider, billing lane) plus a label you type. Saving one does not sign in, does not switch the account a CLI is signed in to, and stores no credentials.

The guided flow has five steps: choose a service, check the installation, complete the provider's official authentication on the Desktop Master computer, check the connection, then save it. Turing displays the official commands for the installation and authentication steps; it never runs them, never installs software, never starts an OAuth flow of its own and never reads provider-owned credential stores. **Check again** re-runs the existing read-only status checks after you have done the step yourself. Authentication and credentials always stay on Desktop Master, including when the interface is open from a phone.

| Service                      | Backend       | Provider                 | Billing lane               |
| ---------------------------- | ------------- | ------------------------ | -------------------------- |
| OpenCode Go                  | `opencode`    | `opencode-go`            | `opencode-go-subscription` |
| Codex — ChatGPT subscription | `codex-cli`   | `openai-codex`           | `chatgpt-subscription`     |
| Claude Pro / Max             | `claude-code` | `anthropic-subscription` | `claude-subscription`      |
| ClinePass                    | `cline`       | `cline-pass`             | `clinepass-subscription`   |

The plan name (for example ChatGPT Pro or Claude Pro) is a label you provide. Turing cannot verify the plan, so it never says it did. Custom routes (other backend, provider or lane combinations) are under **Advanced**.

Setup shows four readings separately: **Installation** (a CLI was found and reported a version), **Authentication** (sign-in status where the provider documents a way to read it), **Model catalog** (whether exact models could be listed) and **Last check**. Each can be _Unknown_, and Unknown is preserved rather than rounded to ready. A detected CLI does not mean the subscription, or any particular model, is usable. Cline authentication is always Unknown and has no catalog; OpenCode's `auth list` shows only that some credential exists.

## OpenCode

Install OpenCode, then use `opencode auth` to connect the provider. Turing reads `opencode models --verbose` for exact model IDs, reported variants, capabilities, and other safe catalog metadata. It starts a run with the provider-native `provider/model#variant` selector when a variant is selected; history separately retains the base model ID and exact variant. The discovered model list is refreshed once per minute. An empty list means the backend is detected but the model catalog could not be read; check `opencode models --verbose` in a terminal.

OpenCode documents ChatGPT Plus as a supported OAuth provider. OpenCode Go is a separate OpenCode subscription and gives OpenCode its own credential; it is not an OpenAI API key. Turing distinguishes the OpenCode Go subscription lane from OpenCode metered/Console billing. Subscription Only blocks Turing-selected metered routes. OpenCode may also support account-side overflow from subscription limits into a Console balance; Turing cannot inspect or disable that setting, and Preview explicitly reports its status as unverifiable. OpenCode's provider documentation says Claude Pro/Max credentials may not be used through the Anthropic plugin. Turing does not route Claude subscription credentials through OpenCode.

## OpenAI Codex CLI

Install Codex CLI and sign in with ChatGPT using `codex login`. Select `OpenAI Codex CLI`; Turing checks `codex login status`, then reads visible models from the authenticated local app server. The provider field is fixed to `openai-codex`. Turing forces ChatGPT login, clears OpenAI API-key/provider overrides from the child environment, disables Codex shell, apps, plugins, web search, and other MCP servers, and supplies only the per-run Turing broker. Codex approves that sole MCP transport call so Turing can evaluate it; the Turing broker makes and records the actual permission decision. Turing does not query remaining ChatGPT allowance or reset time.

This adapter requires Codex CLI 0.155 or later for its broker configuration. `codex exec --json` is parsed for response text and token events; Turing validates structured review output after receipt rather than asking Codex for schema-constrained output.

## Claude Code

Install Claude Code and authenticate through its official CLI flow. Select `Claude Code`, set provider to `anthropic-subscription`, then enter the exact model alias accepted by the installed CLI. Turing does not discover the full Claude model catalog or query plan allowance. It removes sensitive credential-shaped environment variables and Anthropic base URLs from child processes; authenticate in Claude Code's own CLI credential store.

The adapter uses `claude -p` with streaming JSON output, `--restricted`, no built-in tools, and the strict Turing MCP configuration. Each exposed read/write/delete/build/test request goes through the per-run broker and Turing permission engine. Supervised pauses before routine broker operations; Normal permits routine project operations and gates consequential commands. Tool mediation requires Claude Code 2.1.248 or later.

## Cline

Install the official Cline CLI and sign in through its documented provider or OAuth flow. Use provider ID `cline-pass` for ClinePass and provider ID `cline` for Cline usage billing. Enter the exact model ID accepted by that provider. These routes are separate; failure or exhaustion of ClinePass does not select the usage-billing lane. Subscription Only blocks Cline usage billing, while a deliberate non-subscription workflow can select it. Turing does not infer a Cline model catalog or verify an account's subscription tier.

The current adapter launches Cline in JSON mode with automatic approval disabled and bridges its documented file-based approval IPC to Turing's permission engine. Each request is authorized by the Turing broker policy before a decision file is written. Cline does not return per-tool stdout/stderr through that approval interface, so the audit record cannot claim a specific tool result. ClinePass availability and remaining allowance belong to Cline's own dashboard; Turing does not query them.

## OpenRouter (optional, metered)

Add a connection and inference key in Settings → OpenRouter. Nothing uses it until a stage or Decision Gate explicitly selects that connection and the run's billing mode permits `openrouter-metered`. Generative OpenRouter stages require Custom billing mode; Jev Decision Gates are allowed in Subscriptions + Decision Budget. Every request is metered with an atomic budget reservation and a provider `max_price` ceiling. See [OpenRouter](OPENROUTER.md), [Decision Layer](DECISION_LAYER.md), and [Billing safety](BILLING_SAFETY.md).

## Provider-independent workflows

No provider has privileged status. A workflow may run entirely on OpenCode Go, entirely on ClinePass, entirely on a ChatGPT subscription, entirely on a Claude subscription, or any explicit mix. Preview checks only the providers a workflow actually uses, so a disconnected Claude Code does not block an all-OpenCode-Go workflow. Deterministic acceptance tests cover the all-OpenCode-Go, all-ClinePass, mixed, and Subscriptions + Jev cases.

## Capability and billing boundaries

Provider detection means only that the CLI can be launched and returns a version. `authentication: unknown` means Turing cannot confirm the active account. A locally observed run duration is not provider usage. Token counts appear only when the provider emits them in a parseable event; quota, reset time, and cost remain unavailable when no documented source supplies them.

Provider support changes over time. The [capability matrix](PROVIDER_CAPABILITY_MATRIX.md) lists the official documentation reviewed for this release. Check those sources again when updating a CLI adapter. Turing does not scrape subscription websites or reuse credentials from provider-owned stores.

Connection checks use authentication status, CLI status, and model discovery where those mechanisms are available. They do not send a generation prompt. Run Preview shows each stage's exact route and groups stages under the selected billing lane. Subscription Only blocks Turing-managed OpenAI/Anthropic API routes, Cline usage billing, OpenCode metered routes, and other configured PAYG routes. It cannot guarantee the provider will not bill through an account-side fallback that Turing cannot inspect; Preview reports provider-side fallback as **unknown** for every subscription lane (OpenCode Go, ClinePass, ChatGPT, Claude). See [Phase 3.6 provider, model, and context configuration](history/phase3.6-provider-model-context.md) for route rules, context defaults, snapshots, and run-history behavior.

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
- [OpenCode Go limits and Console balance](https://opencode.ai/docs/go/)
- [OpenRouter API keys](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key), [management keys](https://openrouter.ai/docs/guides/overview/auth/management-api-keys), [usage accounting](https://openrouter.ai/docs/guides/administration/usage-accounting), [provider routing / max_price](https://openrouter.ai/docs/guides/routing/provider-selection), [models](https://openrouter.ai/docs/guides/overview/models), [reasoning](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
- [Jev on OpenRouter](https://openrouter.ai/docs/guides/community/jev), [Jev tutorial](https://openrouter.ai/docs/guides/community/jev-tutorial)
