/* sprung-solve: solves sparse linear systems with Intel oneMKL's PARDISO,
   in a process of its own.

   sprung-solve --serve
       Takes systems through standard input and answers through standard
       output, by the protocol in protocol.h (docs/solver-protocol.md).
       CalculiX, as built for Sprung FEA, starts it this way for its PARDISO
       solves. Ends when its input closes.
   sprung-solve --version
       Checks that PARDISO solves on this computer, and names it.
   sprung-solve A.mtx [b.mtx]
       Solves A x = b for a Matrix Market matrix A (coordinate; real or
       integer; general or symmetric) and right-hand side b (array; all ones
       when not given), and prints x, one value per line.

   Each factorization keeps PARDISO's analysis (ordering and symbolic
   factorization) while the matrix's structure stays the same, so the
   iterations of a nonlinear step only refactor.

   SPDX-License-Identifier: MIT
   Copyright (c) 2026 Sprung FEA contributors */

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <mkl.h>

#include "protocol.h"

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif
#ifdef __linux__
#include <signal.h>
#include <sys/prctl.h>
#include <unistd.h>
#endif

/* ---------------------------------------------------------------- PARDISO */

struct system {
  uint64_t handle;
  int factored;
  uint32_t kind;
  long long mtype, n, nnz;
  long long *rows, *columns;
  double *values;
  void *pt[64];
  long long iparm[64];
};

static void *allocate(size_t bytes) {
  void *p = malloc(bytes ? bytes : 1);
  if (!p) {
    fprintf(stderr, "sprung-solve: out of memory (%zu bytes)\n", bytes);
    exit(3);
  }
  return p;
}

static const char *pardiso_error(long long error) {
  switch (error) {
  case -1: return "the input is inconsistent";
  case -2: return "there is not enough memory";
  case -3: return "the reordering failed";
  case -4: return "a zero pivot was found: the system is singular";
  case -5: return "an internal error occurred";
  case -6: return "the preordering failed";
  case -7: return "the diagonal is singular";
  case -8: return "a 32-bit integer overflowed";
  case -9: return "there is not enough memory for the out-of-core solver";
  case -10: return "the out-of-core files could not be opened";
  case -11: return "the out-of-core files could not be read or written";
  case -13: return "the solve was interrupted";
  default: return "it failed";
  }
}

static long long mtype_of(uint32_t kind) {
  /* Real: symmetric indefinite (CalculiX's stiffness matrices can be
     shifted indefinite, as in frequency analyses), structurally symmetric,
     unsymmetric. */
  return kind == SPRUNG_SOLVE_SYMMETRIC ? -2
         : kind == SPRUNG_SOLVE_STRUCTURALLY_SYMMETRIC ? 1 : 11;
}

static long long call(struct system *s, long long phase, long long nrhs,
                      double *b, double *x) {
  long long maxfct = 1, mnum = 1, msglvl = 0, error = 0, perm = 0;
  pardiso_64(s->pt, &maxfct, &mnum, &s->mtype, &phase, &s->n, s->values,
             s->rows, s->columns, &perm, &nrhs, s->iparm, &msglvl, b, x,
             &error);
  return error;
}

static void release(struct system *s) {
  if (s->factored) call(s, -1, 1, NULL, NULL);
  s->factored = 0;
  free(s->rows);
  free(s->columns);
  free(s->values);
  s->rows = s->columns = NULL;
  s->values = NULL;
}

/* PARDISO's defaults for the matrix type (what CalculiX asks for), with
   0-based indices and the parallel nested dissection ordering, and
   iterative refinement only after pivots were perturbed (MKL's "automatic"
   setting) rather than pardisoinit's two steps on every solve. Refinement
   in working precision ruins nearly singular systems: CalculiX's frequency
   analysis of a free part factors K - M, whose rigid-body directions sit
   ten orders of magnitude below its elastic ones, and refined solves there
   turned elastic modes into spurious ones. */
