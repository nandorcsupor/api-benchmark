// bench/run.mjs - the benchmark runner. Enforces the fairness rules described in
// README.md ("Methodology") and writes results/results.json.
//
//   pass 1  max throughput:  oha -z 30s -c 64 -w            x3, median requestsPerSec
//   pass 2  latency:         oha -z 30s -c 64 -q FIXED_RATE x3, median p50/p99
//
// One server at a time, pinned to a single CPU. The load generator runs in its own
// container on the other CPUs and reaches the server by container name inside
// bench-net, so no host port-forward is ever in the measurement path.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const RAW_DIR = join(ROOT, 'results', 'raw');

const NET = process.env.BENCH_NET ?? 'bench-net';
const OHA_IMAGE = process.env.OHA_IMAGE ?? 'api-benchmark/oha:latest';
const SERVER_CPU = process.env.SERVER_CPU ?? '1';
const CONNECTIONS = Number(process.env.CONNECTIONS ?? 64);
const RUNS = Number(process.env.RUNS ?? 3);
const DURATION_S = Number(process.env.DURATION_S ?? 30);
const WARMUP_S = Number(process.env.WARMUP_S ?? 10);
const SERVER_MEM_MB = 512;
const MIN_CPU_PCT = 90;
// Runs of one stack must agree within this much, or that stack is measured again.
const MAX_SPREAD_PCT = Number(process.env.MAX_SPREAD_PCT ?? 5);
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS ?? 2);
const PRODUCTS = 10000;

const STACKS = [
  { key: 'axum', label: 'Rust / Axum', image: 'api-benchmark/rust-axum:latest', container: 'bench-axum' },
  { key: 'fastify', label: 'Node.js / Fastify', image: 'api-benchmark/node-fastify:latest', container: 'bench-fastify' },
  { key: 'express', label: 'Node.js / Express', image: 'api-benchmark/node-express:latest', container: 'bench-express' },
  { key: 'fastapi', label: 'Python / FastAPI', image: 'api-benchmark/python-fastapi:latest', container: 'bench-fastapi' },
];

// Every stack gets the same request mix, generated from this exact pattern.
const urlPattern = container =>
  `http://${container}:8080/products\\?category=(electronics|books|home|toys|sports|beauty|garden|grocery|fashion|automotive)` +
  `&min_price=[1-3]00&max_price=[6-9]00&sort=(price_asc|price_desc|rating_desc)&limit=50`;

// ---------- small helpers ----------
const docker = (args, opts = {}) =>
  execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts }).trim();
