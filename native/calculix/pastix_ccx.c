/* PaStiX entry points for CalculiX, on upstream PaStiX 6.

   CalculiX built with -DPASTIX calls pastix_factor_main, pastix_solve and
   pastix_main (factor, solve), and their _cp variants for a second matrix
   held at the same time (massless contact, cavity radiation). Its own
   pastix.c needs a fork of PaStiX 6.0 (PaStiX4CalculiX: mixed precision,
   GPU offload). This file replaces it with the same entry points on the
   released PaStiX, which conda-forge and the package managers ship.

   Matrices arrive in CalculiX's storage, 1-based:
   - symmetric (symmetryflag 0): diagonal in ad, strict lower triangle
     column by column in au (icol[i] entries in column i, rows in irow);
     a nonzero sigma factors A - sigma B, B held the same way in adb, aub.
   - inputformat 1, structurally symmetric: lower triangle as above in
     au[0, nzs), the matching upper entries, row by row, at au[nzs3 + k].
   - inputformat 3, nonsymmetric: off-diagonal entries column by column in
     au, rows in irow, diagonal in ad.
   Symmetric systems are factored as LDLT, the others as LU, both with
   PaStiX's static pivoting; a factorization that had to perturb pivots is
   refined to double precision accuracy on every solve. The ordering of the last structure is kept, so the
   iterations of a nonlinear step only refactor.

   CalculiX compiled with PARDISO too sends its eigenvalue analyses to
   PARDISO, whose pivoting suits shifted indefinite systems; this file sees
   the static, thermal and nonlinear solves.

   Licensed like CalculiX: GNU General Public License, version 2 or later. */

#include <fcntl.h>
#include <pastix.h>
#include <spm.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <io.h>
#define NULL_DEVICE "NUL"
#else
#include <unistd.h>
#define NULL_DEVICE "/dev/null"
#endif

typedef int ITG;

struct context {
  const char *name;
  pastix_data_t *data;
  spmatrix_t spm;
  pastix_int_t iparm[IPARM_SIZE];
  double dparm[DPARM_SIZE];
  int symmetric;
  pastix_int_t n;
  double scalar; /* the inverse of a 1x1 system, which PaStiX is not given */
  double *rhs;   /* the right-hand sides, kept for refinement */
  size_t rhs_size;
};

static struct context basic = {.name = "pastix"}, as = {.name = "pastix_as"},
                      cp = {.name = "pastix_cp"};

static void fail(const struct context *c, const char *what) {
  printf(" *ERROR in %s (PaStiX): %s\n", c->name, what);
  fflush(stdout);
  exit(201);
}

static void *allocate(const struct context *c, size_t bytes) {
  void *p = malloc(bytes ? bytes : 1);
  if (!p) fail(c, "out of memory");
  return p;
}

/* CalculiX's solver threads: CCX_NPROC_EQUATION_SOLVER, else
   NUMBER_OF_CPUS, else every core. */
static int threads(void) {
  const char *names[] = {"CCX_NPROC_EQUATION_SOLVER", "NUMBER_OF_CPUS"};
  for (int i = 0; i < 2; i++) {
    const char *value = getenv(names[i]);
    if (value && atoi(value) > 0) return atoi(value);
  }
  return -1;
}

/* PaStiX built without hwloc (as conda-forge's is) prints a notice about
   counting processor sockets for energy measurement to stderr whenever it
   starts, which CalculiX's log would show; it is not shown. */
static void start_quietly(struct context *c) {
  int saved, null = open(NULL_DEVICE, O_WRONLY);
  fflush(stderr);
  saved = null >= 0 ? dup(2) : -1;
  if (saved >= 0) dup2(null, 2);
  pastixInit(&c->data, MPI_COMM_WORLD, c->iparm, c->dparm);
  fflush(stderr);
  if (saved >= 0) {
    dup2(saved, 2);
    close(saved);
  }
  if (null >= 0) close(null);
}

/* Sorts each column's rows, carrying the values: PaStiX requires sorted
   columns. CalculiX's are almost always sorted already. */
