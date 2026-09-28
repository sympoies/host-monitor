# Host Monitor

A central, read-only web dashboard for Linux host resources, installed system/user services, container state, functional probes, and recent journal error counts.

Each host owns its collector configuration through its infrastructure repository. The portable collector emits a versioned JSON snapshot over an existing SSH connection; the server schedules collection and serves the UI on loopback. Tailnet exposure belongs to infrastructure. There are no third-party runtime dependencies, browser shell actions, raw journals, environment dumps, or provider data.

The dashboard retains accurate offline/stale state, shows installed inactive services, treats successful dormant oneshots as idle, and flags failed units, stopped required services, missing required containers, failed probes, and disk/memory pressure. Running containers without a health check are labeled unverified instead of healthy. Journal counts are grouped by unit and priority; their private message contents never leave the collector.

## Run and validate

Use Node 24 or newer. Run `npm run validate`. Configure each host and the central server as described in [DEVELOPMENT.md](DEVELOPMENT.md). Infrastructure owns host identities, required services, loopback probes, installation, restart, rollback, and tailnet routing. A new host is a configuration entry, not another copy of the web application.

The app currently runs as a native user service with an immutable installed artifact. It does not build inside a host Compose stack. Preserve the last installed release for rollback, and verify both host snapshots and rendered browser behavior before declaring deployment complete.
