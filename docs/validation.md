# Validation — 0.2.2, 18 October 2026

This page records the evidence behind the current release: what the automated suites check, against which references, and what they do not establish. It replaces the 0.1.0 record of 2 October 2026, whose scope (one solid, linear static only) predates most of the analysis families below. Exclusions in that record no longer describe the application; [the capability audit](solidworks-fea-gap-audit.md) lists what is still missing.

## Verified scope

Every engine and browser test below runs real Gmsh meshing and CalculiX solves; none mock the solver.

| Area | What is checked |
|---|---|
| Linear static | STEP length units, face identity through remeshing, axial extension and cantilever bending against beam theory, reaction balance including loads on supported nodes, pressure direction and overlap, gravity/density units, force conservation over several faces, rigid-motion rejection, input validation, refinement stability, curved faces of a perforated bracket |
| Stress and strain measures | von Mises, principal and Tresca stress of known tensors; tension/compression sides of a bent beam |
| Supports | Frictionless planes allowing free contraction; a cylindrical support against the Lamé thick-tube solution (within 1%); separate axes per pinned hole |
| Loads | Remote force and its offset moment, pure moment, centrifugal rotation against ρω² theory, point-mass weight and rotation, bearing load on the loaded half of a bore |
| Assemblies | Bonded split beam against the solid beam, two materials as springs in series, shared-face drawing, per-group support checks, imprinted footprints, overlap rejection, **yield margin of each body against its own material** |
| Contact and bolts | Bolt cutting keeps face names, bolt preload carried through head/nut/interface, friction holding then sliding, invalid contact studies |
| Nonlinear static | Cantilever elastica against Bisshopp–Drucker (tip within 2–3%), small loads matching linear theory, follower pressure, suggestions to enable large deformation |
| Plasticity | Bar beyond yield: plastic strain, loaded stretch and permanent set; tabulated stress–strain points; elastic agreement below yield; loss of capacity beyond ultimate; required strength data |
| Natural frequencies | Cantilever bending against βL = 1.875 (within 1–3%), effective mass, axial preload shifting frequencies toward buckling, tip mass, six rigid modes of a free part, mesh convergence of the first frequency |
| Buckling | Fixed–free column against the Euler load (within 2–4%), overload and yield-before-buckling warnings, reversed-load factors in tension |
| Harmonic response | Static deflection well below resonance, resonance at the first natural frequency (within 0.2%), amplification near 1/(2ζ), damping control, base excitation relative to the base, too-few-modes warning |
| Thermal | Conduction against kAΔT/L, generation with a cooled end, convection and radiation heat balance, transient warming at P/(mc), temperature-dependent conductivity, modulus and expansion |
| Thermal stress | Free expansion without stress, blocked expansion at EαΔT, thermal plus mechanical loading |
| Convergence | Richardson extrapolation of a second-order sequence, cantilever convergence adopting the finest mesh, rising peak stress reported as a likely singularity |
| Region refinement | Cut-face agreement with the whole part, supports kept inside the region, traction kept on partly included faces, invalid regions rejected, **nonlinear whole-part solves refused** |
| Equation solvers | Threaded SPOOLES against one thread, every direct solver against SPOOLES for static and eigenvalue analyses, iterative CG and algebraic multigrid against the direct answer, fallbacks where a solver is unavailable or stalls, GPU against CPU where a GPU build works (the components a build lacks are skipped; see below) |
| Complex CAD corpus | Four CadQuery/OpenCASCADE parts: refinement, equilibrium, load linearity, and curved-pressure resultants (below) |

Browser scenarios drive the real interface through the same engine: setup, solve, contours, probing, filters and section forces, refinement, save and reopen with results, invalidation and undo, every analysis family above, unit conversion, body visibility, and the results workflow (per-body yield margin, color-scale limits and bands, saved probes and their CSV, persisted through a saved project).

## Acceptance results

Run on an Apple M3 under macOS 26.4.1, from the working tree of this release.

- **Engine subsystem suite (`npm run test:engine`): 105 tests, 95 passed, 8 skipped, 2 failed, in 221 s.** The skipped tests need solver components this local build lacks (hypre algebraic multigrid, the `sprung-solve` helper with PARDISO, a GPU build); multigrid, PARDISO and GPU agreement are therefore not evidenced by this run. Both failures reproduce on the unmodified 0.2.2 commit and are open:
  - *Repeat solves are reproducible* asserts identical stress to a relative 1e-10 over nine solves. One node of 3,378 differed by 2.3e-9 MPa (relative 1.4e-9); in isolation the test failed in two of three runs on the unmodified commit as well. Displacements matched. Threaded stress recovery evidently does not sum in a fixed order, so repeatability holds to round-off, not bit for bit.
  - *Iterative solvers match direct*: the incomplete-Cholesky solve differed from the direct solve by up to 0.000615 mm against a 0.000576 mm tolerance (2.5% of displacement values) in the full run, and passed in three isolated reruns.
- **Local-service and unit tests (`npm test`): 7 passed.**
- **Browser end-to-end suite (`npm run test:e2e`): 38 scenarios, 36 passed, 1 skipped (GPU), 1 failed.** The failure also reproduces on the unmodified commit: *iterative solver* expects the console to name the solver as the Mesh + Solver panel does ("CalculiX conjugate gradients with incomplete Cholesky"), but without hypre the console reports "incomplete Cholesky"; the solve itself completed and reported its iterations. Captured browser errors in the passing scenarios were empty. (The full run first failed one more scenario, where the probe card's new Save button shared the title bar's Save name; it was renamed Save probe and the two affected scenarios were rerun and passed.)
- TypeScript compilation passed.

Packaged-application acceptance (`npm run test:packaged`, `npm run test:desktop`) and Windows/Linux builds were not rerun for this record.

