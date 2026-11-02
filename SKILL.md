---
name: nextjs-vercel-speed
description: Make a Next.js app on Vercel faster — cold starts, slow first loads, sluggish authenticated pages, slow server actions, "it got slower/faster after deploy", TTFB and navigation latency, database-in-the-wrong-region problems, heavy serverless bundles, and mobile load complaints on a Vercel URL. Use this whenever anyone mentions Vercel performance, cold start latency, function regions, Neon/Supabase/Postgres latency from Vercel, "why is my dashboard slow", slow page transitions, or asks to speed up a deployment — even if they never say the words "cold start" or "performance". Also use it before proposing ISR or caching changes to an authenticated app, since those are usually the wrong lever.
---

# Next.js → Vercel speed

## The only model you need

A cold request on Vercel costs, in order:

```
lambda init (the JS this function must load)  +  first DB touch (handshake + query)  +  render
       100–500 ms                                    0–600 ms                       5–50 ms
```

Every fix below attacks one of those three terms. The common waste in this domain
is optimising a term that is already small — shaving React render time off a page
that spends 500 ms on a cross-ocean TCP handshake. So: measure first, and measure
the **cold** path. Warm numbers hide both handshake and init, and warm numbers are
what people quote when they say "it feels fine on my machine".

## Step 0 — Which slowdown is this?

Determine this before touching code. They have different fixes.

| Symptom | Usually |
| --- | --- |
| First visit after idle is slow, then fine | cold start: lambda init or DB handshake |
| Every navigation is slow, evenly | round-trip latency, or sequential query waterfall |
| One route is slow, the rest fine | that route's module graph (heavy dependency) or its query |
| Slow right after a deploy, fine after | cold data cache + cold instances; measure, do not panic-fix |
| Slow for users in one country only | function region vs users |
| Fast, then slow again after a few minutes | session/cookie cache expiry (see Traps) |
| Slow only on first paint, then content pops in | no static shell: nothing paints until the function responds |

## Step 1 — Two facts decide most of it

1. **Where is the database?** Run `node scripts/measure-db-latency.mjs`. It prints
   the host, whether it is a pooled endpoint, and (for Neon) the region embedded in
   the hostname. Other providers: read the connection string / dashboard.
2. **Where do functions run?** Vercel's default is `iad1` (Washington, D.C.) for
   every new project, regardless of where your users are.

Mismatch means every query crosses an ocean: roughly 200–250 ms US↔Asia, ~150 ms
US↔Europe, per round trip, and roughly double that for the TCP+TLS+auth handshake a
cold instance must perform. Fixing the region is one line and beats every other
optimisation combined. If they match, move on.

## Step 2 — Measure the three numbers

Run these with the working directory set to the **project being measured**: that is
how the scripts find `DATABASE_URL`, `.next/` and the project's installed drivers.

```bash
SKILL=${SKILL:-$HOME/.agents/skills/nextjs-vercel-speed}

# 1. Database: cold first touch vs steady-state round trip
node "$SKILL/scripts/measure-db-latency.mjs"

# 2. Pages: TTFB for authenticated routes. Signs in through a Better Auth
#    email/password endpoint; pass JAR=... to reuse any other cookie jar.
BASE=http://localhost:3000 EMAIL=you@example.com PASSWORD=secret \
  bash "$SKILL/scripts/measure-pages.sh" / /orders /payments

# 3. Weight: what a cold function must load, straight from the build trace
npm run build && node "$SKILL/scripts/audit-routes.mjs"
```

Then measure the cold path explicitly: restart the server (or hit a fresh deploy)
and time only the **first** request. That number carries module init; the second
request does not.

Compare against `references/calibration.md`, which lists what these numbers look
like on a real measured app. If your numbers look like that table, the remaining
cost is structural (region, handshake, bundle), not a code smell.

## Step 3 — Fix in this order

Stop whenever the user's complaint is gone. Each row attacks a different term.

