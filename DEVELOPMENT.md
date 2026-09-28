# Development

Node 24 or newer is required. There are no third-party runtime dependencies.

Run `npm run validate` for syntax and deterministic collector/server tests; CI runs it on every pull request and also builds and verifies an artifact from the clean checkout. Run `node src/collector.mjs --config <host-config.json>` for a host snapshot. Start the central server with `node src/server.mjs --config <server-config.json>` and open its loopback URL for isolated UI acceptance. Production installation and tailnet exposure are owned by the host infra repositories.

Test hardware parsing, service classification, incomplete collection, offline/stale state, static path restrictions, and read-only API behavior. Browser acceptance must verify both host views, service filtering, attention events, last-update freshness, and narrow-screen usability using live installed data. Keep resource sampling distinct from lifetime counters. An inactive successful oneshot is normal; a failed unit or a configured continuously-running service that stops needs attention. An unreachable collector must never appear healthy.

Run browser acceptance against a running server with `node scripts/accept-browser.mjs --config <server-config.json> <url> <private-evidence-dir>`. It expects exactly the hosts in the server configuration, drives installed Chrome headed, and writes screenshots and `browser-receipt.json` to the evidence directory. Playwright is not a project dependency: it resolves from this checkout unless `HOST_MONITOR_PLAYWRIGHT_ROOT` names a directory whose `node_modules` contains it.

A host configuration has `name` (the server host name, without dots), optional `identity`, `required` (`system` and `user` lists), `probes`, `docker`, `requiredContainers`, and `nvidia`. The collector refuses to run unless the machine hostname matches `identity`, or `name` when `identity` is absent; both sides are compared case-insensitively after removing a `.local` suffix, so a Mac that reports `MacBook.local` uses `"identity": "MacBook"`.

The collector selects a platform adapter. On Linux it reads `/proc`, GNU `df`, `systemctl`, `journalctl`, and optionally `docker` and `nvidia-smi`. On macOS (`darwin`) it reads launchd without privileges: `required.user` lists LaunchAgent labels in the `gui/<uid>` domain (`user/<uid>` when there is no login session) and `required.system` lists LaunchDaemon labels in the `system` domain. Every loaded job is inventoried from `launchctl print <domain>`; each required label is also read with `launchctl print <domain>/<label>`, keeping only its type, state, pid, run count, last exit code or signal, run interval, and program name. A running job is healthy. A required job that is missing, exited non-zero, or was killed by a signal is an error; a required periodic job that last exited 0 is idle, and any other stopped required job is an error. Jobs that are not required never need attention, because launchd routinely stops idle agents. Error counts come from `/usr/bin/log show --last 1h --style ndjson` filtered to the program names of the required jobs (and to the collecting user for agents), streamed with a timeout and a line cap; only counts and the last timestamp are kept. macOS snapshots set `resources` to `external` and collect no CPU, memory, disk, or GPU data; the dashboard shows Beszel as their source instead of a failure. Snapshots stay `schemaVersion` 1: `platform`, `resources`, service `manager`, and journal `process` are optional additions.

The server configuration lists `hosts` (`name`, and either local `node`/`collector`/`config` paths or an `ssh` alias with remote paths), an optional `port` and `refreshSeconds`, and optional `importantServices`: service-name substrings that the dashboard's default "important services" filter shows in addition to required, failed, and container entries. Set it server-wide or per host; a host entry's list replaces the server-wide one.

### Scheduling, history, and alerts

Each host runs its own collection loop. A host entry may set `refreshSeconds` (default: the server-wide `refreshSeconds`, which defaults to 20) and `timeoutSeconds` (default 30). The next collection for a host starts `refreshSeconds` after its previous attempt settles. An attempt that exceeds `timeoutSeconds` marks only that host offline, so a hung host never delays the others. A snapshot is stale once it is older than three refresh intervals of its host.

The server records attention transitions: a new attention item, a recovered item, a host whose collector has been unreachable for `alerts.offlineAfterSeconds`, and that host becoming reachable again. An item is identified by its kind and title. A changed detail, such as a new journal count, is not a new item.

