#!/usr/bin/env node
// Where is the weight? Next traces every file a server route pulls in, and those
// traced files are what a cold Vercel function has to load. Run after a build.
//
//   node audit-routes.mjs [--dir .next]

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs"
import { join, dirname, relative } from "node:path"

const args = process.argv.slice(2)
const dirIndex = args.indexOf("--dir")
const nextDir = dirIndex >= 0 ? args[dirIndex + 1] : ".next"

if (!existsSync(join(nextDir, "server"))) {
  console.error("No " + nextDir + "/server — run the production build first.")
  process.exit(1)
}

function walk(root, onFile) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) walk(path, onFile)
    else onFile(path)
  }
}

const routes = []
const byPackage = new Map()

walk(join(nextDir, "server"), (path) => {
  if (!path.endsWith(".nft.json")) return
  const manifest = JSON.parse(readFileSync(path, "utf8"))
  const base = dirname(path)
  let bytes = 0
  const packages = new Map()
  for (const file of manifest.files ?? []) {
    let size = 0
    try {
      size = statSync(join(base, file)).size
    } catch {
      continue
    }
    bytes += size
    const match = file.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/)
    if (!match) continue
    packages.set(match[1], (packages.get(match[1]) ?? 0) + size)
    byPackage.set(match[1], (byPackage.get(match[1]) ?? 0) + size)
  }
  routes.push({
    name: relative(join(nextDir, "server"), path).replace(/\.nft\.json$/, ""),
    files: (manifest.files ?? []).length,
    bytes,
    packages,
  })
})

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1) + " MB"

routes.sort((a, b) => b.bytes - a.bytes)
console.log("Heaviest traced functions (what a cold start must load)\n")
console.log("files      size  route")
for (const route of routes.slice(0, 12)) {
  console.log(
    String(route.files).padStart(5) + "  " + mb(route.bytes).padStart(8) + "  " + route.name
  )
}

const heavy = new Map()
for (const route of routes) {
  for (const [pkg, bytes] of route.packages) {
    if (!heavy.has(pkg) || heavy.get(pkg) < bytes) heavy.set(pkg, bytes)
  }
}
const topPackages = [...heavy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
if (topPackages.length) {
  console.log("\nLargest packages inside the heaviest route\n")
  for (const [pkg, bytes] of topPackages) console.log("  " + mb(bytes).padStart(8) + "  " + pkg)
}

let staticBytes = 0
const staticDir = join(nextDir, "static")
if (existsSync(staticDir)) {
  walk(staticDir, (path) => {
    staticBytes += statSync(path).size
  })
  console.log("\nClient assets in " + staticDir + ": " + mb(staticBytes))
}

console.log(
  "\nRead this as cold-start weight, not correctness: a route carrying 300 traced\n" +
    "files and 10 MB of fonts/PDF libraries costs hundreds of ms before it renders.\n" +
    "Keep heavy, rarely used dependencies (PDF, image, spreadsheet libs) reachable\n" +
    "only from the route handlers that need them, never from a page graph."
)
