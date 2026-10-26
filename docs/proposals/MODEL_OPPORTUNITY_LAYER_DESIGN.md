# Model Opportunity Layer — approved design and implementation record

**Current status (2026-10-25).** The owner approved 90-day raw observation retention on 2026-10-21, with temporary references retained through admission expiry and cleanup performed only by an explicit job. The owner also decided that an approved admission proof remains valid for its exact definition until that definition is superseded; new admission and revalidation require fresh raw observations. Implementation was merged into master through PR #15 (`6e5119f`): additive observation and proof migrations, bounded observation writer/readers/retention, exact user admission, a production reservation estimator for admitted OpenRouter Goal routes, and the Opportunity Board. The software gate passed on merged master; live, physical and release qualification are tracked separately. The original rollout and change-log sections below are design history; release state is tracked in [V1_READINESS.md](../V1_READINESS.md).

**Design review.** Prior revision was accepted by job `2a1f800fc3f0470cbc324afd2b6efc6a` (`opencode-go/glm-5.2`). Correction patch job `d86d409d59d841949ba581ebb163534f` (`opencode-go/beam-free`) was independently reviewed ACCEPT by job `d71b755ad25049b19eef37174bdf545b` (`opencode-go/minimax-m3.1-flash-free`).

**Design author.** Job/model: `2e8be4f50f2b4bfd9a73d83af7f18b12` / `opencode-go/deepseek-v4.1-flash`.

**Independent review (prior revision).** Job/model: `2a1f800fc3f0470cbc324afd2b6efc6a` / `opencode-go/glm-5.2` (ACCEPT).

**Independent review (intermediate revision; REVISE).** Job: `d25027e1f3bd4b5abb948b542aaacfe5` (REVISE); its findings are addressed by correction patch `d86d409d59d841949ba581ebb163534f` and independent ACCEPT review `d71b755ad25049b19eef37174bdf545b`.

**Correction patch author.** Job/model: `d86d409d59d841949ba581ebb163534f` / `opencode-go/beam-free`.

**Independent review (current correction).** Job/model: `d71b755ad25049b19eef37174bdf545b` / `opencode-go/minimax-m3.1-flash-free` (ACCEPT).

**Independent review (wording/traceability findings; ACCEPT).** Job/model: `9295a89374954d0f89e4329bf6051399` / `opencode-go/minimax-m3.1-flash-free` (ACCEPT) with three non-blocking wording/traceability findings: chronology in the design status/traceability block, §8 row 5 scope, and `loadStoredEnvironment` observation-read gating. This revision incorporates them.

**Docs reconciliation.** Commit `67f94b8` on implementation baseline `e6120c1`; worker/reviewer evidence: `88a8d04af0054df5a574f3cbd79232a9`, `8b88289051974397b80af107d2713833`, `926d8ab9570e4f54bfcbfd42615e536e`, `6a8195dbb54f4a6aa5563894838983fb`. Root checks passed: docs:links, format:check, git diff --check.

**Retention decision.** Owner-approved on 2026-10-21: raw observations are retained for 90 days; references for active admissions remain through expiry; the explicit retention job performs deletion. Completed admission proof remains valid for its exact unchanged definition until superseded, while new admission and revalidation require fresh observations.

**Scope note.** The Goal completion-policy ancestry-versus-content decision is tracked separately in [GOAL_CONTENT_VERIFIED_INTEGRATION_DESIGN.md](GOAL_CONTENT_VERIFIED_INTEGRATION_DESIGN.md). Neither decision changes existing active Goal or run snapshots.

---

## 1. Non-negotiable invariants

- **One billing evaluator.** Every opportunity member is still evaluated by `evaluateBillingLane`; no new billing/ledger/approval/catalog store. `src/shared/billing.ts:84-125`, `src/server/goals/routing.ts:208-228`.
- **Existing route authority is unchanged.** Opportunity admission only adds a member to an approved route pool. Execution still requires provider readiness, exact lane match, live catalog or fresh validation, and independence. `src/server/goals/routing.ts:185-258`.
- **Last Known is never executable.** Only `catalogSource == 'live'` plus `status == 'current'` satisfies live-catalog; cache/adapter/last-known does not. `src/server/goals/routing.ts:230-238`, `src/server/modelCatalog.ts:20-94`.
- **No automatic discovery, probing, validation or admission.** Observation history records only refreshes that the existing product already performs. Admission, validation probes and adoption remain explicit user actions.
- **Active snapshots are never rewritten.** Admission creates a new definition version; running Goals/cycles retain their exact persisted route snapshots.
- **Auto-revalidation is never enabled.** `routing.pools[].autoRevalidate` must remain `false`; opportunity admission never sets it true, because automatic revalidation could spend allowance silently. `src/server/goals/definitionValidation.ts:703-708`.
- **Manual handoff, completion policy, fixed navigation and desktop/phone authority boundaries are unchanged.** Notifications remain optional, off by default, generic, and scoped to the existing subscription/device.
- **No claim about unverified Codex pagination.** No acceptance claim or design dependency rests on it.

---

## 2. Domain model

### 2.1 Observation history — implemented with approved retention

The following is the implemented shape; the migration and writer were added after the owner approved retention.

#### Provenance vocabulary

- **Provider-advertised** — a claim published by a provider catalog. OpenRouter live and stored provider-catalog cache rows are provider-advertised.
- **Locally-discovered** — a model actually returned by an installed adapter’s `discover()` call, carrying that adapter’s version. This includes the real per-adapter model lists returned by `providers.ts:66,258-280` (for example Codex and OpenCode), not static fallback metadata.
- **Turing-validated** — an exact `route_validations` pass record. It is not a `claim_kind` and never replaces an observation; it is an additional prerequisite for admitting a locally-discovered model.
- **Static placeholder** — fallback metadata such as `jevAdapterMetadata()` injected at `modelCatalog.ts:161-162,177-179` (`openrouter.ts:181-195`). It is Board-only catalog metadata, never an observation and never admissible.

These separate paths preserve the V1 distinction between provider-advertised, locally-discovered and Turing-validated provenance.

#### `model_observation_refreshes`

One row per **provider refresh attempt**, not one per global refresh.

Required fields:

