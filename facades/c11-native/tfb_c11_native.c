/*
 * TechEmpower-compliant C11 WinSock2 HTTP/1.1 keep-alive server.
 *
 * Endpoints:
 *   GET /plaintext -> 200 OK, text/plain, "Hello, World!" (13 bytes)
 *   GET /json      -> 200 OK, application/json, {"message":"Hello, World!"} (27 bytes)
 *
 * Usage:
 *   tfb-c11-native.exe [--port <N>]   (default: 18081)
 */

#define _CRT_SECURE_NO_WARNINGS
#define WIN32_LEAN_AND_MEAN
#define FD_SETSIZE 1024

#include <winsock2.h>
#include <ws2tcpip.h>

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define DEFAULT_PORT 18081
#define MAX_CLIENTS 1020
#define RECV_BUF_CAP 8192
#define SEND_BUF_CAP 16384

typedef struct {
  SOCKET sock;
  char in_buf[RECV_BUF_CAP];
  size_t in_len;
} client_t;

static client_t g_clients[MAX_CLIENTS];

static char g_date_hdr[64];
static time_t g_date_sec = (time_t)-1;

static void refresh_date_header(void) {
  time_t now = time(NULL);
  if (now == g_date_sec) {
    return;
  }
  g_date_sec = now;
  struct tm *gmt = gmtime(&now);
  if (gmt != NULL) {
    strftime(g_date_hdr, sizeof(g_date_hdr), "%a, %d %b %Y %H:%M:%S GMT", gmt);
  } else {
    strcpy(g_date_hdr, "Thu, 01 Jan 1970 00:00:00 GMT");
  }
}

static int send_all(SOCKET s, const char *buf, size_t len) {
  size_t off = 0;
  while (off < len) {
    int n = send(s, buf + off, (int)(len - off), 0);
    if (n <= 0) {
      int err = WSAGetLastError();
      if (err == WSAEWOULDBLOCK) {
        continue;
      }
      return -1;
    }
    off += (size_t)n;
  }
  return 0;
}

static const char *find_header_end(const char *buf, size_t len) {
  if (len < 4) {
    return NULL;
  }
  for (size_t i = 0; i + 3 < len; i++) {
    if (buf[i] == '\r' && buf[i + 1] == '\n' &&
        buf[i + 2] == '\r' && buf[i + 3] == '\n') {
      return buf + i + 4;
    }
  }
  return NULL;
}

static int process_client_buffer(client_t *c) {
  char out_buf[SEND_BUF_CAP];
  size_t out_len = 0;

  for (;;) {
    const char *end = find_header_end(c->in_buf, c->in_len);
    if (end == NULL) {
      break;
    }
    size_t req_len = (size_t)(end - c->in_buf);

    refresh_date_header();

    int n = 0;
    if (req_len >= 15 && memcmp(c->in_buf, "GET /plaintext ", 15) == 0) {
      n = snprintf(
          out_buf + out_len,
          sizeof(out_buf) - out_len,
          "HTTP/1.1 200 OK\r\n"
          "Server: Sectium-C11\r\n"
          "Date: %s\r\n"
          "Content-Type: text/plain\r\n"
          "Content-Length: 13\r\n"
          "Connection: keep-alive\r\n"
          "\r\n"
          "Hello, World!",
          g_date_hdr);
    } else if (req_len >= 10 && memcmp(c->in_buf, "GET /json ", 10) == 0) {
      n = snprintf(
          out_buf + out_len,
          sizeof(out_buf) - out_len,
          "HTTP/1.1 200 OK\r\n"
          "Server: Sectium-C11\r\n"
          "Date: %s\r\n"
          "Content-Type: application/json\r\n"
          "Content-Length: 27\r\n"
          "Connection: keep-alive\r\n"
          "\r\n"
          "{\"message\":\"Hello, World!\"}",
          g_date_hdr);
    } else {
      n = snprintf(
          out_buf + out_len,
          sizeof(out_buf) - out_len,
          "HTTP/1.1 404 Not Found\r\n"
          "Server: Sectium-C11\r\n"
          "Date: %s\r\n"
          "Content-Type: text/plain\r\n"
          "Content-Length: 9\r\n"
          "Connection: keep-alive\r\n"
          "\r\n"
          "Not Found",
          g_date_hdr);
    }

    if (n > 0) {
      out_len += (size_t)n;
    }

    size_t remaining = c->in_len - req_len;
    if (remaining > 0) {
      memmove(c->in_buf, end, remaining);
    }
    c->in_len = remaining;

    if (out_len + 512 >= sizeof(out_buf)) {
      if (send_all(c->sock, out_buf, out_len) != 0) {
        return -1;
      }
      out_len = 0;
    }
  }

  if (out_len > 0) {
    if (send_all(c->sock, out_buf, out_len) != 0) {
      return -1;
    }
  }

  if (c->in_len >= RECV_BUF_CAP) {
    return -1;
  }

  return 0;
}

