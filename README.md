# Concrete Pulse

A read-only community tool answering: **What is changing across Concrete right now?**
It compares live vault snapshots to show TVL, APY, depositor, new-vault and
removed-vault activity. It provides no wallet connection, signing, transactions,
or investment recommendations. This is a community project, not an official
Concrete product.

## Run locally

Tested with Node.js 24 and npm. Install the locked dependencies:

```sh
npm ci
npm start
```

Open http://127.0.0.1:3000. Use **Refresh Pulse** to retrieve the latest completed comparison.
Run `npm test` for offline engine/API tests. For terminal output, stop the server
first and run `node pulse.js`; only one process should write the snapshots.

## Architecture

- `pulse.js` fetches grouped vault data using `@concrete-xyz/sdk`, validates and
  compares snapshots, saves the original source data, and exports reusable functions.
- `server.js` uses Express to serve `public/` and cached API results.
- `public/index.html`, `style.css`, and `app.js` provide the vanilla browser UI.
- `GET /api/health` reports liveness and collector readiness.
- `GET /api/pulse` returns the last completed comparison with freshness metadata.

## Comparisons and snapshots

Vaults are matched by chain ID and case-insensitive address. Changes are sorted
by absolute movement. TVL is shown in USD, APY as percentages with movements in
percentage points, and depositors as whole numbers. APY `-1` and invalid values
are unavailable in results; original source values remain in snapshots.

A TVL change is notable when its absolute USD movement is **at least $1,000 OR
its absolute relative movement is at least 1%**. Relative change is unavailable
when previous TVL is zero. Raw changes are retained regardless of significance.
Most Active Vaults lists vaults appearing in more than one distinct change
category in the current comparison, including raw TVL changes. It is an activity
count, not an investment or risk score.

Runtime storage is ignored by Git. See production collection and storage below.

Comparisons reflect API responses, not transaction history: TVL movement can
include asset-price changes, and absence does not establish why a vault vanished.
JavaScript numeric precision is suitable for display, not accounting settlement.

## Branding and dependencies

See [BRAND.md](BRAND.md) for the original Concrete asset sources and the public
system-font/text-label fallback. The official logo and font files used during local
design work were removed before public publication because redistribution permission
was not confirmed. They may only be restored after permission or applicable license
terms are confirmed.

The Concrete SDK, Express, and official `@vercel/blob` SDK are direct dependencies.
The latest reviewed npm audit reported **2 high** and **24 moderate** findings. The
two high findings enter through optional wallet-related dependencies of
`@concrete-xyz/sdk`; Concrete Pulse uses the SDK's read-only vault-data request path.
No exploitability through Concrete Pulse was demonstrated. This does not claim that
the packages or application are vulnerability-free. No package was upgraded and no
automatic audit fix was applied.

## License

Original Concrete Pulse source code is available under the [ISC License](LICENSE).
That license covers the project's own code only. It does not grant rights to Concrete
names, trademarks, logos, fonts, third-party packages or other third-party assets.

## Local collection and storage

The server owns one collector. `/api/pulse` is now a cached read and never
advances the baseline. Refresh Pulse retrieves that completed result. The
collector starts immediately if no fresh saved result exists, then waits one
interval after each attempt before collecting again. Concurrent internal triggers
join the active operation; there is no visitor-triggered queue. Failed attempts
retry at the same interval, limiting upstream traffic even during outages.

Configuration (all optional):
- `PORT`: 3000; the server binds to `0.0.0.0` for Node hosting.
- `PULSE_DATA_DIR`: local `data/` by default; local storage path (not used by Vercel).
- `PULSE_INTERVAL_MS`: 300000 (five minutes).
- `PULSE_TIMEOUT_MS`: 15000; aborts the underlying SDK request.

`pulse-state.json` contains previous/current raw snapshots, their completed
comparison, and a bounded 24-hour compact observation history in one generation.
A staged file is flushed before atomic rename;
`pulse-backup.json` retains the preceding valid generation. Restart validates the
snapshots and recomputes the result; malformed primary state falls back to backup.
If both are invalid, collection fails closed instead of erasing evidence. Restore
one from a verified backup. Incomplete `.tmp` files are ignored. Original legacy
latest/previous files are imported when no new generation exists and kept intact;
they are no longer updated. Use the generation file for current raw source data.

`collector.lock` uses exclusive file creation and is held for the writer's lifetime.
The CLI uses the same lock: stop the server before running `node pulse.js`.
SIGINT/SIGTERM stop scheduling, abort active work, wait for it, and release the lock.
After a forced kill or machine failure, the lock deliberately remains: verify that
no writer is running before removing only `collector.lock`, then restart. Do not
remove it automatically based on age or PID across containers. Saved generations
remain recoverable. This design requires one service instance and a filesystem
with atomic same-directory rename; it is not distributed locking. Keep disk backups.

`/api/health` is a liveness response (HTTP 200) with ready/collecting/state/stale and
lastSuccessfulCollection. `/api/pulse` includes the same fields under `freshness`.
It serves last-good data during outages with `stale: true`; timestamps are never
rewritten to look fresh. Without any valid result it returns generic JSON HTTP 503
and Retry-After. The UI uses its existing status text for stale results.

No public rate limiter is added: requests only read cached state. Use hosting-edge
limits if needed for request/response volume. Dependency risk acceptance or
remediation still needs resolution before public deployment. Nothing has been deployed.

## Vercel architecture (prepared, not deployed)

