## What and why

<!-- What problem does this solve? One or two sentences a reviewer can read first. -->

## Scope

<!-- Which packages/apps are touched. Anything deliberately left out. -->

## How to verify

<!-- Commands you ran, or steps a reviewer can follow. Paste the checks you actually ran, not the ones you planned. -->

- [ ] `npm run typecheck -w @turingflow/agent-kit`
- [ ] `npm run build -w web`
- [ ] manual check in the web app / desktop app (describe it)

## Checklist

- [ ] No host-specific names or imports added to `packages/agent-kit` (it is published separately)
- [ ] No hardcoded home directory paths; local data derives from `AGENT_APP_NAME`
- [ ] Comments explain why, not the history of the change
- [ ] Docs updated in both languages (`*.md` and `*.zh-CN.md`) when behaviour changed
- [ ] No secrets, tokens or personal paths in the diff, logs or screenshots

## Notes for reviewers

<!-- Trade-offs, follow-ups, anything you are unsure about. -->
