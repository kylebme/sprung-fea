/* sprung-solve: solves sparse linear systems in a process of its own, with
   Intel oneMKL's PARDISO (a direct factorization) or, for symmetric
   positive definite systems, hypre's conjugate gradients preconditioned by
   BoomerAMG algebraic multigrid.

   sprung-solve --serve
       Takes systems through standard input and answers through standard
       output, by the protocol in protocol.h (docs/solver-protocol.md).
       CalculiX, as built for Sprung FEA, starts it this way for its PARDISO
       solves. Ends when its input closes.
   sprung-solve --version
       Checks that PARDISO, and CG with BoomerAMG, solve on this computer,
       and names them.
   sprung-solve [--amg] A.mtx [b.mtx]
       Solves A x = b for a Matrix Market matrix A (coordinate; real or
       integer; general or symmetric) and right-hand side b (array; all ones
       when not given), and prints x, one value per line. --amg solves a
       symmetric positive definite A with CG and BoomerAMG.

   Each factorization keeps PARDISO's analysis (ordering and symbolic
   factorization) while the matrix's structure stays the same, so the
   iterations of a nonlinear step only refactor.

   SPDX-License-Identifier: MIT
   Copyright (c) 2026 Sprung FEA contributors */

#include <errno.h>
#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <mkl.h>
#ifdef SPRUNG_SOLVE_HYPRE
#include <HYPRE.h>
#include <HYPRE_krylov.h>
#include <HYPRE_parcsr_ls.h>
#include <_hypre_parcsr_ls.h>
#endif
#ifdef _OPENMP
#include <omp.h>
#endif
#ifdef HYPRE_USING_CUDA
#include <cuda_runtime_api.h>
#endif

#include "protocol.h"

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <windows.h>
#else
#include <time.h>
#include <unistd.h>
#endif
#ifdef __linux__
#include <signal.h>
#include <sys/prctl.h>
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
  /* Solved with CG and BoomerAMG (hypre) rather than PARDISO. */
  int amg;
  double tolerance;
#ifdef SPRUNG_SOLVE_HYPRE
  HYPRE_IJMatrix A;
  HYPRE_IJVector b, x, r; /* right-hand side, solution, residual */
  HYPRE_Solver precond, cg;
#endif
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

static void release_amg(struct system *s);

