# TechEmpower Cross-Matrix Benchmark Report

- **Generated:** 2026-11-22T15:37:56.331Z
- **Host:** win32/x64 | 20 vCPUs (13th Gen Intel(R) Core(TM) i5-13600KF) | Node v26.11.1
- **Load Generator:** `tfb-loadgen.exe` (25.5 KB, C11 WinSock2 keep-alive + `TCP_NODELAY` + QPC, 4000 req/cell)

## 1. HTTP/1.1 Keep-Alive Matrix (`/plaintext` & `/json`)

| Facade | Binary Size | Cold Start | Endpoint | Concurrency | Req/s | p50 (µs) | p99 (µs) | Errors |
| :--- | ---: | ---: | :--- | ---: | ---: | ---: | ---: | ---: |
| `c11-native` | 24.5 KB | 12.24 ms | `/plaintext` | c=1 | **50,185.1** | 19.6 | 47.1 | 0 |
| `c11-native` | 24.5 KB | 12.24 ms | `/plaintext` | c=8 | **93,449** | 70.8 | 144.3 | 0 |
| `c11-native` | 24.5 KB | 12.24 ms | `/json` | c=1 | **49,201** | 19.8 | 45.2 | 0 |
| `c11-native` | 24.5 KB | 12.24 ms | `/json` | c=8 | **92,072.3** | 70.6 | 169.2 | 0 |
| `sectium-node` | 2.1 KB (+ 100.2 MB Node) | 375.09 ms | `/plaintext` | c=1 | **35,966.6** | 26 | 96.2 | 0 |
| `sectium-node` | 2.1 KB (+ 100.2 MB Node) | 375.09 ms | `/plaintext` | c=8 | **47,374.5** | 134 | 662.5 | 0 |
| `sectium-node` | 2.1 KB (+ 100.2 MB Node) | 375.09 ms | `/json` | c=1 | **32,526.1** | 25.6 | 114.9 | 0 |
| `sectium-node` | 2.1 KB (+ 100.2 MB Node) | 375.09 ms | `/json` | c=8 | **55,218.2** | 126.1 | 366.9 | 0 |

### TFB HTTP Compliance Verification

| Facade | Endpoint | Status | Content-Type | Server | Body Exact | Result |
| :--- | :--- | ---: | :--- | :--- | :--- | :--- |
| `c11-native` | `/plaintext` | 200 | `text/plain` | `Sectium-C11` | `Hello, World!` | PASS |
| `c11-native` | `/json` | 200 | `application/json` | `Sectium-C11` | `{"message":"Hello, World!"}` | PASS |
| `sectium-node` | `/plaintext` | 200 | `text/plain` | `Sectium-Node` | `Hello, World!` | PASS |
| `sectium-node` | `/json` | 200 | `application/json` | `Sectium-Node` | `{"message":"Hello, World!"}` | PASS |

## 2. Runtime / Compute / Startup Matrix (Zero-V8 & Zero-JDK)

| Runtime / Tier | Binary Size | Cold Wall (ms) | Median Wall (ms) | Min Wall (ms) | Internal Compute | Speedup vs Tier-0 | Verified Output |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | :--- |
| sectium-es (Zero-V8 C11 ES) | 94 KB | 80.27 ms | **36.78 ms** | 35.98 ms | 22.407 ms | — | `sectium-es tfb-bench iterations=10000 plaintext=5000 json=5000 total_bytes=1320000 elapsed_ms=22.4066 dup_v8=0B` |
| sectium-jvm Tier-0 (Zero-JDK Interpreter) | 75 KB | 38.44 ms | **14.1 ms** | 14.07 ms | n/a | 1x | `75025 / 12742320` |
| sectium-jvm Tier-2 AOT (zig cc -O3 -s) | 42 KB | 6.93 ms | **4.54 ms** | 4.27 ms | n/a | 3.11x | `75025 / 12742320` |
