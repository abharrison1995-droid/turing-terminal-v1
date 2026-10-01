# Claude Code subscription acceptance

**Current state: AWAITING PROVIDER ALLOWANCE RESET.** Claude Code authentication has been detected as first-party Claude.ai subscription auth. A prior tiny Planner attempt reached Claude and returned HTTP 429 for the weekly limit with a reported reset time; it reported zero input/output tokens and zero cost. No Anthropic API fallback occurred. Do not repeat the call until the allowance resets.

## Minimal post-reset check

1. Confirm the reset time in the Claude account/CLI and verify `claude auth status` reports a signed-in Claude.ai subscription. Do not add an Anthropic API key. Turing blocks non-subscription Claude auth for this provider.
2. Create a fresh temporary Git repository containing only `README.md` with one sentence. Make and commit an initial baseline. Do not use the Turing Terminal repository as the fixture.
3. In Turing, add only that fixture project and create/select a workflow with exactly one enabled **Implementer** stage. Set the execution backend to **Claude Code**, provider to **Claude subscription**, model to the account's available Haiku model, and disable Planner, Reviewer, prompt refinement, and remediation stages.
4. Use a narrow task: `Create acceptance.txt containing exactly the text PASS followed by a newline. Do not inspect or change any other file.` Preview the fixture path, single provider/model, Normal permission mode, one AI stage, no retry for allowance/auth errors, and the configured run deadline. Start once.
5. Expected success: exactly one new fixture file, a passed Implementer stage, provider usage if emitted, and no API billing. If HTTP 429 recurs, record the returned reset timing, stop, and leave the state **AWAITING PROVIDER ALLOWANCE RESET**. Do not retry during the exhausted window.

The reported earlier live Codex validation already proves the Codex subscription-backed path. This document is only the small Claude-specific post-reset check; it is not a reason to repeat the broader Codex test.
