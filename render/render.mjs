// Usage: node render.mjs <results.json> <config.json> <outDir>
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const [resultsPath, configPath, outDir] = process.argv.slice(2);
const R = JSON.parse(readFileSync(resultsPath, 'utf8'));
const C = JSON.parse(readFileSync(configPath, 'utf8'));
mkdirSync(outDir, { recursive: true });

// ---------- formatting ----------
const int = n => Math.round(n).toLocaleString('en-US');
const ratio = (x, sym = '×') => (x >= 10 ? Math.round(x).toString() : x.toFixed(1)) + sym;
const money = n => {
  const r = n < 1000 ? Math.round(n / 10) * 10 : Math.round(n / 100) * 100;
  return '$' + r.toLocaleString('en-US');
};
const moneyK = n => '$' + (n >= 1000 ? Math.round(n / 1000).toLocaleString('en-US') + 'k' : Math.round(n));
// yearly amounts: ~$19k, ~$150k
const yearly = n => {
  const k = n >= 100000 ? Math.round(n / 10000) * 10 : n >= 10000 ? Math.round(n / 1000) : Math.round(n / 100) / 10;
  return '$' + k.toLocaleString('en-US') + 'k';
};
const msFmt = max => x => (max < 10 ? x.toFixed(2) : x < 10 ? x.toFixed(1) : Math.round(x).toString()) + ' ms';
const mb = x => (x < 100 ? x.toFixed(1) : Math.round(x).toString()) + ' MB';
const payback = m => {
  if (m < 2) { const w = Math.max(1, Math.round(m * 4.345)); return `${w} week${w === 1 ? '' : 's'}`; }
  return m < 24 ? `${Math.round(m)} months` : `${(m / 12).toFixed(1)} years`;
};
const fractionWord = n => ({ 2: 'half', 3: 'a third', 4: 'a quarter', 5: 'a fifth', 6: 'a sixth', 7: 'a seventh',
  8: 'an eighth', 9: 'a ninth', 10: 'a tenth' })[n] || `1/${n}`;

// ---------- derived numbers ----------
const S = R.stacks; // { axum, express, fastify, fastapi }
const meta = {
  axum:    { lang: 'Rust',    fw: 'Axum',    post: 'Rust (Axum)' },
  express: { lang: 'Node.js', fw: 'Express', post: 'Node (Express)' },
  fastify: { lang: 'Node.js', fw: 'Fastify', post: 'Node (Fastify)' },
  fastapi: { lang: 'Python',  fw: 'FastAPI', post: 'Python (FastAPI)' },
};
// every list and chart uses the same order: fastest first
const order = Object.keys(meta).sort((a, b) => S[b].rps - S[a].rps);
const base = C.baseline_stack; // "express"
const speedup = S.axum.rps / S[base].rps;
const rExpress = S.axum.rps / S.express.rps;
const rFastapi = S.axum.rps / S.fastapi.rps;
const fastifyVsExpress = S.fastify.rps / S.express.rps;
const twist = fastifyVsExpress < 1.03; // Fastify no faster than Express on this workload
// conservative memory claim: Rust used at most 1/N of EVERY other stack's peak memory
const memN = Math.floor(Math.min(...Object.keys(meta).filter(k => k !== 'axum').map(k => S[k].peak_mem_mb)) / S.axum.peak_mem_mb);
const memFrac = `1/${memN}`;
const machine = C.machine_label || R.machine.cpu;

const V = C.verdict; // { go_max_months, not_yet_max_months }
const verdictOf = pb => (pb <= V.go_max_months ? 'go' : pb <= V.not_yet_max_months ? 'not_yet' : 'no');
const VERDICT_HTML = {
  go: '<b>Start yesterday.</b> The rewrite pays for itself before the next quarter.',
  not_yet: "<b>Not yet.</b> Find product-market fit first, then it's a solid bet.",
  no: "<b>Don't.</b> At this bill it won't pay back in time. Ship features instead.",
};