static void release(struct system *s) {
  if (s->factored && s->amg) release_amg(s);
  else if (s->factored) call(s, -1, 1, NULL, NULL);
  s->factored = 0;
  s->amg = 0;
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
  int same = s->factored && !s->amg && s->kind == kind && s->n == n &&
             s->nnz == nnz &&
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

/* ------------------------------------------------------- CG and BoomerAMG */

static double now(void) {
#ifdef _WIN32
  LARGE_INTEGER count, frequency;
  QueryPerformanceCounter(&count);
  QueryPerformanceFrequency(&frequency);
  return (double)count.QuadPart / (double)frequency.QuadPart;
#else
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (double)t.tv_sec + 1e-9 * (double)t.tv_nsec;
#endif
}

#ifdef SPRUNG_SOLVE_HYPRE

/* Iterations at most: a V-cycle each. Elasticity took 40 to 150 on
   Sprung FEA's parts; more means BoomerAMG does not suit the system (stiff
   contact springs), and PARDISO takes over (solve). */
#define CG_MAX_ITERATIONS 500
/* Once CG has stalled, PARDISO takes every later system of this run:
   CalculiX's increments release and remake their handle, and their systems
   are alike. */
static int stalled;
/* hypre is set up and can run here: a GPU build needs a GPU (main). */
static int amg_ready = 1;
/* solve_amg: CG did not reach the tolerance. */
#define STALLED 1

static void release_amg(struct system *s) {
  HYPRE_ParCSRPCGDestroy(s->cg);
  HYPRE_BoomerAMGDestroy(s->precond);
  HYPRE_IJVectorDestroy(s->b);
  HYPRE_IJVectorDestroy(s->x);
  HYPRE_IJVectorDestroy(s->r);
  HYPRE_IJMatrixDestroy(s->A);
}

static HYPRE_IJVector vector(HYPRE_Int n) {
  HYPRE_IJVector v;
  HYPRE_IJVectorCreate(MPI_COMM_WORLD, 0, n - 1, &v);
  HYPRE_IJVectorSetObjectType(v, HYPRE_PARCSR);
  HYPRE_IJVectorInitialize(v);
  HYPRE_IJVectorAssemble(v);
  return v;
}

/* BoomerAMG as a preconditioner for 3D elasticity with quadratic
   tetrahedra: one V-cycle, HMIS coarsening at a strength threshold of 0.25,
   extended+i interpolation with at most four entries a row, and one l1
   Jacobi sweep before and after each coarse-grid correction. l1 Jacobi is
   symmetric, as conjugate gradients need, converges for any symmetric
   positive definite matrix, and threads perfectly. Hybrid Gauss-Seidel took
   a third fewer iterations, but each cost nearly three times as much;
   aggressive coarsening, other interpolations, and rigid-body modes as
   interpolation vectors (GM-AMG) were slower on Sprung FEA's parts
   (IMPLEMENTATION.md). `functions` > 1 coarsens and interpolates each
   displacement direction apart from the others (systems AMG, the "unknown"
   approach), `function` saying which unknown is which. */
static void amg_options(HYPRE_Solver amg, HYPRE_Int functions,
                        HYPRE_Int *function) {
  HYPRE_BoomerAMGSetMaxIter(amg, 1);
  HYPRE_BoomerAMGSetTol(amg, 0);
  HYPRE_BoomerAMGSetPrintLevel(amg, 0);
#ifdef HYPRE_USING_GPU
  /* HMIS's second pass runs on the host; PMIS stays on the GPU. Restriction
     by a kept transpose rather than a transposed product, which is slow
     there. */
  HYPRE_BoomerAMGSetCoarsenType(amg, 8);
  HYPRE_BoomerAMGSetKeepTranspose(amg, 1);
#else
  HYPRE_BoomerAMGSetCoarsenType(amg, 10);
#endif
  HYPRE_BoomerAMGSetStrongThreshold(amg, 0.25);
  HYPRE_BoomerAMGSetAggNumLevels(amg, 0);
  HYPRE_BoomerAMGSetInterpType(amg, 6);
  HYPRE_BoomerAMGSetPMaxElmts(amg, 4);
  HYPRE_BoomerAMGSetRelaxType(amg, 18);
  HYPRE_BoomerAMGSetNumSweeps(amg, 1);
  HYPRE_BoomerAMGSetRelaxOrder(amg, 0);
  HYPRE_BoomerAMGSetMaxLevels(amg, 25);
  if (functions > 1) {
    HYPRE_BoomerAMGSetNumFunctions(amg, functions);
    /* BoomerAMG takes ownership of the array. */
    HYPRE_BoomerAMGSetDofFunc(amg, function);
  }
}

/* The hierarchy's levels and operator complexity (all levels' entries over
   the matrix's), for the log. */
static void hierarchy(HYPRE_Solver amg, int *levels, double *complexity) {
  hypre_ParAMGData *data = (hypre_ParAMGData *)amg;
  hypre_ParCSRMatrix **A = hypre_ParAMGDataAArray(data);
  double total = 0;
  int i;
  *levels = hypre_ParAMGDataNumLevels(data);
  for (i = 0; i < *levels; i++) {
    hypre_ParCSRMatrixSetNumNonzeros(A[i]);
    total += (double)hypre_ParCSRMatrixNumNonzeros(A[i]);
  }
  *complexity = total / (double)hypre_ParCSRMatrixNumNonzeros(A[0]);
}

/* Whether hypre can take a system with nnz entries in its upper triangle;
   if not, why, in `text`. Its indices are 32-bit, and on the GPU it needs
   about 40 to 55 bytes for each entry of the whole matrix (measured on
   Sprung FEA's parts, the CUDA context included), which must fit in the
   GPU's free memory. */
static int amg_fits(long long n, long long nnz, char *text, size_t size) {
  long long full = 2 * nnz - n;
  if (n >= INT_MAX || full >= INT_MAX) {
    snprintf(text, size, "the system is too large for hypre's 32-bit indices");
    return 0;
  }
#ifdef HYPRE_USING_CUDA
  {
    size_t available = 0, total = 0;
    double need = 64.0 * (double)full + (double)(512 << 20);
#ifdef HYPRE_USING_DEVICE_MALLOC_ASYNC
    /* CUDA's stream-ordered pool (the Windows build's) keeps what earlier
       systems freed, which the free memory does not count: return it. */
    {
      int device = 0;
      cudaMemPool_t pool;
      cudaDeviceSynchronize();
      if (cudaGetDevice(&device) == cudaSuccess &&
          cudaDeviceGetDefaultMemPool(&pool, device) == cudaSuccess)
        cudaMemPoolTrimTo(pool, 0);
    }
#endif
    if (cudaMemGetInfo(&available, &total) != cudaSuccess || need > (double)available) {
      snprintf(text, size, "the system needs about %.1f GB on the GPU, which "
               "has %.1f GB free", need / 1e9, (double)available / 1e9);
      return 0;
    }
  }
#endif
  return 1;
}

/* Sets up CG and BoomerAMG for a symmetric matrix given by its upper
   triangle (rows, columns, values, as FACTOR takes it), which hypre takes
   whole (amg_fits). Takes ownership of the arrays and of `function` (each
   unknown's component, below `functions`; NULL when functions is 1).
   Returns 0, with what was built in `text`. */
static int setup_amg(struct system *s, long long n, long long nnz,
                     long long *rows, long long *columns, double *values,
                     uint32_t functions, uint8_t *function, double tolerance,
                     char *text, size_t size) {
  HYPRE_Int *count, *row, *column, *component = NULL;
  HYPRE_BigInt *index;
  double *value, start = now(), complexity;
  HYPRE_ParCSRMatrix A;
  HYPRE_ParVector b, x;
  long long i, k, full = 2 * nnz - n, *next;
  int levels;
  /* Both triangles: row i holds the entries above it in column i (rows
     j < i, ascending), then its own upper triangle. */
  count = allocate(sizeof *count * (size_t)n);
  memset(count, 0, sizeof *count * (size_t)n);
  for (i = 0; i < n; i++)
    for (k = rows[i]; k < rows[i + 1]; k++) {
      count[i]++;
      if (columns[k] != i) count[columns[k]]++;
    }
  next = allocate(sizeof *next * (size_t)n);
  for (i = 0, k = 0; i < n; k += count[i++]) next[i] = k;
  column = allocate(sizeof *column * (size_t)full);
  value = allocate(sizeof *value * (size_t)full);
  for (i = 0; i < n; i++)
    for (k = rows[i]; k < rows[i + 1]; k++)
      if (columns[k] != i) {
        long long j = columns[k], at = next[j]++;
        column[at] = (HYPRE_Int)i;
        value[at] = values[k];
      }
  for (i = 0; i < n; i++)
    for (k = rows[i]; k < rows[i + 1]; k++) {
      long long at = next[i]++;
      column[at] = (HYPRE_Int)columns[k];
      value[at] = values[k];
    }
  free(next);
  free(rows);
  free(columns);
  free(values);
  row = allocate(sizeof *row * (size_t)n);
  for (i = 0; i < n; i++) row[i] = (HYPRE_Int)i;
  index = (HYPRE_BigInt *)column;
  if (sizeof *index != sizeof *column) {
    index = allocate(sizeof *index * (size_t)full);
    for (k = 0; k < full; k++) index[k] = column[k];
  }
  HYPRE_IJMatrixCreate(MPI_COMM_WORLD, 0, (HYPRE_BigInt)n - 1, 0,
                       (HYPRE_BigInt)n - 1, &s->A);
  HYPRE_IJMatrixSetObjectType(s->A, HYPRE_PARCSR);
  {
    HYPRE_Int *none = allocate(sizeof *none * (size_t)n);
    memset(none, 0, sizeof *none * (size_t)n);
    HYPRE_IJMatrixSetDiagOffdSizes(s->A, count, none);
    free(none);
  }
  /* Assembled from these host arrays, then moved to the GPU in a GPU build
     of hypre. */
  HYPRE_IJMatrixInitialize_v2(s->A, HYPRE_MEMORY_HOST);
  HYPRE_IJMatrixSetValues(s->A, (HYPRE_Int)n, count, (HYPRE_BigInt *)row,
                          index, value);
  HYPRE_IJMatrixAssemble(s->A);
#ifdef HYPRE_USING_GPU
  HYPRE_IJMatrixMigrate(s->A, HYPRE_MEMORY_DEVICE);
#endif
  HYPRE_IJMatrixGetObject(s->A, (void **)&A);
  if (index != (HYPRE_BigInt *)column) free(index);
  free(column);
  free(value);
  free(row);
  free(count);

  if (functions > 1) {
    /* BoomerAMG frees it, with its own allocator, and takes it where the
       matrix is. */
    HYPRE_MemoryLocation where = hypre_ParCSRMatrixMemoryLocation(A);
    HYPRE_Int *host = allocate(sizeof *host * (size_t)n);
    for (i = 0; i < n; i++) host[i] = function[i];
    component = hypre_TAlloc(HYPRE_Int, (size_t)n, where);
    hypre_TMemcpy(component, host, HYPRE_Int, (size_t)n, where, HYPRE_MEMORY_HOST);
    free(host);
  }
  free(function);
  s->b = vector((HYPRE_Int)n);
  s->x = vector((HYPRE_Int)n);
  s->r = vector((HYPRE_Int)n);
  HYPRE_IJVectorGetObject(s->b, (void **)&b);
  HYPRE_IJVectorGetObject(s->x, (void **)&x);
  HYPRE_BoomerAMGCreate(&s->precond);
  amg_options(s->precond, (HYPRE_Int)functions, component);
  HYPRE_ParCSRPCGCreate(MPI_COMM_WORLD, &s->cg);
  HYPRE_PCGSetTol(s->cg, tolerance);
  HYPRE_PCGSetAbsoluteTol(s->cg, 0);
  HYPRE_PCGSetMaxIter(s->cg, CG_MAX_ITERATIONS);
  HYPRE_PCGSetTwoNorm(s->cg, 1);
  /* CG's recurrence for the residual drifts from b - Ax, below the
     round-off a true residual can reach: check the true one before
     stopping. */
  HYPRE_PCGSetRecomputeResidual(s->cg, 1);
  HYPRE_PCGSetPrintLevel(s->cg, 0);
  HYPRE_PCGSetPrecond(s->cg, (HYPRE_PtrToSolverFcn)HYPRE_BoomerAMGSolve,
                      (HYPRE_PtrToSolverFcn)HYPRE_BoomerAMGSetup, s->precond);
  HYPRE_ParCSRPCGSetup(s->cg, A, b, x);
  hierarchy(s->precond, &levels, &complexity);
  s->amg = 1;
  s->tolerance = tolerance;
  snprintf(text, size,
           "BoomerAMG: %d levels, operator complexity %.2f, %u unknown%s a "
           "node, set up in %.2f s",
           levels, complexity, functions, functions == 1 ? "" : "s",
           now() - start);
  return 0;
}

/* Solves each right-hand side with CG from zero. Returns 0 when every one
   reached the tolerance, else STALLED; `text` says how it went. The
   verdict and the residual reported are those of the true residual,
   b - Ax, worked out afresh. */
static int solve_amg(struct system *s, long long nrhs, const double *b,
                     double *x, char *text, size_t size) {
  HYPRE_ParCSRMatrix A;
  HYPRE_ParVector pb, px, pr;
  HYPRE_Int iterations, most = 0;
  double worst = 0, start = now();
  long long k, n = s->n;
  HYPRE_IJMatrixGetObject(s->A, (void **)&A);
  HYPRE_IJVectorGetObject(s->b, (void **)&pb);
  HYPRE_IJVectorGetObject(s->x, (void **)&px);
  HYPRE_IJVectorGetObject(s->r, (void **)&pr);
  for (k = 0; k < nrhs; k++) {
    const double *bk = b + k * n;
    double *xk = x + k * n, bb, rr, residual;
    hypre_TMemcpy(hypre_VectorData(hypre_ParVectorLocalVector(pb)), bk,
                  HYPRE_Real, (size_t)n, hypre_ParVectorMemoryLocation(pb),
                  HYPRE_MEMORY_HOST);
    HYPRE_ParVectorInnerProd(pb, pb, &bb);
    if (bb == 0) {
      memset(xk, 0, sizeof *xk * (size_t)n);
      continue;
    }
    HYPRE_ParVectorSetConstantValues(px, 0);
    HYPRE_ParCSRPCGSolve(s->cg, A, pb, px);
    /* Stopping short is judged below, not as an error. */
    HYPRE_ClearAllErrors();
    HYPRE_PCGGetNumIterations(s->cg, &iterations);
    HYPRE_ParVectorCopy(pb, pr);
    HYPRE_ParCSRMatrixMatvec(-1.0, A, px, 1.0, pr);
    HYPRE_ParVectorInnerProd(pr, pr, &rr);
    residual = sqrt(rr / bb);
    hypre_TMemcpy(xk, hypre_VectorData(hypre_ParVectorLocalVector(px)),
                  HYPRE_Real, (size_t)n, HYPRE_MEMORY_HOST,
                  hypre_ParVectorMemoryLocation(px));
    if (iterations > most) most = iterations;
    /* A NaN counts as the worst. */
    if (!(residual <= worst)) worst = residual;
  }
  snprintf(text, size,
           "CG with BoomerAMG%s: %d iterations, relative residual %.3g, "
           "limit %.3g, in %.2f s",
           worst <= s->tolerance ? "" : " stalled", (int)most, worst,
           s->tolerance, now() - start);
  return worst <= s->tolerance ? 0 : STALLED;
}

static int ascending(const void *a, const void *b) {
  const long long *p = a, *q = b;
  return *p < *q ? -1 : *p > *q;
}

/* The upper triangle of the system's matrix by rows, as FACTOR takes it,
   from hypre's copy (wherever it is), for PARDISO when CG stalls. hypre
   keeps each row's diagonal first and the rest unsorted. */
static long long upper_triangle(struct system *s, long long **rows_out,
                                long long **columns_out, double **values_out) {
  HYPRE_ParCSRMatrix A;
  hypre_CSRMatrix *diag;
  HYPRE_Int *ia, *ja;
  HYPRE_Real *a;
  long long i, k, kept = 0, *rows, *pairs;
  double *values;
  HYPRE_IJMatrixGetObject(s->A, (void **)&A);
  diag = hypre_CSRMatrixClone_v2(hypre_ParCSRMatrixDiag(A), 1, HYPRE_MEMORY_HOST);
  ia = hypre_CSRMatrixI(diag);
  ja = hypre_CSRMatrixJ(diag);
  a = hypre_CSRMatrixData(diag);
  rows = allocate(sizeof *rows * (size_t)(s->n + 1));
  /* Pairs of (column, position) per row, sorted by column. */
  pairs = allocate(sizeof *pairs * 2 * (size_t)ia[s->n]);
  values = allocate(sizeof *values * (size_t)ia[s->n]);
  for (i = 0; i < s->n; i++) {
    long long start = kept;
    rows[i] = kept;
    for (k = ia[i]; k < ia[i + 1]; k++)
      if (ja[k] >= i) {
        pairs[2 * kept] = ja[k];
        pairs[2 * kept + 1] = k;
        kept++;
      }
    qsort(pairs + 2 * start, (size_t)(kept - start), 2 * sizeof *pairs, ascending);
  }
  rows[s->n] = kept;
  for (k = 0; k < kept; k++) values[k] = a[pairs[2 * k + 1]];
  /* The columns, packed. */
  for (k = 0; k < kept; k++) pairs[k] = pairs[2 * k];
  hypre_CSRMatrixDestroy(diag);
  *rows_out = rows;
  *columns_out = realloc(pairs, sizeof *pairs * (size_t)(kept ? kept : 1));
  *values_out = values;
  return kept;
}

static const char *describe_amg(void) {
#if defined(HYPRE_USING_CUDA)
  /* With the GPU's name, as its driver gives it. */
  static char name[320];
  struct cudaDeviceProp properties;
  int device = 0;
  if (cudaGetDevice(&device) == cudaSuccess &&
      cudaGetDeviceProperties(&properties, device) == cudaSuccess)
    snprintf(name, sizeof name,
             "hypre " HYPRE_RELEASE_VERSION " CG with BoomerAMG, on the GPU (%s)",
             properties.name);
  else
    snprintf(name, sizeof name,
             "hypre " HYPRE_RELEASE_VERSION " CG with BoomerAMG, on the GPU");
  return name;
#elif defined(HYPRE_USING_GPU)
  return "hypre " HYPRE_RELEASE_VERSION " CG with BoomerAMG, on the GPU";
#else
  return "hypre " HYPRE_RELEASE_VERSION " CG with BoomerAMG";
#endif
}

#else

static void release_amg(struct system *s) { (void)s; }

#endif

/* ---------------------------------------------------------------- methods */

/* Factors (PARDISO) or sets up (CG and BoomerAMG) the system for the
   method asked for. CG needs a symmetric positive definite matrix, so other
   kinds go to PARDISO, as does every system once CG has stalled, and any
   system too large for hypre (amg_fits). Takes ownership of the arrays.
   Returns 0 or PARDISO's error code, with a note on what was done, or what
   went wrong, in `text`. */
static long long prepare(struct system *s, uint32_t kind, uint32_t method,
                         long long n, long long nnz, long long *rows,
                         long long *columns, double *values,
                         uint32_t functions, uint8_t *function,
                         double tolerance, char *text, size_t size) {
  long long error;
  char unfit[160] = "";
  text[0] = 0;
#ifdef SPRUNG_SOLVE_HYPRE
  if (method == SPRUNG_SOLVE_CG_AMG && kind == SPRUNG_SOLVE_SYMMETRIC &&
      amg_ready && !stalled && amg_fits(n, nnz, unfit, sizeof unfit)) {
    release(s);
    s->kind = kind;
    s->n = n;
    s->nnz = nnz;
    error = setup_amg(s, n, nnz, rows, columns, values, functions, function,
                      tolerance, text, size);
    s->factored = !error;
    if (error) release(s);
    return error;
  }
#endif
  free(function);
  {
    double start = now();
    int again = s->factored && !s->amg && s->kind == kind && s->n == n;
    /* Why PARDISO, when CG was asked for; unfit says more. */
    const char *note = method != SPRUNG_SOLVE_CG_AMG ? ""
#ifdef SPRUNG_SOLVE_HYPRE
                       : !amg_ready ? "; CG needs an NVIDIA GPU, and there is none here"
                       : stalled ? "; CG stalled on an earlier system"
                       : unfit[0] ? "; CG was not used: "
                       : "; CG needs a symmetric matrix";
#else
                       : "; this sprung-solve has no CG (hypre)";
#endif
    error = factor(s, kind, n, nnz, rows, columns, values);
    if (error)
      snprintf(text, size, "The factorization failed: %s (PARDISO error %lld)",
               pardiso_error(error), error);
    else
      snprintf(text, size, "PARDISO factored %lld equations in %.2f s%s%s%s", n,
               now() - start, again ? " (refactored)" : "", note, unfit);
  }
  return error;
}

/* Solves with the system's factorization or CG. Should CG stall, PARDISO
   factors the system and solves it instead, and takes every later system
   too. Returns 0 or PARDISO's error code, with what happened in
   `text`. */
static long long solve(struct system *s, long long nrhs, double *b, double *x,
                       char *text, size_t size) {
  long long error;
  text[0] = 0;
#ifdef SPRUNG_SOLVE_HYPRE
  if (s->amg) {
    long long *rows, *columns, nnz;
    double *values, start;
    size_t used;
    if (solve_amg(s, nrhs, b, x, text, size) != STALLED) return 0;
    nnz = upper_triangle(s, &rows, &columns, &values);
    release(s);
    stalled = 1;
    start = now();
    error = factor(s, s->kind, s->n, nnz, rows, columns, values);
    if (!error) error = call(s, 33, nrhs, b, x);
    used = strlen(text);
    if (error)
      snprintf(text + used, size - used,
               "; PARDISO, taking over, failed: %s (PARDISO error %lld)",
               pardiso_error(error), error);
    else
      snprintf(text + used, size - used,
               "; PARDISO factored and solved instead, in %.2f s", now() - start);
    return error;
  }
#endif
  {
    double start = now();
    error = call(s, 33, nrhs, b, x);
    if (error)
      snprintf(text, size, "The solve failed: %s (PARDISO error %lld)",
               pardiso_error(error), error);
    else
      snprintf(text, size, "PARDISO solved in %.2f s", now() - start);
  }
  return error;
}

/* --------------------------------------------------------------- protocol */

/* The protocol's own copy of standard output (serve). */
static FILE *replies;

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
  if (fwrite(data, 1, bytes, replies) != bytes) exit(2);
}