- `id` — canonical UUID, server-generated.
- `backend_id`, `provider_id`.
- `source_class` — provider-effective `live`, `cache`, `adapter` or `none`.
- `refresh_outcome` — `success`, `empty` or `failed`.
- `started_at` — when this provider’s attempt began.
- `checked_at` — when this provider’s result was actually captured; **must be the per-provider attempt time, not the global fan-out start** (`providers.ts:261-262`).
- `finished_at`.
- `error_code` — finite code or null.
- `cache_observed_at` — cache row timestamp or null.
- `UNIQUE (id, backend_id, provider_id)` — required parent key for the composite foreign key below.

#### `model_observations`

One model observation per model per refresh, append-only.

Fields:

- `id` — canonical UUID, exactly 36 chars.
- `refresh_id` — server-generated UUID; never client-supplied.
- `backend_id`, `provider_id`, `model_id`.
- `claim_kind` — `provider-advertised` or `locally-discovered`.
- `source_class` — per-model provenance: `live`, `cache` or `adapter`.
- `refresh_outcome` — the provider attempt outcome: `success`, `empty` or `failed`.
- `payload_json` — normalized bounded facts, including `pricingEvidence`.
- `payload_digest` — SHA-256 over canonical payload including `claim_kind`, `source_class` and `refresh_outcome`.
- `observed_at`:
  - live: the per-provider attempt `checked_at`;
  - cache: the cache row’s `discovered_at`;
  - adapter: the per-provider attempt `checked_at`.
- `created_at`.

Constraints:

- Unique key: `(refresh_id, backend_id, provider_id, model_id)`.
- Replay with same digest is idempotent.
- Replay with different digest is typed `observation_collision` and aborts the whole refresh transaction; no partial rows.
- `UPDATE` and `DELETE` triggers abort.
- Composite FK:
  `FOREIGN KEY (refresh_id, backend_id, provider_id) REFERENCES model_observation_refreshes (id, backend_id, provider_id)`.
  This prevents an observation from citing a refresh event for another provider/backend.

#### Payload contract and byte bound

`payload_json` is canonical JSON with exactly this bounded shape:

```ts
{
  schemaVersion: 1;
  claimKind: 'provider-advertised' | 'locally-discovered';
  sourceClass: 'live' | 'cache' | 'adapter';
  refreshOutcome: 'success' | 'empty' | 'failed';
  backendId: string;
  providerId: string;
  modelId: string;
  displayName: string;
  adapterVersion: string | null;
  observedAt: string;
  cacheObservedAt: string | null;
  capabilityFingerprint: string | null;
  pricingEvidence: PricingEvidence; // section 5.3 shape, never raw overrides
}
```

Bounds:

- `backendId`, `providerId` ≤ 80 chars; `modelId`, `displayName` ≤ 180; `adapterVersion` ≤ 120; timestamps ≤ 32.
- `capabilityFingerprint` is at most 64 hex chars.
- `pricingEvidence` is the constant-size aggregate from section 5.2 and is capped at 1,536 canonical bytes.
- No raw `ModelOption`, raw `pricing.overrides` array, provider response body or arbitrary provider metadata is stored.

Budget proof:

| Payload part                                      | Maximum canonical bytes |
| ------------------------------------------------- | ----------------------: |
| Identifiers, timestamps, version and fixed fields |                   1,536 |
| Digest/fingerprint and JSON keys/punctuation      |                   1,024 |
| `pricingEvidence` aggregate                       |                   1,536 |
| Hard writer allowance for future fixed fields     |                   4,096 |
| **Writer maximum**                                |               **8,192** |

The writer checks `Buffer.byteLength(canonicalJson(payload), 'utf8') <= 8,192` before inserting. A payload that exceeds the bound aborts the refresh with typed `observation_payload_oversize` and writes no rows; it is never truncated and never drops identity or evidence fields.

The table-level SQL guard is a 16,384-byte looser backstop relative to the operational writer's 8,192-byte cap for unusual storage cases:
`length(CAST(payload_json AS BLOB)) <= 16,384`. The operational writer bound is 8,192 bytes, so the new
pricing evidence is proven inside both caps.

#### Per-provider / per-model provenance rules (M3)

The writer must use the detailed result, not an assumed provider authority.

- A provider attempt returning at least one live provider-catalog model: refresh outcome `success`, refresh source `live`; each live model observation `claim_kind='provider-advertised'`, `source_class='live'`, `observed_at` = that provider attempt’s `checked_at`.
- No live models but cache rows exist: refresh outcome is `empty` or `failed` as actually observed; refresh source `cache`; cache observations `source_class='cache'`, `observed_at` = cache row `discovered_at`. The cache preserves the claim of the source that first recorded it:
  - OpenRouter provider-catalog cache remains `claim_kind='provider-advertised'`;
  - adapter-discovery cache remains `claim_kind='locally-discovered'`.
    Cache is never upgraded to `live` and never changes its originating claim.
- No live/cache rows but **actual adapter model results** exist: refresh source `adapter`; each actual adapter model is `claim_kind='locally-discovered'`, `source_class='adapter'`, `observed_at` = that adapter attempt’s per-provider `checked_at`. These are real local discovery results and are written, subject to the admission prerequisite below.
- Static placeholder metadata, including `jevAdapterMetadata()`, is **never written** as an observation. The detailed producer keeps provider-catalog rows, adapter-returned rows and static placeholders in separate lists; the writer consumes only the first two. Placeholders remain Board-only metadata.
- No live/cache/actual-adapter model rows: refresh source `none`; no model observations.
- Never relabel an actual adapter result as `cache`, and never relabel a placeholder as `adapter`. The legacy provider-level `catalogSource` may still say `cache` when cache rows exist; per-model observation provenance is authoritative.
- `storedProviders` remains memory-plus-DB, no network, no write, and is **not** a reconstruction of observation history (`modelCatalog.ts:198-202`).

#### Admission evidence rule

An opportunity admission may cite an observation only when all of the following hold:

1. the observation exists in `model_observations`;
2. it matches the selected backend/provider/model and the exact member identity;
3. its `observed_at` is not after the decision time;
4. its `payload_digest` recomputes from canonical `payload_json`;
5. its parent refresh exists and matches `(refresh_id, backend_id, provider_id)`;
6. it follows exactly one admissible path:

**Path A — provider-catalog admission**