const quiet = args => {
  try { return docker(args, { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
};
const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const fmt = (n, d = 1) => Number(n.toFixed(d));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const die = msg => { console.error(`\nABORT: ${msg}`); process.exit(1); };

// docker stats emits ANSI screen-clear sequences even when piped.
const stripAnsi = s => s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\u001b[=>]/g, '');

const MEM_UNITS = { B: 1 / 1048576, KiB: 1 / 1024, MiB: 1, GiB: 1024, TiB: 1048576 };
function memToMiB(text) {
  const m = /^\s*([\d.]+)\s*([A-Za-z]+)\s*$/.exec(text);
  if (!m || !(m[2] in MEM_UNITS)) throw new Error(`cannot parse MemUsage "${text}"`);
  return parseFloat(m[1]) * MEM_UNITS[m[2]];
}
const miBtoMB = miB => miB * 1.048576;

// ---------- preflight ----------
mkdirSync(RAW_DIR, { recursive: true });

let info;
try {
  info = JSON.parse(docker(['info', '--format', '{{json .}}']));
} catch {
  die('cannot talk to the Docker daemon. Start it and re-run.');
}
const NCPU = Number(info.NCPU);
if (!(NCPU >= 4)) {
  die(`Docker sees ${NCPU} CPUs, the benchmark needs at least 4 (1 for the OS, 1 for the server, the rest for the load generator).`);
}
const LOAD_CPUS = process.env.LOAD_CPUS ?? `2-${NCPU - 1}`;

// --cpuset-cpus takes the cgroup cpuset list syntax: single CPUs and inclusive
// lo-hi ranges, comma separated ("1", "0,2,5", "2-23", "0,2-5,9"). This has to be
// expanded, not string-matched: "2-23".split(/[,-]/) is ["2","23"], which cannot
// see that CPU 5 is inside the range, and a server sharing a CPU with the load
// generator invalidates every number in the run.
const expandCpuSet = (spec, what) => {
  const cpus = new Set();
  for (const part of spec.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) die(`${what} ("${spec}") is not a cpuset list: "${part}" is neither a CPU number nor a lo-hi range.`);
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    if (hi < lo) die(`${what} ("${spec}") has a backwards range "${part}".`);
    for (let c = lo; c <= hi; c++) cpus.add(c);
  }
  return cpus;
};

const serverCpus = expandCpuSet(SERVER_CPU, 'SERVER_CPU');
const loadCpus = expandCpuSet(LOAD_CPUS, 'LOAD_CPUS');
// The server is measured on exactly one core, and results.json records server_cpus: 1.
if (serverCpus.size !== 1) {
  die(`SERVER_CPU ("${SERVER_CPU}") expands to ${serverCpus.size} CPUs; the server must be pinned to exactly one.`);
}
const missing = [...serverCpus, ...loadCpus].filter(c => c >= NCPU);
if (missing.length) {
  die(`CPU ${missing.join(', ')} does not exist: Docker sees ${NCPU} CPUs (0-${NCPU - 1}).`);
}
const shared = [...loadCpus].filter(c => serverCpus.has(c));
if (shared.length) {
  die(`LOAD_CPUS (${LOAD_CPUS}) overlaps SERVER_CPU (${SERVER_CPU}) on CPU ${shared.join(', ')}.`);
}
const osCpus = Array.from({ length: NCPU }, (_, c) => c).filter(c => !serverCpus.has(c) && !loadCpus.has(c));
if (!osCpus.length) {
  die(`SERVER_CPU (${SERVER_CPU}) and LOAD_CPUS (${LOAD_CPUS}) together cover all ${NCPU} CPUs, leaving none for the OS and dockerd.`);
}

for (const st of STACKS) {
  if (!quiet(['image', 'inspect', st.image])) die(`image ${st.image} is missing. Run "make build" first.`);
}
if (!quiet(['image', 'inspect', OHA_IMAGE])) die(`image ${OHA_IMAGE} is missing. Run "make build" first.`);

// The runner relies on these oha flags; fail loudly rather than silently mis-measuring.
const ohaHelp = docker(['run', '--rm', OHA_IMAGE, '--help']);
for (const flag of ['--rand-regex-url', '--no-tui', '--output-format', '--latency-correction', '--dump-urls']) {
  if (!ohaHelp.includes(flag)) die(`the oha binary in ${OHA_IMAGE} has no ${flag} flag.`);
}
// Long forms, resolved against --help, so an oha rename fails here instead of
// silently changing what is being measured.
function resolveFlag(candidates, what) {
  const found = candidates.find(c => ohaHelp.includes(c));
  if (!found) die(`oha has none of ${candidates.join(', ')} (needed to ${what}).`);
  return found;
}
const WAIT_FLAG = resolveFlag(['--wait-ongoing-requests-after-deadline'], 'wait for in-flight requests at the deadline');
// oha 1.16 has no long form for the rate limit, so -q is checked by its metavar.
if (!ohaHelp.includes('QUERY_PER_SECOND')) die('oha has no -q <QUERY_PER_SECOND> flag (needed to hold a fixed request rate in pass 2).');
const QPS_FLAG = '-q';
if (!/possible values:[^\]]*\bjson\b/.test(ohaHelp)) die('oha --output-format does not list json as a possible value.');
const ohaVersion = docker(['run', '--rm', OHA_IMAGE, '--version']);

