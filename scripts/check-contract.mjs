#!/usr/bin/env node
/**
 * Drift check: CONTRACT.md's machine-readable checklist vs. the CGC-2046
 * platform source snapshot (KTD10).
 *
 *   CGC_PLATFORM_REPO=/path/to/cgc_2046 node scripts/check-contract.mjs
 *
 * Checks (any failure → exit 1, naming the drifted anchor):
 *   1. Every `grep <path> <literal>` checklist entry: the literal must appear
 *      verbatim in <platform>/<path> (structural/content match, no line
 *      numbers).
 *   2. Tool set: server.ex `component(Cgc2046.Mcp.Tools.X)` registrations
 *      (module name underscored) == checklist `tool` entries.
 *   3. Confirmation-flow set, three-way equality:
 *        platform  = mcp/tools/*.ex files defining `def execute_confirmed(`
 *        checklist = `gate` entries
 *        plugin    = CGC_CONFIRMATION_TOOLS in packages/dsh-cgc-core/src/protocol.ts
 *      (the plugin leg is the early-gate list added by plan U4; if the
 *      constant is absent the check fails with an explicit error instead of
 *      silently passing).
 *   4. Deployment TTL override: platform config/*.exs (and rel/env* if the
 *      directory exists) must not set `mcp_confirmation_ttl_seconds` to a
 *      value other than the plugin default 600.
 *
 * Test hooks (not needed in CI): DSH_CONTRACT_PATH / DSH_PROTOCOL_PATH
 * override the checklist and protocol.ts locations.
 */
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const platformRoot = process.env.CGC_PLATFORM_REPO
const contractPath = process.env.DSH_CONTRACT_PATH ?? path.join(repoRoot, 'CONTRACT.md')
const protocolPath =
  process.env.DSH_PROTOCOL_PATH ??
  path.join(repoRoot, 'packages/dsh-cgc-core/src/protocol.ts')

const PLUGIN_TTL_DEFAULT = 600

const failures = []
const fail = (msg) => failures.push(msg)

if (!platformRoot) {
  console.error('check-contract: CGC_PLATFORM_REPO is required (path to a cgc_2046 checkout)')
  process.exit(2)
}
if (!fs.existsSync(path.join(platformRoot, 'backend/lib/cgc_2046/mcp/server.ex'))) {
  console.error(`check-contract: ${platformRoot} does not look like a cgc_2046 checkout (backend/lib/cgc_2046/mcp/server.ex missing)`)
  process.exit(2)
}

// --- Parse the checklist block out of CONTRACT.md -------------------------

const contract = fs.readFileSync(contractPath, 'utf8')
const block = contract.match(/```contract-checklist\n([\s\S]*?)```/)
if (!block) {
  console.error(`check-contract: no \`\`\`contract-checklist block found in ${contractPath}`)
  process.exit(2)
}

const contractTools = []
const contractGate = []
const grepAnchors = []
for (const raw of block[1].split('\n')) {
  const line = raw.trim()
  if (!line || line.startsWith('#')) continue
  if (line.startsWith('tool ')) contractTools.push(line.slice(5).trim())
  else if (line.startsWith('gate ')) contractGate.push(line.slice(5).trim())
  else if (line.startsWith('grep ')) {
    const rest = line.slice(5)
    const sp = rest.indexOf(' ')
    if (sp === -1) fail(`checklist: malformed grep entry (no literal): ${line}`)
    else grepAnchors.push({ file: rest.slice(0, sp), literal: rest.slice(sp + 1).trim() })
  } else fail(`checklist: unknown directive: ${line}`)
}

// --- Platform tool set: server.ex component registrations -----------------

const serverEx = fs.readFileSync(path.join(platformRoot, 'backend/lib/cgc_2046/mcp/server.ex'), 'utf8')
const underscore = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
const platformTools = [...serverEx.matchAll(/component\(Cgc2046\.Mcp\.Tools\.(\w+)\)/g)].map(
  (m) => underscore(m[1])
)

// --- Platform confirmation set: execute_confirmed/2 definitions -----------

