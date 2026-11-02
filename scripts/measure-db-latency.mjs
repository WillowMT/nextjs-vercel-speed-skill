#!/usr/bin/env node
// What does the first database query cost on a cold instance, and what does a
// steady-state query cost? Cold is the number that matters on Vercel: a fresh
// function has no socket, so it pays TCP + TLS + auth before the query.
//
// Usage: node measure-db-latency.mjs [--env .env.local]

import { readFileSync, existsSync } from "node:fs"
import { createRequire } from "node:module"

// Resolve driver packages from the project being measured, not from this skill.
const require = createRequire(process.cwd() + "/package.json")

function loadUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const files = [".env.local", ".env"]
  for (const file of files) {
    if (!existsSync(file)) continue
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim()
      if (!trimmed.startsWith("DATABASE_URL=")) continue
      return trimmed.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "")
    }
  }
  throw new Error("No DATABASE_URL in the environment, .env.local or .env")
}

function describe(url) {
  const host = new URL(url).hostname
  // Neon: ep-<name>-<id>-pooler.<region>.aws.neon.tech. Supabase: db.<ref>.supabase.co
  // (region lives in the project settings). Anything else: ask the user.
  const neon = host.match(/\.([a-z]{2}-[a-z]+-\d)\.aws\.neon\.tech$/)
  const pooled = host.includes("-pooler")
  return { host, region: neon?.[1] ?? null, pooled }
}

async function timed(fn, runs) {
  const times = []
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now()
    await fn()
    times.push(Math.round(performance.now() - started))
  }
  return times
}

const url = loadUrl()
const { host, region, pooled } = describe(url)
console.log("host:  " + host)
console.log("pooled endpoint: " + (pooled ? "yes (PgBouncer in front)" : "no"))
console.log("region: " + (region ?? "unknown — check the provider dashboard"))
if (region) {
  console.log(
    "\nCo-locate Vercel functions here. Vercel's default region is iad1,\n" +
      "so a mismatched deploy adds a transpacific/transatlantic hop to every query."
  )
}

const results = []

if (safeRequire("pg")) {
  const { Pool } = require("pg")
  const pool = new Pool({ connectionString: url, max: 1 })
  try {
    const [first, ...rest] = await timed(() => pool.query("select 1"), 6)
    results.push({ driver: "pg over TCP", first, steady: median(rest) })
  } finally {
    await pool.end()
  }
}

if (safeRequire("@neondatabase/serverless")) {
  const { neon } = require("@neondatabase/serverless")
  const sql = neon(url)
  const [first, ...rest] = await timed(
    () => sql.query("select 1", [], { fullResults: true }),
    6
  )
  results.push({ driver: "Neon HTTP", first, steady: median(rest) })
}

function safeRequire(name) {
  try {
    require.resolve(name)
    return true
  } catch {
    return false
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

console.log("\n| driver | first query (cold-ish) | steady query |")
console.log("| --- | --- | --- |")
for (const row of results) {
  console.log(`| ${row.driver} | ${row.first} ms | ${row.steady} ms |`)
}

const tcp = results.find((row) => row.driver === "pg over TCP")
const http = results.find((row) => row.driver === "Neon HTTP")
if (tcp && http) {
  console.log(
    `\nHandshake cost avoided by HTTP mode: ${tcp.first - http.first} ms ` +
      `(steady-state overhead: ${http.steady - tcp.steady} ms)`
  )
}
console.log(
  "\nRule of thumb: if a page issues its queries in parallel (Promise.all), one RTT\n" +
    "is the whole database cost of that render. If they are sequential, multiply."
)
