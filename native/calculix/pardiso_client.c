/* PARDISO for CalculiX on Linux and Windows, solved in a separate program:
   sprung-solve (native/sprung-solve), which runs Intel oneMKL's PARDISO in
   its own process.

   CalculiX built with -DPARDISO calls the MKL routine pardiso_ with phase
   12 (analyze and factor), 33 (solve) and -1 (release), for real symmetric
   (mtype -2: upper triangle by rows), structurally symmetric (mtype 1) and
   unsymmetric (mtype 11) systems, 1-based. This file provides that routine
   without MKL: it starts sprung-solve the first time, and hands it each
   system through a pipe, by the documented protocol in
   native/sprung-solve/protocol.h (docs/solver-protocol.md). sprung-solve
   is found in SPRUNG_FEA_SOLVE, else at sprung-solve/sprung-solve beside
   this executable. It ends when this program ends.

   MKL threads with the count in MKL_NUM_THREADS, which CalculiX's
   pardiso.c sets before its first call; it is passed on with each system.

   Licensed like CalculiX's other additions here: GNU General Public
   License, version 2 or later. */

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "protocol.h"

typedef int ITG;

#ifdef _WIN32
#include <windows.h>
static HANDLE to_helper, from_helper;
#else
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <spawn.h>
#include <unistd.h>
extern char **environ;
static int to_helper = -1, from_helper = -1;
#endif

static int started;

static void fail(const char *what) {
  printf(" *ERROR in pardiso: %s\n", what);
  fflush(stdout);
  exit(201);
}

static void stopped(void) {
  fail("sprung-solve, which runs the PARDISO solver, stopped unexpectedly");
}

#ifdef _WIN32

static void put(const void *data, size_t bytes) {
  const char *p = data;
  while (bytes) {
    DWORD chunk = bytes > (1u << 30) ? (1u << 30) : (DWORD)bytes, done;
    if (!WriteFile(to_helper, p, chunk, &done, NULL)) stopped();
    p += done;
    bytes -= done;
  }
}

static void get(void *data, size_t bytes) {
  char *p = data;
  while (bytes) {
    DWORD chunk = bytes > (1u << 30) ? (1u << 30) : (DWORD)bytes, done;
    if (!ReadFile(from_helper, p, chunk, &done, NULL) || !done) stopped();
    p += done;
    bytes -= done;
  }
}

static void start_helper(void) {
  wchar_t path[MAX_PATH * 4], command[MAX_PATH * 4 + 16];
  const wchar_t *given = _wgetenv(L"SPRUNG_FEA_SOLVE");
  SECURITY_ATTRIBUTES inherit = {sizeof inherit, NULL, TRUE};
  HANDLE child_in, child_out, child_err, job;
  STARTUPINFOW startup;
  PROCESS_INFORMATION process;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  if (given && *given) {
    wcsncpy(path, given, MAX_PATH * 4 - 1);
    path[MAX_PATH * 4 - 1] = 0;
  } else {
    DWORD length = GetModuleFileNameW(NULL, path, MAX_PATH * 4 - 40);
    wchar_t *slash = wcsrchr(path, L'\\');
    if (!length || !slash) fail("this program's folder was not found");
    wcscpy(slash + 1, L"sprung-solve\\sprung-solve.exe");
  }
  /* Our ends stay ours; the helper inherits its ends as its standard
     input and output, and shares our standard error. */
  if (!CreatePipe(&child_in, &to_helper, &inherit, 1 << 20) ||
      !CreatePipe(&from_helper, &child_out, &inherit, 1 << 20))
    fail("a pipe to sprung-solve could not be made");
  SetHandleInformation(to_helper, HANDLE_FLAG_INHERIT, 0);
  SetHandleInformation(from_helper, HANDLE_FLAG_INHERIT, 0);
  if (!DuplicateHandle(GetCurrentProcess(), GetStdHandle(STD_ERROR_HANDLE),
                       GetCurrentProcess(), &child_err, 0, TRUE,
                       DUPLICATE_SAME_ACCESS))
    child_err = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_WRITE, &inherit,
                            OPEN_EXISTING, 0, NULL);
  memset(&startup, 0, sizeof startup);
  startup.cb = sizeof startup;
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = child_in;
  startup.hStdOutput = child_out;
  startup.hStdError = child_err;
  _snwprintf(command, sizeof command / sizeof *command, L"\"%ls\" --serve", path);
  command[sizeof command / sizeof *command - 1] = 0;
  if (!CreateProcessW(path, command, NULL, NULL, TRUE,
                      CREATE_SUSPENDED | CREATE_NO_WINDOW, NULL, NULL,
                      &startup, &process)) {
    char text[MAX_PATH * 4 + 160];
    snprintf(text, sizeof text,
             "sprung-solve, which runs the PARDISO solver, could not be "
             "started from %ls (Windows error %lu)",
             path, (unsigned long)GetLastError());
    fail(text);
  }
  /* A job that ends the helper with this program, even mid-factorization
     when this program is stopped. */
  job = CreateJobObjectW(NULL, NULL);
  memset(&limits, 0, sizeof limits);
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (job && SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                                     &limits, sizeof limits))
    AssignProcessToJobObject(job, process.hProcess);
  ResumeThread(process.hThread);
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  CloseHandle(child_in);
  CloseHandle(child_out);
  CloseHandle(child_err);
}

