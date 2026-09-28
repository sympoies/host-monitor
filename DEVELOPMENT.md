# Development

Node 24 or newer is required. There are no third-party runtime dependencies.

Run `npm run validate` for syntax and deterministic collector/server tests. Run `node src/collector.mjs --config <host-config.json>` for a host snapshot. Start the central server with `node src/server.mjs --config <server-config.json>` and open its loopback URL for isolated UI acceptance. Production installation and tailnet exposure are owned by the host infra repositories.

Test hardware parsing, service classification, incomplete collection, offline/stale state, static path restrictions, and read-only API behavior. Browser acceptance must verify both host views, service filtering, attention events, last-update freshness, and narrow-screen usability using live installed data. Keep resource sampling distinct from lifetime counters. An inactive successful oneshot is normal; a failed unit or a configured continuously-running service that stops needs attention. An unreachable collector must never appear healthy.

Run browser acceptance against a running server with `node scripts/accept-browser.mjs --config <server-config.json> <url> <private-evidence-dir>`. It expects exactly the hosts in the server configuration, drives installed Chrome headed, and writes screenshots and `browser-receipt.json` to the evidence directory. Playwright is not a project dependency: it resolves from this checkout unless `HOST_MONITOR_PLAYWRIGHT_ROOT` names a directory whose `node_modules` contains it.

The server configuration lists `hosts` (`name`, and either local `node`/`collector`/`config` paths or an `ssh` alias with remote paths), an optional `port` and `refreshSeconds`, and optional `importantServices`: service-name substrings that the dashboard's default "important services" filter shows in addition to required, failed, and container entries. Set it server-wide or per host; a host entry's list replaces the server-wide one.