static void sort_columns(pastix_int_t n, const pastix_int_t *colptr,
                         pastix_int_t *rowptr, double *values) {
  for (pastix_int_t j = 0; j < n; j++)
    for (pastix_int_t k = colptr[j] + 1; k < colptr[j + 1]; k++) {
      pastix_int_t row = rowptr[k];
      double value = values[k];
      pastix_int_t m = k;
      for (; m > colptr[j] && rowptr[m - 1] > row; m--) {
        rowptr[m] = rowptr[m - 1];
        values[m] = values[m - 1];
      }
      rowptr[m] = row;
      values[m] = value;
    }
}

/* CalculiX's storage to 0-based compressed columns: the lower triangle of
   a symmetric matrix, else the whole matrix. */
static void compress(const struct context *c, double *ad, double *au,
                     double *adb, double *aub, double sigma, ITG *icol,
                     ITG *irow, ITG n, ITG nzs, int symmetric, ITG inputformat,
                     ITG *jq, ITG nzs3, pastix_int_t **colptr_out,
                     pastix_int_t **rowptr_out, double **values_out) {
  pastix_int_t nnz = symmetric ? (pastix_int_t)n + nzs
                     : inputformat == 1 ? (pastix_int_t)n + 2 * (pastix_int_t)nzs
                                        : (pastix_int_t)n + nzs;
  pastix_int_t *colptr = allocate(c, sizeof(pastix_int_t) * (n + 1));
  pastix_int_t *rowptr = allocate(c, sizeof(pastix_int_t) * nnz);
  double *values = allocate(c, sizeof(double) * nnz);
  pastix_int_t *next = allocate(c, sizeof(pastix_int_t) * (n + 1));
  pastix_int_t k = 0;

  if (symmetric) {
    for (ITG j = 0; j < n; j++) {
      colptr[j] = k;
      rowptr[k] = j;
      values[k++] = sigma == 0. ? ad[j] : ad[j] - sigma * adb[j];
      for (ITG e = 0; e < icol[j]; e++, k++) {
        pastix_int_t l = k - j - 1;
        rowptr[k] = irow[l] - 1;
        values[k] = sigma == 0. ? au[l] : au[l] - sigma * aub[l];
      }
    }
  } else if (inputformat == 1) {
    /* Column j holds the upper entries A(i, j), i < j, which are stored
       with the lower entries of column i; then the diagonal; then column
       j's lower entries. */
    memset(next, 0, sizeof(pastix_int_t) * (n + 1));
    for (ITG j = 0; j < n; j++) {
      next[j + 1] += 1 + icol[j];
      for (ITG l = jq[j] - 1; l < jq[j + 1] - 1; l++) next[irow[l]]++;
    }
    for (ITG j = 0; j < n; j++) next[j + 1] += next[j];
    memcpy(colptr, next, sizeof(pastix_int_t) * (n + 1));
    for (ITG i = 0; i < n; i++)
      for (ITG l = jq[i] - 1; l < jq[i + 1] - 1; l++) {
        pastix_int_t dest = next[irow[l] - 1]++;
        rowptr[dest] = i;
        values[dest] = au[l + nzs3];
      }
    for (ITG j = 0; j < n; j++) {
      pastix_int_t dest = next[j]++;
      rowptr[dest] = j;
      values[dest] = ad[j];
      for (ITG l = jq[j] - 1; l < jq[j + 1] - 1; l++) {
        dest = next[j]++;
        rowptr[dest] = irow[l] - 1;
        values[dest] = au[l];
      }
    }
    k = colptr[n];
  } else if (inputformat == 3) {
    for (ITG j = 0, l = 0; j < n; j++) {
      colptr[j] = k;
      rowptr[k] = j;
      values[k++] = ad[j];
      for (ITG e = 0; e < icol[j]; e++, l++, k++) {
        rowptr[k] = irow[l] - 1;
        values[k] = au[l];
      }
    }
  } else {
    fail(c, "this matrix storage is not supported");
  }
  colptr[n] = k;
  free(next);
  sort_columns(n, colptr, rowptr, values);
  *colptr_out = colptr;
  *rowptr_out = rowptr;
  *values_out = values;
}