Concrete API → GitHub Actions `/api/collect` → private Vercel Blob →
read-only `/api/pulse` → unchanged frontend.

`api/*.js` are standalone Node functions. Vercel serves `public/` as static files;
there is no Next.js or long-running production collector. Use Other as the framework
preset and Node 24. Local `npm start` still uses Express and filesystem storage;
it needs no Blob credentials. `node pulse.js` remains local. Neither command is
a Vercel startup command.

Create a PRIVATE Blob store connected to the project. Required Vercel environment variables:
- `BLOB_READ_WRITE_TOKEN`: supplied by the connected private store.
- `CRON_SECRET`: random secret of at least 16 characters. The collector expects it
  as `Authorization: Bearer ...`. Missing or short secrets fail closed.

Optional Vercel environment variables:
- `PULSE_BLOB_PATH`: defaults to `pulse/generation.json`; keep stable across deployments.
- `PULSE_INTERVAL_MS`: freshness threshold, 300000. This does not change the
  GitHub Actions schedule.
- `PULSE_TIMEOUT_MS`: upstream abort deadline, 15000. Leave time within the function's
  60-second duration for two Blob operations, each with a 10-second deadline.

Production scheduling uses `.github/workflows/pulse-collector.yml`. GitHub Actions
runs it every five minutes and also exposes `workflow_dispatch` for a manual run.
Configure these GitHub repository secrets:
- `PULSE_BASE_URL`: the deployed production origin, without a required trailing slash.
- `CRON_SECRET`: the collector secret. It must be identical to the `CRON_SECRET`
  configured in Vercel.

The workflow sends an authenticated GET request to
`${PULSE_BASE_URL}/api/collect`. It uses curl's failure mode for non-2xx responses,
has a request timeout, retries transient connection failures, and never echoes the
authorization header. GitHub scheduled workflows are the production scheduler;
Vercel Cron is not configured or required, so this architecture supports Vercel Hobby.

### GitHub setup

Commit the included `.github/workflows/pulse-collector.yml` workflow to the repository's
default branch and enable GitHub Actions. After the first Vercel deployment provides
the production origin, add `PULSE_BASE_URL` and `CRON_SECRET` under the repository's
Actions secrets. Do not commit either value. `CRON_SECRET` must exactly match the
server-only value configured in Vercel. Use the workflow's manual dispatch once to
confirm the deployed collector before relying on its five-minute schedule.

The private JSON object contains `version`, `previous`, `current`, `collectedAt`,
`history`, and `result` (summary counts and change arrays). Raw APY sentinels remain
in snapshots. History stores normalized vault metrics grouped by chain and address;
it is internal and is not returned by `/api/pulse`.
Freshness is derived from `collectedAt` on every read, including cold starts.
No Blob URL or token reaches the browser. Malformed persisted data fails closed.

`blob-storage.js` implements async `load() -> {generation, revision}` and
`commit(generation, revision)`. `file-generation-store.js` has the same contract
for local function testing. Shared generation functions validate and calculate;
routes do not duplicate metrics.

Blob reads bypass its cache with `useCache: false` and obtain content and ETag
together. Updates use `ifMatch`; first creation uses `allowOverwrite: false` and
no random suffix. Two invocations may fetch upstream, but only one can commit
against the baseline they both read. A loser skips without rebasing or retrying.
Duplicate scheduler deliveries within 60 seconds of success skip fetching. No database,
distributed lease, local disk or local lock is used by production functions.

`vercel.json` keeps a 60-second function duration and has no Vercel Cron entry.
The external workflow targets the URL in `PULSE_BASE_URL`. First success creates a
baseline; the next creates changes. Before first success, reads return JSON 503.

Upstream failure preserves the successful object. It becomes stale after the
freshness interval; no separate cross-instance failure flag is stored. Blob service
outages return 503 because a cold function cannot read last-good data then. Health
reports stored readiness/freshness, not an invented global in-progress flag.

API reads access Blob, not Concrete. Blob operations and function usage have costs.
This retains one complete comparison plus the latest 24 hours of compact observations,
not an unbounded archive. A conditional commit is
atomic; a lost acknowledgement can mean a complete generation was committed even
though the caller saw an error. The next origin read is authoritative.

Before deployment:
1. Review dependency risk acceptance/remediation. Do not restore restricted brand
   files unless their redistribution terms are confirmed.
2. Connect a private Blob store to the Vercel Hobby project.
3. Set the Vercel variables above; isolate previews with a different store or Blob path.
4. Set `PULSE_BASE_URL` and the identical `CRON_SECRET` as GitHub repository secrets.
5. Connect GitHub, select Other / Node 24, retain the checked-in configuration,
   and run `npm test` in CI. Keep the output directory `public`.
6. After a separately authorized deployment, manually dispatch the workflow and verify
   unauthenticated collect returns 401, scheduled collection succeeds, the generation
   survives cold starts, concurrent collectors
   cannot overwrite each other, and stale/503 behavior is correct.

Tests mock Blob and never contact a real store. Real Vercel build/runtime and
conditional-write behavior remain to be verified with deployment credentials.

References: [Blob SDK](https://vercel.com/docs/vercel-blob/using-blob-sdk),
[conditional writes](https://vercel.com/docs/vercel-blob),
[GitHub Actions scheduled workflows](https://docs.github.com/actions/using-workflows/events-that-trigger-workflows#schedule),
[GitHub Actions repository secrets](https://docs.github.com/actions/security-guides/using-secrets-in-github-actions).
