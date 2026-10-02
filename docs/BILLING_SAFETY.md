# Billing safety

Turing Terminal is built so that accidental spending is difficult. This page describes what Turing enforces itself, what it cannot verify, and the defaults.

## Defaults

| Setting                                                                      | Default                                                                           |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Billing mode                                                                 | **Subscriptions Only**                                                            |
| Provider lock                                                                | **On**                                                                            |
| Decision Layer                                                               | Absent — no workflow contains a Decision Gate unless you add one                  |
| OpenRouter                                                                   | Unused until a stage or Decision Gate explicitly selects an OpenRouter connection |
| Per-run metered cap                                                          | None set (metered work is blocked anyway in Subscriptions Only)                   |
| Unknown-cost requests                                                        | **Block**                                                                         |
| External decision data                                                       | **Ask before first external send**                                                |
| OpenAI API / Anthropic API / Cline usage-billing / OpenCode metered fallback | Off — Turing has no automatic fallback path at all                                |

## Billing lanes

Every AI stage resolves to exactly one billing lane. Lanes are distinct even when the same model is reachable through several of them.

- Subscription lanes: `opencode-go-subscription`, `clinepass-subscription`, `chatgpt-subscription`, `claude-subscription`.
- Metered lanes: `openrouter-metered`, `opencode-metered` (OpenCode Console balance), `cline-usage-billing`, `openai-api`, `anthropic-api`.

A route can only execute through the lane its provider bills through (`routeMatchesBillingLane` in `src/shared/billing.ts`). `cline` + `cline-pass` can never be labelled `cline-usage-billing`; `opencode` + a non-Go provider can never be labelled `opencode-go-subscription`. Connection profiles are rejected if their route and lane disagree.

## Billing modes

The run-level mode is evaluated by one function (`evaluateBillingLane`) used by Run Preview, the run engine, the OpenRouter adapter, and the Decision Layer.

| Mode                                | Subscription lanes | Metered generative stages                                                | Metered Decision Gates                                        |
| ----------------------------------- | ------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------- |
| **Subscriptions Only**              | allowed            | blocked                                                                  | blocked                                                       |
| **Subscriptions + Decision Budget** | allowed            | blocked                                                                  | OpenRouter decision calls allowed, **requires a per-run cap** |
| **Custom**                          | allowed            | explicitly configured lanes (optionally limited to `customAllowedLanes`) | same                                                          |

An unknown lane is blocked in every mode. The legacy `subscriptionOnly` flag still works: `false` maps to Custom; `true` never widens a stricter saved mode.

## Provider lock and no silent substitution

Turing has no code path that switches backend, provider, lane, model, variant, or reasoning value after a failure. A failed subscription route stays failed. Retries (for transient errors only) reuse the identical route. Budget or billing refusals are never retried.

## Metered budgets and atomic reservation

Before every metered request Turing reserves a conservative amount:

1. Estimate input tokens pessimistically (~3 characters per token, +10%), multiply by the highest catalog prompt price (including conditional pricing overrides), add the bounded output (`max_tokens`) times the highest completion price, plus any per-request price.
2. Inside one `BEGIN IMMEDIATE` SQLite transaction, sum active reservations plus reconciled actual spend for the run, the local day, and the local month, and refuse the request if the new reservation would exceed any hard cap.
3. Send the request with OpenRouter `provider.max_price` set to the same per-token ceilings, so OpenRouter refuses to route to a more expensive upstream.
4. When the response reports `usage.cost`, reconcile the reservation to that **provider-measured actual cost**, releasing unused headroom. If a request fails without a reported charge, release the reservation. If no cost is reported for a successful request, the full reservation stays committed (conservative).

Because the check and the insert share one immediate transaction, parallel requests cannot all pass against the same remaining budget (covered by the concurrency tests in `src/server/metering.test.ts` and the parallel-review acceptance test). Parallel reviewer siblings are allowed to settle before a stage fails, so their spend is reconciled before the run ends.

Caps:

- **Per-run cap** — set per workflow (Safety → Per-run metered cap). Required in Subscriptions + Decision Budget.
- **Daily / monthly caps** — Settings → Turing metered budgets, with a warning threshold (default 80%) and a configurable day-boundary timezone.

These are Turing-side caps, separate from any OpenRouter key limit. Turing never changes provider-side key limits.

### Unknown-cost requests

If a request cannot be bounded (no catalog price, or no bounded output), the workflow's unknown-cost policy applies: **Block** (default), **Ask** (a human approval is created; approving sends the request), or **Allow with warning**. An allowed unbounded request is recorded as `cost_bound = unbounded` and a warning states that Turing **cannot guarantee the hard cap** for it. Turing never claims a hard cap for such a request.

### Residual risk

The input estimate is conservative but is not a tokenizer. A pathological prompt (for example, dense non-Latin text) could tokenise above the estimate; the actual provider cost then exceeds the reservation and Turing records a `metered_reservation_overrun` run event. Output is bounded exactly by `max_tokens`, and price is bounded by `max_price`.

## Provider-side PAYG fallback

Turing's fallback policy and the provider's account settings are different things.

| Lane                 | Provider-side behaviour                                                                                                             | What Turing shows                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| OpenCode Go          | The OpenCode console "Use balance" option can continue on Console balance after the Go limits. No supported read-only check exists. | **Unknown** — "Provider-side PAYG fallback status cannot be verified by Turing Terminal." |
| ClinePass            | Overflow behaviour is not documented. Turing never switches ClinePass to Cline usage-billing.                                       | **Unknown**                                                                               |
| ChatGPT subscription | Purchased credits are governed by the OpenAI account.                                                                               | **Unknown**                                                                               |
| Claude subscription  | Extra-usage settings are governed by the Anthropic account.                                                                         | **Unknown**                                                                               |

Turing never displays "PAYG disabled" because it cannot establish it.

## Connection health without spending

Health and connection checks use CLI version/auth status, model discovery, OpenRouter's public model catalog, and OpenRouter's `/api/v1/key` metadata endpoint. None of them sends a generation request.
