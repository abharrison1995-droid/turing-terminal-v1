# Usage accounting

Turing reports activity it can observe locally. It records one usage event for each provider invocation and each configured build/test process, along with backend, role, project, run, duration, and token counts when the provider returns parseable usage data.

## What the numbers mean

- **Events** count local provider or build/test process invocations, not provider billable requests.
- **Duration** is elapsed time for each process. Parallel process durations are summed, so process minutes can exceed wall-clock minutes.
- **Tokens** are shown only when emitted by the provider CLI in a recognized structured result. Missing values mean unavailable, not zero.
- **Estimated cost** is unavailable. Turing does not estimate it from model names or public price tables.
- **Quota, reset time, subscription allowance** are unavailable unless a documented provider API is implemented. Turing does not scrape provider dashboards.
- **Windows**: Today starts at local midnight. The 7-day and 30-day views use rolling day windows. Daily grouping follows the UTC timestamps stored by the service.

The dashboard and usage page label the source as locally observed or measured. Use the provider's account dashboard for authoritative billing, subscription allowance, and reset information.
