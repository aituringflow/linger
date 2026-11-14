# Development guide

English | [简体中文](development.zh-CN.md)

How to get this repository running locally, how the three packages fit together, and what to check before opening a pull request.

## Prerequisites

| Tool | Version | Needed for |
|---|---|---|
| Node.js | 24.9+ (see `.nvmrc`) | everything |
| Operating system | macOS / Windows | desktop app; Linux is untested |
| npm | 10+ | workspaces |
| PostgreSQL | any recent version | login, sessions, cowork in the web app (optional) |
| Docker | any recent version | group sandbox / `group_bash` (optional) |
| clang (Xcode CLT) | — | macOS status-bar helper in the desktop app (optional) |
| PowerShell | Windows PowerShell 5.1+ | Windows window-control helper in the desktop app (optional) |

Feature-specific extras, all optional: a Codex CLI installation for Codex mode, a local OpenAI-compatible server for custom models, and an ASR service for voice input.

## Repository layout

```
packages/agent-kit/    SDK: server runtime + React UI + OTA server
  src/server/          routes, sessions, auth, artifacts, terminal, cowork
  src/ui/              React components exported as @turingflow/agent-kit/ui
apps/web/              Next.js app, basePath /linger, port 3100
  server.mjs           custom server: Next behind a 1-hour request timeout (OTA uploads)
apps/desktop/         Electron app (main / preload / renderer, electron-vite)
docs/                  long-form docs (this file, product rules, OTA notes)
```

How the SDK is resolved:

- **Workspace**: both apps declare `"@turingflow/agent-kit": "*"`, which npm resolves to `packages/agent-kit` inside the monorepo.
- **Web**: `apps/web/next.config.mjs` aliases every SDK entry (`.`, `/ui`, `/styles.css`, `/ota*`, `/local-chat`) to `packages/agent-kit/src/**` in dev and production; `server.mjs` loads the same source entry through `tsx`.
- **Desktop app**: `electron.vite.config.ts` bundles the SDK server source into the main process and points the renderer UI/CSS at the source. Vite HMR updates the renderer; `--watch` restarts the main process when server source changes.
- **Source-only package**: `@turingflow/agent-kit` is private and not published to npm. Its `exports` point straight at `src/**/*.ts`; there is no `dist/` build and no publish step.

## Quick start

Install dependencies from the repository root and adjust the environment files as needed:

```bash
npm install
cp apps/web/.env.example apps/web/.env
cp apps/desktop/.env.example apps/desktop/.env
```

Set `AUTH_SESSION_SECRET` to a random value in `apps/web/.env` (generate one with `openssl rand -hex 32`); keep it on the server. Start the web and desktop apps in separate terminals:

```bash
npm run dev:web       # http://localhost:3100/linger
npm run dev:desktop
```

Chat does not use API keys. It runs through a subscription login whose credentials are cached in `~/.codebuddy`:

```bash
npm run login            # prints a URL; open it manually, finish sign-in in the browser
```

`npm run login` reads the process environment, not `apps/web/.env`. If you need to point it at a different backend environment, pass the variable on the command line.

## Running the targets

### Web app

```bash
npm run dev:web          # http://localhost:3100/linger
```

The custom server (`apps/web/server.mjs`) runs Next and raises the request timeout to one hour so large OTA uploads survive. The web app serves the product site, the download page and the launcher backend (accounts, OTA); it hosts no chat, so there is no realtime gateway. To run it over HTTPS:

```bash
npm run dev:web:https    # self-signed cert, needed for some microphone / clipboard APIs
```

Production:

```bash
npm run build:web
npm run start -w web     # node server.mjs --production
```

### Desktop app

```bash
npm run dev:desktop
```

The dev entry first compiles two optional native helpers — a macOS status-bar collector (clang) and a Windows window-control helper (PowerShell) — and continues with a warning when the toolchain is missing. It then starts `electron-vite dev`.

The desktop app talks to the web app for login and accounts, so keep `npm run dev:web` running and point `WEB_SERVER_URL` at it. The desktop app verifies sessions through the web service.

Packaging:

```bash
npm run build -w desktop          # builds native helpers and the Electron app
npm run dist -w desktop           # electron-builder via scripts/build-launcher.mjs (portable build)
npm run dist -w desktop -- setup           # installer (NSIS on Windows, DMG on macOS)
npm run dist -w desktop -- setup --reuse   # reuse the portable build, compress only
```

`setup` no longer packages twice: it produces the app directory (`win-unpacked` / `Linger.app`)
first, then lets electron-builder compress it via `--prepackaged`. Running the portable build
once and then `setup --reuse` skips the 1.8GB copy and goes straight to compression.

The Codex CLI platform package (437MB unpacked) is **not bundled**: the installer is 437MB
smaller, and the client downloads the official tgz (~157MB) from the npm mirror the first time
the user enables Codex under Settings → Compute → Codex, unpacks it into
`<userData>/runtime/codex/<version>/` and points `CODEX_CLI_PATH` at it. For offline
distribution, drop the three `@openai` platform exclusions in `electron-builder.yml`.

### SDK on its own

```bash
npm run typecheck -w @turingflow/agent-kit
npm run cli -w @turingflow/agent-kit   # interactive CLI session
```

The SDK has no build or publish step; both apps compile `src` directly.

## Configuration

Configuration uses environment variables. See the [web example](../apps/web/.env.example) and [desktop example](../apps/desktop/.env.example) for the complete options:

| File | Read by |
|---|---|
| `apps/web/.env` | the web app (Next loads it at startup) |
| `apps/desktop/.env` | the desktop app; in development it fills missing keys from `apps/web/.env` |

The variables most people need:

| Variable | Default | Purpose |
|---|---|---|
| `AUTH_SESSION_SECRET` | — | Signs web session cookies; keep it on the server |
| `AUTH_COOKIE_PATH` | `/linger` | Web server cookie path, keep it aligned with `basePath` |
| `AUTH_PROVIDER` | `builtin` | `builtin`, `feishu`, `dingtalk`, `adaptive` or `none` |
| `AUTH_SECURE_COOKIE` | — | `false` for local HTTP; `true` for HTTPS deployments |
| `AGENT_PROVIDER` | `codebuddy` | Default engine |
| `AGENT_APP_NAME` | — | Declares the app name; local data moves to `~/.<name>` |
| `AGENT_DATA_DIR` | — | Optional override for the local data root |
| `AGENT_MODELS_PATH` | — | `models.json` file or its directory |
| `AGENT_ARTIFACT_DIR_NAME` | `.agent-files` | Artifact root directory name; `.<app name>` when a name is declared |
| `TENCENT_CLOUD_APP_ID`, `TENCENT_CLOUD_SECRET_ID`, `TENCENT_CLOUD_SECRET_KEY` | — | Tencent Cloud speech recognition credentials, kept server-side |
| `AGENT_KIT_ASR_PROVIDER`, `AGENT_KIT_ASR_HOST`, `AGENT_KIT_ASR_API_KEY` | — | Optional generic voice transcription service |
| `AGENT_KIT_LOG_LEVEL` | `info` | `debug` for verbose server logs |
| `POSTGRES_HOST/PORT/USER/DB/PASSWORD` | — | Enables server persistence and cowork. Tables are created in the `linger` schema |
| `PORT` | `3100` | Web port |
| `APP_PUBLIC_URL` | — | Public base URL, used in OAuth redirects and links |
| `WEB_SERVER_URL` | `http://127.0.0.1:3100/linger` | Web base URL the desktop app uses |
| `LAUNCHER_APP_NAME` | `linger` | Overrides the desktop app's data directory name |

Desktop login, accounts, and updates depend on the web service. Set `APP_PUBLIC_URL` on the web server and, before packaging, set `WEB_SERVER_URL` in `apps/desktop/.env` to the same service under `/linger`. The entire desktop `.env` is included in the package; put only public client configuration in it. The client cannot verify a session while the service is unavailable.

Schema setup for the web app:

```bash
npm run db:migrate -w web
```

The SDK also applies an idempotent migration on first database connection, so this command is mainly for pre-provisioning a fresh database.

### Where data lands

```
~/.<AGENT_APP_NAME>/models.json      # custom model list
~/.<AGENT_APP_NAME>/chats/           # local sessions (desktop app)
~/.<AGENT_APP_NAME>/artifacts/<sid>/ # per-session outputs
~/.<AGENT_APP_NAME>/knowledge/       # knowledge base: libraries, OCR cache, embedding model
~/.<AGENT_APP_NAME>/terminal-home/   # per-session shell state (rc file, history, npm cache)
```

With no declared name the SDK falls back to `~/.agent` and `~/.agent-files`. The desktop app declares `linger`, so its data lives in `~/.linger`. Nothing is written into the repository.

## Checks before pushing

```bash
npm run typecheck -w @turingflow/agent-kit    # server + ui
npm run typecheck -w desktop                 # node + renderer
npm run build -w web
```

`apps/desktop`'s renderer typecheck currently reports a known backlog of errors unrelated to recent changes; see the readiness checklist. Builds do not run type checking, so a green build does not imply green `tsc`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Authentication required. Please use /login command to sign in` | No subscription login on this machine, or it expired. Run `npm run login`, then restart the dev server — the server keeps a long-lived engine session and will not pick up new credentials otherwise |
| Web changes to SDK source have no effect | Next dev should hot-reload from `src`. Restart the dev server (or clear `.next/`) if the module graph is stale; there is no `dist` build to fall back to |
| Desktop app shows stale behaviour after SDK edits | The renderer hot-reloads and the main process restarts under `electron-vite dev --watch`. Restart `npm run dev:desktop` if the watcher missed a change |
| Desktop app fails to start with no output | `ELECTRON_RUN_AS_NODE=1` in the environment turns Electron into plain Node. The dev entry deletes it; if you launch Electron by hand, unset it |
| Port 3100 already in use | Set `PORT`, and update `WEB_SERVER_URL` to match |
| Electron packaging fails with `EPERM ... rename win-unpacked.tmp` | Another process (an indexer or antivirus) holds the freshly unpacked files. The packaging script writes outside the workspace by default; keep `--out` outside the repo |
| Login succeeds but the app still returns 401 | Check the desktop web URL, cookie path, and web service session configuration |

## Conventions

- Code comments explain *why* a non-obvious choice exists, never the history of how it got there. No migration narratives.
- `packages/agent-kit` is an independent SDK: it must not mention or import any application in this repository. Name hosts as "host", "desktop host", "web".
- Local data directories are derived from `AGENT_APP_NAME`; never hardcode `~/.agent` in new code.
- Long-form docs are kept in pairs (`*.md` in English, `*.zh-CN.md` in Chinese) and must stay in sync.
