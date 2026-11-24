# Awesome-OS TechEmpower Cross-Matrix Benchmark Suite

Minimal, reproducible TechEmpower Framework Benchmarks (TFB) cross-matrix suite for Awesome-OS facades (`c11-native`, `sectium-node`, `sectium-es`, `sectium-jvm` Tier-0 & Tier-2 AOT), isolated on branch `benchmarks/techempower`.

## 1. Architecture & Upstream Mapping

All upstream references are tracked in [`FACADE-MAP.json`](./FACADE-MAP.json) and excluded from Git via `.gitignore` (`upstream/`):

- **TechEmpower `FrameworkBenchmarks`** (`57d92fb`, sparse-shallow): `frameworks/C/lwan`, `frameworks/JavaScript/nodejs`, `frameworks/Java/undertow`, `frameworks/Java/servlet`, `frameworks/PHP/php`.
- **`awesome-os/techempower`** (`22f68cf`, fork of `just-js/techempower`): `just-js` low-overhead socket reference.
- **Load Generator**: [`runner/loadgen.c`](./runner/loadgen.c) compiled to `runner/tfb-loadgen.exe` (`25.5 KB`, native C11 WinSock2 HTTP/1.1 keep-alive with `TCP_NODELAY`, Win32 worker threads, and `QueryPerformanceCounter` microsecond latency percentiles).

## 2. Live Measured Cross-Matrix Scorecard

Measured on `win32/x64` (`13th Gen Intel(R) Core(TM) i5-13600KF`, 20 vCPUs, Node `v26.11.1`) using [`runner/run-matrix.mts`](./runner/run-matrix.mts) (`4,000` keep-alive requests per cell, `0` errors). Full machine-readable output: [`runner/matrix-report.json`](./runner/matrix-report.json) and [`runner/matrix-report.md`](./runner/matrix-report.md).

### 2.1 HTTP/1.1 Keep-Alive Matrix (`/plaintext` & `/json`)

| Facade | Binary Size | Cold Start | Endpoint | Concurrency | Req/s | p50 (µs) | p99 (µs) | Errors |
| :--- | ---: | ---: | :--- | ---: | ---: | ---: | ---: | ---: |
| `c11-native` | 24.5 KB | 12.24 ms | `/plaintext` | c=1 | **50,185.1** | 19.6 | 47.1 | 0 |
| `c11-native` | 24.5 KB | 12.24 ms | `/plaintext` | c=8 | **93,449.0** | 70.8 | 144.3 | 0 |
| `c11-native` | 24.5 KB | 12.24 ms | `/json` | c=1 | **49,201.0** | 19.8 | 45.2 | 0 |
| `c11-native` | 24.5 KB | 12.24 ms | `/json` | c=8 | **92,072.3** | 70.6 | 169.2 | 0 |
| `sectium-node` | 2.1 KB (+ 100.2 MB Node) | 375.09 ms | `/plaintext` | c=1 | **35,966.6** | 26.0 | 96.2 | 0 |
| `sectium-node` | 2.1 KB (+ 100.2 MB Node) | 375.09 ms | `/plaintext` | c=8 | **47,374.5** | 134.0 | 662.5 | 0 |
| `sectium-node` | 2.1 KB (+ 100.2 MB Node) | 375.09 ms | `/json` | c=1 | **32,526.1** | 25.6 | 114.9 | 0 |
| `sectium-node` | 2.1 KB (+ 100.2 MB Node) | 375.09 ms | `/json` | c=8 | **55,218.2** | 126.1 | 366.9 | 0 |

Key takeaways:

- **Cold start:** `c11-native` reaches ready HTTP `200 OK` in `12.24 ms` vs `375.09 ms` for `sectium-node` (`30.6x` faster).
- **Peak throughput (`c=8`):** `c11-native` reaches `93,449.0 req/s` on `/plaintext` (`1.97x` faster than `sectium-node`) and `92,072.3 req/s` on `/json` (`1.67x` faster) with `4.6x` tighter `/plaintext` p99 tail latency (`144.3 µs` vs `662.5 µs`).
- **Compliance:** Both facades pass strict TFB validation (`200 OK`, exact `Hello, World!` / `{"message":"Hello, World!"}` bodies, `Content-Type`, `Server`, and `Date` headers).

### 2.2 Runtime / Compute / Startup Matrix (Zero-V8 & Zero-JDK)

| Runtime / Tier | Binary Size | Cold Wall (ms) | Median Wall (ms) | Min Wall (ms) | Internal Compute | Speedup vs Tier-0 | Verified Output |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | :--- |
| `sectium-es` (Zero-V8 C11 ES) | 94.0 KB | 80.27 ms | **36.78 ms** | 35.98 ms | 22.407 ms | — | `iterations=10000 total_bytes=1320000 dup_v8=0B` |
| `sectium-jvm` Tier-0 (Zero-JDK Interpreter) | 75.0 KB | 38.44 ms | **14.10 ms** | 14.07 ms | n/a | 1.00x | `75025 / 12742320` |
| `sectium-jvm` Tier-2 AOT (`zig cc -O3 -s`) | 42.0 KB | 6.93 ms | **4.54 ms** | 4.27 ms | n/a | **3.11x** | `75025 / 12742320` |

## 3. How to Reproduce (`benchmarks/techempower`)

All commands execute natively on Windows 11 PowerShell (`pwsh`) using hermetic workspace shims from `E:\awesome-os\bin\`:

```powershell
# 1. Compile native C11 HTTP server and load generator
E:\awesome-os\bin\zig.cmd cc -target x86_64-windows-gnu -std=c11 -O3 -Wall -s `
  E:\awesome-os-techempower\benchmarks\techempower\facades\c11-native\tfb_c11_native.c `
  -o E:\awesome-os-techempower\benchmarks\techempower\facades\c11-native\tfb-c11-native.exe -lws2_32

E:\awesome-os\bin\zig.cmd cc -target x86_64-windows-gnu -std=c11 -O3 -Wall -s `
  E:\awesome-os-techempower\benchmarks\techempower\runner\loadgen.c `
  -o E:\awesome-os-techempower\benchmarks\techempower\runner\tfb-loadgen.exe -lws2_32

# 2. Emit JVM TfbBench.class (0xCAFEBABE) and Tier-2 AOT binary
E:\awesome-os\bin\node.ps1 E:\awesome-os-techempower\benchmarks\techempower\facades\sectium-jvm\build-jvm-tfb.mts

# 3. Execute the full cross-matrix and regenerate matrix-report.json / matrix-report.md
E:\awesome-os\bin\node.ps1 E:\awesome-os-techempower\benchmarks\techempower\runner\run-matrix.mts
```

## Quick Start (Windows / Linux / macOS)

```sh
# Clone & enter repository (all platforms)
git clone https://github.com/awesome-os/sectium-benchmarks.git && cd sectium-benchmarks
```
