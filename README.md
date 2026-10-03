# BetterSim

An open-source mechanical FEA workspace built around engineering intent. Import a STEP solid, choose its material, select the faces that hold it, apply loads, and inspect real CalculiX results.

**Version 0.1:** linear static analysis of one solid part. Electron + Vite + React, with VTK compiled to WebAssembly for the 3D view, OpenCASCADE/Gmsh for CAD and meshing and CalculiX for solving. GPL-3.0-or-later.

## Run on macOS

```sh
npm ci
npm run setup
brew install costerwi/calculix/calculix-ccx
npm run dev:desktop
```

`npm run setup` creates the Python engine environment and downloads the pinned VTK.wasm runtime (13 MB, checksum-verified) into `public/vtk-wasm/`. The 3D view needs WebGL 2.

For a browser development session, use `npm run dev` and visit http://127.0.0.1:5173. After `npm run build`, `npm start` opens the desktop application with its own local service. If CalculiX is installed elsewhere, set `BETTERSIM_CCX` to its executable. `BETTERSIM_PYTHON` overrides the development Python runtime.

## Build a standalone Mac app

```sh
.venv/bin/pip install pyinstaller
npm run package:mac
```

The Apple Silicon app is produced at `release/mac-arm64/BetterSim.app`. It bundles the Python/Gmsh engine, CalculiX, all required native libraries, the VTK.wasm runtime, and offline fonts. It needs neither Python nor Homebrew on the destination Mac. The build is ad-hoc signed for local testing, not Apple-notarized. Intel Mac packaging requires an Intel runtime and solver built on that architecture. `npm run dist:mac` also produces a DMG.

## A first study

1. Open the cantilever beam example, or import `.step`/`.stp` containing one solid.
2. Check the dimensions shown after import. Working units are **mm, N, MPa**; STEP length units are converted to mm by OpenCASCADE.
3. Choose a material. The built-in values are representative; enter the actual material specification when needed.
4. Add a support and select CAD faces in the model or face list. "Fixed" blocks all three translations. Directional supports expose individual global X/Y/Z directions.
5. Add force, pressure, or gravity. Vector force is **one total force distributed over all selected faces**. Positive pressure pushes inward; gravity uses m/s² and material density.
6. Start with the Medium mesh. Preview it or run directly; Solve meshes automatically. The direct solver (SPOOLES) is the default; for large meshes choose an iterative solver (incomplete Cholesky or diagonal scaling), which needs far less memory. Mesh size and element count are not limited by the app.
7. Inspect stress, movement, and yield margin. Click the part, or a section through it, to probe interpolated values, or show the peak node. Cut the part with a section plane, show an iso-surface, or threshold the critical region. Deformation magnification is displayed explicitly.
8. Compare with a finer mesh. Save a `.bsim` project, nodal CSV, viewport PNG, solver deck, or log.

Study edits invalidate results. Undo/redo preserves setup history. Autosave retains the most recent geometry and setup. A portable `.bsim` embeds both, plus the latest results, and can be opened on another machine. Saved results are shown only when the geometry and study match exactly, so stale plots are never presented as current.

## Numerical behavior

- Curvature-aware, ten-node quadratic tetrahedra (CalculiX C3D10).
- STEP CAD face IDs survive remeshing of the same source geometry. IDs are scoped to the STEP content hash; this release does not transfer selections to revised CAD geometry.
- Vector loads use consistent quadratic surface integration, not equal per-node force splitting.
- Normal pressures map CAD faces to CalculiX element faces; overlapping pressures and gravity loads add.
- A six-mode rigid-motion rank check rejects unstable support definitions. No automatic soft springs.
- Meshing, assembly, the direct solver and stress recovery use multiple threads (Auto: performance cores; 1 or All selectable in the Mesh panel). OpenMP stays single-threaded, because combined with CalculiX's own threads it produced nondeterministic stresses and reactions; with that pinned, repeated solves are bit-identical. Iterative solves are rejected if CalculiX stops short of its convergence tolerance.
- Mesh inversion checks, finite-value validation, cancellation, diagnostics, and retained solver artifacts.
- CalculiX RF output is corrected for applied nodal loads before reporting support reactions. Force balance is available in result interpretation.
- Stress contours use the solver's averaged nodal stress tensor, converted to von Mises stress.

This analysis assumes isotropic elastic material, slowly applied loads, and small deformation. Yield exceedance and large movement are highlighted. One finer-mesh comparison is evidence, not proof of convergence; sharp corners and support boundaries can produce stress singularities. Assemblies, shells, contact, thermal, modal, buckling, fatigue, nonlinear, and dynamic analyses are outside this first release.

## Tests

```sh
npm run test:engine  # real STEP → mesh → CalculiX; analytical and conservation checks
npm test            # local-service subsystem (save/open/solve/export, recovery, validation) and study-logic invariants
npm run test:e2e    # real browser interaction and solves
npm run test:all
npm run test:desktop # packaged .app, using only its bundled engine and solver
```

Browser tests use installed Chrome by default; set `BETTERSIM_CHROMIUM` to another Chromium executable. Screenshots and failure traces are written under `output/playwright/`. No mock solver substitutes for these acceptance tests.

## Complex STEP acceptance parts

The committed `samples/` corpus includes a filleted bearing block with counterbores, a gusseted bracket, a pocketed housing with crossing bores, and a toroidal tube elbow with annular collars. These were exported by CadQuery 2.7.0, independently of the Gmsh importer. Engine tests check imported CAD volume and dimensions, face identities, positive element quality, reaction equilibrium, doubled-load linearity, and global displacement refinement. Browser tests import and solve each through the complete study UI.

To regenerate these fixtures (optional; ordinary tests need no CadQuery installation):

```sh
python3 -m venv .cad-venv
.cad-venv/bin/pip install cadquery==2.7.0
.cad-venv/bin/python scripts/generate-complex-samples.py
```

See `docs/validation.md` for measured results and their limits. The generator credits the official [CadQuery quickstart](https://cadquery.readthedocs.io/en/stable/quickstart.html) for the bearing-block construction approach; the fixture dimensions and remaining constructions are specific to this project.

## Architecture

See [IMPLEMENTATION.md](IMPLEMENTATION.md) for the implemented architecture, numerical pipeline, API and persistence contracts, validation coverage, and proposed extension sequence.

- `src/`: study state, contextual editors, and the VTK.wasm view (`scene.ts`): face picking, contours, sections, probes, iso-surfaces and thresholds.
- `electron/`: sandboxed desktop shell and native save dialog.
- `server/`: loopback-only service, bounded file import, portable project handling, cancellable isolated jobs.
- `engine/worker.py`: STEP topology, meshing, support checks, CalculiX deck generation and result decoding.
- `scripts/bundle-runtime.py`: standalone engine and native library relocation.
- `docs/interaction-design.md`: pre-implementation workflow research and design decisions.
- `docs/vtk-wasm.md`: decisions behind the VTK.wasm viewer and result filters.
- `tests/`: subsystem and end-to-end acceptance tests.

The project remains solver-independent at the study model boundary. Future solver adapters can consume the same material/support/load definitions. Study types and assembly contact need explicit domain models before extending the UI.

See `THIRD_PARTY_NOTICES.md` for dependencies, licenses, and binary redistribution requirements.
