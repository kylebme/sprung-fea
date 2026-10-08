/* The sprung-solve protocol, version 1: a client sends a sparse linear
   system to the sprung-solve process through its standard input, and reads
   the replies from its standard output. docs/solver-protocol.md describes
   it in full.

   SPDX-License-Identifier: MIT
   Copyright (c) 2026 Sprung FEA contributors */

#ifndef SPRUNG_SOLVE_PROTOCOL_H
#define SPRUNG_SOLVE_PROTOCOL_H

#include <stdint.h>

#define SPRUNG_SOLVE_VERSION 1
/* "SPRS", read as a little-endian 32-bit integer. */
#define SPRUNG_SOLVE_MAGIC 0x53525053u

/* Every request starts with this header; a payload follows. */
struct sprung_solve_request {
  uint32_t magic;
  uint32_t op;
  uint64_t handle; /* chosen by the client; names one factorization */
};

enum sprung_solve_op {
  SPRUNG_SOLVE_HELLO = 0,   /* u32 version */
  SPRUNG_SOLVE_FACTOR = 1,  /* u32 kind, u32 threads, i64 n, i64 nnz,
                               i64 row_start[n+1], i64 column[nnz],
                               f64 value[nnz] */
  SPRUNG_SOLVE_SOLVE = 2,   /* i64 n, i64 nrhs, f64 b[n*nrhs] */
  SPRUNG_SOLVE_RELEASE = 3, /* nothing */
};

/* The matrix, by rows (compressed sparse rows), 0-based, the columns of
   each row ascending. */
enum sprung_solve_kind {
  SPRUNG_SOLVE_SYMMETRIC = 0,              /* the upper triangle */
  SPRUNG_SOLVE_STRUCTURALLY_SYMMETRIC = 1, /* every entry */
  SPRUNG_SOLVE_UNSYMMETRIC = 2,            /* every entry */
};

/* Every reply: i32 status (0: done), u32 length, that many bytes of text
   (UTF-8, no terminator): the solver's name after HELLO, otherwise what
   went wrong, or nothing. A SOLVE that is done then sends f64 x[n*nrhs]. */

#endif