if (!quiet(['network', 'inspect', NET])) docker(['network', 'create', NET]);
for (const st of STACKS) quiet(['rm', '-f', st.container]);

const cpuModel = (() => {
  try {
    const m = /^model name\s*:\s*(.+)$/m.exec(readFileSync('/proc/cpuinfo', 'utf8'));
    if (m) return m[1].replace(/\((R|TM|r|tm)\)/g, '').replace(/\s+/g, ' ').trim();
  } catch { /* fall through */ }
  return os.cpus()[0]?.model ?? 'unknown';
})();
const osName = (() => {
  try {
    const rel = readFileSync('/etc/os-release', 'utf8');
    const pretty = /^PRETTY_NAME="?([^"\n]+)"?$/m.exec(rel)?.[1];
    const wsl = os.release().includes('microsoft') ? ' (WSL2)' : '';
    if (pretty) return pretty + wsl;
  } catch { /* fall through */ }
  return `${os.type()} ${os.release()}`;
})();

const machine = {
  cpu: cpuModel,
  logical_cpus: os.cpus().length,
  ram_gb: Math.round(os.totalmem() / 1024 ** 3),
  os: osName,
  docker: info.ServerVersion,
  docker_vm_cpus: NCPU,
};

log('machine:', JSON.stringify(machine));
log(`pinning: server CPU ${SERVER_CPU} (--cpus=1 --memory=${SERVER_MEM_MB}m), load generator CPUs ${LOAD_CPUS}, left to the OS: ${osCpus.join(',')}`);
log(`oha:     ${ohaVersion}`);

// Show that the pattern really produces the intended URLs before measuring anything.
const urlSample = docker(['run', '--rm', OHA_IMAGE, '--dump-urls', '5', '--rand-regex-url', urlPattern('bench-axum')])
  .split('\n').map(s => s.trim()).filter(Boolean);
log('url sample (oha --dump-urls 5):');
for (const u of urlSample) log('  ' + u);
const SHAPE = /^http:\/\/bench-axum:8080\/products\?category=(electronics|books|home|toys|sports|beauty|garden|grocery|fashion|automotive)&min_price=[1-3]00&max_price=[6-9]00&sort=(price_asc|price_desc|rating_desc)&limit=50$/;
if (urlSample.length !== 5 || !urlSample.every(u => SHAPE.test(u))) {
  die(`oha --dump-urls produced URLs that do not match the intended shape:\n${urlSample.join('\n')}`);
}

// ---------- container lifecycle ----------
function startServer(st) {
  quiet(['rm', '-f', st.container]);
  docker(['run', '-d', '--name', st.container, '--network', NET,
    '--cpuset-cpus', SERVER_CPU, '--cpus', '1', '--memory', `${SERVER_MEM_MB}m`,
    st.image]);
  // Wait for /health from inside bench-net, so no host port is ever published.
  const waiter = quiet(['run', '--rm', '--network', NET, '--cpuset-cpus', LOAD_CPUS,
    '--entrypoint', 'sh', OHA_IMAGE, '-c',
    `for i in $(seq 1 120); do curl -fsS http://${st.container}:8080/health >/dev/null 2>&1 && exit 0; sleep 0.5; done; exit 1`]);
  if (waiter === null) {
    const logs = quiet(['logs', st.container]) ?? '(no logs)';
    die(`${st.key} did not become healthy within 60 s. Container logs:\n${logs}`);
  }
  const logs = docker(['logs', st.container]);
  log(`  ${st.key} up. startup log: ${logs.split('\n').filter(Boolean).join(' | ')}`);
  // Rust must see exactly 1 CPU under the pin, otherwise tokio sizes its pool wrong.
  if (st.key === 'axum') {
    const m = /available_parallelism=(\d+)/.exec(logs);
    if (!m) die('the Rust server did not log available_parallelism.');
    if (m[1] !== '1') die(`the Rust server sees available_parallelism=${m[1]} under --cpuset-cpus=${SERVER_CPU}, expected 1. The CPU pin is not being applied.`);
  }
  return logs;
}
const stopServer = st => quiet(['rm', '-f', st.container]);