static int same_structure(const struct context *c, pastix_int_t n,
                          int symmetric, const pastix_int_t *colptr,
                          const pastix_int_t *rowptr) {
  return c->data && c->n == n && c->symmetric == symmetric &&
         !memcmp(c->spm.colptr, colptr, sizeof(pastix_int_t) * (n + 1)) &&
         !memcmp(c->spm.rowptr, rowptr, sizeof(pastix_int_t) * colptr[n]);
}

static void release(struct context *c) {
  if (c->data) {
    pastixFinalize(&c->data);
    spmExit(&c->spm);
    c->data = NULL;
  }
  free(c->rhs);
  c->rhs = NULL;
  c->rhs_size = 0;
  c->n = 0;
}

static void factor(struct context *c, double *ad, double *au, double *adb,
                   double *aub, double *sigma, ITG *icol, ITG *irow, ITG *neq,
                   ITG *nzs, ITG *symmetryflag, ITG *inputformat, ITG *jq,
                   ITG *nzs3) {
  pastix_int_t n = *neq, *colptr, *rowptr;
  int symmetric = *symmetryflag == 0;
  double *values;
  if (n == 0) return;
  /* With PaStiX's statistics on, keep every line even if the solver stops:
     a pipe (Windows) buffers stdout whole. */
  if (getenv("PASTIX_VERBOSE") && *getenv("PASTIX_VERBOSE"))
    setvbuf(stdout, NULL, _IONBF, 0);
  printf(" Factoring the system of equations using the %s PaStiX solver\n",
         symmetric ? "symmetric" : "unsymmetric");
  fflush(stdout);
  if (n == 1) {
    double a = symmetric && *sigma != 0. ? ad[0] - *sigma * adb[0] : ad[0];
    release(c);
    c->n = 1;
    c->scalar = 1. / a;
    return;
  }
  compress(c, ad, au, adb, aub, *sigma, icol, irow, *neq, *nzs, symmetric,
           *inputformat, jq, *nzs3, &colptr, &rowptr, &values);

  if (same_structure(c, n, symmetric, colptr, rowptr)) {
    memcpy(c->spm.values, values, sizeof(double) * colptr[n]);
    free(colptr);
    free(rowptr);
    free(values);
  } else {
    release(c);
    spmInit(&c->spm);
    c->spm.mtxtype = symmetric ? SpmSymmetric : SpmGeneral;
    c->spm.flttype = SpmDouble;
    c->spm.fmttype = SpmCSC;
    c->spm.baseval = 0;
    c->spm.n = n;
    c->spm.nnz = colptr[n];
    c->spm.dof = 1;
    c->spm.colptr = colptr;
    c->spm.rowptr = rowptr;
    c->spm.values = values;
    spmUpdateComputedFields(&c->spm);

    pastixInitParam(c->iparm, c->dparm);
    /* PASTIX_VERBOSE=1 or 2 prints PaStiX's own statistics and timings. */
    c->iparm[IPARM_VERBOSE] = getenv("PASTIX_VERBOSE")
                                  ? PastixVerboseNot + atoi(getenv("PASTIX_VERBOSE"))
                                  : PastixVerboseNot;
    c->iparm[IPARM_THREAD_NBR] = threads();
    c->iparm[IPARM_FACTORIZATION] = symmetric ? PastixFactLDLT : PastixFactLU;
    c->iparm[IPARM_REFINEMENT] = PastixRefineGMRES;
    c->iparm[IPARM_ITERMAX] = 50;
    c->dparm[DPARM_EPSILON_REFINEMENT] = 1e-12;
    start_quietly(c);
    /* PaStiX threads itself; the BLAS under each thread must not. */
    pastixBlasSetNumThreadsOne();
    c->n = n;
    c->symmetric = symmetric;
    printf(" Using up to %d cpu(s) for PaStiX.\n\n",
           (int)c->iparm[IPARM_THREAD_NBR]);
    fflush(stdout);
    if (pastix_task_analyze(c->data, &c->spm) != PASTIX_SUCCESS)
      fail(c, "the analysis (ordering) failed");
  }
  if (pastix_task_numfact(c->data, &c->spm) != PASTIX_SUCCESS)
    fail(c, "the factorization failed");
}

