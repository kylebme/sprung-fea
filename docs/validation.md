# Validation — 0.1.0, 2 October 2026

## Verified scope

A single STEP solid, isotropic linear elastic material, fixed or global-direction supports, distributed vector forces, normal pressures, gravity, quadratic tetrahedral meshing, CalculiX static solution, nodal equivalent stress and displacement, and refinement comparison. macOS Apple Silicon standalone application. Windows, Linux, Intel Mac, and other analysis types are not validated in this release.

## Acceptance results

- **18 engine subsystem tests passed**, with actual Gmsh/CalculiX execution: STEP face identity across remeshing, length-unit conversion, axial extension, beam bending, reaction balance, pressure direction, gravity/density units, force conservation across multiple faces, rigid-motion rejection, stable directional supports, finite/material/face validation, refinement, a curved perforated bracket, loads on supported nodes, additive overlapping pressures, and identical-input repeatability. The repeatability scenario performs nine solves of the same mesh and compares all displacement and stress values.
- **Local-service subsystem passed**: STEP import, embedded STEP project save, project reopen with matching source hash, solve, solver input export, invalid project rejection, foreign-origin rejection.
- **Seven browser end-to-end scenarios passed**: full setup through refinement/export/save/reopen/resolve/physical-edit invalidation/undo; and malformed STEP handling. Four additional scenarios import the bearing block, ribbed bracket, pocketed housing, and tube elbow, select their CAD support/load surfaces, solve, probe, and refine. A curved-pressure scenario checks toroidal pressure reactions in the UI against the projected-area reference. The full workflow includes actual 3D ray picking for a nodal probe and actual CalculiX solves. Captured browser errors were empty.
- **Packaged Electron acceptance passed**: start the built `.app`, import the included STEP, apply the documented example setup, mesh and solve, inspect contours and peak node. Four more complete import/setup/solve/probe workflows exercise the complex fixtures in the packaged app. The app was launched with PATH limited to `/usr/bin:/bin`; the service explicitly selects the bundled native engine and solver. Captured renderer errors were empty.
- TypeScript compilation and Vite production build passed. The final installed dependency audit reported no known vulnerabilities.

## Analytical reference

For the 100 × 20 × 10 mm cantilever, E = 68,900 MPa, with a total 100 N downward force at its free end, Euler–Bernoulli bending predicts about 0.2903 mm displacement. The balanced quadratic solid mesh gives about 0.2881 mm, within 1%. This comparison permits the expected local clamp/Poisson effects of a three-dimensional solid model. Axial loading is checked against FL/(EA), within 1.5%. Gravity's reaction is checked against a 0.054 kg part at 9.81 m/s², giving 0.52974 N. These are subsystem references, not validation of every possible CAD geometry or support idealization.

## Complex CAD corpus

Four additional single solids are exported by **CadQuery 2.7.0 / OpenCASCADE 7.8.1**, then imported and meshed with **Gmsh 4.15.2** and solved by **CalculiX 2.23**. Import checks compare volume and bounding dimensions with the exporting CAD library. This exercises a separate STEP exporter, though both CAD libraries use OpenCASCADE. Geometry construction is reproducible with `scripts/generate-complex-samples.py`; the checked-in STEP files need no CadQuery installation to test.

Each force case verifies positive quadratic element quality, CAD face identity through remeshing, support reactions within 0.02 N of the specified total force, finite stresses, doubled-load displacement/stress proportionality, and finer-mesh displacement within 8%. The measured changes are much smaller:

| Part | Features | Faces | Coarse → fine elements | Coarse → fine movement (mm) | Movement change |
|---|---|---:|---:|---:|---:|
| bearing-block | Central bore, four counterbores, filleted corners | 23 | 15,993 → 22,493 | 0.000137902 → 0.00013784 | 0.0453% |
| ribbed-bracket | Two gussets, rounded base, six holes | 26 | 20,951 → 28,776 | 0.0092379 → 0.00927451 | 0.3962% |
| pocketed-housing | Deep rounded pocket, crossing bores, counterbores, thin walls | 35 | 43,772 → 55,641 | 0.000217769 → 0.000217789 | 0.0093% |
| tube-elbow | Toroidal walls, 90° bend, annular collars | 10 | 3,388 → 5,130 | 0.0349796 → 0.035051 | 0.2041% |

The lowest quality of the refined ribbed bracket is about 0.036; elements remain uninverted, but this is a reminder that small CAD intersections can produce slivers. Peak stress increased more than displacement (about 20% for the bracket), so these checks do **not** assert converged peak stress. Mesh counts can vary slightly between runs because Gmsh meshes with two threads; identical-input solver repeatability is checked on a fixed mesh. Detailed measurements are in `docs/complex-validation.json`.

Two further pressure references test curved loading:

- A 1 MPa pressure on the inner wall of the quarter-circle tube elbow (bore radius 7 mm) has X and Y resultants of πr² = 153.938 N. Calculated loads and reactions agree within 0.25 N. This checks curved face integration, inward pressure direction, and tetrahedron face mapping.
- A 2 MPa pressure around the bearing-block bore has a zero net resultant, yet a nonzero deformation. Applied load and support reaction resultants are within 0.02 N of zero. Force-balance error is normalized by the absolute equivalent nodal loading, so cancellation does not amplify rounding into a false diagnostic.

## Issues found and corrected

1. CalculiX fixed-width numerical input rejected an unformatted density exponent. Deck scalars now use bounded significant-digit formatting.
2. Quadratic force loading must integrate face shape functions; equal force per surface node would bias the response. Force distribution conserves its requested total over multiple selected faces.
3. CalculiX RF output contains both support reactions and applied nodal loads. Equivalent force/pressure/gravity contributions are removed when computing support reactions, including overlap at supported nodes.
4. This machine's multi-threaded SPOOLES factorization intermittently returned materially different responses for identical input. All solver, assembly, result, and BLAS stages are now pinned to one thread. Repeated identical-input solves pass, and the setting is carried into the bundled engine.
5. Narrow viewports originally cropped geometry; camera fitting now accounts for both viewport dimensions.
6. Zero-resultant bore pressure exposed an unsuitable force-balance denominator. The residual now uses the absolute equivalent nodal loading as its scale when loads cancel.
7. Project save was intercepted by a generic job route; the route now passes save requests through to serialization, with acceptance coverage.

## Limits of this evidence

No physical test coupon, independent commercial solver comparison, or representative customer STEP corpus has been evaluated. Peak stress at sharp corners or clamps may be singular. A single refinement comparison is not an automatic convergence guarantee. Plasticity, large deformation, contact, thin-shell behavior, and dynamic loading require other formulations. The desktop manual click-through could not run because the Mac was locked; automated browser and packaged desktop workflows did run successfully.

The app is a local developer build, ad-hoc signed and not Apple notarized. Corresponding-source and licensing requirements for public binary distribution are recorded in `THIRD_PARTY_NOTICES.md`.