function statsOnce(container) {
  const line = stripAnsi(docker(['stats', '--no-stream', '--format', '{{json .}}', container]))
    .split('\n').map(s => s.trim()).filter(s => s.startsWith('{')).pop();
  return JSON.parse(line);
}

function startStats(container) {
  const proc = spawn('docker', ['stats', '--format', '{{json .}}', container], { stdio: ['ignore', 'pipe', 'ignore'] });
  const samples = [];
  let buf = '';
  proc.stdout.on('data', chunk => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const raw of lines) {
      const line = stripAnsi(raw).trim();
      if (!line.startsWith('{')) continue;
      try { samples.push(JSON.parse(line)); } catch { /* partial frame */ }
    }
  });
  return {
    samples,
    stop() { try { proc.kill('SIGTERM'); } catch { /* already gone */ } },
  };
}

// ---------- oha ----------
function runOha({ container, seconds, qps, latencyCorrection, rawPath }) {
  const args = ['run', '--rm', '--network', NET, '--cpuset-cpus', LOAD_CPUS, OHA_IMAGE,
    '-z', `${seconds}s`, '-c', String(CONNECTIONS),
    // Waiting for in-flight requests at the deadline means no run reports
    // "aborted due to deadline" errors.
    WAIT_FLAG, '--no-tui', '--output-format', 'json'];
  if (qps) args.push(QPS_FLAG, String(qps));
  if (latencyCorrection) args.push('--latency-correction');
  args.push('--rand-regex-url', urlPattern(container));

  const stdout = docker(args);
  const start = stdout.indexOf('{');
  if (start < 0) throw new Error(`oha produced no JSON:\n${stdout.slice(0, 500)}`);
  const json = JSON.parse(stdout.slice(start));
  if (rawPath) writeFileSync(rawPath, JSON.stringify(json, null, 2));
  return json;
}

function assertClean(json, label) {
  const dist = json.statusCodeDistribution ?? {};
  const codes = Object.keys(dist);
  if (codes.length !== 1 || codes[0] !== '200') {
    throw new Error(`${label}: statusCodeDistribution is ${JSON.stringify(dist)}, expected only 200s`);
  }
  const errors = json.errorDistribution ?? {};
  if (Object.keys(errors).length) {
    throw new Error(`${label}: errorDistribution is ${JSON.stringify(errors)}`);
  }
  const sr = json.summary?.successRate;
  // oha reports successRate as a 0..1 ratio; accept a percentage too in case that changes.
  if (!(Math.abs(sr - 1) < 1e-9 || Math.abs(sr - 100) < 1e-9)) {
    throw new Error(`${label}: summary.successRate is ${sr}, expected 1`);
  }
}

const runOrder = [];
const record = entry => { runOrder.push({ n: runOrder.length + 1, ...entry }); };

// A stack whose runs disagree with each other is measuring the machine, not the
// server. Re-measure it once on a fresh container and keep the rejected attempt
// on disk so the discard is visible rather than quietly swept away.
const spreadPct = xs => ((Math.max(...xs) - Math.min(...xs)) / median(xs)) * 100;
function keepRejected(key, pass, attempt) {
  for (let n = 1; n <= RUNS; n++) {
    try {
      renameSync(join(RAW_DIR, `${key}-pass${pass}-${n}.json`),
        join(RAW_DIR, `${key}-pass${pass}-rejected${attempt}-${n}.json`));
    } catch { /* nothing to keep */ }
  }
}