static void defaults(struct system *s) {
  MKL_INT mtype = (MKL_INT)s->mtype, iparm[64];
  int i;
  pardisoinit(s->pt, &mtype, iparm);
  for (i = 0; i < 64; i++) s->iparm[i] = iparm[i];
  s->iparm[0] = 1;  /* not all defaults: these are set */
  s->iparm[1] = 3;  /* parallel nested dissection */
  s->iparm[7] = 0;  /* refine only after perturbed pivots */
  s->iparm[34] = 1; /* 0-based indices */
}

/* Takes ownership of the arrays. Returns PARDISO's error code. */
static long long factor(struct system *s, uint32_t kind, long long n,
                        long long nnz, long long *rows, long long *columns,
                        double *values) {
  int same = s->factored && s->kind == kind && s->n == n && s->nnz == nnz &&
             !memcmp(s->rows, rows, sizeof *rows * (n + 1)) &&
             !memcmp(s->columns, columns, sizeof *columns * nnz);
  long long error;
  if (same) {
    free(rows);
    free(columns);
    free(s->values);
    s->values = values;
    error = call(s, 22, 1, NULL, NULL);
  } else {
    release(s);
    s->kind = kind;
    s->mtype = mtype_of(kind);
    s->n = n;
    s->nnz = nnz;
    s->rows = rows;
    s->columns = columns;
    s->values = values;
    defaults(s);
    error = call(s, 12, 1, NULL, NULL);
  }
  s->factored = 1;
  if (error) release(s);
  return error;
}

static const char *describe(void) {
  static char name[128];
  MKLVersion v;
  mkl_get_version(&v);
  /* 2026.1 is major version 2026, update 1. */
  snprintf(name, sizeof name, "Intel oneMKL %d.%d PARDISO", v.MajorVersion,
           v.UpdateVersion);
  return name;
}

/* --------------------------------------------------------------- protocol */

static void receive(void *data, size_t bytes, int may_end) {
  size_t got = fread(data, 1, bytes, stdin);
  if (got == bytes) return;
  /* The client closed its end: it is done, or gone. */
  if (got == 0 && may_end) exit(0);
  fprintf(stderr, "sprung-solve: the request ended early\n");
  exit(2);
}

static void *receive_array(size_t count, size_t size) {
  void *data = allocate(count * size);
  receive(data, count * size, 0);
  return data;
}

static void put(const void *data, size_t bytes) {
  if (fwrite(data, 1, bytes, stdout) != bytes) exit(2);
}

static void reply(int32_t status, const char *text) {
  uint32_t length = (uint32_t)strlen(text);
  put(&status, sizeof status);
  put(&length, sizeof length);
  put(text, length);
}

static void reply_error(const char *what, long long error) {
  char text[256];
  snprintf(text, sizeof text, "%s: %s (PARDISO error %lld)", what,
           pardiso_error(error), error);
  reply(error ? (int32_t)error : -1, text);
}

static struct system *systems;
static size_t count, capacity;

static struct system *find(uint64_t handle, int create) {
  size_t i;
  for (i = 0; i < count; i++)
    if (systems[i].handle == handle) return &systems[i];
  if (!create) return NULL;
  if (count == capacity) {
    capacity = capacity ? 2 * capacity : 4;
    systems = realloc(systems, capacity * sizeof *systems);
    if (!systems) exit(3);
  }
  memset(&systems[count], 0, sizeof *systems);
  systems[count].handle = handle;
  return &systems[count++];
}

/* Rows and columns must index inside the matrix, as PARDISO does not
   check them all. */