static void reply(int32_t status, const char *text) {
  uint32_t length = (uint32_t)strlen(text);
  put(&status, sizeof status);
  put(&length, sizeof length);
  put(text, length);
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

static void set_threads(uint32_t threads) {
  if (!threads) return;
  mkl_set_num_threads((int)threads);
#ifdef _OPENMP
  omp_set_num_threads((int)threads);
#endif
}

/* Standard output carries replies alone: the libraries' own messages
   (hypre prints some warnings) go to standard error instead. */
static void keep_output(void) {
#ifdef _WIN32
  int out = _dup(1);
  _dup2(2, 1);
  replies = _fdopen(out, "wb");
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(out, _O_BINARY);
#else
  int out = dup(1);
  dup2(2, 1);
  replies = fdopen(out, "wb");
#endif
  if (!replies) exit(2);
  setvbuf(stdin, NULL, _IOFBF, 1 << 20);
  setvbuf(replies, NULL, _IOFBF, 1 << 20);
}

static void serve(void) {
  struct sprung_solve_request request;
  uint32_t version = 0;
  char text[512];
#ifdef __linux__
  /* Ends with CalculiX, even mid-factorization. */
  prctl(PR_SET_PDEATHSIG, SIGKILL);
  if (getppid() == 1) exit(0);
#endif
  keep_output();
  for (;;) {
    struct system *s;
    receive(&request, sizeof request, 1);
    if (request.magic != SPRUNG_SOLVE_MAGIC) {
      fprintf(stderr, "sprung-solve: not a request\n");
      exit(2);
    }
    if (request.op != SPRUNG_SOLVE_HELLO && !version) {
      fprintf(stderr, "sprung-solve: HELLO must come first\n");
      exit(2);
    }
    switch (request.op) {
    case SPRUNG_SOLVE_HELLO: {
      uint32_t asked;
      receive(&asked, sizeof asked, 0);
      if (asked != 1 && asked != 2) {
        reply(-1, "this sprung-solve speaks protocol versions 1 and 2");
        break;
      }
      version = asked;
#ifdef SPRUNG_SOLVE_HYPRE
      if (version >= 2 && amg_ready) {
        snprintf(text, sizeof text, "%s; %s", describe(), describe_amg());
        reply(0, text);
        break;
      }
#endif
      reply(0, describe());
      break;
    }
    case SPRUNG_SOLVE_FACTOR: {
      uint32_t kind, threads, method = SPRUNG_SOLVE_PARDISO, functions = 1;
      double tolerance = 0;
      long long n, nnz, *rows, *columns, error;
      double *values;
      uint8_t *function = NULL;
      receive(&kind, sizeof kind, 0);
      receive(&threads, sizeof threads, 0);
      if (version >= 2) {
        receive(&method, sizeof method, 0);
        receive(&functions, sizeof functions, 0);
        receive(&tolerance, sizeof tolerance, 0);
      }
      receive(&n, sizeof n, 0);
      receive(&nnz, sizeof nnz, 0);
      if (n < 1 || nnz < 1 || functions < 1 || functions > 255) {
        fprintf(stderr, "sprung-solve: a matrix of order %lld with %lld "
                        "entries and %u unknowns a node\n", n, nnz, functions);
        exit(2);
      }
      rows = receive_array((size_t)n + 1, sizeof *rows);
      columns = receive_array((size_t)nnz, sizeof *columns);
      values = receive_array((size_t)nnz, sizeof *values);
      if (functions > 1) function = receive_array((size_t)n, 1);
      if (!valid(kind, n, nnz, rows, columns) || method > SPRUNG_SOLVE_CG_AMG ||
          (method == SPRUNG_SOLVE_CG_AMG && !(tolerance > 0 && tolerance < 1))) {
        free(rows);
        free(columns);
        free(values);
        free(function);
        reply(-1, "the matrix is not 0-based compressed rows with ascending "
                  "columns (when symmetric, the upper triangle with every "
                  "diagonal entry), or the method or tolerance is not valid");
        break;
      }
      if (function) {
        long long i;
        for (i = 0; i < n && function[i] < functions; i++) {}
        if (i < n) {
          free(rows); free(columns); free(values); free(function);
          reply(-1, "an unknown's component is not below the number of "
                    "unknowns a node");
          break;
        }
      }
      set_threads(threads);
      s = find(request.handle, 1);
      error = prepare(s, kind, method, n, nnz, rows, columns, values,
                      functions, function, tolerance, text, sizeof text);
      /* Version 1 replies to a factorization with no text. */
      reply(error ? (int32_t)error : 0, error || version >= 2 ? text : "");
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
        error = solve(s, nrhs, b, x, text, sizeof text);
        if (error) {
          reply((int32_t)error, text);
        } else {
          reply(0, version >= 2 ? text : "");
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
    fflush(replies);
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

/* CG's tolerance from the command line (--amg). */
#define FILE_TOLERANCE 1e-12

static void solve_files(const char *matrix, const char *rhs, uint32_t method) {
  char header[256], buffer[512], text[512];
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
  error = prepare(&s, symmetric ? SPRUNG_SOLVE_SYMMETRIC : SPRUNG_SOLVE_UNSYMMETRIC,
                  method, n, kept, rows, columns, values, 1, NULL,
                  FILE_TOLERANCE, text, sizeof text);
  if (error) {
    fprintf(stderr, "sprung-solve: %s\n", text);
    exit(1);
  }
  if (text[0]) fprintf(stderr, "sprung-solve: %s\n", text);
  x = allocate(sizeof *x * (size_t)n);
  error = solve(&s, 1, b, x, text, sizeof text);
  if (text[0]) fprintf(stderr, "sprung-solve: %s\n", text);
  if (error) exit(1);
  for (i = 0; i < n; i++) printf("%.17g\n", x[i]);
  release(&s);
}

/* A small symmetric system with a known answer, solved by `method`:
   indefinite for PARDISO, positive definite (a chain of springs) for CG.
   The method loads and runs on this processor. */
static int works(uint32_t method) {
  enum { N = 40 };
  struct system s;
  long long *rows = allocate(sizeof *rows * (N + 1)),
            *columns = allocate(sizeof *columns * 2 * N);
  double *values = allocate(sizeof *values * 2 * N), b[N], x[N], y[N];
  char text[512];
  int i, k = 0, ok;
  for (i = 0; i < N; i++) x[i] = 1 + i % 7;
  for (i = 0; i < N; i++) {
    double diagonal = method == SPRUNG_SOLVE_PARDISO && i % 3 == 1 ? -3 : 4;
    rows[i] = k;
    columns[k] = i;
    values[k++] = diagonal;
    if (i + 1 < N) {
      columns[k] = i + 1;
      values[k++] = -1;
    }
    b[i] = diagonal * x[i] - (i > 0 ? x[i - 1] : 0) - (i + 1 < N ? x[i + 1] : 0);
  }
  rows[N] = k;
  memset(&s, 0, sizeof s);
  if (prepare(&s, SPRUNG_SOLVE_SYMMETRIC, method, N, k, rows, columns, values,
              1, NULL, FILE_TOLERANCE, text, sizeof text))
    return 0;
  ok = !solve(&s, 1, b, y, text, sizeof text) && s.amg == (method != SPRUNG_SOLVE_PARDISO);
  for (i = 0; i < N; i++) ok = ok && y[i] > x[i] - 1e-9 && y[i] < x[i] + 1e-9;
  release(&s);
  return ok;
}

int main(int argc, char **argv) {
  uint32_t method = SPRUNG_SOLVE_PARDISO;
#ifdef SPRUNG_SOLVE_HYPRE
#ifdef HYPRE_USING_CUDA
  /* Without an NVIDIA GPU and its driver, a GPU build still runs PARDISO,
     and offers no CG (amg_ready). */
  {
    int devices = 0;
    if (cudaGetDeviceCount(&devices) != cudaSuccess || devices < 1) amg_ready = 0;
  }
#endif
  if (amg_ready) {
    HYPRE_Initialize();
#ifdef HYPRE_USING_GPU
    HYPRE_SetMemoryLocation(HYPRE_MEMORY_DEVICE);
    HYPRE_SetExecutionPolicy(HYPRE_EXEC_DEVICE);
    /* hypre's own sparse products (a build without cuSPARSE has no
       other): cuSPARSE's took up to three times the memory (6.5 GB against
       2 GB at 546,000 equations) and were slower. Device memory comes from
       CUDA's stream-ordered pool, which starts empty and grows, and keeps
       what is freed (build-solver.py). */
    HYPRE_SetSpGemmUseVendor(0);
#endif
  }
#endif
  if (argc == 2 && !strcmp(argv[1], "--serve")) {
    serve();
    return 0;
  }
  if (argc == 2 && !strcmp(argv[1], "--version")) {
    if (!works(SPRUNG_SOLVE_PARDISO)) {
      printf("sprung-solve %d: PARDISO does not work here\n", SPRUNG_SOLVE_VERSION);
      return 1;
    }
    printf("sprung-solve %d: %s\n", SPRUNG_SOLVE_VERSION, describe());
#ifdef SPRUNG_SOLVE_HYPRE
    /* A second method, offered when it works. */
    if (amg_ready && works(SPRUNG_SOLVE_CG_AMG)) printf("amg: %s\n", describe_amg());
#endif
    return 0;
  }
  if (argc >= 2 && !strcmp(argv[1], "--amg")) {
    method = SPRUNG_SOLVE_CG_AMG;
    argv++;
    argc--;
  }
  if ((argc == 2 || argc == 3) && argv[1][0] != '-') {
    solve_files(argv[1], argc == 3 ? argv[2] : NULL, method);
    return 0;
  }
  fprintf(stderr, "Usage: sprung-solve --serve | --version | [--amg] A.mtx [b.mtx]\n");
  return 2;
}