| # | Fix | Cold-path win | Cost | Risk |
| --- | --- | --- | --- | --- |
| 1 | Pin the function region to the database's region | 200 ms → ~2 ms per round trip; ~500 ms → ~30 ms handshake | one config line | none |
| 2 | One pool per instance, sized for serverless | removes a duplicate handshake | small refactor | none |
| 3 | Stateless driver (HTTP) for queries that need no transaction | cold first touch ~257 → ~137 ms; +3 ms steady | medium | must not carry transactional work |
| 4 | Static shell via Cache Components / PPR | first paint from CDN instead of after the function | large | rendering model change |
| 5 | Keep instances warm (Fluid Compute, cron ping) | repeats disappear | small | plan limits |
| 6 | Keep heavy deps off the page graph | 100s of ms off that route's init | small | none |
| 7 | Trim client JS / font preloads | LCP, INP on mobile | small | none |

Do not reorder 1–3 into "the fun one" — region first, then pools, then transport.
A transport change measured against a region mismatch shows almost nothing.

## Playbooks

### 1. Co-locate the functions

```json
// vercel.json
{ "$schema": "https://openapi.vercel.sh/vercel.json", "regions": ["sin1"] }
```

Region ids: `iad1` us-east, `sfo1` us-west, `fra1` eu-central, `lhr1` eu-west,
`sin1` Singapore, `hnd1` Tokyo, `bom1` Mumbai, `syd1` Sydney. Choose the region
next to the **database** when the DB is the bottleneck, next to the users when it
is not.

Verify what actually served the request — do not assume the config took:

```bash
curl -sI https://your-app.vercel.app | grep -i x-vercel-id   # sin1::abc-123
```

### 2. One pool, sized for serverless

Find every pool first: `grep -rn "new Pool(" --include="*.ts" .` — apps often end
up with one in the data layer and a second in the auth config, which doubles the
handshake on every cold instance and multiplies the connection count against the
provider's cap.

```ts
new Pool({
  connectionString,          // the pooled (-pooler) endpoint
  max: 3,                    // each instance serves ~one request at a time
  idleTimeoutMillis: 10_000,
  allowExitOnIdle: true,     // let the process exit without waiting
})
```

Keep the pool on `globalThis` in non-production so dev HMR does not open a new one
per reload.

### 3. Move stateless queries to an HTTP driver

The win exists because a cold function has no socket. A stateless driver turns the
first query into one HTTPS request with no session to establish.

**Before moving anything, prove type parity.** This is the step that decides
whether the swap is safe, and it takes one script:

```js
const SQL = "select now() as ts, current_date as d, 123.45::numeric as n, " +
            "42::bigint as b, '{\"a\":1}'::jsonb as j, 7 as i, null::text as nil"
// time/print every column's typeof from both drivers and diff them
```

If timestamps or numerics come back with different shapes, the swap will silently
break formatting and comparisons in a dozen places — stop and keep the socket
driver.

**Then split by semantics, not by taste:**

- reads and single-statement writes → HTTP (`neon(url)`; `sql.query(text, params,
  { fullResults: true })` gives `{ rows, rowCount }`)
- interactive transactions (`BEGIN`/`COMMIT` across statements), and any
  ORM/adapter that expects a session (Kysely, Better Auth, Prisma) → keep the pool

```bash
# what must stay on the socket path
grep -rn "pool.connect\(\)\|BEGIN\|begin()" --include="*.ts" . | grep -v node_modules
```

Keep the two exported from one module so call sites do not care which transport
they got, and write down in a comment why each exists.

### 4. Serve a static shell (Cache Components)

When the complaint is "the screen sits blank", caching data will not help — the
HTML itself is behind the function. In Next 16:

```ts
// next.config.ts — top level, not under experimental
export default {
  cacheComponents: true,
  partialPrefetching: true,
} satisfies NextConfig
```

Enabling it **removes** the `dynamic`, `dynamicParams`, `revalidate` and
`fetchCache` segment configs, so delete those exports; data suspends under the
`loading.tsx` boundaries a healthy app already has. Budget it as a migration, not
a flag flip: verify every route still streams and nothing that needed a
request-time value got frozen into the shell.

### 5. Keep instances warm

Fluid Compute (default on new projects — verify) lets instances reuse module state,
including open sockets, between requests. On a Pro plan a cron hitting a cheap
route every five minutes keeps the pool warm; on Hobby crons run once a day, so
this lever is not available there and region + transport matter more.

