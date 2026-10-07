/* PARDISO entry point for CalculiX from an Intel MKL installed on the
   computer, on Linux and Windows.

   CalculiX built with -DPARDISO calls the MKL routine pardiso_. MKL is not
   free software, so it is not linked into or shipped with this GPL
   program; this file finds the user's MKL runtime library when CalculiX
   first calls PARDISO and forwards every call to it. The engine offers
   PARDISO only when it has found MKL, and passes the library it found in
   SPRUNG_FEA_MKL (a file, or a folder holding it); otherwise the usual
   library search applies.

   MKL threads PARDISO with the count in MKL_NUM_THREADS, which CalculiX's
   pardiso.c sets before its first call. On Linux MKL uses GNU OpenMP, the
   runtime CalculiX's Fortran already loads; Windows MKL has only Intel's.

   Licensed like CalculiX: GNU General Public License, version 2 or later. */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef int ITG;
typedef void pardiso_t(long long *, ITG *, ITG *, ITG *, ITG *, ITG *,
                       double *, ITG *, ITG *, ITG *, ITG *, ITG *, ITG *,
                       double *, double *, ITG *);

#ifdef _WIN32
#include <windows.h>
static const char *NAMES[] = {"mkl_rt.3.dll", "mkl_rt.2.dll", "mkl_rt.1.dll",
                              "mkl_rt.dll"};
#define SEPARATOR "\\"
/* LOAD_WITH_ALTERED_SEARCH_PATH: MKL's own DLLs (its kernels, Intel
   OpenMP) load from the folder of the one named. */
static void *open_library(const char *path) {
  return (void *)LoadLibraryExA(path, NULL,
                                strpbrk(path, "\\/") ? LOAD_WITH_ALTERED_SEARCH_PATH : 0);
}
static void *symbol(void *library, const char *name) {
  return (void *)GetProcAddress((HMODULE)library, name);
}
#else
#include <dlfcn.h>
static const char *NAMES[] = {"libmkl_rt.so", "libmkl_rt.so.3",
                              "libmkl_rt.so.2", "libmkl_rt.so.1"};
#define SEPARATOR "/"
/* RTLD_LOCAL: MKL's BLAS must not take the place of OpenBLAS, which
   ARPACK and PaStiX call. */
static void *open_library(const char *path) {
  return dlopen(path, RTLD_NOW | RTLD_LOCAL);
}
static void *symbol(void *library, const char *name) {
  return dlsym(library, name);
}
#endif

static pardiso_t *mkl_pardiso;

static void *open_mkl(void) {
  const char *given = getenv("SPRUNG_FEA_MKL");
  char path[4096];
  void *library;
  size_t i, count = sizeof NAMES / sizeof *NAMES;
  if (given && *given) {
    if ((library = open_library(given))) return library;
    for (i = 0; i < count; i++) {
      snprintf(path, sizeof path, "%s" SEPARATOR "%s", given, NAMES[i]);
      if ((library = open_library(path))) return library;
    }
  }
  for (i = 0; i < count; i++)
    if ((library = open_library(NAMES[i]))) return library;
  return NULL;
}

static void load(void) {
  void *library;
#ifndef _WIN32
  /* Before MKL reads it, on its first load. */
  setenv("MKL_THREADING_LAYER", "GNU", 0);
#endif
  library = open_mkl();
  if (library) mkl_pardiso = (pardiso_t *)symbol(library, "pardiso_");
  if (!mkl_pardiso) {
    printf(" *ERROR in pardiso: the PARDISO solver needs Intel MKL, which "
           "was not found. Install it, or choose another solver.\n");
    fflush(stdout);
    exit(201);
  }
  printf(" PARDISO from Intel MKL\n");
}

void pardiso_(long long *pt, ITG *maxfct, ITG *mnum, ITG *mtype, ITG *phase,
              ITG *neq, double *a, ITG *ia, ITG *ja, ITG *perm, ITG *nrhs,
              ITG *iparm, ITG *msglvl, double *b, double *x, ITG *error) {
  if (!mkl_pardiso) load();
  mkl_pardiso(pt, maxfct, mnum, mtype, phase, neq, a, ia, ja, perm, nrhs,
              iparm, msglvl, b, x, error);
}
