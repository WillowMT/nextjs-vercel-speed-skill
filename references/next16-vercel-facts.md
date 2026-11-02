# Next 16 + Vercel facts worth checking before you optimise

Everything here is behaviour a plan can get wrong from memory. Verify against
`node_modules/next/dist/docs/` in the project you are working in — Next ships its
own docs, and they win over anything you remember.

## Caching / rendering

- **`revalidate` does nothing on a dynamic route.** A route is dynamic if any
  layout or page in it touches a request-time API: `cookies()`, `headers()`,
  `searchParams`, `connection()`. Auth helpers read `headers()`, so the whole
  authenticated subtree is dynamic and `export const revalidate = 60` is silently
  ignored — the build still prints `ƒ (Dynamic)` for that route. Prove it with a
  build before promising a client ISR.
- `export const dynamic = "force-dynamic"` is equivalent to setting every
  `fetch` to `{ cache: "no-store", next: { revalidate: 0 } }`; the lowest
  `revalidate` across the layout+page chain decides the route's frequency.
- **Cache Components (Next 16).** `cacheComponents: true` + `partialPrefetching:
  true` go at the **top level** of `next.config.ts` (not under `experimental`),
  and enabling them **removes** the `dynamic`, `dynamicParams`, `revalidate` and
  `fetchCache` segment configs. It also requires the Node runtime and forbids the
  `runtime` segment config. In exchange a route gets a prerendered shell served
  from the CDN with the dynamic parts streaming in — the thing that makes a cold
  start feel like a slow number instead of a blank screen.
- Data cache: `unstable_cache(fn, keyParts, { tags, revalidate })`. Invalidate
  with `updateTag(tag)` (expires immediately, safe inside a Server Action) plus
  `revalidatePath("/", "layout")` for the client router cache. `revalidateTag`
  is the stale-while-revalidate sibling.
- A file-cache delete (`rm -rf .next/cache/fetch-cache`) does **not** clear what a
  running server already holds in memory. To see out-of-band writes (a seed
  script, raw SQL), restart the server or call the app's own revalidate path.

## Vercel

- Default function region is **`iad1` (Washington, D.C.)** for all new projects.
  Pin it with `vercel.json`: `{ "regions": ["sin1"] }`, or in project settings.
  Confirm what actually served a request with
  `curl -sI https://app | grep -i x-vercel-id` — the value starts with the region
  id (`sin1::…`).
- Common region ids: `iad1` us-east, `sfo1` us-west, `fra1` eu-central,
  `lhr1` eu-west, `sin1` Singapore, `hnd1` Tokyo, `bom1` Mumbai, `syd1` Sydney.
  Match the region to the database, not to the users, when the DB is the
  bottleneck.
- Crons on the Hobby plan run **once a day**; finer intervals need Pro. A
  keep-warm cron that hits `/api/health` every 5 minutes is therefore a Pro move.
- Fluid Compute is the default for new projects: instances stay warm between
  requests and reuse module state (including open sockets). Verify it is on
  before blaming cold starts.
- The build picks the package manager from the lockfile. Two lockfiles
  (`bun.lock` + `package-lock.json`) is ambiguous — keep one, or set
  `packageManager` in `package.json`.
- `engines.node` in `package.json` selects the runtime version. Prefer a range
  (`">=22"`) over an exact (`"22.x"`) if developers run a newer Node locally;
  `22.x` makes npm warn on every install for them.
- Better Auth style auth without `BETTER_AUTH_URL` derives callbacks from the
  request and warns at build. Set it to the deployment origin.

## Neon (and other serverless Postgres)

- The `-pooler` host is PgBouncer. Use it for anything that opens sockets;
  `DATABASE_URL_UNPOOLED` is for schema changes.
- `@neondatabase/serverless` gives two modes:
  - `neon(url)` — HTTP. One request per query, no session, no handshake state.
    `sql.query(text, params, { fullResults: true })` returns
    `{ rows, rowCount, fields, command }`. It parses types exactly like `pg`
    (timestamps → `Date`, `bigint`/`numeric` → string, `jsonb` → object).
    Cannot hold a transaction across statements.
  - `Pool` — sockets (WebSocket, needs `ws` in Node, or `neonConfig.poolQueryViaFetch`
    to route pool queries over HTTP). Needed for interactive transactions and for
    ORMs/adapters (Kysely, Better Auth) that expect a session.
- One small pool per serverless instance is right (`max` 1–3, `idleTimeoutMillis`
  ~10s, `allowExitOnIdle: true`). A 10-connection pool multiplied by every
  instance is how projects hit the connection cap during a traffic spike.