- observation `claim_kind='provider-advertised'`;
- observation `source_class='live'`;
- observation `refresh_outcome='success'`;
- parent refresh `source_class='live'` and `refresh_outcome='success'`.

Cache, adapter, empty and failed observations never satisfy this path. Existing pool role-validation rules still apply when the definition requires role validation.

**Path B — locally-discovered admission**

- observation `claim_kind='locally-discovered'`;
- observation `source_class='adapter'`;
- observation `refresh_outcome='success'`;
- parent refresh `source_class='adapter'` and `refresh_outcome='success'`;
- **and** the exact Turing route-validation evidence below is present and fresh.

Local discovery never qualifies for admission from the observation alone.

The exact validation prerequisite is:

- the proposed definition binds the member to at least one role;
- for **every role whose pool cites that member**, `freshValidationSet` returns `available: true` for the exact route identity recomputed by `computeRouteIdentity` from the same snapshot;
- the required profiles are `ROLE_VALIDATION_PROFILES[role]`;
- each record has `provenance='turing_probe_run'`, `status='pass'`, non-null `evidence_run_id`, and authenticates through `recordFromRow`;
- `identity_hash` equals the recomputed exact identity hash, including backend, provider, billing lane, exact model, variant, reasoning, native settings, adapter version and capability fingerprint;
- the latest record controls: a newer failure supersedes an older pass;
- `tested_at` is not after the decision time, and the decision time is before `min(expires_at, tested_at + FRESHNESS_WINDOW_MS[freshnessClass])`;
- `freshnessClass` is required on every opportunity pool member; an opportunity-sourced member must declare `opportunity`, with no default. Existing static pool behavior is unchanged (`src/shared/goals.ts:143-148`).

If the member is bound to no role, it cannot be admitted. A missing, failed, expired or identity-changed validation is never repaired or bypassed by the observation.

Cache, failed, empty, placeholder and static-fallback rows are displayed with provenance where applicable but never satisfy admission.

#### Write / read / reproof flow

**Write**

1. The detailed producer runs each provider attempt, records per-provider `started_at`, `checked_at` and `finished_at`, and classifies models as provider-live, provider-cache, adapter-local or placeholder.
2. The writer excludes placeholders and raw provider payloads, builds the bounded canonical payload and computes the digest.
3. The writer inserts one refresh row and its observations in one transaction. Same-digest replay is a no-op; a different digest aborts the whole refresh.
4. Adapter-local rows are written even though they are not admissible without validation. No validation is performed or refreshed by the writer.

**Read**

- The Board reads observations and their refresh rows directly. Adapter-local rows are visible with `claim_kind`, `source_class`, `refresh_outcome`, per-attempt `checked_at` and `observed_at`.
- The Board never turns adapter-local rows into live rows, never turns a placeholder into an observation, and never invents a timestamp.
- Admission reads authoritative database rows, not Board projections or UI caches.

**Reproof**

- `opportunityAdmission`, `assertOpportunityAdmissions` and `approveDefinition` re-read the observation, parent refresh and, for Path B, the exact validation rows.
- Reproof recomputes the payload digest, checks the composite parent binding, re-checks observation time and exact identity, and re-runs `freshValidationSet` for Path B.
- A digest, parent, identity, timing or validation mismatch is a typed refusal; nothing is repaired or partially written. A validation that expires between admission and approval refuses approval and returns the member to `validation required`/revalidation.
- `startGoal` still runs normal preflight. Opportunity admission never substitutes for live catalog/fresh validation, billing, readiness or independence.

#### Compatibility API rule

Add detailed producers without breaking existing callers:

- `discoverProvidersDetailed()` uses per-adapter `Promise.allSettled` and returns per-provider outcome, per-attempt timestamps, and per-model origin (`provider-live`, `provider-cache`, `adapter-local`, `placeholder`).
- Existing `discoverProviders()` remains exported for compatibility; existing `allProviders` behavior is not silently redefined.
- `openRouterProviderStatusDetailed()` separates configured-none, provider-live success, provider-cache, empty, failed and static placeholder metadata. Existing `openRouterProviderStatus()` remains a compatibility wrapper.
- `applyCatalogCacheDetailed()` returns per-provider and per-model provenance, including the originating claim for cache rows. Existing `applyCatalogCache()` continues to return `ProviderStatus[]`.
- The observation writer uses the detailed path only.
- `checkedAt` is the actual per-provider attempt time, not the global fan-out start (`providers.ts:261-262`).

#### Tests

- Actual adapter results from `adapter.discover()` produce `locally-discovered`/`adapter` observations with per-attempt `checked_at`; two providers with different attempt times do not share the global timestamp.
- The static Jev placeholder is never written, even when the live catalog lists no decision model; it remains Board-only.
- OpenRouter live produces `provider-advertised`/`live`; OpenRouter cache produces `provider-advertised`/`cache`; adapter cache retains `locally-discovered` and never becomes live.
- An adapter-local observation alone cannot be admitted. With an exact fresh pass validation for every bound role it can be admitted; missing, failed, expired, future-dated or identity-changed validation refuses admission.
- A provider-advertised live-success observation admits through Path A without using adapter provenance.
- Cache, failed, empty and placeholder rows are ineligible on both admission paths and remain visibly labelled on the Board.
- Same-digest replay is idempotent; different-digest replay aborts with `observation_collision` and writes no partial rows.
- `UPDATE` and `DELETE` triggers abort.
- A worst-case bounded payload with identifiers at their caps, a 64-hex fingerprint and maximum pricing evidence is ≤ 8,192 bytes; an over-bound payload aborts with `observation_payload_oversize` and no rows.
- `discoverProvidersDetailed()`, `openRouterProviderStatusDetailed()` and `applyCatalogCacheDetailed()` preserve per-model provenance while the existing wrappers retain their current outputs.

The existing `model_catalog_cache` remains the Last Known cache; it is not replaced and does not become executable. `src/server/modelCatalog.ts:20-94`, `migrations/014_metered_decisions_usage.sql:105-114`.

### 2.2 Opportunity identity and admission binding

An opportunity is a deterministic projection over observations; no new opportunity table.

- `opportunityDigest = sha256(canonicalJson({ schema: 1, backendId, providerId, modelId, observationIds: sortedUnique }))`.
- `RouteMember` gains an optional strict opportunity binding:

```ts
opportunity?: {
  schemaVersion: 1;
  opportunityDigest: string;   // 64 lowercase hex
  observationIds: string[];    // 1..8 unique UUIDs, sorted
}
```

- A pool with `admission: "opportunity"` must have every member carry this binding; `freshnessClass` must be `opportunity`. A static pool must not carry it. `src/shared/goals.ts:143-164`, `src/server/goals/definitionValidation.ts:88-104,155-174`.
- Opportunity digest binds evidence, while the existing `memberIdentityHash` binds the exact route. `src/server/goals/routeIdentity.ts:102-173`.
- `memberConfigHash` is `memberConfigHashOf(configuration)` (`src/server/goals/routeIdentity.ts:103-116`): SHA-256 over the declared member configuration only (backend, provider, billing lane, model, connection profile, variant, reasoning and native settings). It is environment-independent and locates a pool slot after a version bump; it is never an approval or validation key.
- `identityHash` is `computeRouteIdentity`'s full hash (`src/server/goals/routeIdentity.ts:118-173`): SHA-256 over the complete route identity, including resolved connection profile, adapter version and capability fingerprint.
- Route-validation `identity_hash` stores this full `identityHash`, not `memberConfigHash`: `routeValidation.ts:156-179` maps the database field to `identityHash`; `validationRecordConsistent` authenticates the hash against canonical `identity` JSON. Approval details store and gates compare the exact `poolId` and `memberIdentityHash` (the same full `identityHash`), never `memberConfigHash`.
- Unknown identity fails closed: an opportunity member whose effective identity kind is `unknown` is rejected at definition acceptance and never selected. `src/server/goals/routeIdentity.ts:53-57`.

---

## 3. Approval model — exact, always required for opportunity admission

### 3.1 Rule

- `humanGates.poolRouteFirstUse` **continues to control static-pool first use only** (`src/shared/goals.ts:193-198`; current evaluator `src/server/goals/routing.ts:297-306`).
- **Opportunity admission always requires its own approved user decision**, regardless of `poolRouteFirstUse`.
- The same existing gate `pool_route_first_use` is reused; no new gate. `src/shared/goals.ts:414-428`.
- Existing static approvals with **no `admissionKind`** remain valid for static first use but **never** satisfy opportunity admission.
- An opportunity approval does not satisfy static first use.

### 3.2 Exact opportunity approval detail

Strict object, exactly these seven keys:

```json
{
  "schemaVersion": 1,
  "admissionKind": "opportunity",
  "poolId": "<1..64 chars>",
  "memberIndex": 0,
  "memberIdentityHash": "<64 lowercase hex>",
  "opportunityDigest": "<64 lowercase hex>",
  "observationIds": ["<uuid>", "..."]
}
```

- `observationIds`: 1–8 unique canonical UUIDs, sorted.
- The approval row is created pending by the admission service; approval requires `decidedBy == "user"` and the existing SQL constraint enforces that. `migrations/017_goal_evidence_reviews.sql:124-127`.
- Static detail remains the existing shape, optionally tagged `admissionKind: "static"`; legacy rows with no tag remain static-only.
- Unknown `admissionKind` values are rejected.
- Approval detail JSON is capped at **4,000 characters** at insertion. This prevents `readModel.ts` from blanking it (`src/server/goals/readModel.ts:106,287-302`).

Worst-case detail size: fixed keys/values ≈ 110 + pool id up to 64 + member index up to 2 + two 64-character hashes + eight UUIDs (8 × 36 = 288) + punctuation ≈ **650 characters**, comfortably below 4,000.

### 3.3 All proof sites

