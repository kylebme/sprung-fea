# The sprung-solve protocol

`sprung-solve` (`native/sprung-solve`, MIT license) is a stand-alone program that solves sparse linear systems with Intel oneMKL's PARDISO. On Linux and Windows, Sprung FEA's CalculiX build sends its PARDISO solves to it (`native/calculix/pardiso_client.c`). It runs as a separate process with its own address space, and it is linked with MKL, which CalculiX is not. Any program can use it the same way, or run it from the command line:

```
sprung-solve --serve            # the protocol below, on standard input and output
sprung-solve --version          # checks that PARDISO solves here; prints "sprung-solve 1: <solver>"
sprung-solve A.mtx [b.mtx]      # solves a Matrix Market system and prints x, one value per line
```

`A.mtx` is a square coordinate matrix, real or integer, general or symmetric. Symmetric files list the lower triangle, as Matrix Market does, and duplicate entries add up. `b.mtx` is an array with one column. Without it, b is all ones.

## Transport

With `--serve`, the client writes requests to the program's standard input and reads replies from its standard output, one reply per request, in order. Standard error carries diagnostics only. The program exits when its input closes. On Linux it also exits when its parent process does, even in the middle of a factorization. CalculiX's client on Windows puts it in a job object that closes with CalculiX, which has the same effect.

Every value is little-endian: `u32`/`i32` take 4 bytes, `u64`/`i64` 8 bytes, and `f64` is an IEEE double. Nothing is padded. The constants are in `native/sprung-solve/protocol.h`.

## Requests

Every request starts with a 16-byte header:

| Field | Type | Meaning |
|---|---|---|
| magic | u32 | `0x53525053` ("SPRS") |
| op | u32 | 0 HELLO, 1 FACTOR, 2 SOLVE, 3 RELEASE |
| handle | u64 | chosen by the client; names one factorization |

A client can keep any number of factorizations at once, each under its own handle. CalculiX uses the address of its PARDISO handle array.

| Request | Payload after the header |
|---|---|
| HELLO | `u32 version` (1) |
| FACTOR | `u32 kind`, `u32 threads`, `i64 n`, `i64 nnz`, `i64 row_start[n+1]`, `i64 column[nnz]`, `f64 value[nnz]` |
| SOLVE | `i64 n`, `i64 nrhs`, `f64 b[n*nrhs]` (one right-hand side after another) |
| RELEASE | nothing |

FACTOR takes the matrix in compressed sparse rows: 0-based, with `row_start[0] = 0`, `row_start[n] = nnz`, and the columns of each row strictly ascending. `kind` is one of:

- `0` symmetric: only the upper triangle, and every diagonal entry, even a zero one. PARDISO factors it as symmetric indefinite, so shifted systems such as those of eigenvalue analyses are fine.
- `1` structurally symmetric: every entry.
- `2` unsymmetric: every entry.

`threads` is the number of threads to factor and solve on. Zero leaves the choice to MKL, which reads `MKL_NUM_THREADS`.

A FACTOR on a handle that already holds a factorization replaces it. When the kind and the structure (`row_start`, `column`) are unchanged, PARDISO's analysis (ordering and symbolic factorization) is kept and only the numeric factorization is redone. This is how a nonlinear step's iterations refactor.

## Replies

Every reply is `i32 status`, `u32 length`, and then `length` bytes of UTF-8 text with no terminator.

- **Status 0** means the request was done. The text is the solver's name after HELLO (for example, "Intel oneMKL 2026.1 PARDISO") and empty otherwise. A successful SOLVE then sends `f64 x[n*nrhs]`.
- **Any other status** means the request failed and nothing else follows. The text says what went wrong. Negative statuses after FACTOR or SOLVE are PARDISO's own error codes; for example, -4 means a zero pivot, so the system is singular. A failed FACTOR leaves the handle empty.

A request that cannot be read (wrong magic, an unknown op, input ending in the middle) ends the program with a message on standard error. The client sees its output close.

## Versions

HELLO must come first. A program that does not speak the requested version answers with a nonzero status. Version 1 is the one described here.