### 6. Get heavy dependencies out of the page graph

`node scripts/audit-routes.mjs` lists traced size per route and the dominant
packages inside the heaviest one. A page carrying a PDF/image/spreadsheet library
pays for it on every cold start even though the library is used once a month:

- import such libraries only from the route handler (or Server Action) that needs
  them, never from a module a page also imports
- `await import(...)` inside the handler keeps it out of the page graph
- note that `serverExternalPackages` keeps a package `require`-able rather than
  bundled; it does **not** shrink the traced files, so it is a correctness knob,
  not a size knob

### 7. Client weight

```ts
experimental: { optimizePackageImports: ["recharts", "lucide-react", "@tanstack/react-table"] }
```

Load chart/markdown/editor libraries with `next/dynamic` so they do not ship on
every page. For `next/font`, set `preload: false` on families used only by a
non-default locale — a subset you never render should not sit on the critical path.

## Traps

- **`export const revalidate` on an authenticated route is a no-op.** Any layout
  reading `headers()`/`cookies()` makes the route dynamic and the build still shows
  `ƒ`. If you promise ISR, prove it with a build first. Removing auth from a layout
  to force prerendering turns per-user data into shared cache — do not.
- **A file-cache delete does not clear in-memory data.** `rm -rf
  .next/cache/fetch-cache` will not touch what a running server holds. After
  out-of-band writes (seed scripts, raw SQL) restart the server or trigger the
  app's own revalidate path. If the UI shows a stale row, check the cache before
  debugging the query.
- **Cookie-cache expiry looks like a performance regression.** A session cache
  with a few minutes of TTL means one extra DB round trip on some requests; if the
  round trip is cross-ocean, warm renders suddenly measure ~2 RTT. Fix the region,
  not the session layer.
- **A duplex lockfile makes the build machine guess.** Keep exactly one of
  `bun.lock` / `package-lock.json` / `pnpm-lock.yaml`, or set `packageManager`.
- **`engines.node: "22.x"` warns on every install** for developers on a newer Node.
  Prefer `">=22"` unless the platform needs an exact major.
- **Counting queries with `pg_stat_database` is unreliable** — the stats view lags
  by up to a second, so tight before/after deltas come back as 0 or negative.
- **Patching `pg` from a `NODE_OPTIONS` preload may miss the app's copy**, because
  Next bundles dependencies. Same reason a top-level import patch can silently do
  nothing while the "unpatched" health route still logs.
- **Do not move transaction paths to a stateless driver.** A single-statement write
  is fine; `BEGIN … COMMIT` across statements is not, and the failure mode is data
  corruption under load rather than a clean error.
- **HTTP driver per-query cost is real** (~3 ms here). Do not switch a long-lived
  self-hosted server just to remove a handshake it pays once.

## Verify before claiming it is faster

```bash
npx tsc --noEmit && npm run lint && npm run build     # build prints the render mode per route
npm start -- -p 3111 &                                # serve the real build
BASE=http://127.0.0.1:3111 EMAIL=... PASSWORD=... bash scripts/measure-pages.sh / /orders
```

Then exercise the flows the change could plausibly have broken — this is where
transport swaps earn or lose trust:

- sign in and confirm the login lands in whatever audit/log table the app keeps
- load every page type (list, detail, dashboard)
- perform the main write (create/record/edit) and read it back
- hit the file/PDF/export endpoints
- use the app's own refresh/revalidate control and confirm a stale row disappears

Report the before/after numbers you actually measured, plus anything you could not
fix from the repo (deployment env vars, plan-gated features, the region the
platform actually served). Never present a config change as a measured win.

## Files

Run all three from the project root; they take the project as the measuring
target and resolve its dependencies themselves.

- `scripts/measure-db-latency.mjs` — cold vs steady query latency, both drivers
- `scripts/measure-pages.sh` — authenticated page TTFB, warm and first-hit
- `scripts/audit-routes.mjs` — traced function weight per route, dominant packages
- `references/next16-vercel-facts.md` — Next 16 caching flags, Vercel region/plan
  facts, Neon driver modes. Read before designing a caching or transport change.
- `references/calibration.md` — real measured numbers to compare against; read it
  when deciding whether a number is "bad" or just normal.
