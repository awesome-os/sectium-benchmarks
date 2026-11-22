import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

interface LoadgenResult {
  ok: number;
  errors: number;
  elapsedMs: number;
  reqPerSec: number;
  p50Us: number;
  p99Us: number;
}

interface ComplianceCheck {
  path: string;
  statusCode: number;
  contentType: string;
  serverHeader: string;
  dateHeader: string;
  body: string;
  passed: boolean;
}

interface HttpCellResult {
  facade: string;
  path: string;
  concurrency: number;
  requests: number;
  ok: number;
  errors: number;
  elapsedMs: number;
  reqPerSec: number;
  p50Us: number;
  p99Us: number;
}

interface HttpFacadeSummary {
  facade: string;
  binaryPath: string;
  binaryBytes: number;
  binaryKb: number;
  runtimeBytes: number | null;
  runtimeKb: number | null;
  coldStartMs: number;
  compliance: ComplianceCheck[];
  cells: HttpCellResult[];
}

interface RuntimeMatrixRow {
  id: string;
  label: string;
  binaryPath: string;
  binaryBytes: number;
  binaryKb: number;
  artifactBytes: number | null;
  coldWallMs: number;
  medianWallMs: number;
  minWallMs: number;
  internalElapsedMs: number | null;
  stdout: string;
  verified: boolean;
  speedupVsTier0: number | null;
}

interface MatrixReport {
  generatedAt: string;
  host: {
    platform: string;
    arch: string;
    cpus: number;
    cpuModel: string;
    nodeVersion: string;
  };
  loadgen: {
    path: string;
    binaryBytes: number;
    binaryKb: number;
    requestsPerCell: number;
    concurrencies: number[];
    paths: string[];
  };
  httpMatrix: HttpFacadeSummary[];
  runtimeMatrix: RuntimeMatrixRow[];
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TFB_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = 'E:\\awesome-os';

const LOADGEN_EXE = path.join(__dirname, 'tfb-loadgen.exe');
const C11_SERVER_EXE = path.join(TFB_ROOT, 'facades', 'c11-native', 'tfb-c11-native.exe');
const NODE_SERVER_MJS = path.join(TFB_ROOT, 'facades', 'sectium-node', 'server.mjs');
const NODE_PS1 = path.join(WORKSPACE_ROOT, 'bin', 'node.ps1');

const SECTIUM_ES_EXE = path.join(WORKSPACE_ROOT, 'sections', 'b8g-es', 'dist', 'sectium-es.exe');
const SECTIUM_ES_SCRIPT = path.join(TFB_ROOT, 'facades', 'sectium-es', 'tfb-es.js');
const SECTIUM_JVM_EXE = path.join(WORKSPACE_ROOT, 'sections', 'b8g-jvm', 'dist', 'sectium-jvm.exe');
const SECTIUM_JVM_CLASS = path.join(TFB_ROOT, 'facades', 'sectium-jvm', 'TfbBench.class');
const SECTIUM_JVM_AOT_EXE = path.join(TFB_ROOT, 'facades', 'sectium-jvm', 'tfb-jvm-aot.exe');

const REQUESTS_PER_CELL = 4000;
const CONCURRENCIES = [1, 8];
const HTTP_PATHS = ['/plaintext', '/json'];

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function requireFile(filePath: string): void {
  if (!existsSync(filePath)) {
    throw new Error(`Required file not found: ${filePath}`);
  }
}

function httpGetOnce(host: string, port: number, urlPath: string): Promise<{
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
        port,
        path: urlPath,
        method: 'GET',
        agent: false,
        headers: { Connection: 'close' },
        timeout: 2000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('HTTP request timed out'));
    });
    req.end();
  });
}