// ---------- pass 1: max throughput ----------
log(`\n=== PASS 1 - max throughput (-c ${CONNECTIONS}, ${RUNS} x ${DURATION_S}s, ${WARMUP_S}s warmup) ===`);
log(`stability gate: if the ${RUNS} runs of a stack spread more than ${MAX_SPREAD_PCT}%, that stack is measured again on a fresh container.`);

async function pass1Attempt(st) {
  startServer(st);
  await sleep(1000);

  const idle = statsOnce(st.container);
  const idleMemMB = miBtoMB(memToMiB(idle.MemUsage.split('/')[0]));
  log(`  idle memory: ${fmt(idleMemMB)} MB`);

  log(`  warmup ${WARMUP_S}s (discarded)`);
  const warm = runOha({ container: st.container, seconds: WARMUP_S, rawPath: join(RAW_DIR, `${st.key}-pass1-warmup.json`) });
  log(`  warmup done: ${Math.round(warm.summary.requestsPerSec)} req/s (not used)`);

  const stats = startStats(st.container);
  const runs = [];
  try {
    for (let n = 1; n <= RUNS; n++) {
      const rawPath = join(RAW_DIR, `${st.key}-pass1-${n}.json`);
      const startedAt = new Date().toISOString();
      const json = runOha({ container: st.container, seconds: DURATION_S, rawPath });
      try { assertClean(json, `${st.key} pass1 run ${n}`); } catch (err) { stats.stop(); stopServer(st); die(err.message); }
      const rps = json.summary.requestsPerSec;
      runs.push({ n, rps, startedAt });
      // summary.total is the elapsed duration in seconds; the request count lives
      // in statusCodeDistribution.
      log(`  run ${n}: ${Math.round(rps)} req/s (${json.statusCodeDistribution['200'].toLocaleString('en-US')} requests in ${json.summary.total.toFixed(1)} s, all 200)`);
    }
  } finally {
    stats.stop();
  }
  await sleep(300);

  if (stats.samples.length < 10) {
    stopServer(st);
    die(`only ${stats.samples.length} docker stats samples for ${st.key}; cannot judge CPU or memory.`);
  }
  const mems = stats.samples.map(s => memToMiB(s.MemUsage.split('/')[0]));
  const cpus = stats.samples.map(s => parseFloat(s.CPUPerc));
  const peakMemMB = miBtoMB(Math.max(...mems));
  const cpuPct = median(cpus);
  log(`  peak memory: ${fmt(peakMemMB)} MB, median CPU: ${fmt(cpuPct)}% over ${stats.samples.length} samples`);

  // If the server was not the bottleneck, the numbers mean nothing.
  if (cpuPct < MIN_CPU_PCT) {
    stopServer(st);
    die(`${st.key} median CPU during pass 1 was ${fmt(cpuPct)}%, below ${MIN_CPU_PCT}%. The server was not the bottleneck, so these numbers are not valid. Check that the load generator CPUs (${LOAD_CPUS}) are not saturated and that nothing else is running.`);
  }
  stopServer(st);

  const rpsRuns = runs.map(r => r.rps);
  return { runs, rpsRuns, peakMemMB, idleMemMB, cpuPct, spread: spreadPct(rpsRuns) };
}

