# The sprung-solve protocol

`sprung-solve` (`native/sprung-solve`, MIT license) is a stand-alone program that solves sparse linear systems with Intel oneMKL's PARDISO, or, for symmetric positive definite systems, with hypre's conjugate gradients preconditioned by BoomerAMG algebraic multigrid. On Linux and Windows, Sprung FEA's CalculiX build sends its PARDISO solves to it (`native/calculix/pardiso_client.c`). It runs as a separate process with its own address space, and it is linked with MKL (and hypre), which CalculiX is not. Any program can use it the same way, or run it from the command line:

```
sprung-solve --serve              # the protocol below, on standard input and output
sprung-solve --version            # checks that each method solves here, and names them
sprung-solve [--amg] A.mtx [b.mtx]  # solves a Matrix Market system and prints x, one value per line
```

`--version` prints `sprung-solve 2: <PARDISO's name>` when PARDISO works, then `amg: <name>` when CG with BoomerAMG does too. The number is the newest protocol version the program speaks.

`A.mtx` is a square coordinate matrix, real or integer, general or symmetric. Symmetric files list the lower triangle, as Matrix Market does, and duplicate entries add up. `b.mtx` is an array with one column. Without it, b is all ones. `--amg` solves a symmetric positive definite matrix with CG and BoomerAMG to a relative residual of 10⁻¹², as one unknown a node; the setup and the iterations are reported on standard error.

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
| FACTOR | `u32 kind`, `u32 threads`, `u32 method`, `u32 functions`, `f64 tolerance`, `i64 n`, `i64 nnz`, `i64 row_start[n+1]`, `i64 column[nnz]`, `f64 value[nnz]`, then `u8 function[n]` when `functions` > 1 |
| SOLVE | `i64 n`, `i64 nrhs`, `f64 b[n*nrhs]` (one right-hand side after another) |
| RELEASE | nothing |

FACTOR takes the matrix in compressed sparse rows: 0-based, with `row_start[0] = 0`, `row_start[n] = nnz`, and the columns of each row strictly ascending. `kind` is one of:

- `0` symmetric: only the upper triangle, and every diagonal entry, even a zero one. PARDISO factors it as symmetric indefinite, so shifted systems such as those of eigenvalue analyses are fine.
- `1` structurally symmetric: every entry.
- `2` unsymmetric: every entry.

`threads` is the number of threads to factor and solve on. Zero leaves the choice to MKL, which reads `MKL_NUM_THREADS` (and to OpenMP, which reads `OMP_NUM_THREADS`).

`method` says how the handle's systems are solved:

- `0` PARDISO: a direct factorization. `functions`, `function` and `tolerance` are not used.
- `1` CG with BoomerAMG: conjugate gradients, preconditioned by one BoomerAMG V-cycle, from zero to a true relative residual ‖b − Ax‖₂ / ‖b‖₂ of `tolerance` (between 0 and 1). FACTOR builds the multigrid hierarchy. The matrix must be symmetric positive definite, as a supported structure's stiffness is; a matrix of another kind is factored by PARDISO instead, and the reply says so. Should CG stall (500 iterations without reaching the tolerance, as with stiff contact springs), PARDISO factors the system and solves it instead, and factors every later system the program is sent too, whatever its handle; the replies' text says so. `functions` > 1 makes BoomerAMG a systems AMG ("unknown" approach): `function[i]` (below `functions`) is the component of unknown i, such as the direction of a displacement, and each component is coarsened and interpolated on its own. With `functions` = 1 every unknown is the same kind (a temperature, say) and no `function` follows. A FACTOR always rebuilds the hierarchy.

A FACTOR on a handle that already holds a factorization replaces it. When the kind and the structure (`row_start`, `column`) are unchanged, PARDISO's analysis (ordering and symbolic factorization) is kept and only the numeric factorization is redone. This is how a nonlinear step's iterations refactor.

## Replies

Every reply is `i32 status`, `u32 length`, and then `length` bytes of UTF-8 text with no terminator.

- **Status 0** means the request was done. The text names the solvers after HELLO (for example, "Intel oneMKL 2026.1 PARDISO; hypre 3.2.0 CG with BoomerAMG"), and says what FACTOR and SOLVE did: the time taken, BoomerAMG's levels and operator complexity, CG's iterations and final relative residual. RELEASE replies with no text. A successful SOLVE then sends `f64 x[n*nrhs]`.
- **Any other status** means the request failed and nothing else follows. The text says what went wrong. Negative statuses after FACTOR or SOLVE are PARDISO's own error codes; for example, -4 means a zero pivot, so the system is singular. A failed FACTOR leaves the handle empty.

A request that cannot be read (wrong magic, an unknown op, input ending in the middle) ends the program with a message on standard error. The client sees its output close.

## Versions

HELLO must come first. A program that does not speak the requested version answers with a nonzero status. Version 2 is the one described here; sprung-solve also speaks version 1, which differs in two ways. Its FACTOR has no `method`, `functions`, `tolerance` or `function` (every handle is PARDISO's), and the replies to FACTOR and SOLVE carry no text.

On standard error, which carries diagnostics only, the libraries may also print messages of their own.