static int valid(uint32_t kind, long long n, long long nnz,
                 const long long *rows, const long long *columns) {
  long long i, k;
  if (kind > SPRUNG_SOLVE_UNSYMMETRIC || rows[0] != 0 || rows[n] != nnz)
    return 0;
  for (i = 0; i < n; i++) {
    if (rows[i + 1] < rows[i]) return 0;
    /* PARDISO needs every diagonal entry of a symmetric matrix. */
    if (kind == SPRUNG_SOLVE_SYMMETRIC &&
        (rows[i + 1] == rows[i] || columns[rows[i]] != i))
      return 0;
    for (k = rows[i]; k < rows[i + 1]; k++)
      if (columns[k] < (kind == SPRUNG_SOLVE_SYMMETRIC ? i : 0) ||
          columns[k] >= n || (k > rows[i] && columns[k] <= columns[k - 1]))
        return 0;
  }
  return 1;
}

static void serve(void) {
  struct sprung_solve_request request;
#ifdef __linux__
  /* Ends with CalculiX, even mid-factorization. */
  prctl(PR_SET_PDEATHSIG, SIGKILL);
  if (getppid() == 1) exit(0);
#endif
  for (;;) {
    struct system *s;
    receive(&request, sizeof request, 1);
    if (request.magic != SPRUNG_SOLVE_MAGIC) {
      fprintf(stderr, "sprung-solve: not a request\n");
      exit(2);
    }
    switch (request.op) {
    case SPRUNG_SOLVE_HELLO: {
      uint32_t version;
      receive(&version, sizeof version, 0);
      if (version != SPRUNG_SOLVE_VERSION)
        reply(-1, "this sprung-solve speaks protocol version 1");
      else
        reply(0, describe());
      break;
    }
    case SPRUNG_SOLVE_FACTOR: {
      uint32_t kind, threads;
      long long n, nnz, *rows, *columns, error;
      double *values;
      receive(&kind, sizeof kind, 0);
      receive(&threads, sizeof threads, 0);
      receive(&n, sizeof n, 0);
      receive(&nnz, sizeof nnz, 0);
      if (n < 1 || nnz < 1) {
        fprintf(stderr, "sprung-solve: a matrix of order %lld with %lld entries\n", n, nnz);
        exit(2);
      }
      rows = receive_array((size_t)n + 1, sizeof *rows);
      columns = receive_array((size_t)nnz, sizeof *columns);
      values = receive_array((size_t)nnz, sizeof *values);
      if (!valid(kind, n, nnz, rows, columns)) {
        free(rows);
        free(columns);
        free(values);
        reply(-1, "the matrix is not 0-based compressed rows with ascending "
                  "columns (when symmetric, the upper triangle with every "
                  "diagonal entry)");
        break;
      }
      if (threads) mkl_set_num_threads((int)threads);
      s = find(request.handle, 1);
      error = factor(s, kind, n, nnz, rows, columns, values);
      if (error) reply_error("The factorization failed", error);
      else reply(0, "");
      break;
    }
    case SPRUNG_SOLVE_SOLVE: {
      long long n, nrhs, error;
      double *b, *x;
      receive(&n, sizeof n, 0);
      receive(&nrhs, sizeof nrhs, 0);
      if (n < 1 || nrhs < 1) exit(2);
      b = receive_array((size_t)(n * nrhs), sizeof *b);
      s = find(request.handle, 0);
      if (!s || !s->factored || s->n != n) {
        reply(-1, "there is no factorization of this order to solve with");
      } else {
        x = allocate(sizeof *x * (size_t)(n * nrhs));
        error = call(s, 33, nrhs, b, x);
        if (error) {
          reply_error("The solve failed", error);
        } else {
          reply(0, "");
          put(x, sizeof *x * (size_t)(n * nrhs));
        }
        free(x);
      }
      free(b);
      break;
    }
    case SPRUNG_SOLVE_RELEASE:
      s = find(request.handle, 0);
      if (s) {
        release(s);
        *s = systems[--count];
      }
      reply(0, "");
      break;
    default:
      fprintf(stderr, "sprung-solve: unknown request %u\n", request.op);
      exit(2);
    }
    fflush(stdout);
  }
}