The optional `stateDir` is an absolute path to a private directory that holds two files:

- `events.jsonl`: the append-only transition log. It is rotated to `events.1.jsonl` when it would exceed `historyMaxBytes` (default 1 MiB), so at most two files are kept. Each write re-reads the current file size, so a file removed or truncated outside the server is recreated; the server logs one fixed-string warning per failure streak.
- `alert-state.json`: the active items per host. A restart therefore neither re-announces items that were already notified nor misses items that changed meanwhile.

Without `stateDir`, the most recent 500 events are kept in memory only. A host seen for the first time without saved state becomes a silent baseline.

`GET /api/events?limit=<1-500>&host=<configured host>` returns the recent events, newest first. The dashboard shows the last 20 events for the selected host.

The optional `alerts` object sends transitions to a notification relay. The keys are:

| Key | Meaning |
| --- | --- |
| `webhookUrl` | Required. A plain `http`/`https` URL on loopback (`127.0.0.1`, `localhost`, `[::1]`) or the tailnet (`*.ts.net` or `100.64.0.0/10`). URLs with credentials or a query string are rejected. |
| `authEnv` | Optional. The name of an environment variable whose value is sent as `Authorization: Bearer <value>`. Configuration never holds a token. |
| `kinds` | Attention kinds that are notified. Default: `service`, `unit`, `container`, `probe`. Other kinds are recorded in history only. |
| `offlineAfterSeconds` | Default 300; `0` disables offline alerts. |
| `quietHours` | `{"start":"23:00","end":"07:00","timeZone":"Asia/Taipei"}`. During quiet hours alerts are held and sent afterwards as one summary; an item that recovers meanwhile is dropped. |

Delivery runs on its own bounded queue: 100 messages, 3 attempts with backoff, and a 5 s request timeout. Collection never waits for it.

Each alert is one JSON `POST` in the Apprise API shape used by the sympoies `telegram-notify` relay. That relay is `http://127.0.0.1:8000/notify` on sympoies, the same endpoint dsh-notify uses, and it holds the Telegram token server-side. For example:

```json
{"title":"[host-monitor] c8: service needs attention","body":"web.service — user · inactive · success","type":"failure","format":"text"}
```

The `type` values are:

- `failure`: an error-severity attention item, or an unreachable collector;
- `warning`: any other attention item;
- `success`: a recovery;
- `info`: the quiet-hours summary.

Every title starts with `[host-monitor]`.

Alert ownership follows fleet-infra decision 0002:

- Beszel alerts on resource thresholds (CPU, memory, disk, temperature, GPU) and on agent host-down. Its failed-systemd alert stays disabled.
- host-monitor alerts on service health: required units and launchd jobs, containers, and probes.

The host-monitor offline alert means that SSH or the collector is unreachable, which Beszel cannot see. Set `offlineAfterSeconds` to `0` to leave host-down entirely to Beszel.

Example server configuration:

```json
{"port":9105,"refreshSeconds":20,"stateDir":"/var/lib/host-monitor","historyMaxBytes":1048576,
 "alerts":{"webhookUrl":"http://127.0.0.1:8000/notify","offlineAfterSeconds":300,"quietHours":{"start":"23:00","end":"07:00","timeZone":"Asia/Taipei"}},
 "hosts":[{"name":"c8","ssh":"c8","node":"/usr/bin/node","collector":"/opt/host-monitor/current/src/collector.mjs","config":"/etc/host-monitor/c8.json","refreshSeconds":30,"timeoutSeconds":20}]}
```

## Releases

A release is the immutable artifact from `scripts/build-artifact.mjs`, identified by its artifact id: the SHA-256 content hash recorded as `artifact` in its `manifest.json`. To cut one, merge a change that sets `package.json` `version` and adds its release entry to the development log (`docs/devlog/`; this repository keeps no `CHANGELOG.md`), then push the matching tag from the merged commit on `main`:

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

The workflow writes the release notes itself: the artifact id, the install steps, the `SHA256SUMS` contents, and a link to `docs/devlog/` at the tag, where the release entry describes the changes.

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