const companies = C.companies.map(c => {
  const rustBill = c.monthly_bill_usd / speedup;
  const savings = c.monthly_bill_usd - rustBill;
  const pb = C.rewrite_price_usd / savings;
  const pbHalf = C.rewrite_price_usd / (savings * C.conservative_factor);
  const verdict = verdictOf(pb);
  return {
    name: c.name, bill: c.monthly_bill_usd, rustBill, savings, pb, pbHalf, verdict,
    billText: money(c.monthly_bill_usd) + '/mo', billShort: money(c.monthly_bill_usd),
    rustBillShort: '~' + money(rustBill), rustShare: rustBill / c.monthly_bill_usd,
    savingsText: '~' + yearly(savings * 12) + '/yr', rewriteText: moneyK(C.rewrite_price_usd),
    paybackText: '~' + payback(pb), verdictHtml: VERDICT_HTML[verdict],
  };
});

// Consistency check between the illustrative scenarios in config.json and the measured
// speedup. The measurement is never touched: Company A and B are hypothetical bills chosen
// to show that the same benchmark gives opposite answers, so if one stops landing where the
// slide copy says it does, the copy or the scenario is stale - not the data.
const [A, B] = companies;
const warnings = [];
if (R.mock) warnings.push('results.mock is true: these are PLACEHOLDER numbers, do not post.');
if (A.verdict !== 'not_yet') warnings.push(`Company A payback is ${A.pb.toFixed(1)} months (${A.verdict}): the "not yet" copy on slide 4 no longer matches. Rewrite the copy, or pick a different illustrative bill.`);
if (B.verdict !== 'go') warnings.push(`Company B payback is ${B.pb.toFixed(1)} months (${B.verdict}): "start yesterday" on slide 4 no longer matches. Rewrite the copy, or pick a different illustrative bill.`);

const p99Max = Math.max(...order.map(k => S[k].p99_ms));
const ms = msFmt(p99Max);
const methodLine = `${R.setup.endpoint_short} · Docker, 1 vCPU / 512 MB each · oha, ${R.setup.connections} connections, ` +
  `${R.setup.runs} × ${R.setup.duration_s} s, median · ${machine} · ${R.date}`;

const view = {
  mock: !!R.mock,
  text: {
    ratioExpress: ratio(rExpress),
    ratioFastapi: ratio(rFastapi),
    coverCap: `Rust's throughput on the same 1 vCPU,<br>using <b>${memFrac}</b> of the memory.`,
    endpointCap: `Filter, sort and return JSON from an in-memory catalog of ${int(R.setup.products)} products. The bread and butter of every product API.`,
    loadRule: `Load: oha, ${R.setup.connections} connections`,
    runsRule: `${R.setup.runs} runs × ${R.setup.duration_s} s, median reported`,
    hwLine: `Hardware: ${machine} · Code: github.com/nandorcsupor/api-benchmark`,
    resultsSub: `Rust served <b>${ratio(rExpress)}</b> the traffic of Express and <b>${ratio(rFastapi)}</b> of FastAPI,<br>on <b>${memFrac}</b> of the memory.` +
      (twist ? ' Fastify? No faster than Express.' : ''),
    p99Title: `p99 latency at ${int(R.setup.fixed_rate_rps)} req/s`,
    methodLine,
    moneyNote: `CPU only: Rust's ${memFrac} memory footprint isn't even counted. Database, storage and egress don't shrink. ` +
      `Speedup measured here: Express → Axum, ${ratio(speedup)}. At half the savings, ${B.name.replace(' ', '&nbsp;')} still pays back in ~${payback(B.pbHalf).replace(' ', '&nbsp;')}.`,
  },
  stacks: order.map(k => ({ ...meta[k], highlight: k === 'axum' })),
  rows: {
    rps: order.map(k => ({ ...meta[k], value: S[k].rps, text: int(S[k].rps), highlight: k === 'axum' })),
    p99: order.map(k => ({ ...meta[k], value: S[k].p99_ms, text: ms(S[k].p99_ms), highlight: k === 'axum' })),
    mem: order.map(k => ({ ...meta[k], value: S[k].peak_mem_mb, text: mb(S[k].peak_mem_mb), highlight: k === 'axum' })),
  },
  companies,
};

// ---------- post + first comment ----------
const mem = fractionWord(memN);
const twistBlock = twist
  ? `Plot twist: Fastify was no faster than Express. Same runtime, same ceiling.
Switching frameworks didn't move the number. Switching languages did: ${ratio(rExpress, 'x')} over Express, ${ratio(rFastapi, 'x')} over FastAPI, on ${mem} of the memory.`
  : `Rust: ${ratio(rExpress, 'x')} over Express, ${ratio(rFastapi, 'x')} over FastAPI, on ${mem} of the memory.`;
