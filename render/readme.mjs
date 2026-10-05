// Generates README.md from results/results.json + render/config.json - the same two
// inputs render.mjs uses - so the README, the carousel and the post can never
// disagree about a number. Wired into `make render`, so a re-run refreshes all three.
// Usage: node render/readme.mjs <results.json> <config.json> <README.md> <urls.txt> <parity.mjs>
import { readFileSync, writeFileSync } from 'node:fs';

const [resultsPath, configPath, outPath, urlsPath, parityPath] = process.argv.slice(2);
const R = JSON.parse(readFileSync(resultsPath, 'utf8'));
const C = JSON.parse(readFileSync(configPath, 'utf8'));

// Counted from the gate itself rather than typed, so the README cannot drift from
// what parity.mjs actually checks.
const URL_COUNT = readFileSync(urlsPath, 'utf8')
  .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).length;
const paritySrc = readFileSync(parityPath, 'utf8');
const invalidBlock = paritySrc.slice(paritySrc.indexOf('const INVALID'), paritySrc.indexOf('];', paritySrc.indexOf('const INVALID')));
const INVALID_COUNT = invalidBlock.split('\n').filter(l => l.trim().startsWith("'")).length;
if (!URL_COUNT || !INVALID_COUNT) throw new Error('could not count the parity URLs');
const S = R.stacks;

const META = {
  axum: { lang: 'Rust', fw: 'Axum' },
  fastify: { lang: 'Node.js', fw: 'Fastify' },
  express: { lang: 'Node.js', fw: 'Express' },
  fastapi: { lang: 'Python', fw: 'FastAPI' },
};
const ORDER = ['axum', 'fastify', 'express', 'fastapi'];

const int = n => Math.round(n).toLocaleString('en-US');
const x = n => (n >= 10 ? Math.round(n).toString() : n.toFixed(1)) + 'x';
const money = n => '$' + (n < 1000 ? Math.round(n / 10) * 10 : Math.round(n / 100) * 100).toLocaleString('en-US');
const moneyK = n => '$' + (n >= 1000 ? Math.round(n / 1000) + 'k' : Math.round(n));
// money() rounds to the nearest $100 above $1,000, which is fine for a slide but makes
// a table row fail to add up ($2,500 - $930 printed as $1,600). The table uses a single
// $10 grid for all three columns instead.
const money10 = n => '$' + (Math.round(n / 10) * 10).toLocaleString('en-US');
const payback = m => {
  if (m < 2) { const w = Math.max(1, Math.round(m * 4.345)); return `${w} week${w === 1 ? '' : 's'}`; }
  return m < 24 ? `${Math.round(m)} months` : `${(m / 12).toFixed(1)} years`;
};

const speedup = S.axum.rps / S[C.baseline_stack].rps;
const vsFastapi = S.axum.rps / S.fastapi.rps;
const fastifyVsExpress = S.fastify.rps / S.express.rps;
// The slide floors this fraction (render.mjs). Use the identical formula here, or
// the README says "4.0 times" next to an embedded image that says "1/3".
const lightestOther = ['fastify', 'express', 'fastapi']
  .reduce((a, b) => (S[a].peak_mem_mb <= S[b].peak_mem_mb ? a : b));
const memFrac = Math.floor(S[lightestOther].peak_mem_mb / S.axum.peak_mem_mb);

// If the spread gate rejected a measurement, say so in the README: three unexplained
// *-rejected*.json files in results/raw/ read like cherry-picking otherwise.
const reMeasured = ORDER.filter(k => S[k].quality && (S[k].quality.pass1_measurements > 1 || S[k].quality.pass2_measurements > 1));
const spreadNote = reMeasured.length
  ? `\n\n**One measurement was rejected and repeated.** ${reMeasured.map(k => META[k].fw).join(', ')} exceeded the `
    + `${S[reMeasured[0]].quality.spread_gate_pct}% spread gate on the first attempt, so the runner threw that attempt away and measured the `
    + `stack again on a fresh container. The rejected runs are committed too, as \`results/raw/*-rejected*.json\`, `
    + `so you can check which way the discard went rather than taking it on trust.`
  : `\n\nEvery stack cleared the ${R.setup.runs}-run spread gate on the first measurement, so nothing was discarded.`;

