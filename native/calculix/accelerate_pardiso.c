/* PARDISO entry point for CalculiX backed by Apple Accelerate's sparse
   direct solvers.

   CalculiX built with -DPARDISO calls the MKL routine pardiso_ with phase
   12 (analyze and factor), 33 (solve) and -1 (release), for real symmetric
   (mtype -2: upper triangle by rows) and real nonsymmetric (mtype 1, 11:
   full matrix by rows) systems, 1-based. This file provides that routine:
   symmetric systems are factored by supernodal Cholesky, or LDLT with
   threshold partial pivoting when Cholesky finds them indefinite;
   nonsymmetric ones by LU with threshold partial pivoting (QR before macOS
   15.5). The ordering of the last matrix structure is kept, so the
   iterations of a nonlinear step only refactor. Accelerate factors on the
   threads vecLib allows (VECLIB_MAXIMUM_THREADS).

   Licensed like CalculiX: GNU General Public License, version 2 or later. */

#include <Accelerate/Accelerate.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef int ITG;

struct factored {
  SparseOpaqueFactorization_Double factor;
  ITG n;
};

static void fail(const char *what, SparseStatus_t status) {
  printf(" *ERROR in pardiso (Apple Accelerate): %s (status %d)\n", what,
         (int)status);
  fflush(stdout);
  exit(201);
}

static const char *kind_name(SparseFactorization_t kind) {
  switch (kind) {
  case SparseFactorizationCholesky: return "Cholesky";
  case SparseFactorizationLDLT: return "LDLT";
  case SparseFactorizationQR: return "QR";
  default: return "LU";
  }
}

/* The symbolic factorization (ordering and fill pattern) of the last
   matrix structure and factorization kind. Nonlinear steps refactor the
   same structure every iteration, and its METIS ordering costs about as
   much as the numeric factorization. `indefinite` remembers that Cholesky
   failed on this structure, so later iterations go straight to LDLT. */
static struct {
  int valid, indefinite;
  SparseFactorization_t kind;
  SparseOpaqueSymbolicFactorization symbolic;
  ITG n;
  long nnz;
  long *starts;
  int *rows;
} cache;

static int same_structure(ITG n, long nnz, const long *starts,
                          const int *rows) {
  return cache.valid && cache.n == n && cache.nnz == nnz &&
         !memcmp(cache.starts, starts, sizeof(long) * (n + 1)) &&
         !memcmp(cache.rows, rows, sizeof(int) * nnz);
}

/* Takes ownership of the structure's arrays: the cache keeps them, or
   frees them when it already holds the same structure. Nested dissection
   (METIS) suits 3D solid meshes: less fill and more independent work than
   the default minimum-degree ordering. */
static SparseOpaqueSymbolicFactorization symbolic_for(
    SparseFactorization_t kind, SparseMatrixStructure S, long nnz) {
  long *starts = S.columnStarts;
  int *rows = S.rowIndices;
  if (same_structure(S.columnCount, nnz, starts, rows)) {
    if (starts != cache.starts) {
      free(starts);
      free(rows);
    }
    if (cache.kind == kind) return cache.symbolic;
  } else {
    if (cache.valid) {
      free(cache.starts);
      free(cache.rows);
    }
    cache.n = S.columnCount;
    cache.nnz = nnz;
    cache.starts = starts;
    cache.rows = rows;
    cache.indefinite = 0;
  }
  if (cache.valid) SparseCleanup(cache.symbolic);
  S.columnStarts = cache.starts;
  S.rowIndices = cache.rows;
  SparseSymbolicFactorOptions options = _SparseDefaultSymbolicFactorOptions;
  options.orderMethod = SparseOrderMetis;
  cache.symbolic = SparseFactor(kind, S, options);
  cache.kind = kind;
  cache.valid = cache.symbolic.status == SparseStatusOK;
  if (!cache.valid) fail("ordering failed", cache.symbolic.status);
  return cache.symbolic;
}

/* A's structure arrays pass to the cache, and A is left pointing at the
   cache's copy of the same structure. */
static SparseOpaqueFactorization_Double factor(SparseFactorization_t kind,
                                               SparseMatrix_Double *A) {
  long nnz = A->structure.columnStarts[A->structure.columnCount];
  SparseOpaqueSymbolicFactorization S = symbolic_for(kind, A->structure, nnz);
  A->structure.columnStarts = cache.starts;
  A->structure.rowIndices = cache.rows;
  return SparseFactor(S, *A, _SparseDefaultNumericFactorOptions_Double);
}

