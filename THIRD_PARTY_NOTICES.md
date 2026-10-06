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
| ARPACK-NG | CalculiX linear algebra dependency | BSD-3-Clause | https://github.com/opencollab/arpack-ng |
| OpenBLAS | Linear algebra | BSD-3-Clause | https://github.com/OpenMathLib/OpenBLAS |
| GCC runtime | Fortran, OpenMP, quadmath | GPL-3.0 with GCC Runtime Library Exception where applicable; LGPL for quadmath | https://gcc.gnu.org/ |
| Open MPI / PMIx / hwloc / libevent | Transitive native dependencies | BSD licenses; see individual notices | https://www.open-mpi.org/ and https://libevent.org/ |
| LLVM OpenMP | Transitive native dependency | Apache-2.0 with LLVM exception | https://llvm.org/ |

The VTK.wasm runtime is Kitware's unmodified prebuilt package `vtk-wasm32-emscripten` 9.7.20260927 from the VTK package registry (https://gitlab.kitware.com/vtk/vtk/-/packages), SHA-256 `63252b799e8c44dfb149f329c94f9f6715c78b654292f18cce067c9d080a2e92`. `scripts/fetch-vtk-wasm.mjs` downloads and verifies it; it is not committed to this repository.

The macOS solver is built by `scripts/build-solver.py` from the CalculiX 2.23 source archive (SHA-256 `9c88385c10fb04f5dc6c4e98027a51bebdd8aee3920e05190d6c1dd08357d6e7`) and SPOOLES 2.2 (SHA-256 `a84559a0e987a1e423055ef4fdf3035d55b65bbe4bf915efaa1a35bef7f8c5dd`). Its modifications are all in this repository: the SPOOLES patches in `native/calculix/spooles-patches`, a one-line CalculiX compile fix (also in Homebrew's `costerwi/homebrew-calculix` formula), and `native/calculix/accelerate_pardiso.c` with `native/calculix/mkl_service.h`, which answer CalculiX's PARDISO calls with Apple Accelerate (GPL-2.0-or-later, like CalculiX). It links Homebrew's ARPACK and GCC runtime libraries, whose install names are changed only to use adjacent bundled libraries. The Gmsh wheel includes its upstream CAD/mesher implementation unchanged. Windows and Linux builds bundle the unmodified conda-forge `calculix` 2.23 package, build 8 or later (https://github.com/conda-forge/calculix-feedstock), which links the same patched SPOOLES, and the conda-forge ARPACK, BLAS/LAPACK and GCC runtime libraries it links; on Linux only their library search path is changed, to the solver's own folder. Windows builds also include the MinGW-w64 winpthreads runtime (MIT-style license, https://www.mingw-w64.org/).

License texts in `licenses/` are included in packaged builds. Electron additionally includes Chromium's own third-party notices. Build scripts collect the installed native and JavaScript dependency notices. This repository currently produces a local developer build; a public binary release must also provide corresponding source for GPL/LGPL components and their build modifications, alongside the binary distribution. Upstream source URLs alone are not a replacement for that source distribution.
