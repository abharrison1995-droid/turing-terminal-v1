# Usage accounting

Turing reports activity it can observe locally. It records one usage event for each provider invocation and each configured build/test process, with stage, backend, provider, billing lane, exact model/variant, project, run, duration, and token counts when the provider returns parseable usage data. These route fields provide Turing usage attribution; they are not provider invoices or proof that an account incurred no charge.

## What the numbers mean

- **Events** count local provider or build/test process invocations, not provider billable requests.
- **Stage and billing-lane attribution** identify the saved route used by each Turing stage. ClinePass and Cline usage billing remain distinct; OpenCode Go and its metered/Console route remain distinct. Subscription Only blocks Turing-managed metered routes, but cannot override billing behavior internal to a provider account.
- **Duration** is elapsed time for each process. Parallel process durations are summed, so process minutes can exceed wall-clock minutes.
- **Tokens** are shown only when emitted by the provider CLI in a recognized structured result. Missing values mean unavailable, not zero.
- **Quota envelope** is optional and marked **USER CONFIGURED**. The user enters the allowance, unit, effective date, reset, and notes; these values are not provider telemetry.
- **Observed consumption** is **PROVIDER MEASURED** when the CLI reports token counts and **LOCALLY MEASURED** for request count and process duration. A token forecast is unavailable if any sample in the selected window lacks the required token count.
- **Remaining allowance and exhaustion date** are estimates from the manual envelope and this master's recorded use. The UI shows sample count, confidence, and provenance. A projected date is omitted when there is no burn rate or enough information.
- **API-equivalent value** is marked **ESTIMATED**, not actual spend. It is computed only for an exact provider/model match in `src/server/pricing.ts` and complete input/output token counts. Cached input uses its public cached rate only if separately measured; otherwise cached tokens are assumed to be zero and labeled. Unknown aliases, unlisted models, and subscription-only usage have no estimate.
- Public rates are stored as USD per million tokens with an effective date and direct pricing reference. Turing does not convert currencies or claim the provider charged this amount. Validate rates against the provider source before using them for financial decisions.
- **Windows**: Today starts at local midnight. The 7-day and 30-day views use rolling day windows. Daily grouping follows the UTC timestamps stored by the service.

The dashboard and usage page keep source labels visible. Use the provider's account dashboard for authoritative billing, subscription allowance, and reset information. Threshold notifications are sent only for a configured envelope once locally observed use reaches 80%; token thresholds are suppressed when token telemetry is incomplete.

For OpenCode Go, Turing cannot inspect or disable provider-side overflow into a Console balance through a supported mechanism. Run Preview reports that this fallback status cannot be verified and does not claim PAYG is disabled. Review the provider account's billing controls before relying on a subscription-only cost expectation. See [provider and context configuration](phase3.6-provider-model-context.md#billing-and-provider-lock).
