# CLAUDE.md

Read [AGENTS.md](AGENTS.md) first; it is the canonical cross-agent context. Release status is in [docs/V1_READINESS.md](docs/V1_READINESS.md). This file holds only Claude Code operational notes and must not define product behaviour.

- Use the standard validation gate listed in AGENTS.md before declaring work done.
- Frontend work follows [DESIGN.md](DESIGN.md) and the `impeccable` skill in `.claude/skills/`.
- Before assessing project state, check `git fetch` and compare with `origin/master`; local checkouts have been stale before.
- Commit messages end with the Co-Authored-By line given by the session attribution reminder.