async function waitForReady(host: string, port: number, timeoutMs: number): Promise<number> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    try {
      const res = await httpGetOnce(host, port, '/plaintext');
      if (res.statusCode === 200) {
        return performance.now() - start;
      }
    } catch {
      // Server still starting
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Server on ${host}:${port} did not become ready within ${timeoutMs} ms`);
}

function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(pid)], {
      shell: false,
      stdio: 'ignore',
    });
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already exited
    }
  }
}

async function verifyCompliance(host: string, port: number): Promise<ComplianceCheck[]> {
  const checks: ComplianceCheck[] = [];

  const pt = await httpGetOnce(host, port, '/plaintext');
  const ptCt = String(pt.headers['content-type'] ?? '');
  const ptServer = String(pt.headers['server'] ?? '');
  const ptDate = String(pt.headers['date'] ?? '');
  checks.push({
    path: '/plaintext',
    statusCode: pt.statusCode,
    contentType: ptCt,
    serverHeader: ptServer,
    dateHeader: ptDate,
    body: pt.body,
    passed:
      pt.statusCode === 200 &&
      pt.body === 'Hello, World!' &&
      ptCt.toLowerCase().includes('text/plain') &&
      ptServer.length > 0 &&
      ptDate.length > 0,
  });

  const js = await httpGetOnce(host, port, '/json');
  const jsCt = String(js.headers['content-type'] ?? '');
  const jsServer = String(js.headers['server'] ?? '');
  const jsDate = String(js.headers['date'] ?? '');
  checks.push({
    path: '/json',
    statusCode: js.statusCode,
    contentType: jsCt,
    serverHeader: jsServer,
    dateHeader: jsDate,
    body: js.body,
    passed:
      js.statusCode === 200 &&
      js.body === '{"message":"Hello, World!"}' &&
      jsCt.toLowerCase().includes('application/json') &&
      jsServer.length > 0 &&
      jsDate.length > 0,
  });

  for (const c of checks) {
    if (!c.passed) {
      throw new Error(`TFB compliance failed for ${c.path}: ${JSON.stringify(c)}`);
    }
  }

  return checks;
}

function runLoadgen(port: number, urlPath: string, concurrency: number, requests: number): LoadgenResult {
  const res = spawnSync(
    LOADGEN_EXE,
    [
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--path',
      urlPath,
      '--concurrency',
      String(concurrency),
      '--requests',
      String(requests),
    ],
    {
      shell: false,
      encoding: 'utf8',
    },
  );
  if (res.error) {
    throw res.error;
  }
  if (res.status !== 0) {
    throw new Error(`tfb-loadgen failed (exit ${res.status}): ${res.stderr || res.stdout}`);
  }
  const line = res.stdout.trim().split(/\r?\n/).pop() ?? '';
  return JSON.parse(line) as LoadgenResult;
}

async function benchmarkHttpFacade(opts: {
  facade: string;
  cmd: string;
  args: string[];
  port: number;
  binaryPath: string;
  runtimeBytes: number | null;
}): Promise<HttpFacadeSummary> {
  const binaryBytes = statSync(opts.binaryPath).size;
  const child = spawn(opts.cmd, opts.args, {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrBuf = '';
  child.stderr?.on('data', (d: Buffer) => {
    stderrBuf += d.toString('utf8');
  });

  try {
    const coldStartMs = await waitForReady('127.0.0.1', opts.port, 10000);
    const compliance = await verifyCompliance('127.0.0.1', opts.port);

    // Short warmup to stabilize socket/JIT state before measured cells
    runLoadgen(opts.port, '/plaintext', 1, 200);

    const cells: HttpCellResult[] = [];
    for (const urlPath of HTTP_PATHS) {
      for (const concurrency of CONCURRENCIES) {
        const lg = runLoadgen(opts.port, urlPath, concurrency, REQUESTS_PER_CELL);
        if (lg.ok !== REQUESTS_PER_CELL || lg.errors !== 0) {
          throw new Error(
            `Loadgen errors on ${opts.facade} ${urlPath} c=${concurrency}: ${JSON.stringify(lg)}`,
          );
        }
        cells.push({
          facade: opts.facade,
          path: urlPath,
          concurrency,
          requests: REQUESTS_PER_CELL,
          ok: lg.ok,
          errors: lg.errors,
          elapsedMs: round(lg.elapsedMs, 3),
          reqPerSec: round(lg.reqPerSec, 2),
          p50Us: round(lg.p50Us, 2),
          p99Us: round(lg.p99Us, 2),
        });
      }
    }

    return {
      facade: opts.facade,
      binaryPath: opts.binaryPath,
      binaryBytes,
      binaryKb: round(binaryBytes / 1024, 1),
      runtimeBytes: opts.runtimeBytes,
      runtimeKb: opts.runtimeBytes !== null ? round(opts.runtimeBytes / 1024, 1) : null,
      coldStartMs: round(coldStartMs, 2),
      compliance,
      cells,
    };
  } catch (err) {
    throw new Error(`${opts.facade} failed: ${String(err)}${stderrBuf ? `\nstderr: ${stderrBuf}` : ''}`);
  } finally {
    killProcessTree(child.pid);
  }
}

function runTimedCommand(cmd: string, args: string[], runs: number): {
  coldWallMs: number;
  medianWallMs: number;
  minWallMs: number;
  stdout: string;
} {
  const timings: number[] = [];
  let lastStdout = '';
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const res = spawnSync(cmd, args, {
      shell: false,
      encoding: 'utf8',
    });
    const elapsed = performance.now() - t0;
    if (res.error) throw res.error;
    if (res.status !== 0) {
      throw new Error(`Command failed (${cmd} ${args.join(' ')}): exit ${res.status}\n${res.stderr}`);
    }
    timings.push(elapsed);
    lastStdout = res.stdout.trim();
  }
  return {
    coldWallMs: round(timings[0], 2),
    medianWallMs: round(median(timings), 2),
    minWallMs: round(Math.min(...timings), 2),
    stdout: lastStdout,
  };
}

function benchmarkRuntimeMatrix(): RuntimeMatrixRow[] {
  const RUNS = 5;

  // 1. sectium-es (zero-V8)
  const esTiming = runTimedCommand(SECTIUM_ES_EXE, [SECTIUM_ES_SCRIPT], RUNS);
  const esMatch = esTiming.stdout.match(/elapsed_ms=([0-9.]+)/);
  const esInternalMs = esMatch ? round(Number(esMatch[1]), 3) : null;
  const esVerified =
    esTiming.stdout.includes('iterations=10000') &&
    esTiming.stdout.includes('dup_v8=0B') &&
    esInternalMs !== null;
  if (!esVerified) {
    throw new Error(`sectium-es output verification failed: ${esTiming.stdout}`);
  }
  const esBinBytes = statSync(SECTIUM_ES_EXE).size;

  // 2. sectium-jvm Tier-0 (zero-JDK interpreter)
  const jvm0Timing = runTimedCommand(SECTIUM_JVM_EXE, ['--run', SECTIUM_JVM_CLASS], RUNS);
  const jvm0Verified =
    jvm0Timing.stdout.includes('75025') && jvm0Timing.stdout.includes('12742320');
  if (!jvm0Verified) {
    throw new Error(`sectium-jvm Tier-0 verification failed: ${jvm0Timing.stdout}`);
  }
  const jvm0BinBytes = statSync(SECTIUM_JVM_EXE).size;
  const jvmClassBytes = statSync(SECTIUM_JVM_CLASS).size;

  // 3. sectium-jvm Tier-2 AOT (zig cc -O3 -s)
  const jvm2Timing = runTimedCommand(SECTIUM_JVM_AOT_EXE, [], RUNS);
  const jvm2Verified =
    jvm2Timing.stdout.includes('75025') && jvm2Timing.stdout.includes('12742320');
  if (!jvm2Verified) {
    throw new Error(`sectium-jvm Tier-2 AOT verification failed: ${jvm2Timing.stdout}`);
  }
  const jvm2BinBytes = statSync(SECTIUM_JVM_AOT_EXE).size;

  const speedup = round(jvm0Timing.medianWallMs / jvm2Timing.medianWallMs, 2);

  return [
    {
      id: 'sectium-es',
      label: 'sectium-es (Zero-V8 C11 ES)',
      binaryPath: SECTIUM_ES_EXE,
      binaryBytes: esBinBytes,
      binaryKb: round(esBinBytes / 1024, 1),
      artifactBytes: statSync(SECTIUM_ES_SCRIPT).size,
      coldWallMs: esTiming.coldWallMs,
      medianWallMs: esTiming.medianWallMs,
      minWallMs: esTiming.minWallMs,
      internalElapsedMs: esInternalMs,
      stdout: esTiming.stdout,
      verified: esVerified,
      speedupVsTier0: null,
    },
    {
      id: 'sectium-jvm-tier0',
      label: 'sectium-jvm Tier-0 (Zero-JDK Interpreter)',
      binaryPath: SECTIUM_JVM_EXE,
      binaryBytes: jvm0BinBytes,
      binaryKb: round(jvm0BinBytes / 1024, 1),
      artifactBytes: jvmClassBytes,
      coldWallMs: jvm0Timing.coldWallMs,
      medianWallMs: jvm0Timing.medianWallMs,
      minWallMs: jvm0Timing.minWallMs,
      internalElapsedMs: null,
      stdout: jvm0Timing.stdout.replace(/\r?\n/g, ' / '),
      verified: jvm0Verified,
      speedupVsTier0: 1.0,
    },
    {
      id: 'sectium-jvm-tier2-aot',
      label: 'sectium-jvm Tier-2 AOT (zig cc -O3 -s)',
      binaryPath: SECTIUM_JVM_AOT_EXE,
      binaryBytes: jvm2BinBytes,
      binaryKb: round(jvm2BinBytes / 1024, 1),
      artifactBytes: jvmClassBytes,
      coldWallMs: jvm2Timing.coldWallMs,
      medianWallMs: jvm2Timing.medianWallMs,
      minWallMs: jvm2Timing.minWallMs,
      internalElapsedMs: null,
      stdout: jvm2Timing.stdout.replace(/\r?\n/g, ' / '),
      verified: jvm2Verified,
      speedupVsTier0: speedup,
    },
  ];
}

function renderMarkdown(report: MatrixReport): string {
  const lines: string[] = [];
  lines.push('# TechEmpower Cross-Matrix Benchmark Report');
  lines.push('');
  lines.push(`- **Generated:** ${report.generatedAt}`);
  lines.push(
    `- **Host:** ${report.host.platform}/${report.host.arch} | ${report.host.cpus} vCPUs (${report.host.cpuModel}) | Node ${report.host.nodeVersion}`,
  );
  lines.push(
    `- **Load Generator:** \`tfb-loadgen.exe\` (${report.loadgen.binaryKb} KB, C11 WinSock2 keep-alive + \`TCP_NODELAY\` + QPC, ${report.loadgen.requestsPerCell} req/cell)`,
  );
  lines.push('');
  lines.push('## 1. HTTP/1.1 Keep-Alive Matrix (`/plaintext` & `/json`)');
  lines.push('');
  lines.push(
    '| Facade | Binary Size | Cold Start | Endpoint | Concurrency | Req/s | p50 (µs) | p99 (µs) | Errors |',
  );
  lines.push('| :--- | ---: | ---: | :--- | ---: | ---: | ---: | ---: | ---: |');

  for (const facade of report.httpMatrix) {
    const sizeLabel =
      facade.runtimeKb !== null
        ? `${facade.binaryKb} KB (+ ${round(facade.runtimeKb / 1024, 1)} MB Node)`
        : `${facade.binaryKb} KB`;
    for (const cell of facade.cells) {
      lines.push(
        `| \`${facade.facade}\` | ${sizeLabel} | ${facade.coldStartMs} ms | \`${cell.path}\` | c=${cell.concurrency} | **${cell.reqPerSec.toLocaleString('en-US', { maximumFractionDigits: 1 })}** | ${cell.p50Us} | ${cell.p99Us} | ${cell.errors} |`,
      );
    }
  }

  lines.push('');
  lines.push('### TFB HTTP Compliance Verification');
  lines.push('');
  lines.push('| Facade | Endpoint | Status | Content-Type | Server | Body Exact | Result |');
  lines.push('| :--- | :--- | ---: | :--- | :--- | :--- | :--- |');
  for (const facade of report.httpMatrix) {
    for (const c of facade.compliance) {
      lines.push(
        `| \`${facade.facade}\` | \`${c.path}\` | ${c.statusCode} | \`${c.contentType}\` | \`${c.serverHeader}\` | \`${c.body}\` | ${c.passed ? 'PASS' : 'FAIL'} |`,
      );
    }
  }

  lines.push('');
  lines.push('## 2. Runtime / Compute / Startup Matrix (Zero-V8 & Zero-JDK)');
  lines.push('');
  lines.push(
    '| Runtime / Tier | Binary Size | Cold Wall (ms) | Median Wall (ms) | Min Wall (ms) | Internal Compute | Speedup vs Tier-0 | Verified Output |',
  );
  lines.push('| :--- | ---: | ---: | ---: | ---: | ---: | ---: | :--- |');

  for (const r of report.runtimeMatrix) {
    const internal = r.internalElapsedMs !== null ? `${r.internalElapsedMs} ms` : 'n/a';
    const speedup = r.speedupVsTier0 !== null ? `${r.speedupVsTier0}x` : '—';
    lines.push(
      `| ${r.label} | ${r.binaryKb} KB | ${r.coldWallMs} ms | **${r.medianWallMs} ms** | ${r.minWallMs} ms | ${internal} | ${speedup} | \`${r.stdout}\` |`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  requireFile(LOADGEN_EXE);
  requireFile(C11_SERVER_EXE);
  requireFile(NODE_SERVER_MJS);
  requireFile(NODE_PS1);
  requireFile(SECTIUM_ES_EXE);
  requireFile(SECTIUM_ES_SCRIPT);
  requireFile(SECTIUM_JVM_EXE);
  requireFile(SECTIUM_JVM_CLASS);
  requireFile(SECTIUM_JVM_AOT_EXE);

  const c11Summary = await benchmarkHttpFacade({
    facade: 'c11-native',
    cmd: C11_SERVER_EXE,
    args: ['--port', '18081'],
    port: 18081,
    binaryPath: C11_SERVER_EXE,
    runtimeBytes: null,
  });

  const nodeSummary = await benchmarkHttpFacade({
    facade: 'sectium-node',
    cmd: 'pwsh.exe',
    args: ['-NoProfile', '-File', NODE_PS1, NODE_SERVER_MJS, '--port', '18082'],
    port: 18082,
    binaryPath: NODE_SERVER_MJS,
    runtimeBytes: statSync(process.execPath).size,
  });

  const runtimeMatrix = benchmarkRuntimeMatrix();

  const cpus = os.cpus();
  const loadgenBytes = statSync(LOADGEN_EXE).size;
  const report: MatrixReport = {
    generatedAt: new Date().toISOString(),
    host: {
      platform: process.platform,
      arch: process.arch,
      cpus: cpus.length,
      cpuModel: cpus[0]?.model?.trim() ?? 'unknown',
      nodeVersion: process.version,
    },
    loadgen: {
      path: LOADGEN_EXE,
      binaryBytes: loadgenBytes,
      binaryKb: round(loadgenBytes / 1024, 1),
      requestsPerCell: REQUESTS_PER_CELL,
      concurrencies: CONCURRENCIES,
      paths: HTTP_PATHS,
    },
    httpMatrix: [c11Summary, nodeSummary],
    runtimeMatrix,
  };

  const jsonPath = path.join(__dirname, 'matrix-report.json');
  const mdPath = path.join(__dirname, 'matrix-report.md');
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  writeFileSync(mdPath, renderMarkdown(report), 'utf8');

  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
  console.log('\n' + renderMarkdown(report));
}

await main();
