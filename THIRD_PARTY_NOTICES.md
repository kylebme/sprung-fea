# Third-party software

The Sprung FEA source code in this repository is GPL-3.0-or-later, except `native/sprung-solve`, which is MIT. Prebuilt distributions (the macOS DMG, Windows installer and Linux AppImage) are mixed-license: they bundle separately licensed third-party components, each under its own license, listed below. Most are free and open-source software. The Linux and Windows builds also contain Intel oneMKL, which is proprietary, distributed in binary form under the Intel Simplified Software License.

The distribution contains separate programs that communicate only through files, command-line arguments and pipes, each in its own process:

- **The Sprung FEA application** (Electron interface, local service and Python engine): GPL-3.0-or-later.
- **CalculiX CrunchiX (`ccx`)**: GPL-2.0-only, as CalculiX itself is (below). The engine writes a CalculiX input file, runs `ccx` on it, and reads its result files. Only libraries whose licenses are compatible with GPL-2.0 are linked into `ccx`.
- **`sprung-solve`** (Linux and Windows): MIT source, linked statically with Intel oneMKL and hypre (MIT, as distributed here). It solves sparse linear systems sent to it through a pipe, by the documented protocol in `docs/solver-protocol.md`, and it can also be run on its own. `ccx` sends its PARDISO solves there and falls back to its built-in SPOOLES solver when `sprung-solve` is absent. Neither MKL, hypre nor `sprung-solve` is linked into `ccx` or into the Sprung FEA application. Packaged builds keep it in its own folder (`runtime/solver/sprung-solve`), with its MIT license, Intel's license, Intel's third-party notices, and hypre's license and notices.
- **`sprung-solve-gpu`** (the NVIDIA builds for Linux and Windows only): the same program and libraries, with hypre compiled for NVIDIA GPUs and NVIDIA's CUDA runtime linked statically, in its own folder (`runtime/solver/sprung-solve-gpu`) beside NVIDIA's cuSPARSE, cuRAND and nvJitLink libraries, with the same notices and NVIDIA's CUDA license. The engine starts it only where an NVIDIA GPU and its driver work; otherwise the NVIDIA builds solve exactly as the others do. The NVIDIA driver is the user's own and is not distributed.

No SolidWorks code, assets, or proprietary UI components are used. Official SolidWorks documentation informed the workflow research recorded in `docs/interaction-design.md`.

| Component | Purpose | License | Upstream/source |
|---|---|---|---|
| CalculiX CrunchiX 2.23 | Structural solver, a separate program (`ccx`) | GPL-2.0-only: its source files are licensed under "the GNU General Public License as published by the Free Software Foundation (version 2)", without "or any later version" (a few headers allow later versions) | https://www.dhondt.de/ and https://github.com/Dhondtguido/CalculiX |
| Gmsh 4.15.2 | STEP/OpenCASCADE import and meshing | GPL-2.0-or-later with exception | https://gmsh.info and https://gitlab.onelab.info/gmsh/gmsh |
| OpenCASCADE (within Gmsh) | CAD kernel | LGPL-2.1 with exception | https://dev.opencascade.org/ |
| NumPy 2.2.6 | Mesh and result calculations | BSD-3-Clause; bundled notices included | https://github.com/numpy/numpy |
| Python 3.10 | Packaged engine runtime | PSF license | https://www.python.org/downloads/source/ |
| PyInstaller | Native runtime packaging | GPL with bootloader exception | https://pyinstaller.org/ |
| Electron | Desktop application shell | MIT, Chromium third-party notices | https://github.com/electron/electron |
| React | User interface | MIT | https://github.com/facebook/react |
| VTK 9.7 (nightly 9.7.20260927, WebAssembly build) | 3D rendering, picking, sections, probing, iso-surfaces and thresholds in the viewer | BSD-3-Clause; bundled third-party libraries keep their own permissive licenses | https://gitlab.kitware.com/vtk/vtk |
| @kitware/vtk-wasm 3.0.5 | JavaScript loader and bindings for VTK.wasm | Apache-2.0 | https://github.com/Kitware/vtk-wasm |
| Lucide | Interface icons | ISC | https://github.com/lucide-icons/lucide |
| CadQuery 2.7.0 (optional development only) | Reproducible complex STEP test fixtures | Apache-2.0 | https://github.com/CadQuery/cadquery |
| Vite | Frontend build and development | MIT | https://github.com/vitejs/vite |
| Express / Multer | Local service and file import | MIT | https://github.com/expressjs |
| Inter / JetBrains Mono | Bundled offline fonts | SIL OFL-1.1 | https://github.com/rsms/inter and https://github.com/JetBrains/JetBrainsMono |
| SPOOLES 2.2 | CalculiX direct solver (statically linked) | Public domain | https://www.netlib.org/linalg/spooles/ |
| conda-forge spooles-feedstock patches (build 1006) | SPOOLES threading fixes, in `native/calculix/spooles-patches` | BSD-3-Clause | https://github.com/conda-forge/spooles-feedstock |
| Apple Accelerate | Sparse direct solver behind CalculiX's PARDISO interface on macOS | macOS system library (GPL-2.0's system library exception), not redistributed | https://developer.apple.com/documentation/accelerate/sparse_solvers |
| sprung-solve | Separate program that runs CalculiX's PARDISO solves on Linux and Windows | MIT (`licenses/sprung-solve.txt`) | `native/sprung-solve` in this repository |
| Intel oneMKL 2026 | PARDISO sparse direct solver, linked statically into `sprung-solve` only (Linux and Windows builds) | Intel Simplified Software License (October 2022), `licenses/Intel-oneMKL.txt`; proprietary, binary only; its third-party notices are in `licenses/Intel-oneMKL-third-party-programs.txt` | https://www.intel.com/content/www/us/en/developer/tools/oneapi/onemkl.html (conda-forge `mkl-static`) |
| hypre 3.2.0 | Conjugate gradients with BoomerAMG algebraic multigrid, linked statically into `sprung-solve` only (Linux and Windows builds) | Apache-2.0 OR MIT, distributed under MIT; its copy of the reference BLAS and LAPACK routines is BSD-3-Clause (University of Tennessee); `licenses/hypre.txt` | https://github.com/hypre-space/hypre |
| NVIDIA CUDA 12.9 Runtime, cuSPARSE, cuRAND and nvJitLink (NVIDIA builds only) | CUDA runtime, linked statically (`cudart_static`) into `sprung-solve-gpu`; the sparse matrix, random number and JIT linking libraries hypre uses, unmodified, beside it | NVIDIA CUDA Toolkit End User License Agreement; each is a redistributable listed in its Attachment A; `licenses/NVIDIA-CUDA.txt` | https://developer.nvidia.com/cuda-toolkit (conda-forge `cuda-cudart-static`) |
| ARPACK-NG | CalculiX linear algebra dependency | BSD-3-Clause | https://github.com/opencollab/arpack-ng |
| OpenBLAS | Linear algebra | BSD-3-Clause | https://github.com/OpenMathLib/OpenBLAS |
| GCC runtime | Fortran, OpenMP, quadmath | GPL-3.0 with GCC Runtime Library Exception where applicable; LGPL for quadmath | https://gcc.gnu.org/ |
| LLVM OpenMP | OpenMP runtime: CalculiX's on macOS; MKL's threads in `sprung-solve` on Windows (as `libiomp5md.dll`) | Apache-2.0 with LLVM exception | https://llvm.org/ |

