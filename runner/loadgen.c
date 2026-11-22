#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <process.h>

#include <ctype.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    const char *host;
    int port;
    const char *request;
    int request_len;
    int count;
    double qpc_freq;
    double *latencies_us;
    uint64_t ok;
    uint64_t errors;
} WorkerArgs;

static int ascii_ci_starts_with(const char *s, size_t len, const char *prefix) {
    size_t plen = strlen(prefix);
    if (len < plen) return 0;
    for (size_t i = 0; i < plen; i++) {
        if (tolower((unsigned char)s[i]) != tolower((unsigned char)prefix[i])) {
            return 0;
        }
    }
    return 1;
}

static int find_header_end(const char *buf, int len) {
    for (int i = 0; i + 3 < len; i++) {
        if (buf[i] == '\r' && buf[i + 1] == '\n' && buf[i + 2] == '\r' && buf[i + 3] == '\n') {
            return i + 4;
        }
    }
    return -1;
}

static int parse_headers(const char *buf, int hdr_end, int *status_ok, int *content_length, int *conn_close) {
    *status_ok = 0;
    *content_length = 0;
    *conn_close = 0;

    if (hdr_end >= 12) {
        if ((memcmp(buf, "HTTP/1.1 200", 12) == 0) || (memcmp(buf, "HTTP/1.0 200", 12) == 0)) {
            *status_ok = 1;
        }
    }

    int pos = 0;
    while (pos < hdr_end) {
        int line_end = pos;
        while (line_end + 1 < hdr_end && !(buf[line_end] == '\r' && buf[line_end + 1] == '\n')) {
            line_end++;
        }
        size_t line_len = (size_t)(line_end - pos);
        if (ascii_ci_starts_with(buf + pos, line_len, "content-length:")) {
            const char *p = buf + pos + 15;
            const char *end = buf + line_end;
            while (p < end && (*p == ' ' || *p == '\t')) p++;
            int val = 0;
            while (p < end && *p >= '0' && *p <= '9') {
                val = val * 10 + (*p - '0');
                p++;
            }
            *content_length = val;
        } else if (ascii_ci_starts_with(buf + pos, line_len, "connection:")) {
            const char *p = buf + pos + 11;
            const char *end = buf + line_end;
            while (p < end && (*p == ' ' || *p == '\t')) p++;
            if (ascii_ci_starts_with(p, (size_t)(end - p), "close")) {
                *conn_close = 1;
            }
        }
        pos = line_end + 2;
    }
    return 0;
}

static SOCKET connect_server(const char *host, int port) {
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons((unsigned short)port);
    if (inet_pton(AF_INET, host, &addr.sin_addr) != 1) {
        struct addrinfo hints, *res = NULL;
        memset(&hints, 0, sizeof(hints));
        hints.ai_family = AF_INET;
        hints.ai_socktype = SOCK_STREAM;
        char port_str[16];
        snprintf(port_str, sizeof(port_str), "%d", port);
        if (getaddrinfo(host, port_str, &hints, &res) != 0 || res == NULL) {
            return INVALID_SOCKET;
        }
        memcpy(&addr, res->ai_addr, sizeof(addr));
        freeaddrinfo(res);
    }

    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) return INVALID_SOCKET;

    int nodelay = 1;
    setsockopt(s, IPPROTO_TCP, TCP_NODELAY, (const char *)&nodelay, sizeof(nodelay));

    DWORD timeout_ms = 5000;
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (const char *)&timeout_ms, sizeof(timeout_ms));
    setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, (const char *)&timeout_ms, sizeof(timeout_ms));

    if (connect(s, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        closesocket(s);
        return INVALID_SOCKET;
    }
    return s;
}

static int send_all(SOCKET s, const char *buf, int len) {
    int sent = 0;
    while (sent < len) {
        int n = send(s, buf + sent, len - sent, 0);
        if (n <= 0) return -1;
        sent += n;
    }
    return 0;
}

static unsigned __stdcall worker_thread(void *arg) {
    WorkerArgs *w = (WorkerArgs *)arg;
    SOCKET s = INVALID_SOCKET;
    char buf[8192];

    for (int i = 0; i < w->count; i++) {
        if (s == INVALID_SOCKET) {
            s = connect_server(w->host, w->port);
            if (s == INVALID_SOCKET) {
                w->errors++;
                continue;
            }
        }

        LARGE_INTEGER t0, t1;
        QueryPerformanceCounter(&t0);

        if (send_all(s, w->request, w->request_len) != 0) {
            closesocket(s);
            s = connect_server(w->host, w->port);
            if (s == INVALID_SOCKET || send_all(s, w->request, w->request_len) != 0) {
                if (s != INVALID_SOCKET) {
                    closesocket(s);
                    s = INVALID_SOCKET;
                }
                w->errors++;
                continue;
            }
        }

        int total = 0;
        int hdr_end = -1;
        int status_ok = 0;
        int content_length = 0;
        int conn_close = 0;
        int failed = 0;

        while (1) {
            if (total >= (int)sizeof(buf) - 1) {
                failed = 1;
                break;
            }
            int n = recv(s, buf + total, (int)sizeof(buf) - 1 - total, 0);
            if (n <= 0) {
                failed = 1;
                break;
            }
            total += n;
            if (hdr_end < 0) {
                hdr_end = find_header_end(buf, total);
                if (hdr_end >= 0) {
                    parse_headers(buf, hdr_end, &status_ok, &content_length, &conn_close);
                }
            }
            if (hdr_end >= 0 && total >= hdr_end + content_length) {
                break;
            }
        }

        QueryPerformanceCounter(&t1);

        if (failed || !status_ok) {
            w->errors++;
            closesocket(s);
            s = INVALID_SOCKET;
        } else {
            double us = ((double)(t1.QuadPart - t0.QuadPart) * 1e6) / w->qpc_freq;
            w->latencies_us[w->ok++] = us;
            if (conn_close) {
                closesocket(s);
                s = INVALID_SOCKET;
            }
        }
    }

    if (s != INVALID_SOCKET) {
        closesocket(s);
    }
    return 0;
}