const bet = A.pb >= 9 && A.pb <= 15 ? 'a solid 1-year bet' : 'a solid bet';

const post = `I sell Rust rewrites.
Most companies shouldn't buy one.

Here's the math I use to tell the difference.

I built the same API in Rust, Node and Python. Same data, same load, 1 vCPU each.

Requests per second:
${order.map(k => `→ ${meta[k].post}: ${int(S[k].rps)}`).join('\n')}

${twistBlock}

Impressive. Also irrelevant, until you put a bill next to it.

${A.name} spends ${money(A.bill)}/month on Node app servers.
Rust saves ~${yearly(A.savings * 12)} a year. A ${moneyK(C.rewrite_price_usd)} rewrite pays back in ~${payback(A.pb)}.
My advice: not yet. Find product-market fit first, the code will change anyway. Once traffic is steady, it's ${bet}.

${B.name} spends ${money(B.bill)}/month.
Rust saves ~${yearly(B.savings * 12)} a year. Same rewrite pays back in ~${payback(B.pb)}.
My advice: start yesterday.

Same benchmark. "Not yet" vs "yesterday".

And that's CPU only. Rust also used ${mem} of the memory. I didn't even count that.

Grab did it in 2025 (Go → Rust): same traffic, 20 cores down to 4.5.
Microsoft went the other way and ported the TypeScript compiler to Go, because porting kept the existing compiler's structure where a rewrite would not.
Both were right.

So, hype or worth it?
Neither. It's a payback calculation.

Send me your stack and monthly server spend. I'll tell you which company you are, free. If the answer is "not yet", you'll hear it from me first.

Code + methodology in the first comment.
Have you seen a rewrite pay off, or blow up?
`;
const comment = `Code, raw results and methodology: https://github.com/nandorcsupor/api-benchmark

Setup: the same catalog endpoint (filter + sort + JSON over ${int(R.setup.products)} products) in Axum, Fastify, Express and FastAPI. Each in Docker, pinned to 1 vCPU / 512 MB. Load: oha, ${R.setup.connections} connections, ${R.setup.runs} x ${R.setup.duration_s} s runs, median. All four return the same JSON for every request the benchmark sends, checked before each run.
Hardware: ${machine}. Run it yourself and tell me if your numbers differ.
${twist ? 'Think Fastify should win? The code is in the repo, send a PR.\n' : ''}`;
writeFileSync(join(outDir, 'post.txt'), post);
writeFileSync(join(outDir, 'first-comment.txt'), comment);

// ---------- render ----------
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(resolve(here, 'template.html')).href);
await page.evaluate(() => document.fonts.ready);
await page.evaluate(v => window.render(v), view);
await page.evaluate(() => document.fonts.ready);

// overflow guard: nothing may spill out of a slide
const overflow = await page.evaluate(() => [...document.querySelectorAll('.slide')].map((s, i) => {
  const r = s.getBoundingClientRect();
  const bad = [...s.querySelectorAll('*')].filter(e => {
    const b = e.getBoundingClientRect();
    return b.width && (b.bottom > r.bottom - 40 || b.right > r.right - 60);
  }).map(e => e.className || e.tagName);
  return { slide: i + 1, bad: [...new Set(bad)].slice(0, 5) };
}).filter(x => x.bad.length));
if (overflow.length) warnings.push('Layout overflow: ' + JSON.stringify(overflow));

const slides = await page.$$('.slide');
for (let i = 0; i < slides.length; i++) {
  await slides[i].screenshot({ path: join(outDir, `slide-${i + 1}.png`) });
}
copyFileSync(join(outDir, 'slide-3.png'), join(outDir, 'results.png'));
await page.emulateMedia({ media: 'print' });
await page.pdf({ path: join(outDir, 'carousel.pdf'), width: '1080px', height: '1350px', printBackground: true });
await browser.close();

console.log(JSON.stringify({
  order, speedup_vs_baseline: +speedup.toFixed(2), express: +rExpress.toFixed(2), fastapi: +rFastapi.toFixed(2),
  fastify_vs_express: +fastifyVsExpress.toFixed(2), memory_fraction: memFrac,
  companies: companies.map(c => ({ name: c.name, rust: Math.round(c.rustBill), save_mo: Math.round(c.savings),
    save_yr: Math.round(c.savings * 12), payback_months: +c.pb.toFixed(1), verdict: c.verdict })),
  warnings,
}, null, 2));
