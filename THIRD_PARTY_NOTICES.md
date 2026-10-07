# Third-party software

Sprung FEA is GPL-3.0-or-later. Its original interface and integration code are in this repository. No SolidWorks code, assets, or proprietary UI components are used. Official SolidWorks documentation informed the workflow research recorded in `docs/interaction-design.md`.

| Component | Purpose | License | Upstream/source |
|---|---|---|---|
| CalculiX CrunchiX 2.23 | Structural solver | GPL-2.0-or-later | https://www.dhondt.de/ and https://github.com/Dhondtguido/CalculiX |
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
| Apple Accelerate | Sparse direct solver behind CalculiX's PARDISO interface on macOS | macOS system framework, not redistributed | https://developer.apple.com/documentation/accelerate/sparse_solvers |
| PaStiX 6.4 (with its SPM library) | Multithreaded sparse direct solver behind CalculiX's PaStiX interface | LGPL-3.0-or-later | https://solverstack.gitlabpages.inria.fr/pastix/ and https://gitlab.inria.fr/solverstack/pastix |
| Scotch 7 | Matrix ordering for PaStiX | CeCILL-C | https://gitlab.inria.fr/scotch/scotch |
| METIS 5 | Graph partitioning, a PaStiX dependency (where linked) | Apache-2.0 | https://github.com/KarypisLab/METIS |
| zlib / bzip2 / xz | Compression, Scotch dependencies (macOS, Linux) | Zlib / bzip2 license / 0BSD and public domain | https://zlib.net/, https://sourceware.org/bzip2/, https://tukaani.org/xz/ |
| Intel MKL (optional, user-installed) | PARDISO on Windows and Linux when the user has installed MKL | Intel Simplified Software License; not distributed, linked or bundled | https://www.intel.com/content/www/us/en/developer/tools/oneapi/onemkl.html |
| ARPACK-NG | CalculiX linear algebra dependency | BSD-3-Clause | https://github.com/opencollab/arpack-ng |
| OpenBLAS | Linear algebra | BSD-3-Clause | https://github.com/OpenMathLib/OpenBLAS |
| GCC runtime | Fortran, OpenMP, quadmath | GPL-3.0 with GCC Runtime Library Exception where applicable; LGPL for quadmath | https://gcc.gnu.org/ |
| Open MPI / PMIx / hwloc / libevent | Transitive native dependencies | BSD licenses; see individual notices | https://www.open-mpi.org/ and https://libevent.org/ |
| LLVM OpenMP | Transitive native dependency | Apache-2.0 with LLVM exception | https://llvm.org/ |

The VTK.wasm runtime is Kitware's unmodified prebuilt package `vtk-wasm32-emscripten` 9.7.20260927 from the VTK package registry (https://gitlab.kitware.com/vtk/vtk/-/packages), SHA-256 `63252b799e8c44dfb149f329c94f9f6715c78b654292f18cce067c9d080a2e92`. `scripts/fetch-vtk-wasm.mjs` downloads and verifies it; it is not committed to this repository.

The solver is built on every platform by `scripts/build-solver.py` from the CalculiX 2.23 source archive (SHA-256 `9c88385c10fb04f5dc6c4e98027a51bebdd8aee3920e05190d6c1dd08357d6e7`) and SPOOLES 2.2 (SHA-256 `a84559a0e987a1e423055ef4fdf3035d55b65bbe4bf915efaa1a35bef7f8c5dd`), with compilers and libraries from conda-forge (`native/calculix/solver-env-*.yml`). Its modifications are all in this repository: the SPOOLES patches in `native/calculix/spooles-patches`, two small CalculiX compile fixes (a void function's return value, also fixed in Homebrew's `costerwi/homebrew-calculix` formula, and a Windows-only call outside any function that only affected the old msvcrt), `native/calculix/pastix_ccx.c`, which replaces CalculiX's `pastix.c` to call the released PaStiX, `native/calculix/accelerate_pardiso.c`, which answers CalculiX's PARDISO calls with Apple Accelerate on macOS, `native/calculix/mkl_pardiso.c`, which forwards them to an Intel MKL the user has installed on Windows and Linux, and `native/calculix/mkl_service.h`, which stands in for MKL's header (all GPL-2.0-or-later, like CalculiX). Because PaStiX is LGPL-3.0-or-later, the solver as distributed is covered by GPL-3.0, which CalculiX's GPL-2.0-or-later allows. It links the unmodified conda-forge ARPACK, OpenBLAS, PaStiX, Scotch and GCC (or LLVM OpenMP) runtime libraries; on macOS and Windows, PaStiX 6.4 is built from its release archive with one build fix to its code for running without hwloc (an undefined warning function and a missing macOS header; `build_pastix` in `scripts/build-solver.py`) (SHA-256 `891d426188eed56c1075fb34d2d80132593a1536ffc05cf333567f68a4811e55`), and on Windows Scotch 7.0.11 is built unmodified from its release archive (SHA-256 `d3578b15a8ff5c7924ab0fa4cd166e58d907da4fd95cdaaab37a9034669c64d2`) and linked statically into PaStiX. Bundling changes only the libraries' search paths (Linux) or install names (macOS), to the solver's own folder. Intel MKL is never distributed with Sprung FEA: it is proprietary, and a GPL program may not be shipped combined with it. Windows builds also include the MinGW-w64 winpthreads runtime (MIT-style license, https://www.mingw-w64.org/), and Microsoft's Visual C++ runtime library `vcruntime140.dll`, which conda-forge's OpenBLAS needs, under Microsoft's terms for redistributable Visual C++ runtime files. The Gmsh wheel includes its upstream CAD/mesher implementation unchanged.

License texts in `licenses/` are included in packaged builds. Electron additionally includes Chromium's own third-party notices. Build scripts collect the installed native and JavaScript dependency notices. This repository currently produces a local developer build; a public binary release must also provide corresponding source for GPL/LGPL components and their build modifications, alongside the binary distribution. Upstream source URLs alone are not a replacement for that source distribution.
