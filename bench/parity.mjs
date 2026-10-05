// Parity gate. Runs before any measurement: if the four servers do not return
// JSON that parses to the same value, the benchmark is meaningless, so a mismatch
// aborts. Deliberately not a byte comparison: serialisers differ legitimately on
// number formatting (serde writes 5.0 where V8 writes 5) and on key order. See
// diff() below.
// Usage: node bench/parity.mjs [axumBase fastifyBase expressBase fastapiBase]
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BASES = {
  axum: process.argv[2] ?? 'http://127.0.0.1:18081',
  fastify: process.argv[3] ?? 'http://127.0.0.1:18082',
  express: process.argv[4] ?? 'http://127.0.0.1:18083',
  fastapi: process.argv[5] ?? 'http://127.0.0.1:18084',
};
const REF = 'axum';
const OTHERS = Object.keys(BASES).filter(k => k !== REF);

const paths = readFileSync(join(here, 'urls.txt'), 'utf8')
  .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

// Invalid requests that must be 400 in every stack.
const INVALID = [
  '/products',
  '/products?category=books&min_price=abc',
  '/products?category=books&max_price=not-a-number',
  '/products?category=books&sort=price_up',
  '/products?category=books&limit=0',
  '/products?category=books&limit=101',
  // A present-but-empty price is not a zero price. Node's Number('') is 0, so this
  // is the case Express used to answer 200 with a full page of products.
  '/products?category=books&min_price=',
  '/products?category=books&max_price=',
  // Non-finite prices. Rust's and Python's parsers produce inf for these, and AJV
  // coerces them for Fastify, so every stack needs an explicit finite check.
  '/products?category=books&min_price=Infinity',
  '/products?category=books&min_price=-Infinity',
  '/products?category=books&max_price=Infinity',
  '/products?category=books&min_price=1e400',
];

// Deep equality on parsed JSON. Object key order is ignored (keys are sorted before
// comparison); array order is NOT, because the order of `items` is the sort
// behaviour under test. Both sides went through JSON.parse, so number formatting
// differences between the stacks are already normalised; anything left is a real
// behavioural difference.
function diff(a, b, path = '') {
  if (a === b) return null;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return `${path}: array vs ${typeof b}`;
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = diff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (ka.join('|') !== kb.join('|')) return `${path}: keys [${ka}] vs [${kb}]`;
    for (const k of ka) {
      const d = diff(a[k], b[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

async function get(base, path) {
  const res = await fetch(base + path);
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

const failures = [];
const note = m => failures.push(m);

// The four servers were just started, so give each one up to 60 s to answer /health.
async function waitHealthy(stack, base) {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(base + '/health')).ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  console.error(`parity: ${stack} at ${base} never answered /health`);
  process.exit(1);
}
for (const [stack, base] of Object.entries(BASES)) await waitHealthy(stack, base);
console.log(`parity: all 4 servers healthy (${Object.entries(BASES).map(([k, v]) => `${k}=${v}`).join(' ')})`);

console.log(`parity: ${paths.length} URLs x 4 stacks, reference = ${REF}`);
let nonEmpty = 0;

for (const path of paths) {
  const got = {};
  for (const [stack, base] of Object.entries(BASES)) {
    try {
      got[stack] = await get(base, path);
    } catch (err) {
      note(`${path} [${stack}] request failed: ${err.message}`);
    }
  }
  if (Object.keys(got).length !== 4) continue;

  for (const [stack, r] of Object.entries(got)) {
    if (r.status !== 200) note(`${path} [${stack}] status ${r.status}, expected 200`);
    const ct = (r.headers.get('content-type') ?? '').split(';')[0].trim();
    if (ct !== 'application/json') note(`${path} [${stack}] content-type "${ct}", expected application/json`);
    // No stack may use compression or ETags: both would change what is measured.
    if (r.headers.get('content-encoding')) note(`${path} [${stack}] sent content-encoding: ${r.headers.get('content-encoding')}`);
    if (r.headers.get('etag')) note(`${path} [${stack}] sent an etag`);
  }

  let ref;
  try {
    ref = JSON.parse(got[REF].text);
  } catch (err) {
    note(`${path} [${REF}] invalid JSON: ${err.message}`);
    continue;
  }
  if (typeof ref.total !== 'number' || !Array.isArray(ref.items)) {
    note(`${path} [${REF}] body is not {total,items}: ${got[REF].text.slice(0, 120)}`);
    continue;
  }
  if (ref.total > 0) nonEmpty++;

  for (const stack of OTHERS) {
    let body;
    try {
      body = JSON.parse(got[stack].text);
    } catch (err) {
      note(`${path} [${stack}] invalid JSON: ${err.message}`);
      continue;
    }
    const d = diff(ref, body);
    if (d) note(`${path} [${stack}] differs from ${REF} at ${d}`);
  }
  const shown = `total=${ref.total} items=${ref.items.length}`;
  console.log(`  ok  ${path}  ${shown}`);
}

console.log(`parity: ${INVALID.length} invalid requests must be 400 everywhere`);
for (const path of INVALID) {
  const codes = {};
  for (const [stack, base] of Object.entries(BASES)) {
    try {
      codes[stack] = (await get(base, path)).status;
    } catch (err) {
      note(`${path} [${stack}] request failed: ${err.message}`);
    }
  }
  const bad = Object.entries(codes).filter(([, s]) => s !== 400);
  if (bad.length) note(`${path} expected 400 everywhere, got ${JSON.stringify(codes)}`);
  else console.log(`  ok  ${path}  400 in all 4`);
}

if (nonEmpty < 10) note(`only ${nonEmpty} URLs returned a non-empty result: the URL list is not exercising the servers`);

if (failures.length) {
  console.error(`\nPARITY FAILED (${failures.length} problems):`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(`\nPARITY OK: ${paths.length} URLs agree across all 4 stacks (parsed JSON, deep-equal), ${INVALID.length} invalid requests 400 everywhere, every response application/json with no etag and no content-encoding.`);
