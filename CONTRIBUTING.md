# Contributing

Thanks for taking the time to contribute. This repository holds a publishable SDK (`packages/agent-kit`) and two applications that consume it (`apps/web`, `apps/desktop`).

## Before you start

- Open an issue for anything larger than a typo fix. It is cheaper to agree on the approach than to rework a pull request.
- For security problems, do **not** open an issue. Follow [SECURITY.md](SECURITY.md).
- By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

See the [development guide](docs/development.md) (English) or [开发指南](docs/development.zh-CN.md) (Chinese). The short version:

```bash
npm install
npm run dev:web        # http://localhost:3100/linger
npm run dev:desktop   # Electron app in dev mode
```

Both apps compile `packages/agent-kit/src` directly in dev and production, so SDK edits
hot-reload. `@turingflow/agent-kit` is a private, source-only workspace package: it is not
published to npm and has no `dist/` build.

## Known type errors

`npm run typecheck -w desktop` currently reports 18 pre-existing errors (17 in `DesktopWidget.tsx` / `Desktop.tsx` / `FileManagerWidget.tsx` / `ContactsWindow.tsx` plus one in `Dock.tsx`). Almost all of them are missing type declarations, not runtime bugs — for example `window.agentHost` is exposed by the preload script but absent from the global `Window` type, and React's `PointerEvent<HTMLDivElement>` is mixed with the DOM `PointerEvent`. CI runs this job with `continue-on-error: true` for that reason. Do not fix them as a side effect of an unrelated PR, and do not add new ones.

## What a pull request should contain

1. **A focused change.** One topic per pull request. Refactors unrelated to the fix belong in their own pull request.
2. **Green checks.** At minimum:

   ```bash
   npm run typecheck -w @turingflow/agent-kit
   npm run build -w web
   ```

   `npm run typecheck -w desktop` has a known backlog of pre-existing renderer errors; do not add new ones.

3. **Docs updated.** Behaviour changes update the relevant README or `docs/` page. Long-form docs are maintained in pairs (`*.md` English, `*.zh-CN.md` Chinese) — update both.
4. **A description that explains why.** What problem the change solves, what you tried that did not work, and anything a reviewer should look at closely.

## Code conventions

- **No host-specific names in the SDK.** `packages/agent-kit` is published on its own and must not mention or import any application in this repository. Refer to hosts as `host`, `desktop host`, `web`.
- **Comments explain why, not history.** No migration narratives, no "we used to do it this way", no changelog prose in source comments.
- **No hardcoded home directories.** Local data paths derive from `AGENT_APP_NAME` through the SDK helpers; never write `~/.agent` directly.
- **TypeScript strictness matches the package you touch.** Server code (`tsconfig.json`), SDK UI (`tsconfig.ui.json`), desktop main (`tsconfig.node.json`) and desktop renderer (`tsconfig.web.json`) are separate configs.
- **Keep the dependency direction.** Applications depend on the SDK. The SDK never depends on an application.

## Commit messages

Conventional prefixes, one line of intent, body only when the reason is not obvious:

```
fix(agent-kit): keep artifact root stable when a workspace is passed
feat(launcher): persist pasted files under the app home directory
docs: pair the development guide in English and Chinese
```

## Reviewing and merging

- Maintainers merge with squash. Keep the branch rebased on `main`.
- A pull request that changes behaviour without touching docs will be asked to add them.
- Large features are worth a short design note in `docs/` before implementation.

## Reporting a bug

Use the bug report template. Include: what you ran, what you expected, what happened, the OS and Node version, and any relevant server log lines (`AGENT_KIT_LOG_LEVEL=debug` produces more).