const pass1 = {};
for (const st of STACKS) {
  let result, attempt = 0;
  for (;;) {
    attempt++;
    log(`\n[${st.key}] ${st.label}${attempt > 1 ? `  (measurement ${attempt})` : ''}`);
    result = await pass1Attempt(st);
    log(`  rps spread: ${fmt(result.spread, 2)}% across ${RUNS} runs (gate: ${MAX_SPREAD_PCT}%)`);
    if (result.spread <= MAX_SPREAD_PCT || attempt >= MAX_ATTEMPTS) break;
    log(`  -> outside ${MAX_SPREAD_PCT}%, re-measuring ${st.key} on a fresh container`);
    keepRejected(st.key, 1, attempt);
  }
  if (result.spread > MAX_SPREAD_PCT) {
    log(`  WARNING: ${st.key} still spreads ${fmt(result.spread, 2)}% after ${attempt} measurements; reporting the last one.`);
  }
  for (const r of result.runs) {
    record({ stack: st.key, pass: 1, run: r.n, measurement: attempt, started_at: r.startedAt, raw: `results/raw/${st.key}-pass1-${r.n}.json`, rps: fmt(r.rps, 1) });
  }
  pass1[st.key] = {
    rps_runs: result.rpsRuns.map(r => fmt(r, 1)),
    rps: fmt(median(result.rpsRuns), 1),
    peak_mem_mb: fmt(result.peakMemMB),
    idle_mem_mb: fmt(result.idleMemMB),
    cpu_pct: fmt(result.cpuPct),
    spread_pct: fmt(result.spread, 2),
    measurements: attempt,
  };
  log(`  median: ${Math.round(pass1[st.key].rps)} req/s`);
}

// ---------- pass 2: latency at a fixed rate ----------
const minMedian = Math.min(...STACKS.map(s => pass1[s.key].rps));
const FIXED_RATE = Math.max(100, Math.floor((0.5 * minMedian) / 100) * 100);
log(`\n=== PASS 2 - latency at a fixed rate ===`);
log(`slowest stack median: ${Math.round(minMedian)} req/s  ->  FIXED_RATE = max(100, floor(0.5 * ${Math.round(minMedian)} / 100) * 100) = ${FIXED_RATE} req/s`);

log(`stability gate: if the ${RUNS} p99 values of a stack spread more than ${MAX_SPREAD_PCT}%, that stack is measured again on a fresh container.`);

async function pass2Attempt(st) {
  startServer(st);
  await sleep(1000);

  log(`  warmup ${WARMUP_S}s (discarded)`);
  runOha({ container: st.container, seconds: WARMUP_S, qps: FIXED_RATE, latencyCorrection: true, rawPath: join(RAW_DIR, `${st.key}-pass2-warmup.json`) });

  const runs = [];
  for (let n = 1; n <= RUNS; n++) {
    const rawPath = join(RAW_DIR, `${st.key}-pass2-${n}.json`);
    const startedAt = new Date().toISOString();
    const json = runOha({ container: st.container, seconds: DURATION_S, qps: FIXED_RATE, latencyCorrection: true, rawPath });
    try { assertClean(json, `${st.key} pass2 run ${n}`); } catch (err) { stopServer(st); die(err.message); }
    const p50 = json.latencyPercentiles.p50 * 1000;
    const p99 = json.latencyPercentiles.p99 * 1000;
    runs.push({ n, p50, p99, startedAt, achieved: json.summary.requestsPerSec });
    log(`  run ${n}: p50 ${fmt(p50, 2)} ms, p99 ${fmt(p99, 2)} ms (${Math.round(json.summary.requestsPerSec)} req/s achieved)`);
  }
  stopServer(st);

  const p99s = runs.map(r => r.p99);
  return { runs, p50s: runs.map(r => r.p50), p99s, spread: spreadPct(p99s) };
}