const rows = ORDER.map(k => {
  const s = S[k];
  return `| **${META[k].lang} / ${META[k].fw}** | ${s.version} | ${int(s.rps)} | ${s.p50_ms} | ${s.p99_ms} | ${s.peak_mem_mb} | ${s.idle_mem_mb} | ${s.cpu_pct} |`;
}).join('\n');

const runsRows = ORDER.map(k => `| ${META[k].fw} | ${S[k].rps_runs.join(' / ')} | ${S[k].p50_ms_runs.join(' / ')} | ${S[k].p99_ms_runs.join(' / ')} |`).join('\n');

const companies = C.companies.map(c => {
  // Round the Rust bill first and derive the saving from the rounded figure, so the
  // published row actually adds up. Rounding the two independently makes
  // $2,500 - $930 display as $1,600.
  const rustBill = Math.round(c.monthly_bill_usd / speedup / 10) * 10;
  const savings = c.monthly_bill_usd - rustBill;
  const pb = C.rewrite_price_usd / savings;
  const pbHalf = C.rewrite_price_usd / (savings * C.conservative_factor);
  const verdict = pb <= C.verdict.go_max_months ? 'go' : pb <= C.verdict.not_yet_max_months ? 'not_yet' : 'no';
  return { ...c, rustBill, savings, pb, pbHalf, verdict };
});
const companyRows = companies.map(c =>
  `| ${c.name} | ${money10(c.monthly_bill_usd)}/mo | ${money10(c.rustBill)}/mo | ${money10(c.savings)}/mo | ~${payback(c.pb)} | ~${payback(c.pbHalf)} | ${{ go: '**Start yesterday**', not_yet: '**Not yet**', no: "**Don't**" }[c.verdict]} |`).join('\n');

