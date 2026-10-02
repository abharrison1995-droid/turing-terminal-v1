# Decision Layer

The Decision Layer is **optional and absent by default**. No shipped workflow contains a Decision Gate, the default engine is none, and adding OpenRouter credentials never adds one.

A **Decision Gate** is a workflow node that sends bounded, structured run state to a Decision Engine with one constrained question, then routes according to an explicit Turing policy. **Engines provide judgement; Turing decides what is permitted.** A gate cannot bypass permissions, provider lock, billing mode, budgets, approvals, workflow bounds, or loop limits.

## Engines

The workflow engine depends only on the `DecisionEngine` interface (`src/server/decisionEngines.ts`), which is batch-shaped (`evaluate(requests[])`, shared `batchId`).

| Engine | External | Billing | Confidence semantics |
| --- | --- | --- | --- |
| Deterministic Rules | No | none | probability 1/0 from a typed rule over build/test/review/final-gate state |
| Jev via OpenRouter Decisions | Yes | `openrouter-metered`, decision workload | engine-reported (see below) |
| Subscription LLM Judge | Yes | the judge route's subscription lane | `confidence` is **self-reported** by the model; no probability |
| OpenRouter generative judge | Yes | `openrouter-metered`, decision workload | self-reported |

## Question types

| Type | Jev type | Result fields |
| --- | --- | --- |
| Boolean / proposition | `noul` | `probability` = engine-reported P(true). No answer is derived and no confidence is invented. |
| Choice (2–255 options) | `choice` | `answer` (option), `distribution` (per-option probabilities), `confidence` |
| Score (2–10 ordered levels) | `score` | `score` (probability-weighted level), `distribution`, `confidence`, `legend` |

## Probability is not confidence

`DecisionResult` keeps `answer`, `probability`, `distribution`, `confidence`, `confidenceKind`, and `score` as separate fields. For Jev, confidence measures how peaked the distribution is — it is **not** the winning option's probability. A routing policy names one field (`probability`, `confidence`, or `score`); if the engine did not report that field, the result is **UNCERTAIN** — Turing never substitutes another field.

## Routing and uncertainty

| Question | Routing |
| --- | --- |
| Boolean + probability | ≥ PASS threshold → PASS; ≤ FAIL threshold → FAIL; between → **UNCERTAIN** |
| Boolean + confidence | confidence ≥ minimum → PASS/FAIL by answer; otherwise UNCERTAIN |
| Choice | below minimum confidence (or the selected option's probability) → UNCERTAIN; otherwise the route configured for that option; an option without a route → UNCERTAIN |
| Score | optional minimum confidence; ≥ PASS / ≤ FAIL score thresholds; between → UNCERTAIN |

Route actions: **Continue**, **Skip later stages** (forward only, validated), **Stop the run (FAIL)**, **Ask a person** (human approval; denial stops the run), and, for UNCERTAIN, **Escalate** to one configured second engine. If the escalation is also uncertain, a person decides. Uncertainty is never forced into a binary outcome.

## Decision state and external data

Each gate selects input categories: task specification, plan artifact, implementation artifact (summary + changed files), diff summary (changed files + bounded excerpt), test result, build result, review findings (counts + up to 25 open findings), final gate result. State is built from structured artifacts and redacted summaries, never full transcripts or raw logs, and compacted to a character budget (default 24,000).

Data sharing is separate from billing. The workflow's **External decision data** policy is:

- **Ask before first external send** (default) — one human approval per project and engine, recorded in `external_data_consents`;
- **Allow** — configured external engines may receive the selected state;
- **Block** — external engines may not receive project state (Preview blocks the run).

## Versioning and history

Each result stores a SHA-256 hash and full snapshot of the engine/model, judge route, schema version, question, criteria, inputs, rule, thresholds, routing policy, escalation, and instructions (`decision_results.config_hash`, `config_snapshot_json`). Local connection-profile IDs are excluded from the hash, so the same configuration on another machine hashes identically. Run detail lists every decision with its fields, route, cost, and hash.

## Usage and analytics

Metered decision calls are canonical usage events with `workload_type = decision`, the decision engine, question type, and outcome, so Jev usage stays analytically separate from generative use. Decision analytics report counts by type and outcome, auto-routed vs escalated decisions, cost, tokens, mean boolean probability, and mean engine-reported confidence per type — never an average across incompatible fields.

## Policy test mode

`POST /api/decision-gates/test` evaluates a gate configuration against fixtures (state, condition values for deterministic rules, expected outcome) and reports accuracy, probability and confidence distributions, escalation rate, errors, and actual cost. External engines require explicit confirmation; metered engines use the normal billing gate and an atomic reservation with the supplied test cap. The Workflow Studio offers a one-click fixture test for Deterministic Rules gates.

## Batch foundation

The engine interface accepts many requests under one batch ID, and usage/decision rows record `batch_id`. Jev's API has no batch endpoint, so batch items run with bounded concurrency (3). There is no batch UI in V1.