#else

static void put(const void *data, size_t bytes) {
  const char *p = data;
  while (bytes) {
    ssize_t done = write(to_helper, p, bytes);
    if (done < 0 && errno == EINTR) continue;
    if (done <= 0) stopped();
    p += done;
    bytes -= (size_t)done;
  }
}

static void get(void *data, size_t bytes) {
  char *p = data;
  while (bytes) {
    ssize_t done = read(from_helper, p, bytes);
    if (done < 0 && errno == EINTR) continue;
    if (done <= 0) stopped();
    p += done;
    bytes -= (size_t)done;
  }
}

static void start_helper(void) {
  char path[4096], text[4300];
  const char *given = getenv("SPRUNG_FEA_SOLVE");
  int in[2], out[2], error;
  pid_t pid;
  posix_spawn_file_actions_t actions;
  char *argv[3];
  if (given && *given) {
    snprintf(path, sizeof path, "%s", given);
  } else {
    ssize_t length = readlink("/proc/self/exe", path, sizeof path - 40);
    char *slash;
    if (length <= 0) fail("this program's folder was not found");
    path[length] = 0;
    slash = strrchr(path, '/');
    strcpy(slash + 1, "sprung-solve/sprung-solve");
  }
  if (pipe(in) || pipe(out)) fail("a pipe to sprung-solve could not be made");
  /* Only the helper's standard input and output survive into it. */
  fcntl(in[0], F_SETFD, FD_CLOEXEC);
  fcntl(in[1], F_SETFD, FD_CLOEXEC);
  fcntl(out[0], F_SETFD, FD_CLOEXEC);
  fcntl(out[1], F_SETFD, FD_CLOEXEC);
  posix_spawn_file_actions_init(&actions);
  posix_spawn_file_actions_adddup2(&actions, in[0], 0);
  posix_spawn_file_actions_adddup2(&actions, out[1], 1);
  argv[0] = path;
  argv[1] = "--serve";
  argv[2] = NULL;
  error = posix_spawn(&pid, path, &actions, NULL, argv, environ);
  posix_spawn_file_actions_destroy(&actions);
  if (error) {
    snprintf(text, sizeof text,
             "sprung-solve, which runs the PARDISO solver, could not be "
             "started from %s: %s",
             path, strerror(error));
    fail(text);
  }
  close(in[0]);
  close(out[1]);
  to_helper = in[1];
  from_helper = out[0];
  /* A helper that stops shows as a failed write, not a signal. */
  signal(SIGPIPE, SIG_IGN);
}

