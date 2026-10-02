# Model configuration

## Identity model

Each AI stage resolves eight separate things; none is inferred from another:

1. **Execution backend** — `opencode`, `cline`, `codex-cli`, `claude-code`, or `openrouter`.
2. **Connection profile** — a reusable, credential-free reference such as "OpenCode Go — Alex".
3. **Billing lane** — e.g. `opencode-go-subscription` (see [Billing safety](BILLING_SAFETY.md)).
4. **Provider** — e.g. `opencode-go`, `cline-pass`, `openai-codex`, `anthropic-subscription`, `openrouter`.
5. **Exact model ID** — provider-native, never a category.
6. **Variant / reasoning** — provider-native value.
7. **Context policy** — see [Context management](CONTEXT_MANAGEMENT.md).
8. **Advanced settings** — only those the selected model reports.

A backend and its billing source are not synonymous: OpenCode can run OpenCode Go (subscription) or a Console-billed provider (metered); Cline can run ClinePass or Cline usage-billing.

## Inheritance

Workflow defaults → defaults for the stage kind → the node itself. A selected connection profile is authoritative for backend, provider, and lane. Changing a node's route clears an inherited profile unless the node selects another. Run Preview always shows the final resolved configuration.

## Capability metadata

`ModelOption` carries `reasoningControl` (`effort`, `variant`, `budget`, `provider-controlled`, `none`), provider-native `reasoningLevels` / `variantIds`, reasoning budget range, temperature and max-output support and ranges, tools, images, structured output, context length, pricing (metered providers), identity (pinned/floating), status, and deprecation date. `ProviderCapabilities` adds metered billing, provider-side fallback visibility, and decision support.

| Backend | Discovery | Reasoning control |
| --- | --- | --- |
| Codex CLI | live (`model/list`) | provider-native efforts the model reports |
| OpenCode | live (`opencode models --verbose`) | provider-native variants, sent as `provider/model#variant` |
| OpenRouter | live public catalog | `reasoning.effort` values and `reasoning.max_tokens` when `reasoning` is a supported parameter; temperature and max output when supported |
| Claude Code | none (exact model/alias entered) | provider controlled |
| Cline | none (exact model entered) | provider controlled |

The Workflow Studio shows a reasoning selector only for `effort`, a variant selector only for `variant`, "Provider controlled" when the backend reports no control, and nothing for `none`. **Advanced Model Settings** lists only supported settings. Changing the backend clears model settings; changing the model prunes any setting the new model does not support (`pruneModelSettings`). The run engine re-validates with the same rules (`validateModelSettings`) and refuses unsupported values rather than sending them.

## Discovery, cache, and status

**Refresh models** (Workflow Studio) re-runs discovery without restarting. Successful catalogs are persisted in `model_catalog_cache`. If a later discovery returns nothing, cached entries are shown as **Last Known** — never as current.

| Status | Meaning |
| --- | --- |
| Current | present in a live catalog |
| Last Known | from cache, or the backend has no discovery |
| Unavailable | absent from a live, complete catalog |
| Deprecated | the provider reports a deprecation/expiration date |

Turing never replaces an unavailable or deprecated model. The editor says **Choose replacement**; the user picks one.

## Pinned vs floating

Aliases such as `~typesafe/jev-latest`, `…-latest`, `openrouter/auto`, and Claude Code aliases (`opus`, `sonnet`, …) are **floating / routed**. They are allowed; Preview warns that reruns may not be identical, and history records both the configured alias and the resolved model reported by telemetry.

## Snapshots and history

At Start each AI stage snapshots backend, connection name, provider, lane, exact model ID, display name, variant, reasoning, capability metadata (including pricing for metered models), discovery time, adapter version, catalog status, identity, and reasoning control. Later catalog changes do not rewrite history. **Run Again With Same Configuration** revalidates the snapshot against current providers; **Duplicate and Edit** copies it for repair.

## Presets

Model presets store backend, connection reference, provider, lane, model, variant, reasoning, and safe native settings — never credentials. Applying a preset fills the stage, which can then be edited.

## Exports

Workflow exports keep provider names, model IDs, variants, context settings, Decision Gate questions and thresholds, budgets, retry and timeout settings. Local connection-profile IDs are replaced by symbolic `backend:provider:lane` references (including those inside Decision Gates and judge routes) and remapped on import. Credential-like keys and values are removed.
