// Writes servers/node-fastify/server.js minus the 200 response schema into
// .build/server.js, so the no-schema variant can never drift from the server that
// is actually measured. Aborts if the block is not found exactly once.
// Usage: node experiments/fastify-schema/derive-noschema.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..');
const SRC = join(ROOT, 'servers', 'node-fastify', 'server.js');

const original = readFileSync(SRC, 'utf8');
const BLOCK = /\n *\/\/ Declaring the 200 response schema[\s\S]*?\n {6}\},\n(?= {4}\},\n {2}\},)/;
if (!BLOCK.test(original)) {
  console.error(`derive-noschema: the response schema block was not found in ${SRC}.`);
  console.error('The server changed shape; update this script rather than hand-editing a copy.');
  process.exit(1);
}
const patched = original.replace(BLOCK, '\n');
if (/response:\s*\{/.test(patched)) {
  console.error('derive-noschema: a response block is still present after the edit.');
  process.exit(1);
}

const outDir = join(here, '.build');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, 'server.js');
writeFileSync(out, patched);
console.log(`wrote ${out} (${original.length - patched.length} bytes removed)`);
console.log('Build it against servers/node-fastify/Dockerfile with this file mounted over /app/server.js,');
console.log('then run it through bench/parity.mjs before measuring anything.');