## Analytical reference

For the 100 × 20 × 10 mm cantilever, E = 68,900 MPa, with a total 100 N downward force at its free end, Euler–Bernoulli bending predicts about 0.2903 mm displacement. The medium quadratic solid mesh gives about 0.2881 mm, within 1%. This comparison permits the expected local clamp/Poisson effects of a three-dimensional solid model. Axial loading is checked against FL/(EA), within 1.5%. Gravity's reaction is checked against a 0.054 kg part at 9.81 m/s², giving 0.52974 N. The other closed-form references and their tolerances are listed in the scope table. These are subsystem references, not validation of every possible CAD geometry or support idealization.

## Complex CAD corpus

Four additional single solids are exported by **CadQuery 2.7.0 / OpenCASCADE 7.8.1**, then imported and meshed with **Gmsh 4.15.2** and solved by **CalculiX 2.23**. Import checks compare volume and bounding dimensions with the exporting CAD library. This exercises a separate STEP exporter, though both CAD libraries use OpenCASCADE. Geometry construction is reproducible with `scripts/generate-complex-samples.py`; the checked-in STEP files need no CadQuery installation to test.

Each force case verifies positive quadratic element quality, CAD face identity through remeshing, support reactions within 0.02 N of the specified total force, finite stresses, doubled-load displacement/stress proportionality, and finer-mesh displacement within 8%. The table records the measurements of the 0.1.0 run; the current suite re-asserts the same bounds but does not regenerate the table.

| Part | Features | Faces | Coarse → fine elements | Coarse → fine movement (mm) | Movement change |
|---|---|---:|---:|---:|---:|
| bearing-block | Central bore, four counterbores, filleted corners | 23 | 15,993 → 22,493 | 0.000137902 → 0.00013784 | 0.0453% |
| ribbed-bracket | Two gussets, rounded base, six holes | 26 | 20,951 → 28,776 | 0.0092379 → 0.00927451 | 0.3962% |
| pocketed-housing | Deep rounded pocket, crossing bores, counterbores, thin walls | 35 | 43,772 → 55,641 | 0.000217769 → 0.000217789 | 0.0093% |
| tube-elbow | Toroidal walls, 90° bend, annular collars | 10 | 3,388 → 5,130 | 0.0349796 → 0.035051 | 0.2041% |

The lowest quality of the refined ribbed bracket is about 0.036; elements remain uninverted, but small CAD intersections can produce slivers. Peak stress increased more than displacement (about 20% for the bracket), so these checks do **not** assert converged peak stress. Mesh counts can vary slightly between runs because Gmsh meshes with several threads; identical-input solver repeatability is checked on a fixed mesh. Detailed measurements are in `docs/complex-validation.json`.

Two further pressure references test curved loading:

- A 1 MPa pressure on the inner wall of the quarter-circle tube elbow (bore radius 7 mm) has X and Y resultants of πr² = 153.938 N. Calculated loads and reactions agree within 0.25 N. This checks curved face integration, inward pressure direction, and tetrahedron face mapping.
- A 2 MPa pressure around the bearing-block bore has a zero net resultant, yet a nonzero deformation. Applied load and support reaction resultants are within 0.02 N of zero. Force-balance error is normalized by the absolute equivalent nodal loading, so cancellation does not amplify rounding into a false diagnostic.

## Issues found and corrected

1. CalculiX fixed-width numerical input rejected an unformatted density exponent. Deck scalars now use bounded significant-digit formatting.
2. Quadratic force loading must integrate face shape functions; equal force per surface node would bias the response. Force distribution conserves its requested total over multiple selected faces.
3. CalculiX RF output contains both support reactions and applied nodal loads. Equivalent force/pressure/gravity contributions are removed when computing support reactions, including overlap at supported nodes.
4. Multi-threaded SPOOLES factorization intermittently returned materially different responses for identical input. SPOOLES 2.2 hands work between threads without memory ordering, which Apple silicon exposes. The bundled solver carries conda-forge's SPOOLES threading fixes, refuses to build without them, and uses the fastest available direct solver (Apple Accelerate on macOS); threaded solves match a single-threaded SPOOLES solve to round-off (`tests/test_solvers.py`).
5. Narrow viewports originally cropped geometry; camera fitting now accounts for both viewport dimensions.
6. Zero-resultant bore pressure exposed an unsuitable force-balance denominator. The residual now uses the absolute equivalent nodal loading as its scale when loads cancel.
7. Project save was intercepted by a generic job route; the route now passes save requests through to serialization, with acceptance coverage.
8. Yield margins of assemblies used the part material's yield strength for every body, so a weaker body could yield unreported. Margins, warnings and the plotted margin now use each body's own material; nodes where bodies meet take the weaker one (`tests/test_assembly.py`, `tests/results.spec.ts`).
9. Region refinement accepted a whole-part solve with plasticity or large deformation and re-solved the region as linear elastic from its displacements. Such solves are now refused, in the engine and in the interface.

## Limits of this evidence

No physical test coupon, independent commercial solver comparison, or representative customer STEP corpus has been evaluated. Peak stress at sharp corners or clamps may be singular; the convergence tool flags a likely singularity but does not remove it. Analytical references are simple prismatic or axisymmetric parts; agreement there does not establish accuracy for every geometry, support idealization, contact configuration or nonlinear path. Contact and bolt results are checked for equilibrium and preload transfer, not against measured joint stiffness. Shells, beams, fatigue, random vibration and transient structural dynamics are not implemented, so they are not validated.

macOS builds are ad-hoc signed and not Apple notarized. Corresponding-source and licensing requirements for public binary distribution are recorded in `THIRD_PARTY_NOTICES.md`.
