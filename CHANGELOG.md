# Changelog

Each version is released by tagging `v<version>` on `main`; see the Releases section of `DEVELOPMENT.md`.

## 0.2.0

- Collector: a macOS adapter that reads launchd jobs without privileges, and an optional host `identity` for machines whose hostname differs from the server host name.
- Server: per-host collection loops with `refreshSeconds` and `timeoutSeconds`, so one hung host never delays the others.
- Server: attention transition history (`stateDir`, `GET /api/events`) and optional alerts to a loopback or tailnet notification relay (`alerts`).
- Server: the CLI starts when launched through a symlinked release directory such as `current/src/server.mjs`; 0.1.0 exited 0 without listening.
- Snapshots remain `schemaVersion` 1; a 0.1.0 server configuration stays valid.

## 0.1.0

- Initial release: Linux collector, read-only central server and dashboard, and pinnable release artifacts.