/* ------------------------------------------------------------ Matrix Market */

struct entry {
  long long row, column;
  double value;
};

static int by_position(const void *a, const void *b) {
  const struct entry *p = a, *q = b;
  if (p->row != q->row) return p->row < q->row ? -1 : 1;
  return p->column < q->column ? -1 : p->column > q->column;
}

static FILE *open_market(const char *path, char *header, size_t size) {
  FILE *file = fopen(path, "r");
  char *c;
  if (!file || !fgets(header, (int)size, file)) {
    fprintf(stderr, "sprung-solve: %s could not be read\n", path);
    exit(1);
  }
  for (c = header; *c; c++)
    if (*c >= 'A' && *c <= 'Z') *c += 'a' - 'A';
  if (strncmp(header, "%%matrixmarket matrix ", 22) || strstr(header, "complex") ||
      strstr(header, "pattern")) {
    fprintf(stderr, "sprung-solve: %s is not a real Matrix Market matrix\n", path);
    exit(1);
  }
  return file;
}

/* The next line that is not a comment. */
static char *line(FILE *file, char *buffer, int size) {
  while (fgets(buffer, size, file))
    if (buffer[0] != '%' && strspn(buffer, " \t\r\n") != strlen(buffer))
      return buffer;
  return NULL;
}

static void solve_files(const char *matrix, const char *rhs) {
  char header[256], buffer[512];
  FILE *file = open_market(matrix, header, sizeof header);
  int symmetric = strstr(header, "symmetric") != NULL;
  long long m, n, nz, i, k, kept;
  struct entry *entries;
  struct system s;
  long long *rows, *columns;
  double *values, *b, *x;
  long long error;
  if (!strstr(header, "coordinate") || strstr(header, "skew") ||
      strstr(header, "hermitian") || !line(file, buffer, sizeof buffer) ||
      sscanf(buffer, "%lld %lld %lld", &m, &n, &nz) != 3 || m != n || n < 1) {
    fprintf(stderr, "sprung-solve: %s is not a square coordinate matrix, "
                    "general or symmetric\n", matrix);
    exit(1);
  }
  /* Symmetric: every diagonal entry, as PARDISO needs, zero if absent. */
  entries = allocate(sizeof *entries * (size_t)(nz + n));
  for (k = 0; k < nz; k++) {
    long long r, c;
    double v;
    if (!line(file, buffer, sizeof buffer) ||
        sscanf(buffer, "%lld %lld %lf", &r, &c, &v) != 3 || r < 1 || c < 1 ||
        r > n || c > n) {
      fprintf(stderr, "sprung-solve: entry %lld of %s is not valid\n", k + 1, matrix);
      exit(1);
    }
    /* The upper triangle of a symmetric matrix (the file has the lower). */
    if (symmetric && r > c) { long long t = r; r = c; c = t; }
    entries[k].row = r - 1;
    entries[k].column = c - 1;
    entries[k].value = v;
  }
  fclose(file);
  if (symmetric)
    for (i = 0; i < n; i++) {
      entries[nz + i].row = entries[nz + i].column = i;
      entries[nz + i].value = 0;
    }
  nz += symmetric ? n : 0;
  qsort(entries, (size_t)nz, sizeof *entries, by_position);

  rows = allocate(sizeof *rows * (size_t)(n + 1));
  columns = allocate(sizeof *columns * (size_t)nz);
  values = allocate(sizeof *values * (size_t)nz);
  memset(rows, 0, sizeof *rows * (size_t)(n + 1));
  /* Duplicates add up. */
  for (k = 0, kept = 0; k < nz; k++) {
    if (kept && entries[k].row == entries[k - 1].row &&
        entries[k].column == entries[k - 1].column) {
      values[kept - 1] += entries[k].value;
      continue;
    }
    columns[kept] = entries[k].column;
    values[kept] = entries[k].value;
    rows[entries[k].row + 1]++;
    kept++;
  }
  free(entries);
  for (i = 0; i < n; i++) rows[i + 1] += rows[i];

  b = allocate(sizeof *b * (size_t)n);
  for (i = 0; i < n; i++) b[i] = 1;
  if (rhs) {
    long long rows, columns;
    file = open_market(rhs, header, sizeof header);
    if (!strstr(header, "array") || !line(file, buffer, sizeof buffer) ||
        sscanf(buffer, "%lld %lld", &rows, &columns) != 2 || rows != n ||
        columns != 1) {
      fprintf(stderr, "sprung-solve: %s is not an array of %lld values\n", rhs, n);
      exit(1);
    }
    for (i = 0; i < n; i++)
      if (!line(file, buffer, sizeof buffer) || sscanf(buffer, "%lf", &b[i]) != 1) {
        fprintf(stderr, "sprung-solve: %s has too few values\n", rhs);
        exit(1);
      }
    fclose(file);
  }
  memset(&s, 0, sizeof s);
  error = factor(&s, symmetric ? SPRUNG_SOLVE_SYMMETRIC : SPRUNG_SOLVE_UNSYMMETRIC,
                 n, kept, rows, columns, values);
  if (error) {
    fprintf(stderr, "sprung-solve: the factorization failed: %s (PARDISO error %lld)\n",
            pardiso_error(error), error);
    exit(1);
  }
  x = allocate(sizeof *x * (size_t)n);
  error = call(&s, 33, 1, b, x);
  if (error) {
    fprintf(stderr, "sprung-solve: the solve failed: %s (PARDISO error %lld)\n",
            pardiso_error(error), error);
    exit(1);
  }
  for (i = 0; i < n; i++) printf("%.17g\n", x[i]);
  release(&s);
}

