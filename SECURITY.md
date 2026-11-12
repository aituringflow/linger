# Security policy

## Reporting a vulnerability

Do not open a public issue for a security problem. Report it through GitHub's private vulnerability reporting (**Security** tab → **Report a vulnerability**), or by mail to **security@aituringflow.com**. Include:

- affected component (`packages/agent-kit`, `apps/web`, `apps/desktop`)
- affected version or commit
- a description of the issue and its impact
- reproduction steps or a proof of concept
- any mitigation you already know of

You will get an acknowledgement within a few days. We will keep you informed while we investigate, and credit you in the fix announcement unless you ask otherwise.

## Scope

In scope:

- the SDK server runtime: authentication, session handling, artifact and file access, terminal and sandbox execution, OTA update checks
- the web app's custom server, realtime and terminal gateways
- the desktop app's preload bridge and IPC surface (privilege boundaries between renderer and main)
- credential handling and where secrets are stored

Out of scope:

- vulnerabilities in third-party dependencies without a demonstrated impact on this project (report them upstream, and tell us if you think we need to pin or patch)
- issues that require an already-compromised machine or a locally modified build
- missing hardening headers with no demonstrable exploit
- social engineering of maintainers or users

## Handling of secrets

Never include real credentials in issues, pull requests, screenshots or logs. Subscription credentials live in `~/.codebuddy`; provider keys belong in a local `.env` file, which is ignored by git. If you believe a credential has been committed, tell us privately so it can be rotated.

## Supported versions

The latest published minor version of `@turingflow/agent-kit` receives fixes. Older minors get them at the maintainers' discretion.