/* Solves in place; 0 on success, -1 when refinement did not reach double
   precision accuracy (CalculiX warns and continues). A factorization
   without static pivots is exact, as SPOOLES's and PARDISO's are, and
   refinement would only add solves. */
static ITG solve(struct context *c, double *b, ITG *neq, ITG *nrhs) {
  pastix_int_t n = *neq, m = *nrhs, size = n * m;
  int zero = 1;
  if (n == 0) return 0;
  if (n != c->n) fail(c, "solve without a matching factorization");
  if (n == 1) {
    for (pastix_int_t i = 0; i < m; i++) b[i] *= c->scalar;
    return 0;
  }
  if (c->iparm[IPARM_STATIC_PIVOTING] == 0) {
    if (pastix_task_solve(c->data, n, m, b, n) != PASTIX_SUCCESS)
      fail(c, "the solve failed");
    return 0;
  }
  /* Refinement measures error relative to the right-hand side. */
  for (pastix_int_t i = 0; i < size && zero; i++) zero = b[i] == 0.;
  if (zero) return 0;
  if (c->rhs_size < (size_t)size) {
    free(c->rhs);
    c->rhs = allocate(c, sizeof(double) * size);
    c->rhs_size = size;
  }
  memcpy(c->rhs, b, sizeof(double) * size);
  if (pastix_task_solve(c->data, n, m, b, n) != PASTIX_SUCCESS)
    fail(c, "the solve failed");
  if (pastix_task_refine(c->data, n, m, c->rhs, n, b, n) != PASTIX_SUCCESS)
    return -1;
  for (pastix_int_t i = 0; i < size; i++)
    if (b[i] != b[i]) fail(c, "the solution is not a number; the system is singular");
  return 0;
}

#define ENTRY_POINTS(suffix, context)                                        \
  void pastix_factor_main##suffix(                                          \
      double *ad, double *au, double *adb, double *aub, double *sigma,      \
      ITG *icol, ITG *irow, ITG *neq, ITG *nzs, ITG *symmetryflag,          \
      ITG *inputformat, ITG *jq, ITG *nzs3) {                               \
    factor(&context, ad, au, adb, aub, sigma, icol, irow, neq, nzs,         \
           symmetryflag, inputformat, jq, nzs3);                            \
  }                                                                         \
  ITG pastix_solve##suffix(double *b, ITG *neq, ITG *symmetryflag,          \
                           ITG *nrhs) {                                     \
    (void)symmetryflag;                                                     \
    return solve(&context, b, neq, nrhs);                                   \
  }                                                                         \
  void pastix_main##suffix(double *ad, double *au, double *adb, double *aub, \
                           double *sigma, double *b, ITG *icol, ITG *irow,  \
                           ITG *neq, ITG *nzs, ITG *symmetryflag,           \
                           ITG *inputformat, ITG *jq, ITG *nzs3,            \
                           ITG *nrhs) {                                     \
    factor(&context, ad, au, adb, aub, sigma, icol, irow, neq, nzs,         \
           symmetryflag, inputformat, jq, nzs3);                            \
    if (solve(&context, b, neq, nrhs) == -1)                                \
      printf(" *WARNING in %s: the refinement did not converge\n",          \
             context.name);                                                 \
  }                                                                         \
  void pastix_cleanup##suffix(ITG *neq, ITG *symmetryflag) {                \
    (void)neq;                                                              \
    (void)symmetryflag;                                                     \
    release(&context);                                                      \
  }

ENTRY_POINTS(, basic)
ENTRY_POINTS(_as, as)
ENTRY_POINTS(_cp, cp)