const pass2 = {};
for (const st of STACKS) {
  let result, attempt = 0;
  for (;;) {
    attempt++;
    log(`\n[${st.key}] ${st.label} at ${FIXED_RATE} req/s${attempt > 1 ? `  (measurement ${attempt})` : ''}`);
    result = await pass2Attempt(st);
    log(`  p99 spread: ${fmt(result.spread, 2)}% across ${RUNS} runs (gate: ${MAX_SPREAD_PCT}%)`);
    if (result.spread <= MAX_SPREAD_PCT || attempt >= MAX_ATTEMPTS) break;
    log(`  -> outside ${MAX_SPREAD_PCT}%, re-measuring ${st.key} on a fresh container`);
    keepRejected(st.key, 2, attempt);
  }
  if (result.spread > MAX_SPREAD_PCT) {
    log(`  WARNING: ${st.key} p99 still spreads ${fmt(result.spread, 2)}% after ${attempt} measurements; reporting the last one.`);
  }
  for (const r of result.runs) {
    record({ stack: st.key, pass: 2, run: r.n, measurement: attempt, started_at: r.startedAt, raw: `results/raw/${st.key}-pass2-${r.n}.json`, p50_ms: fmt(r.p50, 3), p99_ms: fmt(r.p99, 3), achieved_rps: fmt(r.achieved, 1) });
  }
  pass2[st.key] = {
    p50_ms: fmt(median(result.p50s), 2),
    p99_ms: fmt(median(result.p99s), 2),
    p99_ms_runs: result.p99s.map(v => fmt(v, 2)),
    p50_ms_runs: result.p50s.map(v => fmt(v, 2)),
    spread_pct: fmt(result.spread, 2),
    measurements: attempt,
  };
  log(`  median: p50 ${pass2[st.key].p50_ms} ms, p99 ${pass2[st.key].p99_ms} ms`);
}

// ---------- versions ----------
function imageVersions() {
  const run = (image, entrypoint, args) => docker(['run', '--rm', '--entrypoint', entrypoint, image, ...args]);
  const lock = readFileSync(join(ROOT, 'servers', 'rust-axum', 'Cargo.lock'), 'utf8');
  const axumVer = /name = "axum"\nversion = "([^"]+)"/.exec(lock)?.[1] ?? 'unknown';
  // Read out of the image that was actually built, like the other three stacks,
  // rather than pulling a toolchain image at benchmark time and reporting whatever
  // that tag happens to resolve to then.
  const rustc = run('api-benchmark/rust-axum:latest', 'cat', ['/app/rustc-version.txt']).replace(/\s*\(.*\)$/, '');

  const nodeVer = image => run(image, 'node', ['-p', 'process.versions.node']);
  const pkgVer = (image, pkg) => run(image, 'node', ['-p', `require('${pkg}/package.json').version`]);
  const py = run('api-benchmark/python-fastapi:latest', 'python', ['-c',
    "import sys,fastapi,pydantic,uvicorn;print(f'{sys.version.split()[0]}|{fastapi.__version__}|{pydantic.VERSION}|{uvicorn.__version__}')"]).split('|');

  return {
    axum: `${rustc}, axum ${axumVer}`,
    fastify: `Node.js ${nodeVer('api-benchmark/node-fastify:latest')}, Fastify ${pkgVer('api-benchmark/node-fastify:latest', 'fastify')}`,
    express: `Node.js ${nodeVer('api-benchmark/node-express:latest')}, Express ${pkgVer('api-benchmark/node-express:latest', 'express')}`,
    fastapi: `Python ${py[0]}, FastAPI ${py[1]}, Pydantic ${py[2]}, uvicorn ${py[3]}`,
  };
}
log('\ncollecting exact versions from the built images');
const versions = imageVersions();
for (const [k, v] of Object.entries(versions)) log(`  ${k}: ${v}`);

// ---------- results.json ----------
const stacks = {};
for (const st of STACKS) {
  stacks[st.key] = {
    version: versions[st.key],
    rps: pass1[st.key].rps,
    rps_runs: pass1[st.key].rps_runs,
    p50_ms: pass2[st.key].p50_ms,
    p99_ms: pass2[st.key].p99_ms,
    p99_ms_runs: pass2[st.key].p99_ms_runs,
    p50_ms_runs: pass2[st.key].p50_ms_runs,
    peak_mem_mb: pass1[st.key].peak_mem_mb,
    idle_mem_mb: pass1[st.key].idle_mem_mb,
    cpu_pct: pass1[st.key].cpu_pct,
    quality: {
      rps_spread_pct: pass1[st.key].spread_pct,
      p99_spread_pct: pass2[st.key].spread_pct,
      spread_gate_pct: MAX_SPREAD_PCT,
      pass1_measurements: pass1[st.key].measurements,
      pass2_measurements: pass2[st.key].measurements,
    },
  };
}