| Proof site                                                                               | Required change                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routing.ts` `firstUseOf` `127-152`                                                      | Match exact `poolId`, `memberIdentityHash`, and `admissionKind`. Static accepts absent/`static`; opportunity requires `opportunity` plus matching digest and observation IDs.                                                                     |
| `routing.ts` `evaluateMember` `297-306`                                                  | Require opportunity approval even when `poolRouteFirstUse == false`; compare the exact pool id and full member identity hash. Static first use still obeys the flag.                                                                              |
| `routing.ts` `reproveRoleResolution` `506-525`                                           | Prove kind and binding from the approved member: approval `poolId` equals the resolution pool id and approval `memberIdentityHash` equals the selected full identity hash.                                                                        |
| `routeResolution.ts` `proveDurableReferences` `120-168`                                  | Require a user-approved row with exact kind, pool id, member identity hash, digest, and observation ids; reject every cross-pool/member mismatch. Also prove cited observation rows exist, are self-consistent, and belong to the selected model. |
| `routeResolution.ts` `loadFirstUseApprovals` / `loadStoredEnvironment` `303-334,336-370` | Parse only recognised static or opportunity shapes; malformed rows establish nothing.                                                                                                                                                             |
| `routePlan.ts` `firstUseOf` / `mapRefusal` `57-90`                                       | Carry admission kind, digest, and observation ids from the refusal candidate into the gate request.                                                                                                                                               |
| `supervisor.ts` `ensureFirstUseApproval` `513-543`                                       | Dedupe only against the same admission kind and full opportunity binding, including exact pool id and member identity hash.                                                                                                                       |
| `supervisor.ts` `gateResolved` / `tickNeedsUser` `362-375,609-652`                       | Preserve current round-robin/denial semantics; pending or denied opportunity rows fail closed.                                                                                                                                                    |
| `approvals.ts` `requestGoalApproval` `135-257`                                           | Strictly parse gate details: validate schema, UUIDs, counts, digest, exact pool id and member identity hash, no extra keys, detail ≤4,000, and reject unknown kinds or mismatches.                                                                |
| `approvals.ts` `decideGoalApproval` / `bindExactGate` `294-365`                          | Keep user-only approval and exact-gate binding; do not let a dedicated approval substitute.                                                                                                                                                       |
| `readModel.ts` `approvalView` / `exactGateAction` `287-302,450-458`                      | Preserve the 4,000-char guard and existing denial/resume semantics.                                                                                                                                                                               |
| Immutable approval triggers                                                              | Existing triggers freeze gate, detail, requester and timestamps after insert and forbid delete. Add an insert guard for opportunity detail; do not weaken identity triggers.                                                                      |

`RoleResolution.approval` gains optional `admissionKind`, `opportunityDigest` and `observationIds`; old static resolutions without them remain valid and are treated as static. New opportunity resolutions must carry them.

### 3.4 Admission order

1. Goal remains `draft`.
2. Proposed definition version contains the opportunity pool and exact member bindings.
3. User selects **Admit**. `opportunityAdmission` loads the proposed version, validates the member, computes `memberConfigHash`, recomputes `opportunityDigest`, and re-proves the cited observation from authoritative rows:
   - Path A requires provider-advertised live + success observation and live + success parent refresh;
   - Path B requires locally-discovered adapter + success observation, adapter + success parent refresh, and the exact fresh Turing validation for every role whose pool cites the member;
   - cache, failed, empty and placeholder rows are rejected.
     Only after those checks does it estimate size and call `requestGoalApproval` with a pending `pool_route_first_use` detail binding exact `poolId` and `memberIdentityHash` (exact opportunity detail, section 3.2).
4. User approves through `decideGoalApproval`; only a user decision can approve (`approvals.ts:294-332`; `migrations/017_goal_evidence_reviews.sql:124-127`).
5. `approveDefinition` runs pure validation, size validation, then DB-backed `assertOpportunityAdmissions`; it re-proves the observation, parent refresh and Path B validation freshness. Only then does it request/decide the definition approval and move the Goal to `ready`.
6. `startGoal` runs normal preflight. The approved opportunity admission is already present; no static first-use gate is created. Execution still requires live catalog/fresh validation, billing, readiness and independence.

Admission is per Goal. The same model admitted for Goal A is not admitted for Goal B. An admitted locally-discovered model is not thereby executable, free, or validation-current; execution preflight still decides.

`routing.pools[].autoRevalidate` stays `false` and opportunity admission never sets it true. The existing definition validator rejects any other value (`src/server/goals/definitionValidation.ts:703-708`).

---

## 4. Shared bounds — one contract

Create `src/shared/opportunityContract.ts` exporting constants and strict schemas used by definition acceptance, `routeMemberSchema`, approval parsing/insertion, role audit and resolution schemas.

| Bound                                                                                                                         |                                 Value |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------: |
| Observation id                                                                                                                |              36 chars, canonical UUID |
| Observation ids per member                                                                                                    |                                     8 |
| Opportunity pool members                                                                                                      |                                    16 |
| Route identifier field (`backendId`, `providerId`, `modelId`, `connectionProfileId`, `variantId`, `reasoning`, `billingLane`) |                              96 chars |
| Pool id                                                                                                                       |                              64 chars |
| `nativeSettings` entries                                                                                                      |                                     8 |
| `nativeSettings` key                                                                                                          |                              48 chars |
| `nativeSettings` string value                                                                                                 |                              96 chars |
| Approval detail JSON                                                                                                          |                           4,000 chars |
| Observation payload JSON (operational writer cap)                                                                             |                           8,192 bytes |
| Observation payload JSON (SQL backstop, looser)                                                                               |                          16,384 bytes |
| Total route resolution JSON                                                                                                   | 64,000 chars (existing cap preserved) |

Replace the proposed 64,000-character id/count schema bounds. `routeAudit.ts:167-190,282-283` and `routeIdentity.ts:175-183` currently use the 64 KB cap as a field/count bound; they must import the shared operational bounds instead. The existing max-total cap remains at `src/server/goals/routeAudit.ts:173`.

### 4.1 Conservative size proof

Per opportunity member, worst case:

- configuration: 7 route fields × 96 = 672, plus 8 native settings × (48 key + 96 value + ~8 JSON overhead) = 1,216 → **≈1,888 chars**.
- audit overhead: hashes, index, kind, booleans, catalog labels, two validation profiles, first-use state, reasons → **≈1,300 chars**.
- per member ≈ **3,188 chars**; 16 members ≈ **51,008 chars**.
- role wrapper, selected entry, catalog/approval records ≈ 1,500 chars.
- final-reviewer independence with 16 compared authority entries ≈ 6,000 chars.
- worst case ≈ **58,500 chars**, below the 64,000 cap.

If the actual audit can still exceed 64,000 (for example a larger independence authority list), a deterministic check must refuse **before any run, queue or approval**:

1. At definition acceptance, estimate the full worst-case route-resolution JSON for the defined roles/pools; reject with `opportunity.route_audit_too_large`.
2. After resolution and before persistence/launch, canonicalize `{schema:1, roles}` and reject with `route_resolution_too_large` if it exceeds 64,000. The existing persist-time check remains as a second barrier (`src/server/goals/routeResolution.ts:260-265`).
3. Add a boundary test just-over and just-under the cap.

---

## 5. Cost class and reservation

Use a shared price-evidence helper for **every** observation producer, not only OpenRouter.

Source pattern to preserve: OpenRouter already includes the base value in each max aggregate, then stores max prompt/completion fields. `src/server/openrouter.ts:102-111,153-162`. New producers must either call the same aggregation or compute effective max safely; they must never store `max = 0` while the base is positive.

### 5.1 Classification

For prompt and completion separately:

- if base and max override are both known finite: `effective = max(base, override)`;
- if either is missing: effective is **unknown**, unless a known positive value already proves metered;
- negative or non-finite values are invalid and fail closed.

Then:

- **metered** if any known positive value exists in prompt base/effective, completion base/effective, `requestUsd`, or `cacheReadUsdPerToken`;
- **free only when every applicable field is known finite zero**: effective prompt, effective completion, request and cache-read;
- otherwise **unknown**.

Required cases:

| Case                                  | Result                                            |
| ------------------------------------- | ------------------------------------------------- |
| prompt base `0.001`, max override `0` | `max = 0.001` → **metered**                       |
| base positive, override missing       | **metered**; reservation may still be unboundable |
| base missing, override positive       | **metered**                                       |
| both missing and nothing positive     | **unknown**, never free                           |
| request positive                      | **metered**                                       |
| cache-read positive                   | **metered**                                       |
| request or cache-read missing         | **unknown**, never free                           |
| all applicable fields known zero      | **free**                                          |

### 5.2 Reservation consistency

The cost class must never be more optimistic than the reservation. The owner chose to preserve the legacy estimator and Decision Layer behavior, so Model Opportunity uses a separate estimator in `src/shared/opportunityCost.ts`:

- require effective prompt, effective completion, request and cache-read;
- use `inputRate = max(effectivePrompt, effectiveCacheRead)` conservatively;
- return `null` when an applicable field is missing; the existing unknown-cost policy then applies;
- return `0` only when the same evidence yields `costClass = free`.

The estimator is selected only when a stored Goal route resolution proves an exact Model Opportunity admission for the OpenRouter route. It uses the provider's current bounded catalog evidence and the request's conservative input-token estimate and output-token limit. Missing or invalid price evidence returns `null`, allowing the existing unknown-cost policy to block or request explicit approval. Ordinary routes and Decision Layer outputs keep the legacy estimator unchanged. `maxPriceFor` remains prompt/completion only because the provider ceiling supports those fields; the design makes no claim about a provider-side cache-read ceiling.

A `free` catalog class never changes the billing lane, bypasses `evaluateBillingLane`, or authorizes spend. It is a catalog-price label only.

### 5.3 Additive raw pricing evidence

Extend `ModelPricingSnapshot` additively and optionally (`src/shared/types.ts:70-81`):

```ts
type PriceEvidence = {
  present: boolean;
  valid: boolean;
  value: number | null;
};