static void close_client(client_t *c) {
  if (c->sock != INVALID_SOCKET) {
    closesocket(c->sock);
    c->sock = INVALID_SOCKET;
    c->in_len = 0;
  }
}

static int parse_port(int argc, char **argv) {
  int port = DEFAULT_PORT;
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--port") == 0 && i + 1 < argc) {
      port = atoi(argv[++i]);
    } else if (strncmp(argv[i], "--port=", 7) == 0) {
      port = atoi(argv[i] + 7);
    }
  }
  if (port <= 0 || port > 65535) {
    port = DEFAULT_PORT;
  }
  return port;
}

int main(int argc, char **argv) {
  int port = parse_port(argc, argv);

  WSADATA wsa;
  if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
    fprintf(stderr, "tfb-c11-native: WSAStartup failed\n");
    return 1;
  }

  for (int i = 0; i < MAX_CLIENTS; i++) {
    g_clients[i].sock = INVALID_SOCKET;
    g_clients[i].in_len = 0;
  }

  SOCKET listen_sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (listen_sock == INVALID_SOCKET) {
    fprintf(stderr, "tfb-c11-native: socket() failed (%d)\n", WSAGetLastError());
    WSACleanup();
    return 1;
  }

  BOOL reuse = TRUE;
  setsockopt(listen_sock, SOL_SOCKET, SO_REUSEADDR, (const char *)&reuse, sizeof(reuse));

  struct sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  addr.sin_port = htons((uint16_t)port);

  if (bind(listen_sock, (struct sockaddr *)&addr, sizeof(addr)) == SOCKET_ERROR) {
    fprintf(stderr, "tfb-c11-native: bind(127.0.0.1:%d) failed (%d)\n", port, WSAGetLastError());
    closesocket(listen_sock);
    WSACleanup();
    return 1;
  }

  if (listen(listen_sock, SOMAXCONN) == SOCKET_ERROR) {
    fprintf(stderr, "tfb-c11-native: listen() failed (%d)\n", WSAGetLastError());
    closesocket(listen_sock);
    WSACleanup();
    return 1;
  }

  refresh_date_header();
  printf("Sectium-C11 TFB server listening on http://127.0.0.1:%d\n", port);
  fflush(stdout);

  fd_set readfds;
  for (;;) {
    FD_ZERO(&readfds);
    FD_SET(listen_sock, &readfds);

    for (int i = 0; i < MAX_CLIENTS; i++) {
      if (g_clients[i].sock != INVALID_SOCKET) {
        FD_SET(g_clients[i].sock, &readfds);
      }
    }

    int ready = select(0, &readfds, NULL, NULL, NULL);
    if (ready == SOCKET_ERROR) {
      break;
    }

    if (FD_ISSET(listen_sock, &readfds)) {
      SOCKET client_sock = accept(listen_sock, NULL, NULL);
      if (client_sock != INVALID_SOCKET) {
        BOOL nodelay = TRUE;
        setsockopt(client_sock, IPPROTO_TCP, TCP_NODELAY, (const char *)&nodelay, sizeof(nodelay));

        int placed = 0;
        for (int i = 0; i < MAX_CLIENTS; i++) {
          if (g_clients[i].sock == INVALID_SOCKET) {
            g_clients[i].sock = client_sock;
            g_clients[i].in_len = 0;
            placed = 1;
            break;
          }
        }
        if (!placed) {
          closesocket(client_sock);
        }
      }
    }

    for (int i = 0; i < MAX_CLIENTS; i++) {
      SOCKET cs = g_clients[i].sock;
      if (cs == INVALID_SOCKET || !FD_ISSET(cs, &readfds)) {
        continue;
      }

      int n = recv(
          cs,
          g_clients[i].in_buf + g_clients[i].in_len,
          (int)(RECV_BUF_CAP - g_clients[i].in_len),
          0);
      if (n <= 0) {
        close_client(&g_clients[i]);
        continue;
      }

      g_clients[i].in_len += (size_t)n;
      if (process_client_buffer(&g_clients[i]) != 0) {
        close_client(&g_clients[i]);
      }
    }
  }

  for (int i = 0; i < MAX_CLIENTS; i++) {
    close_client(&g_clients[i]);
  }
  closesocket(listen_sock);
  WSACleanup();
  return 0;
}
