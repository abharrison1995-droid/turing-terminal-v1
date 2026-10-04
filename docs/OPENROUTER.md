# OpenRouter

OpenRouter is an **optional, metered** first-class connection. Verified against openrouter.ai documentation on 2026-10-02.

## What adding a connection does — and does not do

Adding an OpenRouter connection (Settings → OpenRouter) creates a connection profile and lets you store keys. It does **not** alter any workflow, add a Decision Gate, replace a reviewer, enable metered billing, or enable Jev. Nothing uses OpenRouter until a stage or Decision Gate explicitly selects that connection, and the run's billing mode permits the metered lane. Without an OpenRouter profile, Turing makes no OpenRouter network request at all.

## Credentials

| Credential         | Used for                                                 | Required                    |
| ------------------ | -------------------------------------------------------- | --------------------------- |
| **Inference key**  | Chat completions, Jev decisions, `/api/v1/key` telemetry | Yes, for any OpenRouter use |
| **Management key** | `/api/v1/credits` account balance only                   | No                          |

OpenRouter management keys cannot run inference; Turing never uses one for inference.

Keys are written through `PUT /api/connection-profiles/:id/credentials/:kind` from the **desktop only** (paired phones receive 403) and stored in `<data dir>/secrets/credentials.json` with owner-only permissions (directory `0700`, file `0600`; Windows uses the per-user profile ACL). They are not stored in SQLite. No API route returns them; the profile list exposes only `credentials: { inference: boolean, management: boolean }`. They are never placed in an agent's environment (every `OPENROUTER_*` variable and any `*_MANAGEMENT_KEY` is stripped from child processes), prompts, workflow exports, run history, usage exports, or logs, and errors are scrubbed of the key value. V1 does not use an OS keychain.

## Generative stages

Choose backend **OpenRouter**, provider `openrouter`, lane `openrouter-metered`, an OpenRouter connection, and an exact model from the catalog. The adapter:

- calls `POST /api/v1/chat/completions` with the exact model ID — no `models` fallback array;
- sets `max_tokens` (stage setting, default 8,192, capped at the model's reported maximum);
- sets `provider.max_price` from catalog prices so no pricier upstream is used;
- sends `reasoning.effort` / `reasoning.max_tokens` and `temperature` only when the model reports support for them;
- exposes Turing's broker tools as functions (read-only roles get only `list_files` and `read_file`), executing every tool call through the same Turing authorization and audit path as CLI backends;
- meters **every HTTP request** (each agent turn) as one canonical usage event with its own atomic reservation, up to 16 turns.

Generative OpenRouter stages are allowed only in **Custom** billing mode.

## Decision Gates (Jev)

See [Decision Layer](DECISION_LAYER.md). Jev uses `POST /api/alpha/decisions`, not the chat endpoint.

## Catalog

`GET /api/v1/models` (public, no key) supplies IDs, names, context length, input modalities, `supported_parameters` (tools, reasoning, temperature, max_tokens, structured outputs), per-token prices (including conditional `overrides`, of which Turing uses the maximum for reservations), and `expiration_date` (shown as **Deprecated**). The catalog is cached for 10 minutes and persisted; if it cannot be fetched, cached entries show as **Last Known**. If the live catalog omits Jev, Turing lists `typesafe/jev-1.13` from adapter metadata as Last Known without inventing a price — unpriced Jev calls then fall under the unknown-cost policy.

## Telemetry

Settings → OpenRouter → **Read key usage** calls metadata endpoints only (no generation):

- **Key-level** (`/api/v1/key`, inference key): usage today / this week / this month (OpenRouter defines these in UTC), the key's limit, remaining limit, reset cadence, and expiry.
- **Account-level** (`/api/v1/credits`, management key only): remaining credits and total usage.

All are labelled **PROVIDER MEASURED**, kept separate by scope, and shown next to — not merged with — Turing's own caps. Turing never modifies a key's limit.

## Usage, cost, and upstream routing

Each response's `usage` object is recorded on the canonical event: prompt, cached, cache-write, reasoning, completion, and total tokens, plus `cost` as **provider-measured actual cost**. `id` is stored as the provider request ID, `model` as the resolved model, and `provider` as the upstream inference provider. Analytics group by Turing billing lane first; upstream providers appear in model drill-down.

## Limitations

- OpenRouter's Decisions API is an `alpha` endpoint.
- Turing does not call `/api/v1/generation` for a second, later cost lookup; when a response lacks `usage.cost`, the full reservation stays committed.
- Streaming is not used.
