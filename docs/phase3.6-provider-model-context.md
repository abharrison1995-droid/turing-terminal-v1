# Phase 3.6 Provider, Model, and Context Configuration

> This page records the first Phase 3.6 pass. The completed architecture — billing modes, OpenRouter, the Decision Layer, metered budget reservation, and canonical usage analytics — is documented in [Billing safety](BILLING_SAFETY.md), [OpenRouter](OPENROUTER.md), [Decision Layer](DECISION_LAYER.md), [Model configuration](MODEL_CONFIGURATION.md), [Context management](CONTEXT_MANAGEMENT.md), and [Usage accounting](USAGE_ACCOUNTING.md). Where this page says "Subscription Only", read "Subscriptions Only billing mode".

## Configuration identity

An AI stage preserves the execution backend, optional connection profile, provider/billing lane, exact model ID, provider-native variant, native settings, and discovery snapshot as separate fields. At the OpenCode adapter boundary, a selected variant is serialized into the provider-native `provider/model#variant` selector; it is not renamed or translated. The Run Preview and run history keep the base model and exact variant separately.

Configuration resolves in this order:

1. Workflow model defaults.
2. Defaults for the stage kind.
3. Values set on the individual workflow node.
4. If a connection profile is selected, its backend, provider, and billing lane are authoritative for the connection. A node-level route override clears an inherited profile unless that node explicitly selects another profile.

Profiles and presets contain labels, provider/model configuration, and symbolic references only. They do not contain API keys, OAuth tokens, cookies, subscription tokens, or other secret material. Provider authentication continues through the installed official CLI or a separately supported desktop credential store. Workflow export removes local profile IDs from workflow defaults, stage defaults, and nodes, and emits symbolic backend/provider/lane references; import remaps them to matching local profiles when available.

## Instruction precedence

Instructions are combined deterministically in this order, highest priority first:

1. Turing security rules, execution broker permissions, and approval gates. These are enforced outside the model and cannot be overridden by prompt text.
2. Mandatory Global Rules and mandatory Project Rules, in the saved effective-rule order.
3. Turing's built-in role instructions (planner, implementer, reviewer, orchestrator, and other configured AI roles).
4. Advisory Global Rules and Project Rules.
5. Workflow instructions.
6. Stage-specific custom instructions.
7. The task and structured handoff artifacts provide the work request and evidence; they cannot change the configured route or permission policy.

The provider receives an explicit precedence statement. A prompt cannot authorize a broker operation that the workflow's permission mode denies or requires approval for.

## Billing and provider lock

Subscription Only and Lock Providers default to ON in each workflow and can be reviewed per run. Turing blocks API and metered billing lanes when Subscription Only is active. Stages keep their selected backend/provider/model on retries; Turing has no automatic provider or model substitution path. A failed stage stops or pauses under the normal workflow failure policy.

ClinePass and Cline usage billing have distinct lane IDs. The Cline adapter receives the selected provider ID exactly; it does not retry on another provider. OpenCode Go and OpenCode metered/Console routes are separate lanes. Turing cannot inspect or disable OpenCode account-side overflow billing through a supported mechanism, so Run Preview states: “Provider-side PAYG fallback status cannot be verified by Turing Terminal.” Turing never claims that provider-side PAYG is disabled.

Connection health checks use CLI authentication status and model discovery where available. They do not send a generation prompt.

## Catalog and history snapshots

At Start, every AI stage snapshots its exact model ID, display name, provider, selected variant, reported capabilities, discovery time, adapter version, and catalog status. A reliable current catalog match is `current`; a configured model absent from a complete catalog is `unavailable`; providers without model discovery retain a `last-known` state. The adapter does not infer deprecation from a missing model. No automatic model migration occurs.

Run Again With Same Configuration uses the historical workflow snapshot and checks it against current provider/model discovery before creating a new run. If that configuration cannot be validated, replay stops and shows the failing assignments. Duplicate and Edit creates a workflow copy from the historical snapshot for user repair.

## Context budgets and handoffs

The default is Focused context, 32,000 estimated input tokens, at most 24 files, and at most 80 KB per file. Each stage may override the strategy and limits. The available strategies are Focused, Changed Files, Artifacts Only, and Full Project / Broad. Include/exclude globs and diff/build/test/artifact switches are saved with the workflow. Diff inclusion defaults on for reviewer, consolidation, and final-gate stages, and off for other AI roles; each stage can change that.

Stage tools enforce file count, per-file bytes, and estimated token limits across tool results as well as the prepared prompt. Changed Files limits reads to paths changed in the working tree plus explicit include globs. Artifacts Only blocks repository browsing unless include globs identify files. File reads are cached, and each result returned to the provider counts against the stage budget. The estimate is an estimate of prepared Turing context, not an exact provider token count; provider-internal system tokens may not be visible to Turing.

When a prepared prompt exceeds its limit, the default policy compacts optional artifacts, diffs, and build/test summaries. Mandatory task, rule, security, and role instructions remain intact. If they alone exceed the limit, the stage stops before provider execution. Ask and Stop policies block Start when the preview estimate already exceeds the limit; later broker reads are denied before they could exceed the budget.

Previous stages hand off bounded artifacts such as `PlanArtifact`, `ImplementationResult`, `ReviewFinding[]`, and test/build summaries. Successful build/test output stored for handoff is reduced to a concise summary. Prior AI-stage responses can be included by explicit per-stage opt-in; provider-internal tool conversations are not stored by Turing. Broad repository access is explicit and still subject to the broker and configured context limits.

## Orchestrator

An Orchestrator is an optional AI stage in the saved workflow graph. It can interpret plans and structured handoffs, but Turing's deterministic workflow engine remains the state machine. The orchestrator uses the configured model, context policy, and provider lock; its broker role is read-only. It cannot create agents or stages, reroute a provider/model, change limits, bypass approvals, or call tools outside Turing's execution broker.

## Deterministic acceptance coverage and live limits

The application tests include a subscription-only OpenCode Go workflow that runs stages on the exact same base model with different native variants (`high` and `max`), then checks adapter arguments, historical snapshots, Preview, and per-stage usage attribution. A separate ClinePass-only case checks exact route preservation and usage attribution, and confirms that Cline usage billing is blocked in Subscription Only and runs only when that lane is explicitly configured with Subscription Only off. Tests also cover default/stage/node inheritance, strict-mode route blocking, context-limit enforcement, profile metadata without secrets, and history replay validation.

These are deterministic adapter and workflow tests. They do not establish a live OpenCode Go or ClinePass account's authentication, allowance, or billing behavior. Provider account dashboards remain authoritative, and OpenCode's account-side PAYG fallback remains unverifiable by Turing. See [Live provider validation](LIVE_PROVIDER_VALIDATION.md) for the recorded Codex and Claude checks and their limits.