static int cmp_double(const void *a, const void *b) {
    double da = *(const double *)a;
    double db = *(const double *)b;
    if (da < db) return -1;
    if (da > db) return 1;
    return 0;
}

static double percentile(const double *sorted, size_t n, double p) {
    if (n == 0) return 0.0;
    size_t idx = (size_t)((p / 100.0) * (double)(n - 1));
    if (idx >= n) idx = n - 1;
    return sorted[idx];
}

int main(int argc, char **argv) {
    const char *host = "127.0.0.1";
    int port = 18081;
    const char *path = "/plaintext";
    int concurrency = 1;
    int requests = 1000;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--host") == 0 && i + 1 < argc) {
            host = argv[++i];
        } else if (strcmp(argv[i], "--port") == 0 && i + 1 < argc) {
            port = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--path") == 0 && i + 1 < argc) {
            path = argv[++i];
        } else if (strcmp(argv[i], "--concurrency") == 0 && i + 1 < argc) {
            concurrency = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--requests") == 0 && i + 1 < argc) {
            requests = atoi(argv[++i]);
        }
    }

    if (concurrency < 1) concurrency = 1;
    if (concurrency > 256) concurrency = 256;
    if (requests < 1) requests = 1;
    if (concurrency > requests) concurrency = requests;

    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        fprintf(stderr, "WSAStartup failed\n");
        return 1;
    }

    char request_buf[1024];
    int request_len = snprintf(
        request_buf,
        sizeof(request_buf),
        "GET %s HTTP/1.1\r\nHost: %s:%d\r\nConnection: keep-alive\r\n\r\n",
        path,
        host,
        port
    );

    LARGE_INTEGER freq, t_start, t_end;
    QueryPerformanceFrequency(&freq);
    double qpc_freq = (double)freq.QuadPart;

    WorkerArgs *workers = (WorkerArgs *)calloc((size_t)concurrency, sizeof(WorkerArgs));
    HANDLE *threads = (HANDLE *)calloc((size_t)concurrency, sizeof(HANDLE));
    double *all_latencies = (double *)malloc((size_t)requests * sizeof(double));
    if (!workers || !threads || !all_latencies) {
        fprintf(stderr, "OOM\n");
        WSACleanup();
        return 1;
    }

    int base = requests / concurrency;
    int rem = requests % concurrency;
    size_t offset = 0;

    for (int i = 0; i < concurrency; i++) {
        int c = base + (i < rem ? 1 : 0);
        workers[i].host = host;
        workers[i].port = port;
        workers[i].request = request_buf;
        workers[i].request_len = request_len;
        workers[i].count = c;
        workers[i].qpc_freq = qpc_freq;
        workers[i].latencies_us = all_latencies + offset;
        workers[i].ok = 0;
        workers[i].errors = 0;
        offset += (size_t)c;
    }

    QueryPerformanceCounter(&t_start);

    for (int i = 0; i < concurrency; i++) {
        uintptr_t h = _beginthreadex(NULL, 0, worker_thread, &workers[i], 0, NULL);
        threads[i] = (HANDLE)h;
    }

    for (int i = 0; i < concurrency; i++) {
        if (threads[i]) {
            WaitForSingleObject(threads[i], INFINITE);
            CloseHandle(threads[i]);
        }
    }

    QueryPerformanceCounter(&t_end);

    double elapsed_ms = ((double)(t_end.QuadPart - t_start.QuadPart) * 1e3) / qpc_freq;
    uint64_t total_ok = 0;
    uint64_t total_errors = 0;

    double *packed = (double *)malloc((size_t)requests * sizeof(double));
    size_t packed_n = 0;
    for (int i = 0; i < concurrency; i++) {
        total_ok += workers[i].ok;
        total_errors += workers[i].errors;
        if (workers[i].ok > 0) {
            memcpy(packed + packed_n, workers[i].latencies_us, (size_t)workers[i].ok * sizeof(double));
            packed_n += (size_t)workers[i].ok;
        }
    }

    if (packed_n > 1) {
        qsort(packed, packed_n, sizeof(double), cmp_double);
    }

    double req_per_sec = elapsed_ms > 0.0 ? ((double)total_ok / (elapsed_ms / 1000.0)) : 0.0;
    double p50_us = percentile(packed, packed_n, 50.0);
    double p99_us = percentile(packed, packed_n, 99.0);

    printf(
        "{\"ok\":%llu,\"errors\":%llu,\"elapsedMs\":%.3f,\"reqPerSec\":%.2f,\"p50Us\":%.2f,\"p99Us\":%.2f}\n",
        (unsigned long long)total_ok,
        (unsigned long long)total_errors,
        elapsed_ms,
        req_per_sec,
        p50_us,
        p99_us
    );

    free(packed);
    free(all_latencies);
    free(threads);
    free(workers);
    WSACleanup();
    return total_ok > 0 ? 0 : 1;
}