#endif

/* A reply's status, and its text in `text`. */
static int32_t answer(char *text, size_t size) {
  int32_t status;
  uint32_t length, kept;
  char rest[256];
  get(&status, sizeof status);
  get(&length, sizeof length);
  kept = length < size - 1 ? length : (uint32_t)(size - 1);
  get(text, kept);
  text[kept] = 0;
  for (length -= kept; length; length -= kept) {
    kept = length < sizeof rest ? length : (uint32_t)sizeof rest;
    get(rest, kept);
  }
  return status;
}

static void request(uint32_t op, long long *pt) {
  struct sprung_solve_request header;
  header.magic = SPRUNG_SOLVE_MAGIC;
  header.op = op;
  /* CalculiX keeps one handle array (pt) for each factorization. */
  header.handle = (uint64_t)(uintptr_t)pt;
  put(&header, sizeof header);
}

static void start(void) {
  uint32_t version = SPRUNG_SOLVE_VERSION;
  char name[512];
  start_helper();
  started = 1;
  request(SPRUNG_SOLVE_HELLO, NULL);
  put(&version, sizeof version);
  if (answer(name, sizeof name)) fail(name);
  printf(" PARDISO: %s, in sprung-solve\n", name);
  fflush(stdout);
}

/* 1-based ITG indices as 0-based 64-bit ones, a block at a time. */
static void put_indices(const ITG *index, long long count) {
  int64_t block[8192];
  long long i, k;
  for (i = 0; i < count; i += k) {
    for (k = 0; k < 8192 && i + k < count; k++) block[k] = (int64_t)index[i + k] - 1;
    put(block, sizeof *block * (size_t)k);
  }
}

static void check(void) {
  char text[512];
  if (answer(text, sizeof text)) fail(text);
}

void pardiso_(long long *pt, ITG *maxfct, ITG *mnum, ITG *mtype, ITG *phase,
              ITG *neq, double *a, ITG *ia, ITG *ja, ITG *perm, ITG *nrhs,
              ITG *iparm, ITG *msglvl, double *b, double *x, ITG *error) {
  int64_t n = *neq;
  (void)maxfct; (void)mnum; (void)perm; (void)iparm; (void)msglvl;
  *error = 0;
  if (*phase == -1) {
    if (started) {
      request(SPRUNG_SOLVE_RELEASE, pt);
      check();
    }
    return;
  }
  if (!started) start();
  if (*phase == 12) {
    uint32_t kind, threads;
    const char *env = getenv("MKL_NUM_THREADS");
    int64_t nnz = (int64_t)ia[n] - 1;
    if (*mtype == -2) kind = SPRUNG_SOLVE_SYMMETRIC;
    else if (*mtype == 1) kind = SPRUNG_SOLVE_STRUCTURALLY_SYMMETRIC;
    else if (*mtype == 11) kind = SPRUNG_SOLVE_UNSYMMETRIC;
    else fail("this matrix type is not supported");
    threads = env && atoi(env) > 0 ? (uint32_t)atoi(env) : 0;
    request(SPRUNG_SOLVE_FACTOR, pt);
    put(&kind, sizeof kind);
    put(&threads, sizeof threads);
    put(&n, sizeof n);
    put(&nnz, sizeof nnz);
    put_indices(ia, n + 1);
    put_indices(ja, nnz);
    put(a, sizeof *a * (size_t)nnz);
    check();
  } else if (*phase == 33) {
    int64_t count = *nrhs;
    request(SPRUNG_SOLVE_SOLVE, pt);
    put(&n, sizeof n);
    put(&count, sizeof count);
    put(b, sizeof *b * (size_t)(n * count));
    check();
    get(x, sizeof *x * (size_t)(n * count));
  } else {
    fail("this PARDISO phase is not supported");
  }
}
