# Development

Node 24 or newer is required. There are no third-party runtime dependencies.

Run `npm run validate` for syntax and deterministic collector/server tests; CI runs it on every pull request and also builds and verifies an artifact from the clean checkout. Run `node src/collector.mjs --config <host-config.json>` for a host snapshot. Start the central server with `node src/server.mjs --config <server-config.json>` and open its loopback URL for isolated UI acceptance. Production installation and tailnet exposure are owned by the host infra repositories.

Test hardware parsing, service classification, incomplete collection, offline/stale state, static path restrictions, and read-only API behavior. Browser acceptance must verify both host views, service filtering, attention events, last-update freshness, and narrow-screen usability using live installed data. Keep resource sampling distinct from lifetime counters. An inactive successful oneshot is normal; a failed unit or a configured continuously-running service that stops needs attention. An unreachable collector must never appear healthy.

Run browser acceptance against a running server with `node scripts/accept-browser.mjs --config <server-config.json> <url> <private-evidence-dir>`. It expects exactly the hosts in the server configuration, drives installed Chrome headed, and writes screenshots and `browser-receipt.json` to the evidence directory. Playwright is not a project dependency: it resolves from this checkout unless `HOST_MONITOR_PLAYWRIGHT_ROOT` names a directory whose `node_modules` contains it.

A host configuration has `name` (the server host name, without dots), optional `identity`, `required` (`system` and `user` lists), `probes`, `docker`, `requiredContainers`, and `nvidia`. The collector refuses to run unless the machine hostname matches `identity`, or `name` when `identity` is absent; both sides are compared case-insensitively after removing a `.local` suffix, so a Mac that reports `MacBook.local` uses `"identity": "MacBook"`.

The collector selects a platform adapter. On Linux it reads `/proc`, GNU `df`, `systemctl`, `journalctl`, and optionally `docker` and `nvidia-smi`. On macOS (`darwin`) it reads launchd without privileges: `required.user` lists LaunchAgent labels in the `gui/<uid>` domain (`user/<uid>` when there is no login session) and `required.system` lists LaunchDaemon labels in the `system` domain. Every loaded job is inventoried from `launchctl print <domain>`; each required label is also read with `launchctl print <domain>/<label>`, keeping only its type, state, pid, run count, last exit code or signal, run interval, and program name. A running job is healthy. A required job that is missing, exited non-zero, or was killed by a signal is an error; a required periodic job that last exited 0 is idle, and any other stopped required job is an error. Jobs that are not required never need attention, because launchd routinely stops idle agents. Error counts come from `/usr/bin/log show --last 1h --style ndjson` filtered to the program names of the required jobs (and to the collecting user for agents), streamed with a timeout and a line cap; only counts and the last timestamp are kept. macOS snapshots set `resources` to `external` and collect no CPU, memory, disk, or GPU data; the dashboard shows Beszel as their source instead of a failure. Snapshots stay `schemaVersion` 1: `platform`, `resources`, service `manager`, and journal `process` are optional additions.

The server configuration lists `hosts` (`name`, and either local `node`/`collector`/`config` paths or an `ssh` alias with remote paths), an optional `port` and `refreshSeconds`, and optional `importantServices`: service-name substrings that the dashboard's default "important services" filter shows in addition to required, failed, and container entries. Set it server-wide or per host; a host entry's list replaces the server-wide one.

## Releases

A release is the immutable artifact from `scripts/build-artifact.mjs`, identified by its artifact id: the SHA-256 content hash recorded as `artifact` in its `manifest.json`. To cut one, merge a change that sets `package.json` `version`, then push the matching tag from the merged commit on `main`:

```sh
git tag -s v<version> -m v<version> <merged-main-commit>
git push origin v<version>
```

The `release` workflow runs `npm run validate`, refuses a tag that differs from `v<package.json version>`, and publishes a GitHub release with these assets, produced by `scripts/package-release.sh OUTPUT TAG`:

- `host-monitor-<version>-<artifact-id>.tar.gz`: the artifact under one top-level directory of the same name.
- `verify-artifact.mjs` and `install-release.sh`: the admission and install scripts matching that artifact.
- `artifact-id`: the artifact id on one line.
- `SHA256SUMS`: checksums of the four files above.

Archive timestamps come from the tagged commit, so rebuilding the same tag reproduces the same tarball bytes.

An infrastructure repository pins the release by both version and artifact id, and installs it with Node 24 or newer:

```sh
version=<version> artifact=<artifact-id>
gh release download "v$version" --repo serenvia/host-monitor --dir release
cd release
sha256sum --check --strict SHA256SUMS
test "$(cat artifact-id)" = "$artifact"
tar -xzf "host-monitor-$version-$artifact.tar.gz"
node verify-artifact.mjs "host-monitor-$version-$artifact" "$artifact"
bash install-release.sh "$(command -v node)" "host-monitor-$version-$artifact" "$artifact" "$HOME"
```

`install-release.sh` verifies the artifact again, installs it to `<prefix>/.local/share/host-monitor/releases/<artifact-id>`, and prints that path; it is idempotent and refuses a drifted installed copy. The infrastructure repository then points its `current` link and service at that path and keeps the previous release for rollback.