const results = {
  date: new Date().toISOString().slice(0, 10),
  machine,
  setup: {
    products: PRODUCTS,
    connections: CONNECTIONS,
    runs: RUNS,
    duration_s: DURATION_S,
    warmup_s: WARMUP_S,
    fixed_rate_rps: FIXED_RATE,
    server_cpus: 1,
    server_mem_mb: SERVER_MEM_MB,
    endpoint_short: 'Catalog endpoint, filter + sort + JSON over 10k products',
  },
  stacks,
  tooling: {
    oha: ohaVersion,
    load_generator_cpus: LOAD_CPUS,
    server_cpu: SERVER_CPU,
    url_pattern: urlPattern('<server>'),
    url_sample: urlSample,
  },
  run_order: runOrder,
};

const outPath = join(ROOT, 'results', 'results.json');
writeFileSync(outPath, JSON.stringify(results, null, 2) + '\n');

// A zero or a null here means a stack silently failed to measure. Refuse to publish it.
const bad = [];
for (const [key, s] of Object.entries(stacks)) {
  for (const [field, value] of Object.entries(s)) {
    if (value === null || value === undefined) bad.push(`stacks.${key}.${field} is ${value}`);
    else if (typeof value === 'number' && value === 0) bad.push(`stacks.${key}.${field} is 0`);
    else if (Array.isArray(value) && value.some(v => !v)) bad.push(`stacks.${key}.${field} contains a zero`);
  }
}
if (bad.length) die(`results.json is not usable:\n  ${bad.join('\n  ')}`);

// ---------- summary ----------
const pad = (s, w) => String(s).padStart(w);
log(`\n=== RESULTS  (${results.date}, ${machine.cpu}) ===`);
log(`${'stack'.padEnd(10)}${pad('req/s', 10)}${pad('p50 ms', 9)}${pad('p99 ms', 9)}${pad('peak MB', 9)}${pad('idle MB', 9)}${pad('CPU %', 8)}${pad('rps +-', 9)}${pad('p99 +-', 9)}   version`);
for (const st of STACKS) {
  const s = stacks[st.key];
  log(`${st.key.padEnd(10)}${pad(Math.round(s.rps).toLocaleString('en-US'), 10)}${pad(s.p50_ms, 9)}${pad(s.p99_ms, 9)}${pad(s.peak_mem_mb, 9)}${pad(s.idle_mem_mb, 9)}${pad(s.cpu_pct, 8)}${pad(s.quality.rps_spread_pct + '%', 9)}${pad(s.quality.p99_spread_pct + '%', 9)}   ${s.version}`);
}
const reMeasured = STACKS.filter(st => stacks[st.key].quality.pass1_measurements > 1 || stacks[st.key].quality.pass2_measurements > 1);
log(reMeasured.length
  ? `re-measured for spread > ${MAX_SPREAD_PCT}%: ${reMeasured.map(st => st.key).join(', ')} (rejected attempts kept in results/raw/*-rejected*.json)`
  : `all 8 stack/pass combinations stayed inside the ${MAX_SPREAD_PCT}% spread gate on the first measurement.`);
log(`\naxum vs express: ${(stacks.axum.rps / stacks.express.rps).toFixed(2)}x   axum vs fastapi: ${(stacks.axum.rps / stacks.fastapi.rps).toFixed(2)}x   fastify vs express: ${(stacks.fastify.rps / stacks.express.rps).toFixed(2)}x`);
log(`p50/p99 measured at a fixed ${FIXED_RATE} req/s for every stack.`);
log(`\nwrote ${outPath}`);
log(`raw oha output: results/raw/ (${runOrder.length} measured runs + ${STACKS.length * 2} discarded warmups)`);