static void analyze_and_factor(long long *pt, ITG mtype, ITG n, double *a,
                               ITG *ia, ITG *ja) {
  long nnz = (long)ia[n] - 1;
  long *starts = malloc(sizeof(long) * (n + 1));
  int *rows = malloc(sizeof(int) * (nnz > 0 ? nnz : 1));
  double *values = a;
  SparseMatrix_Double A;
  SparseOpaqueFactorization_Double F;
  SparseFactorization_t kind;
  if (!starts || !rows) fail("out of memory", SparseInternalError);

  if (mtype == -2) {
    /* The upper triangle by rows is the lower triangle by columns. */
    for (ITG i = 0; i <= n; i++) starts[i] = (long)ia[i] - 1;
    for (long k = 0; k < nnz; k++) rows[k] = ja[k] - 1;
    A.structure = (SparseMatrixStructure){
        .rowCount = n,
        .columnCount = n,
        .columnStarts = starts,
        .rowIndices = rows,
        .attributes = {.kind = SparseSymmetric,
                       .triangle = SparseLowerTriangle},
        .blockSize = 1};
    A.data = values;
    kind = same_structure(n, nnz, starts, rows) && cache.indefinite
               ? SparseFactorizationLDLT
               : SparseFactorizationCholesky;
    F = factor(kind, &A);
    if (F.status != SparseStatusOK && kind == SparseFactorizationCholesky) {
      /* Not positive definite: a shifted eigenvalue problem, buckling,
         or a structure that is not held. */
      SparseCleanup(F);
      kind = SparseFactorizationLDLT;
      F = factor(kind, &A);
      cache.indefinite = 1;
    }
  } else if (mtype == 1 || mtype == 11) {
    /* Rows to columns: count, then scatter each row's entries. */
    values = malloc(sizeof(double) * (nnz > 0 ? nnz : 1));
    if (!values) fail("out of memory", SparseInternalError);
    memset(starts, 0, sizeof(long) * (n + 1));
    for (long k = 0; k < nnz; k++) starts[ja[k]]++;
    for (ITG j = 0; j < n; j++) starts[j + 1] += starts[j];
    for (ITG i = 0; i < n; i++)
      for (long k = ia[i] - 1; k < ia[i + 1] - 1; k++) {
        long dest = starts[ja[k] - 1]++;
        rows[dest] = i;
        values[dest] = a[k];
      }
    for (ITG j = n; j > 0; j--) starts[j] = starts[j - 1];
    starts[0] = 0;
    A.structure = (SparseMatrixStructure){
        .rowCount = n,
        .columnCount = n,
        .columnStarts = starts,
        .rowIndices = rows,
        .attributes = {.kind = SparseOrdinary},
        .blockSize = 1};
    A.data = values;
    kind = SparseFactorizationQR;
#ifdef __MAC_15_5
    /* SDKs before macOS 15.5 do not declare LU. */
    if (__builtin_available(macOS 15.5, *)) kind = SparseFactorizationLUTPP;
#endif
    F = factor(kind, &A);
  } else {
    printf(" *ERROR in pardiso (Apple Accelerate): matrix type %d is not "
           "supported\n", (int)mtype);
    exit(201);
  }
  /* The factorization keeps its own copy of the values. */
  if (values != a) free(values);
  if (F.status != SparseStatusOK) {
    SparseCleanup(F);
    fail(F.status == SparseMatrixIsSingular ? "the matrix is singular"
                                            : "factorization failed",
         F.status);
  }
  printf(" Apple Accelerate sparse %s factorization\n", kind_name(kind));
  struct factored *state = malloc(sizeof *state);
  state->factor = F;
  state->n = n;
  pt[0] = (long long)(intptr_t)state;
}

void pardiso_(long long *pt, ITG *maxfct, ITG *mnum, ITG *mtype, ITG *phase,
              ITG *neq, double *a, ITG *ia, ITG *ja, ITG *perm, ITG *nrhs,
              ITG *iparm, ITG *msglvl, double *b, double *x, ITG *error) {
  struct factored *state = (struct factored *)(intptr_t)pt[0];
  (void)maxfct; (void)mnum; (void)perm; (void)iparm; (void)msglvl;
  *error = 0;
  if (*phase == 12) {
    if (state) {
      SparseCleanup(state->factor);
      free(state);
      pt[0] = 0;
    }
    analyze_and_factor(pt, *mtype, *neq, a, ia, ja);
  } else if (*phase == 33) {
    if (!state) fail("solve before factorization", SparseInternalError);
    ITG n = state->n, m = *nrhs;
    memcpy(x, b, sizeof(double) * (size_t)n * (size_t)m);
    DenseMatrix_Double X = {.rowCount = n,
                            .columnCount = m,
                            .columnStride = n,
                            .attributes = {0},
                            .data = x};
    SparseSolve(state->factor, X);
  } else if (*phase == -1 || *phase == 0) {
    if (state) {
      SparseCleanup(state->factor);
      free(state);
    }
    pt[0] = 0;
  } else {
    printf(" *ERROR in pardiso (Apple Accelerate): phase %d is not "
           "supported\n", (int)*phase);
    exit(201);
  }
}
