# Usage accounting

## Canonical usage events

One external inference or decision call is exactly **one** row in `usage_events`. CLI backends produce one event per invocation (per attempt); OpenRouter produces one per HTTP request (each agent turn, each Jev call); local build/test processes produce `deterministic` events with duration only.

The row is created **before** the call (`pending`, with any local estimate) and updated in place as telemetry arrives:

`PENDING → LOCALLY ESTIMATED → PROVIDER RECONCILED` (or `final` when only local measurement exists).

Later, more accurate telemetry never adds a second billable row. If Turing estimated 10,000 input tokens and the provider reports 9,714, headline totals use 9,714; the estimate stays in `estimated_input_tokens` and in the `observations_json` audit trail.

### Provenance precedence

1. **PROVIDER MEASURED**
2. **LOCALLY MEASURED**
3. **USER CONFIGURED**
4. **ESTIMATED**
5. **UNAVAILABLE**

An observation replaces headline values only if it is at least as authoritative as the current one. Token provenance and cost provenance are tracked separately.

### Recorded dimensions (where available)

Event, Turing request and provider request IDs; timestamp (UTC); machine, project, workflow, run, stage, role; workload (`generative`, `decision`, `deterministic`); backend, connection profile, billing lane, provider, upstream provider; configured and resolved model, display name, variant, reasoning, context strategy; decision engine, type, outcome, batch ID; input, cached input, cache-write, reasoning, output, and total tokens; request count; duration and latency; status and finish reason; **actual metered cost** and its provenance; the original estimate. Dimensions a provider does not report stay null.

## Actual spend vs estimated value

- **Actual metered spend** — provider-reported charge (OpenRouter `usage.cost`). Only metered lanes can have it; subscription calls are not counted as "missing" spend.
- **Estimated API-equivalent value** — **ESTIMATED**, never spend. Computed only for provider- or locally-measured tokens with an exact provider/model match in `src/server/pricing.ts` (rates with effective dates and sources live only there). Cached input uses the public cached rate when cached tokens are measured. Unmatched models show **Unavailable**, never a guessed price.

## Analytics

`src/server/usageAnalytics.ts` is the single query layer. Headline cards, the daily/hourly token chart, provider-lane, model, role, project, workflow, machine, workload, and reasoning breakdowns, model drill-down, decision analytics, and CSV/JSON exports all derive from one filtered event list, and tests assert that their totals reconcile.

- **Filters:** date range (Today, Yesterday, 7 days, 30 days, this month, custom dates, or a configured quota envelope's billing period via `range=period&quotaId=…`), timezone, billing lane, provider, connection, model, project, workflow, role, machine, workload, reasoning/variant, run.
- **Timezones:** events are stored in UTC and bucketed by local day/hour in the selected display timezone (default: the system timezone). Today means local midnight to local midnight, DST-correct.
- **Unavailable is not zero:** each metric reports `value`, how many calls reported it, and how many did not. A metric no call reported is **Unavailable**. An empty day is genuinely zero.
- **Lanes stay distinct:** the same model through OpenCode Go, ClinePass, and OpenRouter appears as three rows.
- **Chart:** stacked bars split input into uncached and cached portions plus output, so the stack equals input + output. A legend and a table view accompany it.
- **Decision analytics** are kept separate (see [Decision Layer](DECISION_LAYER.md)).

## Export

`GET /api/usage/export?format=csv|json` with the same filters as the view. Columns cover timestamps (UTC and local), machine, project, workflow, run, stage, role, workload, lane, connection, backend, provider, upstream provider, model, resolved model, variant, reasoning, context strategy, decision fields, every token dimension, request count, status, provenance, reconciliation state, actual cost, estimated value, and the original estimate. Exports contain no prompts, outputs, or credentials; CSV cells that look like spreadsheet formulas are neutralised.

## Retention

Detailed usage is kept until you delete it. 7/30-day views never discard data; the schema keeps per-event rows so later aggregation or cleanup can be added.

## Quotas and forecasts

Quota envelopes remain optional and **USER CONFIGURED** (allowance, unit, effective date, reset, notes). Forecasts use the envelope plus measured burn and are omitted when data is insufficient; a token forecast is unavailable while any sample in the window lacks token telemetry. Threshold notifications fire once at 80%.

## OpenRouter key and account telemetry

Key-level (`/api/v1/key`) and account-level (`/api/v1/credits`, management key) values are **PROVIDER MEASURED** and shown separately from Turing-recorded events and Turing budgets. See [OpenRouter](OPENROUTER.md).
