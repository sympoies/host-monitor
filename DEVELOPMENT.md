# Development

Node 24 or newer is required. There are no third-party runtime dependencies.

Run `npm run validate` for syntax and deterministic collector/server tests. Run `node src/collector.mjs --config <host-config.json>` for a host snapshot. Start the central server with `node src/server.mjs --config <server-config.json>` and open its loopback URL for isolated UI acceptance. Production installation and tailnet exposure are owned by the host infra repositories.

Test hardware parsing, service classification, incomplete collection, offline/stale state, static path restrictions, and read-only API behavior. Browser acceptance must verify both host views, service filtering, attention events, last-update freshness, and narrow-screen usability using live installed data. Keep resource sampling distinct from lifetime counters. An inactive successful oneshot is normal; a failed unit or a configured continuously-running service that stops needs attention. An unreachable collector must never appear healthy.
