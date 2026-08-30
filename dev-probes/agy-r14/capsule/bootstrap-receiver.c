#define _GNU_SOURCE

#include <arpa/inet.h>
#include <errno.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#define MAX_PAYLOAD 80
#define INTERNAL_ERROR_EXIT 70

static void fail(const char *message) {
  dprintf(STDERR_FILENO, "AGY_R14_RECEIVER_FAILED: %s\n", message);
  _exit(INTERNAL_ERROR_EXIT);
}

static int parse_port(const char *value) {
  if (value == NULL || *value == '\0') fail("AGY_BOOTSTRAP_PORT is missing");
  char *end = NULL;
  errno = 0;
  long parsed = strtol(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0' || parsed < 1024 || parsed > 65535) {
    fail("AGY_BOOTSTRAP_PORT is invalid");
  }
  return (int)parsed;
}

static void write_all(const char *payload, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t written = write(STDOUT_FILENO, payload + offset, length - offset);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) fail("cannot write payload");
    offset += (size_t)written;
  }
}

int main(void) {
  const int port = parse_port(getenv("AGY_BOOTSTRAP_PORT"));
  int listener = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (listener < 0) fail("cannot create listener");
  int enabled = 1;
  if (setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &enabled, sizeof(enabled)) != 0) {
    fail("cannot configure listener");
  }

  struct sockaddr_in address = {
      .sin_family = AF_INET,
      .sin_port = htons((uint16_t)port),
      .sin_addr = {.s_addr = htonl(INADDR_ANY)},
  };
  if (bind(listener, (struct sockaddr *)&address, sizeof(address)) != 0) {
    fail("cannot bind listener");
  }
  if (listen(listener, 1) != 0) fail("cannot listen");
  alarm(60);
  int client = accept4(listener, NULL, NULL, SOCK_CLOEXEC);
  if (client < 0) fail("cannot accept handoff");
  close(listener);

  char payload[MAX_PAYLOAD + 1] = {0};
  size_t length = 0;
  for (;;) {
    if (length == MAX_PAYLOAD) fail("payload is too large");
    ssize_t received = read(client, payload + length, MAX_PAYLOAD - length);
    if (received < 0 && errno == EINTR) continue;
    if (received < 0) fail("cannot read payload");
    if (received == 0) break;
    length += (size_t)received;
  }
  close(client);
  alarm(0);
  if (length < 1 || payload[length - 1] != '\n' || memchr(payload, '\0', length) != NULL) {
    fail("payload framing is invalid");
  }
  for (size_t index = 0; index + 1 < length; index += 1) {
    unsigned char byte = (unsigned char)payload[index];
    if (byte < 0x20 || byte > 0x7e) fail("payload contains invalid bytes");
  }
  write_all(payload, length);
  return 0;
}