/* A small indefinite system with a known answer: PARDISO loads and runs on
   this processor. */
static int works(void) {
  struct system s;
  long long rows[] = {0, 2, 4, 5}, columns[] = {0, 1, 1, 2, 2};
  double values[] = {4, 1, -3, 1, 2}, b[3], x[3] = {1, 2, 3}, y[3];
  long long *r = allocate(sizeof rows), *c = allocate(sizeof columns);
  double *v = allocate(sizeof values);
  int i, ok;
  memcpy(r, rows, sizeof rows);
  memcpy(c, columns, sizeof columns);
  memcpy(v, values, sizeof values);
  b[0] = 4 * x[0] + x[1];
  b[1] = x[0] - 3 * x[1] + x[2];
  b[2] = x[1] + 2 * x[2];
  memset(&s, 0, sizeof s);
  if (factor(&s, SPRUNG_SOLVE_SYMMETRIC, 3, 5, r, c, v)) return 0;
  ok = !call(&s, 33, 1, b, y);
  for (i = 0; i < 3; i++) ok = ok && y[i] > x[i] - 1e-9 && y[i] < x[i] + 1e-9;
  release(&s);
  return ok;
}

int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--serve")) {
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    setvbuf(stdin, NULL, _IOFBF, 1 << 20);
    setvbuf(stdout, NULL, _IOFBF, 1 << 20);
    serve();
    return 0;
  }
  if (argc == 2 && !strcmp(argv[1], "--version")) {
    if (!works()) {
      printf("sprung-solve %d: PARDISO does not work here\n", SPRUNG_SOLVE_VERSION);
      return 1;
    }
    printf("sprung-solve %d: %s\n", SPRUNG_SOLVE_VERSION, describe());
    return 0;
  }
  if ((argc == 2 || argc == 3) && argv[1][0] != '-') {
    solve_files(argv[1], argc == 3 ? argv[2] : NULL);
    return 0;
  }
  fprintf(stderr, "Usage: sprung-solve --serve | --version | A.mtx [b.mtx]\n");
  return 2;
}
