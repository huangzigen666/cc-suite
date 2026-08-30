#define _GNU_SOURCE

#include <ctype.h>
#include <errno.h>
#include <grp.h>
#include <linux/capability.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define WORKLOAD_UID 65532
#define WORKLOAD_GID 65532
#define INTERNAL_ERROR_EXIT 70
#define RECORD_PREFIX "CC_SUITE_AGY_COMPLETION "

static volatile sig_atomic_t workload_pid = -1;

static void fail(const char *message) {
  dprintf(STDERR_FILENO, "AGY_R13_SUPERVISOR_FAILED: %s\n", message);
  _exit(INTERNAL_ERROR_EXIT);
}

static bool valid_run_id(const char *value) {
  if (value == NULL || strlen(value) != 32) return false;
  for (size_t index = 0; index < 32; index += 1) {
    if (!((value[index] >= '0' && value[index] <= '9') ||
          (value[index] >= 'a' && value[index] <= 'f'))) {
      return false;
    }
  }
  return true;
}

static bool valid_profile_hash(const char *value) {
  if (value == NULL || strlen(value) != 71 || strncmp(value, "sha256:", 7) != 0) {
    return false;
  }
  for (size_t index = 7; index < 71; index += 1) {
    if (!((value[index] >= '0' && value[index] <= '9') ||
          (value[index] >= 'a' && value[index] <= 'f'))) {
      return false;
    }
  }
  return true;
}

static void zero_capabilities(void) {
  struct __user_cap_header_struct header = {
      .version = _LINUX_CAPABILITY_VERSION_3,
      .pid = 0,
  };
  struct __user_cap_data_struct data[2] = {{0}};
  if (syscall(SYS_capset, &header, &data) != 0) fail("cannot clear capabilities");
}

static void keep_kill_capability(void) {
  struct __user_cap_header_struct header = {
      .version = _LINUX_CAPABILITY_VERSION_3,
      .pid = 0,
  };
  struct __user_cap_data_struct data[2] = {{0}};
  const unsigned int index = CAP_KILL / 32;
  const uint32_t mask = UINT32_C(1) << (CAP_KILL % 32);
  data[index].effective = mask;
  data[index].permitted = mask;
  if (syscall(SYS_capset, &header, &data) != 0) fail("cannot retain only CAP_KILL");
}

static void drop_bounding_capabilities(int retained_capability) {
  for (int capability = 0; capability <= 63; capability += 1) {
    if (capability == retained_capability) continue;
    if (prctl(PR_CAPBSET_DROP, capability, 0, 0, 0) != 0 && errno != EINVAL) {
      fail("cannot reduce capability bounding set");
    }
  }
}

static void set_no_new_privileges(void) {
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    fail("cannot set no_new_privs");
  }
}

static void disable_core_dumps(void) {
  struct rlimit limit = {.rlim_cur = 0, .rlim_max = 0};
  if (setrlimit(RLIMIT_CORE, &limit) != 0) fail("cannot disable core dumps");
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) fail("cannot disable dumpability");
}

static void forward_signal(int signal_number) {
  pid_t pid = (pid_t)workload_pid;
  if (pid > 1) {
    (void)kill(-pid, signal_number);
    (void)kill(pid, signal_number);
  }
}

static void install_signal_handlers(void) {
  const int signals[] = {SIGTERM, SIGINT, SIGHUP, SIGQUIT};
  struct sigaction action = {0};
  action.sa_handler = forward_signal;
  sigemptyset(&action.sa_mask);
  for (size_t index = 0; index < sizeof(signals) / sizeof(signals[0]); index += 1) {
    if (sigaction(signals[index], &action, NULL) != 0) {
      fail("cannot install signal handler");
    }
  }
}

static void format_timestamp(const struct timespec *timestamp, char output[25]) {
  struct tm utc;
  if (gmtime_r(&timestamp->tv_sec, &utc) == NULL) fail("cannot format timestamp");
  int written = snprintf(
      output,
      25,
      "%04d-%02d-%02dT%02d:%02d:%02d.%03ldZ",
      utc.tm_year + 1900,
      utc.tm_mon + 1,
      utc.tm_mday,
      utc.tm_hour,
      utc.tm_min,
      utc.tm_sec,
      timestamp->tv_nsec / 1000000L);
  if (written != 24) fail("timestamp formatting overflow");
}

static void reap_nonblocking(void) {
  int status;
  while (waitpid(-1, &status, WNOHANG) > 0) {
  }
}

static void terminate_and_reap_descendants(void) {
  struct timespec delay = {.tv_sec = 0, .tv_nsec = 100000000L};
  (void)kill(-1, SIGTERM);
  for (int attempt = 0; attempt < 10; attempt += 1) {
    reap_nonblocking();
    if (waitpid(-1, NULL, WNOHANG) < 0 && errno == ECHILD) return;
    (void)nanosleep(&delay, NULL);
  }

  (void)kill(-1, SIGKILL);
  for (;;) {
    pid_t reaped = waitpid(-1, NULL, 0);
    if (reaped > 0) continue;
    if (reaped < 0 && errno == EINTR) continue;
    if (reaped < 0 && errno == ECHILD) return;
    fail("cannot reap workload descendants");
  }
}