const PRICING_OVERRIDE_EVIDENCE_CAP = 16;

type OverrideFieldEvidence = {
  present: boolean;
  validCount: number;              // saturated at the cap
  invalidCount: number;             // saturated at the cap
  maxValidValue: number | null;
  allValidEqualBase: boolean | null; // false if any valid value differs; null if unknown
  complete: boolean;
};

type PricingOverrideEvidence = {
  count: number;                   // min(raw override rows, cap)
  complete: boolean;               // false when the cap overflowed
  overflow: boolean;
  prompt: OverrideFieldEvidence;
  completion: OverrideFieldEvidence;
  request: OverrideFieldEvidence;
  cacheRead: OverrideFieldEvidence;
};

pricingEvidence?: {
  schemaVersion: 1;
  base: {
    prompt: PriceEvidence;
    completion: PriceEvidence;
    request: PriceEvidence;
    cacheRead: PriceEvidence;
  };
  overrides: PricingOverrideEvidence;
};
```

Semantics:

- `base.*` distinguishes absent (`present: false`), present-valid (`present: true, valid: true, value: number`) and present-invalid (`present: true, valid: false, value: null`).
- An override field is `present` when at least one override row declares it, even if the value is invalid.
- `validCount` counts finite non-negative values; `invalidCount` counts present but unparseable, negative or non-finite values. Both saturate at `PRICING_OVERRIDE_EVIDENCE_CAP`.
- `maxValidValue` is the maximum valid value across the scanned rows, or `null` when there is none or the result is unknown.
- `allValidEqualBase` is `true` only when at least one valid override exists, no invalid override exists for that field, and every valid value equals the base value. It is `false` when any valid value differs, and `null` when there is no valid base/value or the evidence is unknown. This distinguishes **absent**, **equal-to-base** and **invalid** overrides per prompt/completion/request/cache-read.
- When `pricing.overrides.length > PRICING_OVERRIDE_EVIDENCE_CAP`, `overflow: true`, `complete: false`, counts are saturated lower bounds, and `maxValidValue`/`allValidEqualBase` are `null`. Consumers must treat override evidence as unknown; they may not infer absence or equality from the partial sample. Legacy aggregate fields still cover every override exactly.
- The aggregate is constant-size. Its canonical JSON is capped at 1,536 bytes; no raw override array is carried into the observation payload.

Producer changes:

- `parseOpenRouterModels` preserves base presence, override presence and override validity for prompt/completion/request/cache-read. Invalid/negative/non-finite values are recorded as present-invalid, not silently dropped.
- Legacy aggregate fields remain unchanged: `maxPromptUsdPerToken`, `maxCompletionUsdPerToken`, including the base and all valid overrides (`openrouter.ts:102-111,153-162`). Legacy estimator and Decision Layer outputs do not change.
- `model_catalog_cache.model_json` already stores the whole `ModelOption`; additive evidence survives cache without a schema migration.
- The observation payload carries the bounded aggregate above and is covered by `payload_digest`.
- Old cached rows without evidence remain parseable. For opportunity classification they are evidence-absent: unknown unless a known positive legacy value proves metered; never free.

Tests:

- Empty overrides: each field `present: false`, counts `0`, `maxValidValue: null`, `allValidEqualBase: null`, `complete: true`.
- Many valid overrides within the cap: exact counts and maximum per field; equal-to-base values yield `allValidEqualBase: true`; a greater value yields `false`.
- Invalid/negative/non-finite overrides: `present: true`, `invalidCount` increments, `validCount` excludes them, and base values are unaffected.
- Overflow above the cap: `overflow: true`, `complete: false`, counts saturate, `maxValidValue` and `allValidEqualBase` are `null`; the payload contains no raw override array and remains within 1,536 bytes.
- Legacy `maxPromptUsdPerToken`/`maxCompletionUsdPerToken`, reservation estimates, `maxPriceFor` and Decision Layer behavior are unchanged.
- Prompt, completion, request and cache-read are each covered independently.

---

## 6. Evaluator purity and database binding

- `RoutingEnvironment` remains immutable and gains bounded, already-loaded opportunity evidence (`opportunityAdmissions` / observation summaries) alongside providers, profiles, validations, first-use approvals and prior resolutions. `src/server/goals/routing.ts:43-69`.
- `resolveRoutes` remains pure: no SQLite, no network, no discovery, no approval creation, no clock beyond `environment.now`.
- `loadStoredEnvironment` loads approvals from existing tables and, only after the observation migration is approved and exists, observations from canonical tables; it does not create or refresh. `src/server/goals/routeResolution.ts:336-370`.
- Write-time and read-time authority stay shared:
  - `reproveRoleResolution` proves the resolution against the approved definition;
  - `proveDurableReferences` proves approval/observation rows exist in canonical SQLite;
  - `persistRoleResolution` applies both before write. `src/server/goals/routeResolution.ts:214-236`.

**Stored-provider correction.** `storedProviders` is **not** a SQLite-only reader. It combines the in-process CLI cache and in-memory OpenRouter catalog with `applyCatalogCache(..., { persist: false })`; it performs no network request and no write, but it is not a reconstruction of persisted observation history. `src/server/modelCatalog.ts:181-202`. Also, `applyCatalogCache` labels a provider live and persists models whenever that provider returned at least one live model; cache fallback applies only when the live model list is empty. `src/server/modelCatalog.ts:24-61`. Observation producers must therefore record the actual source kind (`live`, `cache`, `adapter`, `none`) rather than assuming a stored-provider read is authoritative.

---

## 7. Opportunity Board

The Board is **read-only** over saved observations, admissions and catalog projections, apart from explicit user actions to refresh provider catalogs, queue route validation, or request a bounded admission. Refresh sends no generation request. The Board never auto-admits or rewrites a definition.

User actions:

- **Inspect** — read-only evidence detail.
- **Validate** — queues the existing route-validation probe path; it creates no new authority.
- **Admit** — opens the opportunity admission flow. It is enabled only when the cited observation follows one admissible path:
  - provider-advertised live + success; or
  - locally-discovered adapter + success with exact fresh Turing validation for every role whose pool cites the member.

  Identity must be known, member binding exact, and cost/lane displayable. Admission is per Goal. Cache, failed, empty and placeholder rows are never enabled for Admit.

- **Dismiss** — local UI dismissal only; it is not a database authority decision and cannot approve or deny a gate.

Display requirements:

- `claim_kind`, `source_class`, `refresh_outcome`, per-attempt `checked_at` and cache `observed_at` are shown separately.
- Actual adapter-discovered models are shown as `locally-discovered` / `adapter` with their own observation timestamp. They are not hidden, not relabelled as cache, and not confused with static placeholder metadata.
- Static placeholder metadata, including `jevAdapterMetadata()`, is Board-only; it is never shown as an observation, never given an invented timestamp, and never admissible.
- Provider-advertised live/cache remains labelled separately. Cache is last-known and never rendered as live.
- `costClass` (`free`/`metered`/`unknown`) and lane are shown separately. Unknown is never rendered as free.
- Stale cache and static placeholder metadata are clearly labelled and cannot be admitted.
- A locally-discovered row without exact fresh validation shows `validation required`, `validation expired`, `validation failed` or `validation identity changed` as applicable; Admit stays disabled until the existing Validate path records a fresh pass.
- No auto-admit, bulk admit, silent model substitution, or free-to-metered transition.

Retention behavior:

- Raw observations and temporary admission references are retained for 90 days, then deleted by the explicit retention job.
- A completed admission proof retains its exact observation IDs and digest for the approved definition until that definition is superseded.
- The Board reports invalid or missing evidence as unavailable; it never presents cache or stale evidence as live or admissible.

Notifications:

- Reuse `push_subscriptions` / existing configuration. `migrations/011_phase3_notifications.sql:3-11`, `src/server/routes/notificationRoutes.ts:18-27,50-68`.
- Closed-client notifications remain opt-in through the existing subscription/device control and are off by default. An admission approval uses the existing generic Goal approval notice. No MOP-specific store or automatic refresh notification is added.

---

## 8. Rollout dependencies

This table records the original dependency order before the owner approved retention. It is retained as design history; the current implementation and gate state are summarized at the top of this document and in [V1_READINESS.md](../V1_READINESS.md).

| Order | Dependency                                                                                                                                         | Historical dependency state                                             |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1     | Shared `opportunityContract.ts`: bounds, schemas, digest, cost helper.                                                                             | Yes                                                                     |
| 2     | Cost classifier, reservation changes and producer aggregation.                                                                                     | Yes                                                                     |
| 3     | Approval detail parser/insertion guard and SQL trigger migration; no new table.                                                                    | Yes                                                                     |
| 4     | Routing environment/evaluator changes that do not read observations.                                                                               | Yes                                                                     |
| 5     | Reproof and `proveDurableReferences`: exact approval-kind/pool/member binding and DB-backed observation-dependent reproof/durable-reference proof. | Implemented                                                             |
| 6     | Observation tables, writer/readers, indices and retention mechanism.                                                                               | Implemented after retention approval                                    |
| 7     | Opportunity admission service and observation-dependent definition acceptance.                                                                     | Implemented                                                             |
| 8     | Opportunity Board UI shell and notification hooks.                                                                                                 | Implemented; notifications use the existing opt-in Goal approval notice |
| 9     | Acceptance tests for independent contract, kind, bounds, cost, approval and evaluator rules.                                                       | Yes                                                                     |
| 10    | Observation-backed acceptance tests and full gate.                                                                                                 | Tests implemented; full gate pending                                    |

At the time this dependency order was written, observation-dependent work awaited a retention decision. The owner approved 90-day raw observation retention on 2026-10-21, and those observation-dependent pieces are now implemented. Completed admission proofs retain their ID and digest for the exact definition until it is superseded; a new admission or revalidation requires fresh observations.

---

## 9. Acceptance tests

These cases remain the acceptance contract. Current test and gate evidence is listed in [V1_READINESS.md](../V1_READINESS.md).

The following is the acceptance contract used by implementation tests. The observation-backed cases are implemented; full gate evidence is tracked in [V1_READINESS.md](../V1_READINESS.md).

1. **Approval regardless of flag**
   - opportunity pool with `poolRouteFirstUse=false` refuses without the admission approval;
   - same pool resolves with the exact approved opportunity admission in pure resolution with synthetic evidence; DB-backed observation and durable-reference proof is blocked under rollout row 6;
   - static pool with flag false needs no first-use approval;
   - static pool with flag true still needs one.
2. **Kind binding at every proof site**
   - legacy static approval with no `admissionKind` never satisfies opportunity in evaluator, reproof, durable-reference proof, environment loading, supervisor dedupe, parser, trigger;
   - opportunity approval does not satisfy static first use.
   - exact approval-kind/pool/member binding rejects cross-pool/member mismatches at `firstUseOf`, `evaluateMember`, `reproveRoleResolution`, `proveDurableReferences`, supervisor dedupe and approval parsing; these pre-retention cases do not read observation tables;
   - DB-backed observation existence and self-consistency proof remains blocked under rollout row 6.
3. **Bounds**
   - 17 pool members rejected;
   - 9 observation IDs rejected;
   - non-UUID/duplicate/unsorted IDs rejected;
   - long route field/native settings rejected;
   - approval detail >4,000 rejected;
   - unknown identity rejected.
   - opportunity members with missing or wrong `freshnessClass` are rejected; static pool member behavior remains unchanged.
   - `routing.pools[].autoRevalidate` cannot be set true by opportunity admission; the source schema uses literal `false` and the validator rejects any other value (`src/server/goals/definitionValidation.ts:703-708`).
4. **Size cap**
   - synthetic maximum 16-member pool serializes below 64,000;
   - just-over-cap full resolution fails before run/queue/approval;
   - definition acceptance rejects an estimated over-cap definition.
5. **Cost**
   - base positive/override zero → metered;
   - missing base with positive override → metered;
   - both missing → unknown;
   - all applicable fields zero → free;
   - positive request or cache-read → metered;
   - missing request/cache-read → unknown;
   - reservation null/zero agrees with the class.
6. **Observation identity and retention**
   - replay same digest idempotent;
   - different digest typed collision aborts whole refresh;
   - `UPDATE`/`DELETE` abort;
   - one row per model per refresh;
   - the operational writer rejects payloads over 8,192 bytes; the SQL backstop rejects payloads over 16,384 bytes.
7. **Evaluator immutability**
   - environment deep-frozen; resolver performs no DB/network/write;
   - evidence loaded before resolution;
   - reproof/persistence read canonical tables only.
8. **Cache/live labeling (retention-independent for existing route/catalog rules)**
   - last-known/cache/adapter/none never executable;
   - Board labels advertised/discovered/validated/Last Known distinctly;
   - `storedProviders` source behavior covered;
   - no automatic discovery/probe/validation/admission.
   - observation-backed Board fields show provenance, freshness and cache/live status from the bounded observation store.
9. **Notifications (retention-independent)**
   - absent/off by default; enabled only for an existing subscription/device; generic content.

10. **Observation-backed coverage**

- per-provider provenance and observation-backed Board fields;
- replay, collision, update/delete, observation payload caps, retention expiry and admission-proof preservation;
- observation identity and cross-model binding.

Existing `routeAuditBounds.test.ts:27-71` encodes the superseded 64,000 field/count assumptions and must be replaced with the shared-bound tests.

---

## 10. Owner decisions

**Model Opportunity Layer:** retention was approved on 2026-10-21: raw observations are retained for 90 days; references used by active admissions remain until those admissions expire; deletion runs only through the explicit retention job. The owner further decided that a completed admission's ID and digest remain valid for that exact definition until the next exam cycle or the definition is superseded. New admission and revalidation require fresh raw observations.

- Raw observation deletion is performed by the explicit retention job. The evidence tables remain immutable to ordinary update/delete operations.
- New admissions and revalidation reject observations older than 90 days, even if the retention job has not removed them yet. Existing completed admission proof remains valid for the exact, unchanged definition; it does not authorize a new admission or revalidation.

---

## 11. Change log from prior revision

1. **Removed the `poolRouteFirstUse=true` requirement.** Opportunity admission now always needs its own user approval; static first use alone follows the existing flag. Reproof accepts the exact opportunity approval even when the flag is false.
2. **Replaced 64,000-character/count bounds** with one shared operational contract: UUID observation IDs, 8 per member, 16 pool members, bounded route/native settings, 4,000-char approval detail, 8,192-byte writer / 16,384-byte SQL payload caps, preserved 64,000 total audit cap plus deterministic pre-run size checks.
3. **Fixed cost classification:** `max(base, override)` for conservative prompt/completion values, fail closed when either is missing unless a positive known value proves metered, include request and cache-read costs, and only classify free when every applicable field is known zero.
4. **Recorded the existing OpenRouter aggregation** of base plus overrides and required all new observation producers to do the same or compute effective max safely.
5. **Retained collision-proof append-only observation identity:** refresh-scoped unique key, payload digest replay, typed collision, `UPDATE`/`DELETE` abort, payload cap, one observation per model per refresh.
6. **Retained evaluator purity:** bounded immutable environment plus DB-backed reference proof.
7. **Corrected the stored-provider source claim:** `storedProviders` is memory-plus-DB with no network/write, not a persisted-history reader; corrected the live/cache labeling consequence.
8. **Applied the approved retention policy.** Raw observations expire after 90 days; active admission references remain through admission expiry; an explicit job performs deletion. Completed admission proof remains valid for its exact definition until superseded, while new admission and revalidation require fresh raw observations.
9. **Preserved all requested architecture:** `evaluateBillingLane` only, no parallel stores/ledgers/approvals/billing, no automatic discovery/probing/validation/admission, Last Known not executable, active snapshots unchanged, manual admission, fixed nav, optional/off/generic notifications, completion policy unchanged.
10. **Resolved remaining technical choices:** reuse `pool_route_first_use` with `admissionKind`, no new gate; unknown identity fails closed; notification scope stays per existing subscription/device and off by default; no Codex pagination claim.
11. **Replaced acceptance coverage** with the cases in section 9, including approval despite `poolRouteFirstUse=false`, proof-site kind binding, bounds, size cap, base-positive/override-zero cost, replay/collision/update/delete, evaluator immutability and cache/live labeling.
12. **Corrections per review `d25027e1f3bd4b5abb948b542aaacfe5`:** split retention-dependent from independent work; scoped `freshnessClass` to opportunity pools; bounded `billingLane`; clarified the payload-byte bound; and separated binding-only proof tests from DB-backed observation proof.
13. **Corrections per review `9295a89374954d0f89e4329bf6051399` (ACCEPT):** recorded that review and the three non-blocking wording/traceability findings it raised in the traceability block — status/traceability chronology, §8 row 5 binding-only versus observation-dependent proof scope, and `loadStoredEnvironment` observation-read gating — and this revision incorporates them. No product decision, status, source claim, evidence ID or citation changed.

## Appendix: growth risk preserved

Raw observation history is retained for 90 days and deleted by the explicit retention job. Payloads are capped at 16,384 bytes per row, with a lower operational writer cap. Completed admission proofs retain only their bounded identity/digest evidence for the exact definition until superseded; they do not keep raw observation payloads alive beyond the active admission window.
