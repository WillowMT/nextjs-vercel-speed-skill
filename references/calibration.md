# Calibration — what the numbers look like on a measured app

From a Next 16 app on Vercel-shaped serverless assumptions, Postgres (Neon)
branch in `ap-southeast-1`, measured from a client in Asia (so the numbers
include realistic WAN latency).

## Database

| Measurement | Value |
| --- | --- |
| Steady query RTT (`pg` over TCP) | 33 ms |
| Steady query RTT (Neon HTTP) | 36 ms |
| First query, cold (TCP: connect + TLS + auth + query) | 257–338 ms |
| First query, cold (HTTP: TLS + query) | 137–180 ms |

Reading: the HTTP driver removes ~200 ms of handshake while adding ~3 ms of
per-query overhead. It pays off whenever instances are short-lived; it does not
matter if you are co-located and warm.

## Pages

| Measurement | Value |
| --- | --- |
| Warm render, session cookie cache valid | 8–12 ms |
| Warm render, cookie cache expired (one extra DB round trip) | ~80 ms |
| First request to a freshly started process | 420–520 ms |

Reading: the cold number is module init, not your code. The 80 ms case is the
trap that makes people think a change regressed performance — it is the session
lookup, and it is proportional to your round-trip time, so fixing the region
fixes it too.

## Bundle weight (build output, after `next build`)

| Route | Traced files | Traced size |
| --- | --- | --- |
| `app/(app)/orders/page` | 239 | 4.0 MB |
| `app/(app)/payments/page` | 240 | 4.1 MB |
| `app/api/daily-brief` (pdfkit) | 315 | 9.8 MB |
| `app/api/customers/[id]/invoice` (pdfkit) | 315 | 9.8 MB |
| Client assets (`.next/static`) | — | 2.2 MB |

Reading: ~3.5–4 MB per page function is normal Next + React server weight.
A route that doubles it usually carries a heavy native-ish dependency (PDF,
image, spreadsheet) that belongs only behind a route handler or should be
dynamically imported, and its dominant packages are visible in the audit
(pdfkit 3.8 MB, fontkit 2.1 MB here).

## What "fixed" looked like

| Change | Effect |
| --- | --- |
| Functions pinned to the DB's region | Removes a whole ocean from every round trip (was default `iad1` vs DB in `ap-southeast-1`) |
| Two pools → one, `max` 10+5 → 3 | One connection set per cold instance instead of two |
| `pg` TCP → Neon HTTP for reads and single-statement writes | Cold first touch 257 ms → 137 ms; steady +3 ms |
| Warm renders after all of it | unchanged (10–12 ms) — the wins are all on the cold path |

If a proposed change does not move a number in this table, it is not a
performance fix — it is cleanup dressed up as one.