static void prepare_workload(void) {
  if (setsid() < 0) fail("cannot create workload session");
  drop_bounding_capabilities(-1);
  if (setgroups(0, NULL) != 0) fail("cannot clear supplementary groups");
  if (setgid(WORKLOAD_GID) != 0) fail("cannot drop workload gid");
  if (setuid(WORKLOAD_UID) != 0) fail("cannot drop workload uid");
  zero_capabilities();
  set_no_new_privileges();
  disable_core_dumps();
  unsetenv("AGY_RUN_ID");
  unsetenv("AGY_PROFILE_HASH");
  unsetenv("AGY_PROXY_HOST");
  unsetenv("AGY_PROXY_PORT");
  unsetenv("AGY_NETWORK_PREFIX");
  unsetenv("AGY_OAUTH_VOLUME_NAME");
  unsetenv("AGY_BOOTSTRAP_PORT");
  unsetenv("AGY_BOOTSTRAP_NONCE");
}

static void prepare_supervisor(void) {
  drop_bounding_capabilities(CAP_KILL);
  keep_kill_capability();
  set_no_new_privileges();
  disable_core_dumps();
}

static void write_completion_record(
    const char *run_id,
    const char *profile_hash,
    pid_t child,
    int status,
    const struct timespec *started,
    const struct timespec *finished) {
  char started_at[25];
  char finished_at[25];
  char exit_code[16];
  char signal_number[16];
  const char *exit_kind;

  format_timestamp(started, started_at);
  format_timestamp(finished, finished_at);
  if (WIFEXITED(status)) {
    exit_kind = "exit";
    snprintf(exit_code, sizeof(exit_code), "%d", WEXITSTATUS(status));
    snprintf(signal_number, sizeof(signal_number), "null");
  } else if (WIFSIGNALED(status)) {
    exit_kind = "signal";
    snprintf(exit_code, sizeof(exit_code), "null");
    snprintf(signal_number, sizeof(signal_number), "%d", WTERMSIG(status));
  } else {
    fail("workload status is not terminal");
  }

  char record[1024];
  int length = snprintf(
      record,
      sizeof(record),
      "\n" RECORD_PREFIX
      "{\"schemaVersion\":1,\"runId\":\"%s\",\"profileHash\":\"%s\"," 
      "\"supervisorPid\":%ld,\"workloadPid\":%ld,\"exitKind\":\"%s\"," 
      "\"exitCode\":%s,\"signal\":%s,\"startedAt\":\"%s\"," 
      "\"finishedAt\":\"%s\"}\n",
      run_id,
      profile_hash,
      (long)getpid(),
      (long)child,
      exit_kind,
      exit_code,
      signal_number,
      started_at,
      finished_at);
  if (length <= 0 || (size_t)length >= sizeof(record)) fail("completion record overflow");

  size_t offset = 0;
  while (offset < (size_t)length) {
    ssize_t written = write(STDOUT_FILENO, record + offset, (size_t)length - offset);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) fail("cannot write completion record");
    offset += (size_t)written;
  }
}

int main(int argc, char **argv) {
  const char *run_id = getenv("AGY_RUN_ID");
  const char *profile_hash = getenv("AGY_PROFILE_HASH");
  struct timespec started;
  struct timespec finished;
  int status;

  if (getpid() != 1) fail("supervisor must run as PID 1");
  if (argc < 2 || argv[1] == NULL) fail("workload command is required");
  if (!valid_run_id(run_id)) fail("AGY_RUN_ID is invalid");
  if (!valid_profile_hash(profile_hash)) fail("AGY_PROFILE_HASH is invalid");
  if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0) {
    fail("cannot become child subreaper");
  }
  install_signal_handlers();
  if (clock_gettime(CLOCK_REALTIME, &started) != 0) fail("cannot read start time");
  fflush(NULL);

  pid_t child = fork();
  if (child < 0) fail("cannot fork workload");
  if (child == 0) {
    prepare_workload();
    execvp(argv[1], &argv[1]);
    dprintf(STDERR_FILENO, "AGY_R13_WORKLOAD_EXEC_FAILED: %s\n", strerror(errno));
    _exit(127);
  }

  workload_pid = child;
  prepare_supervisor();
  for (;;) {
    pid_t waited = waitpid(child, &status, 0);
    if (waited == child) break;
    if (waited < 0 && errno == EINTR) continue;
    fail("cannot wait for workload");
  }
  workload_pid = -1;
  terminate_and_reap_descendants();
  if (clock_gettime(CLOCK_REALTIME, &finished) != 0) fail("cannot read finish time");
  write_completion_record(run_id, profile_hash, child, status, &started, &finished);
  return 0;
}