const md = `# Rewrite it in Rust: hype or worth it?

The same catalog API in **Rust (Axum)**, **Node.js (Fastify)**, **Node.js (Express)** and **Python (FastAPI)**,
each pinned to 1 vCPU and 512 MB in Docker, measured with [oha](https://github.com/hatoo/oha) —
then priced, because req/s only matters next to a bill.

![Results](docs/results.png)

## Results

${R.setup.endpoint_short}. ${R.setup.runs} x ${R.setup.duration_s} s per stack, median reported.
p50 and p99 are measured in a separate pass at a fixed **${int(R.setup.fixed_rate_rps)} req/s** for every stack,
so the latency numbers compare like with like instead of each stack being measured at its own breaking point.

| Stack | Version | req/s (median) | p50 (ms) | p99 (ms) | Peak mem (MB) | Idle mem (MB) | CPU % |
|---|---|---:|---:|---:|---:|---:|---:|
${rows}

- Rust served **${x(speedup)}** the requests of Express and **${x(vsFastapi)}** of FastAPI on the same single core.
- Fastify came out **${x(fastifyVsExpress)}** Express here, i.e. no faster. Same runtime, same ceiling, and on this
  payload Fastify's schema serialiser costs more than it saves. There is a section on that below.
- Rust held peak memory at **1/${memFrac}** of the lightest other stack's (${S.axum.peak_mem_mb} MB vs ${META[lightestOther].fw}'s ${S[lightestOther].peak_mem_mb} MB).
  These three columns come from a \`docker stats\` stream that is not committed, unlike the throughput and
  latency numbers; re-run \`make bench\` to reproduce them.

Per-run numbers, so you can see the spread rather than trusting a single median:

| Stack | req/s runs | p50 ms runs | p99 ms runs |
|---|---|---|---|
${runsRows}

Every raw oha run is committed under [\`results/raw/\`](results/raw), and the full machine-readable
result is [\`results/results.json\`](results/results.json).${spreadNote}

### Why Fastify came out below Express here

Published benchmarks usually put Fastify well ahead of Express, so this result needs an explanation
rather than a shrug.

Fastify's one structural advantage in this test is its documented fast path: declaring the 200 response
schema so [fast-json-stringify](https://github.com/fastify/fast-json-stringify) replaces
\`JSON.stringify\`. That pays off on small, flat payloads. This endpoint returns **50 full product objects,
about 8 KB with 8 fields each**, and at that size it stops paying off — V8's native \`JSON.stringify\` is
optimised C++, while fast-json-stringify is generated JavaScript.

Two side experiments, run on the same machine. They are **not** part of the benchmark and are not in
\`results.json\`; the scripts and the raw oha output are committed under
[\`experiments/fastify-schema/\`](experiments/fastify-schema) so the numbers below can be checked rather than
taken on trust.

- **Serialising one of the pages the load pattern generates** (\`books\`, 100-800, \`price_asc\`) in isolation,
  compiling the exact schema the server declares: \`JSON.stringify\` 13.1 us/op vs fast-json-stringify 7.0.1 at
  17.5 us/op — the schema serialiser is **0.75x native** (captured in
  [\`raw/serialiser.txt\`](experiments/fastify-schema/raw/serialiser.txt); repeated runs land between 0.75x and
  0.80x). This is a ratio between two functions in one process, not a throughput number, and it was not
  CPU-pinned.
- **The same Fastify server with the \`response\` schema removed**, 3 x 30 s at
  \`-c ${R.setup.connections}\` on the same 1 vCPU pin: **6,292 req/s** (runs: 6,313 / 6,270 / 6,292, spread
  0.69%, every run 100% HTTP 200, byte-identical response body). That puts Fastify ahead of Express by
  **1.09x** — a far smaller margin than published framework benchmarks suggest — and means the schema costs it
  ~15% here. Unlike the main table this run had no warmup, no \`docker stats\` bottleneck check and no spread
  gate; it is a side experiment, not a measurement to the same standard.

So Fastify is not misconfigured here, and it is not being handicapped on purpose: it is running the setup its own
documentation recommends, and on this payload that setup costs it more than it pays. The benchmark keeps the
schema, because removing it to make a stack look better is exactly the kind of tuning this repo refuses to do.
To reproduce, [\`experiments/fastify-schema/derive-noschema.mjs\`](experiments/fastify-schema/derive-noschema.mjs)
regenerates the variant from the current [\`servers/node-fastify/server.js\`](servers/node-fastify/server.js) by
deleting only the \`response\` block, so it cannot drift from the server that is actually measured.

### What FastAPI's declared return type does

Fastify's documented fast path cost it performance here, so the symmetric question is what FastAPI's costs.
\`/products\` declares \`-> ProductsPage\` and leaves the response class at its default, which is what selects
FastAPI's \`dump_json\` path: the returned object is checked against the route's response model — an identity
check rather than a re-validation, because the handler returns the \`Product\` instances it already holds — and
then Pydantic's Rust core writes the response body as bytes in a single pass, with no intermediate Python dict
and no \`json.dumps\`. So unlike Fastify, here the idiomatic choice is also the cheap one and there is nothing to
trade off. That path exists from FastAPI 0.130 onwards; earlier versions take a slower dict-then-\`json.dumps\`
route for the same source code, which is one reason
[\`requirements.txt\`](servers/python-fastapi/requirements.txt) pins the version. No FastAPI variant was
benchmarked, so unlike the Fastify section this one claims no number.

The wider lesson is the same one the cost model makes: **ratios from someone else's benchmark do not
transfer to your workload.** This endpoint is compute-heavy, which compresses every framework gap —
it is also why Rust comes out at ${x(speedup)} here rather than the 3-4x a hello-world test would show,
and why FastAPI looks relatively better than its reputation.

## Machine

| | |
|---|---|
| CPU | ${C.machine_label || R.machine.cpu} |
| Logical CPUs | ${R.machine.logical_cpus} (${R.machine.docker_vm_cpus} visible to Docker) |
| RAM | ${R.machine.ram_gb} GB |
| OS | ${R.machine.os} |
| Docker | ${R.machine.docker} |
| Load generator | ${R.tooling.oha} |
| Date | ${R.date} |

## Methodology

**Dataset.** ${int(R.setup.products)} products generated by [\`data/generate.mjs\`](data/generate.mjs) with a seeded
PRNG (mulberry32, seed 42) and committed, so every stack and every re-run loads byte-identical data:
10 categories of 1,000 products each, prices 1.00–999.99, ratings 1.0–5.0, ~10% out of stock, 0–3 tags,
and \`created_at\` as a plain ISO 8601 string — never parsed into a date type, because that would reformat
it on the way out and break JSON parity. Each server builds a per-category index at startup; startup is not measured.

**Endpoint.** \`GET /products?category=&min_price=&max_price=&sort=&limit=\`, identical in all four stacks:
take the category's products, keep those with \`min_price <= price <= max_price\` **and** \`stock > 0\`, count them
into \`total\`, sort by \`price_asc\` / \`price_desc\` / \`rating_desc\` with ties **always** broken by \`id\` ascending,
take the first \`limit\` (1–100, default 20), return \`{"total": int, "items": [...]}\`.
Invalid parameters return 400 everywhere — including FastAPI, which needs a \`RequestValidationError\` handler
to stop answering 422.

**No cheating, in any stack.** No response caching, no per-query memoisation, no pre-sorted copies per sort key,
no pre-serialised JSON, no compression, no request logging, no ETags. Every request does the full filter,
sort and serialise. Each stack does get its own idiomatic production setup and nothing more: Fastify declares
its 200 response schema (fast-json-stringify), Express gets \`etag: false\` and \`x-powered-by\` disabled so it is
not penalised for headers nobody else sends, FastAPI holds Pydantic instances and declares \`ProductsPage\` as the
return type, and Rust is a plain \`cargo build --release\` with the default profile — no LTO tweaks, no custom
allocator, no unsafe.

**Docker pinning.** One server at a time, \`--cpuset-cpus=${R.tooling.server_cpu} --cpus=1 --memory=${R.setup.server_mem_mb}m\`, a fresh container per stack.
The load generator runs in its own container pinned to CPUs ${R.tooling.load_generator_cpus}, never on the server's CPU, and reaches the
server **by container name on the \`bench-net\` Docker network** — no host port-forward is ever in the measurement
path, because on Docker Desktop that proxy becomes the bottleneck before the server does. CPU 0 is left to the
OS and dockerd.

**Load.** Every stack gets the same request mix, generated by oha from one regex:

\`\`\`
${R.tooling.url_pattern}
\`\`\`

**Runs.** ${R.setup.warmup_s} s of identical warmup load first, discarded (the Node stacks need the JIT warm).
Then pass 1: \`oha -z ${R.setup.duration_s}s -c ${R.setup.connections} --wait-ongoing-requests-after-deadline\`, ${R.setup.runs} runs, median \`requestsPerSec\`.
Then pass 2, after pass 1 finished for all four stacks: a fixed rate of
\`${int(R.setup.fixed_rate_rps)}\` req/s — \`max(100, floor(0.5 x min(median rps) / 100) x 100)\` — with
\`--latency-correction\`, ${R.setup.runs} runs, median p50 and p99. Every run had to come back 100% HTTP 200 or the
benchmark aborts. Memory and CPU come from \`docker stats\` streamed during pass 1.

**Parity gate.** [\`bench/parity.mjs\`](bench/parity.mjs) runs before any measurement — \`make bench\` will not
start without it. ${URL_COUNT} URLs ([\`bench/urls.txt\`](bench/urls.txt)) covering every category, every sort,
limits 1/20/50/100, an empty result, an unknown and an empty category, and boundary prices exactly equal to a real
product's price — fetched from all four servers, \`JSON.parse\`d and deep-compared against the Rust response, plus
${INVALID_COUNT} invalid requests that must be 400 everywhere. Any mismatch aborts the run. A benchmark of four servers that
disagree measures nothing.

The comparison is on parsed JSON, not bytes: serialisers legitimately differ on number formatting (serde writes
\`5.0\` where V8 writes \`5\`) and on key order. What is verified is that every request the benchmark sends, and
every invalid form the gate checks, produces the same status and the same JSON value in all four stacks. Error
*bodies* are not compared. Beyond that surface each stack uses its own language's string-to-number parser, and
they disagree on exotic literals — \`limit=50.0\`, \`1e2\`, \`0x10\`, leading or trailing whitespace, Python's
\`1_0\`, and duplicate query keys. Normalising those would mean replacing each framework's native query parsing,
which is part of what is being measured, so they are documented here rather than papered over. The load generator
never sends them.

**Sanity checks that can fail the run**, not just decorate it: the Rust server must log
\`available_parallelism=1\` under the pin (otherwise tokio sized its pool for the whole host);
every stack must reach 90%+ median CPU during pass 1 (otherwise the server was not the bottleneck and
the numbers are void); and \`oha --dump-urls\` output must match the intended URL shape.

## Reproduce

\`\`\`bash
make all        # data, build, parity, bench, render
\`\`\`

Needs Docker with at least 4 CPUs visible (\`docker info --format '{{.NCPU}}'\`) and Node.js for the runner
and the renderer. Individual steps: \`make data\`, \`make build\`, \`make parity\`, \`make bench\`, \`make render\`,
\`make clean\`.

**On Docker Desktop (macOS/Windows), give the VM at least 6 CPUs and 8 GB** before running, or the load
generator and the server will fight over the same cores and every number will be wrong.
Close heavy apps and keep the laptop on power.

## Caveats

- **This endpoint is CPU-bound on purpose** — in-memory filter, sort and JSON, no I/O. That is exactly where a
  compiled language wins. If your API spends most of its time waiting on a database, the latency gains shrink
  toward nothing, and the compute savings scale with CPU time per request, not with the ratios here.
- **1 vCPU per server, so this measures per-core efficiency**, not maximum capacity. Every one of these stacks
  scales out with more processes; Node and Python need more of them to fill a box, which is the whole point of
  the cost model below.
- **It is a synthetic benchmark on one machine.** One desktop: ${R.machine.cpu}, Docker inside a WSL2 VM,
  which presents its own flat ${R.machine.logical_cpus / 2}-core/${R.machine.logical_cpus}-thread topology. The real chip is 8 P-cores plus 8 E-cores,
  and from inside the VM there is no way to tell which physical core a pinned vCPU is running on, or whether it
  stays there. Same conditions for all four stacks, but not a clean-room result. Your numbers will differ. Run it.
- **Latency is measured at a fixed ${int(R.setup.fixed_rate_rps)} req/s**, which is half the slowest stack's
  throughput. At its own saturation point every stack looks much worse; comparing p99 at each stack's own
  maximum would be comparing different experiments.

## The cost model

Throughput is not an argument. A bill is. Baseline is Node.js (Express):

\`\`\`
speedup        = rps(axum) / rps(express)          = ${speedup.toFixed(2)}
rust_bill      = monthly_bill / speedup
savings        = monthly_bill - rust_bill
payback_months = ${moneyK(C.rewrite_price_usd)} rewrite / savings
\`\`\`

| Company | App servers today | On Rust | Saves | ${moneyK(C.rewrite_price_usd)} rewrite pays back | At half the savings | Verdict |
|---|---|---|---|---|---|---|
${companyRows}

Same benchmark, opposite answers. That is the entire point: the speedup is a constant, the payback is not.

Only **app-server compute** shrinks. Database, storage and egress do not. And the usual cheap escape hatch did not
show up here either: swapping Express for Fastify measured ${x(fastifyVsExpress)}, so on this workload the choice is
the runtime, not the framework.

All of it is in [\`render/config.json\`](render/config.json) — change the bills and re-run \`make render\`.

## Further reading

- Grab, Counter Service rewrite: https://engineering.grab.com/counter-service-how-we-rewrote-it-in-rust
- Cloudflare, Pingora: https://blog.cloudflare.com/how-we-built-pingora-the-proxy-that-connects-cloudflare-to-the-internet/
- Microsoft, TypeScript native port (Go): https://devblogs.microsoft.com/typescript/typescript-native-port/
- Sharkbench: https://sharkbench.dev/web

---

Built by Nandor, [nandor.build](https://nandor.build). I help startups find out whether a rewrite pays back,
then do it at a fixed price.

## License

MIT — see [LICENSE](LICENSE).
`;

writeFileSync(outPath, md);
console.log(`wrote README.md (${md.length} bytes)`);
console.log(`speedup=${speedup.toFixed(2)} vsFastapi=${vsFastapi.toFixed(2)} fastifyVsExpress=${fastifyVsExpress.toFixed(2)} memFraction=1/${memFrac}`);
for (const c of companies) console.log(`  ${c.name}: save ${money(c.savings)}/mo, payback ${c.pb.toFixed(1)} mo, ${c.verdict}`);