const toolsDir = path.join(platformRoot, 'backend/lib/cgc_2046/mcp/tools')
const platformGate = fs
  .readdirSync(toolsDir)
  .filter((f) => f.endsWith('.ex'))
  .filter((f) => fs.readFileSync(path.join(toolsDir, f), 'utf8').includes('def execute_confirmed('))
  .map((f) => f.replace(/\.ex$/, ''))

// --- Plugin early-gate list: CGC_CONFIRMATION_TOOLS in protocol.ts ---------

const protocol = fs.readFileSync(protocolPath, 'utf8')
const gateMatch = protocol.match(/CGC_CONFIRMATION_TOOLS[^=]*=\s*\[([\s\S]*?)\]/)
let protocolGate = null
if (gateMatch) {
  protocolGate = [...gateMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
} else {
  fail(
    `protocol.ts: early-gate constant CGC_CONFIRMATION_TOOLS not found in ${protocolPath} — ` +
      'it must list exactly the 26 confirmation-flow tools from the CONTRACT.md checklist ' +
      '(added by plan U4; three-way comparison cannot silently pass without it)'
  )
}

// --- Set comparisons --------------------------------------------------------

const diff = (a, b) => {
  const onlyA = a.filter((x) => !b.includes(x))
  const onlyB = b.filter((x) => !a.includes(x))
  return onlyA.length || onlyB.length
    ? { onlyA, onlyB }
    : null
}
const reportSetDiff = (label, aName, a, bName, b) => {
  const d = diff(a, b)
  if (d) {
    fail(
      `${label} mismatch: only in ${aName}: [${d.onlyA.join(', ') || '—'}]; ` +
        `only in ${bName}: [${d.onlyB.join(', ') || '—'}]`
    )
  }
}

reportSetDiff('tool set', 'platform server.ex components', platformTools, 'CONTRACT.md checklist', contractTools)
reportSetDiff('confirmation-flow set', 'platform execute_confirmed/2 files', platformGate, 'CONTRACT.md checklist', contractGate)
if (protocolGate) {
  reportSetDiff('confirmation-flow set', 'platform execute_confirmed/2 files', platformGate, 'protocol.ts CGC_CONFIRMATION_TOOLS', protocolGate)
}

// --- Grep anchors -----------------------------------------------------------

for (const { file, literal } of grepAnchors) {
  const abs = path.join(platformRoot, file)
  if (!fs.existsSync(abs)) {
    fail(`grep anchor: ${file} not found in platform snapshot (literal: ${literal})`)
    continue
  }
  if (!fs.readFileSync(abs, 'utf8').includes(literal)) {
    fail(`grep anchor drifted: ${file} no longer contains: ${literal}`)
  }
}

// --- Deployment TTL override scan ------------------------------------------

const configFiles = []
const configDir = path.join(platformRoot, 'backend/config')
if (fs.existsSync(configDir)) {
  for (const f of fs.readdirSync(configDir)) if (f.endsWith('.exs')) configFiles.push(path.join(configDir, f))
}
const relDir = path.join(platformRoot, 'backend/rel')
if (fs.existsSync(relDir)) {
  for (const f of fs.readdirSync(relDir)) if (/^env(\.|$)/.test(f)) configFiles.push(path.join(relDir, f))
}
for (const file of configFiles) {
  const text = fs.readFileSync(file, 'utf8')
  const m = text.match(/mcp_confirmation_ttl_seconds[^0-9]*(\d+)/)
  if (m && Number(m[1]) !== PLUGIN_TTL_DEFAULT) {
    fail(
      `TTL override drift: ${path.relative(platformRoot, file)} sets mcp_confirmation_ttl_seconds ` +
        `to ${m[1]}, plugin default is ${PLUGIN_TTL_DEFAULT} — keep deployment and plugin in sync`
    )
  }
}

// --- Report -----------------------------------------------------------------

if (failures.length) {
  console.error(`check-contract: ${failures.length} drift failure(s):`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(
  `check-contract: OK — ${contractTools.length} tools, ${contractGate.length} confirmation-flow tools ` +
    `(three-way equal), ${grepAnchors.length} grep anchors, no TTL override drift`
)