The VTK.wasm runtime is Kitware's unmodified prebuilt package `vtk-wasm32-emscripten` 9.7.20260927 from the VTK package registry (https://gitlab.kitware.com/vtk/vtk/-/packages), SHA-256 `63252b799e8c44dfb149f329c94f9f6715c78b654292f18cce067c9d080a2e92`. `scripts/fetch-vtk-wasm.mjs` downloads and verifies it; it is not committed to this repository.

The solver is built on every platform by `scripts/build-solver.py` from the CalculiX 2.23 source archive (SHA-256 `9c88385c10fb04f5dc6c4e98027a51bebdd8aee3920e05190d6c1dd08357d6e7`) and SPOOLES 2.2 (SHA-256 `a84559a0e987a1e423055ef4fdf3035d55b65bbe4bf915efaa1a35bef7f8c5dd`), with compilers and libraries from conda-forge (`native/calculix/solver-env-*.yml`). The build checks CalculiX's license notices and stops if they are no longer the GPL version 2 ones described here. Its modifications to CalculiX are all in this repository:

- the SPOOLES patches in `native/calculix/spooles-patches`;
- two small compile fixes: a void function's return value (also fixed in Homebrew's `costerwi/homebrew-calculix` formula), and a Windows-only call outside any function that only affected the old msvcrt;
- `native/calculix/accelerate_pardiso.c`, which answers CalculiX's PARDISO calls with Apple Accelerate on macOS;
- `native/calculix/pardiso_client.c`, which hands them to `sprung-solve` on Linux and Windows, and one call that build-solver.py adds to `mastruct.c`, telling it the direction of each equation once CalculiX has numbered them (for algebraic multigrid);
- `native/calculix/mkl_service.h`, which stands in for MKL's header so that CalculiX compiles without MKL.

These additions are GPL-2.0-or-later. CalculiX's PaStiX interface is not built. `ccx` links the unmodified conda-forge ARPACK, OpenBLAS and GCC (or, on macOS, LLVM OpenMP) runtime libraries.

`sprung-solve` is built by the same script from `native/sprung-solve`, the unmodified static libraries of Intel oneMKL (conda-forge `mkl-static`), and hypre 3.2.0, compiled unmodified from its source archive (SHA-256 `5273205a310fb6aa3ae506ce216760fb67b30e02024874f3cdb8b811e4801de7`) without MPI. It is built with GCC and GNU OpenMP on Linux, and on Windows with Microsoft's C compiler and LLVM OpenMP. `sprung-solve-gpu` compiles the same hypre for NVIDIA GPUs with NVIDIA's `nvcc` (CUDA 12.9, from conda-forge), without NVIDIA's cuBLAS or cuSOLVER libraries; it links the CUDA runtime's static library, and NVIDIA's cuSPARSE and cuRAND, which ship beside it unmodified. Intel's license permits redistributing MKL without modification, provided its copyright notice and terms are reproduced; they ship beside `sprung-solve` and in `licenses/`.

Bundling changes only the libraries' search paths (Linux) or install names (macOS), to each program's own folder. Windows builds also include the MinGW-w64 winpthreads runtime (MIT-style license, https://www.mingw-w64.org/), and Microsoft's Visual C++ runtime library `vcruntime140.dll`, which conda-forge's OpenBLAS and `sprung-solve` need, under Microsoft's terms for redistributable Visual C++ runtime files. The Gmsh wheel includes its upstream CAD/mesher implementation unchanged.

License texts in `licenses/` are included in packaged builds. Electron additionally includes Chromium's own third-party notices. Build scripts collect the installed native and JavaScript dependency notices. This repository currently produces a local developer build. A public binary release must also provide the corresponding source for the GPL and LGPL components and their build modifications, alongside the binary distribution. Intel oneMKL has no source to provide; it is not a GPL component. Upstream source URLs alone are not a replacement for that source distribution.
