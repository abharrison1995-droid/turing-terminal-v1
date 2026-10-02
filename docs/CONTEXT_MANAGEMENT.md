# Context management

Context is first-class configuration. No stage receives the whole repository, full run history, previous transcripts, or raw logs unless configured to.

## Strategies

| Strategy                     | Repository access                                           | Typical use            |
| ---------------------------- | ----------------------------------------------------------- | ---------------------- |
| **Focused / Auto** (default) | relevant files through the broker, within limits            | most stages            |
| **Changed Files**            | only paths changed in the working tree, plus include globs  | review stages          |
| **Artifacts Only**           | structured artifacts; files only if include globs name them | gates, consolidation   |
| **Broad Project**            | broad repository access, still within limits                | explicitly chosen only |

## Budgets

Per workflow and per stage: estimated maximum input tokens (default 32,000), maximum files (24), maximum bytes per file (80 KB), include/exclude globs, and switches for the current diff, test summary, build summary, previous-stage artifact, and previous AI responses (off by default). The diff is included by default only for reviewer, consolidation, and final-gate stages. Budgets apply to the prepared prompt **and** to every brokered tool result (including OpenRouter function calls).

## Preview estimates

Run Preview shows each stage's strategy and an **ESTIMATED** initial input (characters ÷ 4 for Turing-prepared content). Provider-internal system prompts are not visible to Turing. The estimate exists to catch accidental huge runs, not to bill.

## Over-limit policy

| Policy                | Behaviour                                                                                                                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Compact** (default) | Optional blocks (prior artifacts, previous responses, diff, build/test summaries, consolidation/remediation finding lists) are shortened head-and-tail with a visible marker. Task, rules, security, and role instructions are never removed. If mandatory content alone exceeds the limit, the stage stops before any provider call. |
| **Ask** / **Stop**    | Start is blocked when the preview estimate exceeds the limit; later tool reads that would exceed it are denied.                                                                                                                                                                                                                       |

## Structured handoffs

Stages hand off bounded artifacts — `PlanArtifact`, `ImplementationResult` (summary + changed files), `ReviewFinding[]`, `FinalGateResult`, `OrchestrationDecision`, `DecisionResult`, and concise build/test summaries — instead of conversational transcripts. This keeps handoffs provider-agnostic and cheap. Decision Gates use the same artifacts as their state (see [Decision Layer](DECISION_LAYER.md)).

## Instruction precedence

1. Turing security rules, broker permissions, and approval gates (enforced outside the model)
2. Mandatory Global and Project Rules
3. Turing role instructions
4. Advisory Global and Project Rules
5. Workflow instructions
6. Stage-specific custom instructions

Lower levels cannot weaken higher ones, change provider/model routes, or bypass approvals.
