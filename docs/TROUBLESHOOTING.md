# Troubleshooting

## The service refuses to start on my network address

This build accepts loopback hosts only. Set `TT_HOST=127.0.0.1` or remove `TT_HOST`. Network binding stays disabled until authenticated device pairing exists.

## A provider is shown as missing

Install its CLI using the provider's official instructions and confirm it is available on the PATH of the shell that starts Turing. Check `codex --version`, `opencode --version`, `claude --version`, or `cline --version`. After installing a CLI, refresh the page; provider discovery is cached for up to one minute.

## Codex CLI subscription sign-in or model discovery is unavailable

Run `codex login status` and make sure it reports ChatGPT sign-in. Turing does not launch this adapter under OpenAI API-key authentication. The model list comes from the authenticated local Codex app server; if it returns no visible models, restart Codex CLI, refresh provider discovery, and select an exact model ID from the reported list.

## OpenCode is detected but my model isn't available

Sign in through `opencode auth`, then run `opencode models` in a terminal. Turing requires the exact discovered model ID. Check the provider ID associated with that model. If the catalog is empty, it will not silently substitute another model.

## Claude Code or Cline says the account/model is invalid

Authenticate through that CLI's own account flow. Claude Code must report `claude.ai` with first-party provider authentication; Anthropic API-key authentication is rejected. Use the model alias or provider/model identifier accepted by the installed CLI. Cline's account tier and remaining allowance are not queried.

## A preview says the Git working tree is dirty or unavailable

Use **Refresh project details** in the project profile. Isolated worktree workflows require a clean Git repository and a verifiable `HEAD`. Commit or stash local changes, or edit the workflow to turn off isolation. A non-Git folder runs directly from its registered path.

## A run fails on build or test

Review the stage output. Only configured `build`, `test`, and `lint` package scripts can run. Edit the project profile to choose an available command. The project script runs with the local user's permissions; inspect it before execution.

## Review or final-gate output is rejected

Reviewers must return JSON containing a `findings` array; the final gate must return JSON with a boolean `pass` and a `reason`. Turing retains malformed output in the failed stage record instead of treating it as a clean review.

## Cline tool operations have incomplete result details

Turing disables Cline automatic approval and bridges Cline's file-based approval requests into the permission engine. The CLI does not provide per-tool stdout/stderr through this interface; the operation ledger records the authorization and provider-process completion, but may not contain the individual tool's result. Do not enable automatic approval to bypass Turing policy.

## Run state after a service restart

The engine pauses runs that were preparing, running, cancelling, or waiting for human approval. Any pending approval is denied during recovery. Inspect the working copy and run history before resuming. The current run tree is preserved; Turing does not commit it automatically.

## The UI loads but cannot run anything offline

The service worker caches static interface assets only. Project data, provider status, run state, approvals, and usage require the local API to be available.
