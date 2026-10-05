# Sprung FEA implementation

Version 0.1.0 · 2 October 2026 · implementation baseline: `738bb11`

This document describes the implemented application, its numerical and persistence contracts, and the work needed to extend it. Future work is identified separately from shipped behavior. Interaction research is recorded in [interaction-design.md](docs/interaction-design.md); measured acceptance results are recorded in [validation.md](docs/validation.md).

## 1. Scope and product decisions

Sprung FEA analyzes a STEP part or bonded assembly with CalculiX: linear static stress, natural frequencies, linear buckling, steady heat transfer, thermal stress, and harmonic response. The current packaged application targets macOS Apple Silicon. Electron, Vite, React, and VTK compiled to WebAssembly (VTK.wasm) provide the desktop shell and interface; Gmsh with OpenCASCADE imports CAD geometry and creates the volume mesh.

The application follows engineering intent: import a part, choose its material, define where it is held, apply loads, inspect the mesh, and examine results. A study tree with the part's face list on the left, the model view in the center, and an inspector on the right keep these dependencies visible. A collapsible console under the view holds job output and solver checks. Light and dark themes follow the system setting until the user picks one. Basic controls use physical descriptions; advanced controls expose material properties, global support directions, and mesh size.

Official SolidWorks documentation informed the workflow decisions before the interface was implemented. Sprung FEA uses an original layout, styling, assets, and integration code.

Implemented analysis inputs are:

- One solid imported from `.step` or `.stp`, with dimensions and CAD surfaces available for inspection.
- A homogeneous isotropic elastic material, including density and optional yield strength.
- Fixed supports, supports that block selected global X/Y/Z translations, frictionless supports that block only the face normal, and cylindrical supports that block radial, tangential or axial motion of holes and shafts.
- A total vector force distributed over selected faces, normal pressure, gravity, a remote force acting at a point off the faces, a moment, a bearing load on cylindrical faces, and rotation about an axis.
- Point masses: a rigid mass at a center of mass, carried by selected faces, standing in for components that are not modeled.
- Curvature-aware quadratic tetrahedral meshing, with detail presets and an explicit target size.

Results include von Mises stress, maximum and minimum principal stress, maximum shear stress (Tresca, (σ1 − σ3)/2), equivalent and principal strain, displacement magnitude, yield margin, support reactions, force balance, interpolated and nodal probes, section planes with the force and moment they carry, iso-surfaces, thresholds, and a finer-mesh comparison. All numerical results come from the actual solver pipeline.

## 2. Architecture and source ownership

```mermaid
flowchart LR
    Shell[Electron shell] --> UI[React renderer with VTK.wasm view]
    UI --> Service[Loopback Node service]
    Service --> Worker[Isolated Python or bundled worker]
    Worker --> CAD[OpenCASCADE and Gmsh]
    Worker --> Solver[CalculiX executable]
    Solver --> Worker
    Worker --> Service
    Service --> UI
```

| Location | Responsibility |
|---|---|
| [src/App.tsx](src/App.tsx) | Application state, job polling, autosave, project save/open, exports, and layout |
| [src/logic.ts](src/logic.ts) | Pure study logic: undo/redo history, draft previews, saved-result validation, yield-margin scale, and material edits |
| [src/Sidebar.tsx](src/Sidebar.tsx), [src/Inspector.tsx](src/Inspector.tsx), [src/Console.tsx](src/Console.tsx), [src/StartScreen.tsx](src/StartScreen.tsx) | Study tree and face list, per-section inspector panels, output/checks console and job progress, and start screen |
| [src/Viewer.tsx](src/Viewer.tsx), [src/scene.ts](src/scene.ts) | VTK.wasm view: CAD-face rendering, selection and hover, camera controls, condition annotations, mesh display, contours, deformation, picking, probes, sections, iso-surfaces, and thresholds |
| [src/viewData.ts](src/viewData.ts) | Decoding of the engine's binary view file, setup triangulation, derived fields, probes at nodes, and surface CSV |
| [src/types.ts](src/types.ts) | Renderer domain types, material presets, and initial study values |
| [src/api.ts](src/api.ts) | Local HTTP requests and browser/native file-save bridge |
| [electron/main.cjs](electron/main.cjs) | Window lifecycle, local service startup, packaged engine paths, application menus, and native save dialogs |
| [electron/preload.cjs](electron/preload.cjs) | Minimal bridge for platform information and file saving |
| [server/index.mjs](server/index.mjs) | File intake, document storage, worker execution, job lifecycle, project serialization, and artifact downloads |
| [server/validation.mjs](server/validation.mjs) | Incoming study schema and value validation |
| [engine/worker.py](engine/worker.py) | Worker entry point: the JSON protocol and command dispatch |
| [engine/cad.py](engine/cad.py) | STEP import, mesh generation, CAD face mappings, and the binary view file |
| [engine/model.py](engine/model.py) | Solver-independent physics: setup validation, rigid-motion check, and equivalent loads (forces, pressures, remote loads, moments, bearing loads, body loads) |
| [engine/calculix.py](engine/calculix.py) | CalculiX adapter: deck syntax, execution and thread control, log checks, and FRD decoding into frames |
| [engine/analyses.py](engine/analyses.py) | Analysis types: each validates a study, writes its solver step, and builds the common result schema |
| [scripts/bundle-runtime.py](scripts/bundle-runtime.py) | Frozen engine generation and relocation of native solver dependencies |
| [scripts/sign-mac.mjs](scripts/sign-mac.mjs) | Ad-hoc application signing and signature verification |

The study model avoids CalculiX deck syntax. The engine keeps three boundaries: `model.py` turns a study into solver-independent quantities (validated supports, equivalent nodal forces, element-face pressures, body accelerations); `calculix.py` is the only module that knows deck syntax, solver execution and output formats; and `analyses.py` registers analysis types, each with `validate`, `deck` and `results`. Adding a solver means another adapter with the same three duties; adding an analysis type means another registry entry.

## 3. Domain and units

| Object | Main fields and meaning |
|---|---|
| Geometry | STEP content hash, bounds, dimensions, volume, recommended element size, preview nodes, and CAD faces |
| Face | CAD entity ID, surface type, area, center, surface anchor, normal, and rendering triangle indices |
| Material | Name, elastic modulus, Poisson ratio, density, and optional yield strength |
| Support | Stable condition ID, name, selected face IDs, and three blocked/free translation flags |
| Point mass | Stable condition ID, name, selected face IDs, mass (kg), and center of mass (mm) |
| Load | Stable condition ID, name, kind, selected faces, vector components, and pressure magnitude |
| Study | Analysis type, material and per-body materials, supports, loads, point masses, thermal conditions, mesh size, detail preset, and equation solver |
| Mesh | Nodes, quadratic tetrahedra, CAD face-to-node/triangle mappings, element count, size, and minimum quality |
| Result | Schema version, analysis type, frames, nodal fields per frame, analysis summary, check rows, charts, warnings, and solver/mesh metadata |

Studies, results, the engine and the view file always use the SI working units. The interface shows either SI or US units, a per-computer preference switched from the status bar and kept in browser storage (`sprung-fea-units`). US units are inches, pounds-force, psi, lb/in³, lb, °F, in/s², lbf·in, Btu/(hr·ft·°F), µin/(in·°F), Btu/(hr·ft²·°F) and Btu/(hr·ft²); hertz, rpm, watts, percentages and ratios are shared. [src/units.ts](src/units.ts) maps each SI working unit to its US unit (temperatures with an offset). Number fields convert what they show and read back, keep the typed text while it is edited, and show converted values to six significant digits; engine check rows, key results and charts convert by their unit strings, and the surface CSV follows the chosen system, with the unit in each column name. In SI the interface uses **mm, N, and MPa**. Material density is entered in **kg/m³**, and gravity in **m/s²**. The solver deck uses the consistent **mm–N–tonne–s** system: density is multiplied by `1e-12`, and acceleration by `1000`.

Face selections reference CAD entities rather than rendering triangles or mesh nodes. Face IDs survive remeshing of the same STEP source. They are scoped to that source's SHA-256 hash; selection transfer to a revised CAD file is not implemented.

## 4. Analysis pipeline

### STEP import

The service stores the uploaded STEP in a document directory and launches an import worker. OpenCASCADE converts STEP length units to millimetres. The worker requires exactly one solid with positive volume, creates a triangulated surface preview for setup, and records dimensions, volume, face metadata, and the source hash. The preview uses its own sizing, independent of the analysis mesh: about 36 segments per full turn on curved faces, element sizes between 1/300 and 1/50 of the longest dimension, and coarser triangles on flat faces. The sample parts produce roughly 3,000–60,000 display triangles.

Surface annotations use anchors on the actual CAD surfaces, including curved faces. The initial mesh recommendation is the larger of the smallest part dimension divided by 2.5 and the largest dimension divided by 60. This is a starting heuristic, not a convergence criterion.

### Bonded assemblies

A STEP file with several solids is an assembly. OpenCASCADE `fragment` makes bodies that touch share their contact faces, so the mesh is continuous across them: they are bonded, with no sliding or separation. Bodies that only partly touch are bonded over the shared area (the footprint is imprinted on the larger face). Overlapping bodies are rejected. A single solid skips fragmenting, which keeps its face numbers. Bonded contact faces are inside the assembly: they are not listed or selectable. Each outer face records its body.

Geometry lists the bodies (name, volume) and the groups of bonded bodies. Each group must be held on its own: the rigid-motion check runs per group and names the bodies that can still move. A vibration study counts rigid motions over all groups. Bodies may have their own material (`bodyMaterials`, by body id); the others use the part material. The deck writes one element set, material and section per material group, and body loads and the mass check use each element's density. The suggested element size uses the thinnest body's smallest extent. Region refinement is not available for assemblies yet.

### Meshing

Gmsh imports the same STEP source, applies curvature-aware size controls, generates a tetrahedral volume mesh, raises it to second order, and optimizes the curved elements. The worker accepts ten-node tetrahedra and records quadratic surface triangles for load integration and selection mappings.

Minimum signed element quality must be positive. There is no limit on element count or element size; any positive size is meshed. Practical limits are memory and time: Gmsh and the worker hold the mesh in memory, the direct solver's factorization grows quickly with model size, and the viewer holds the volume mesh in a 32-bit WebAssembly heap (4 GB).

Coarse, Medium, and Fine use target-size multipliers of 1.5, 1, and 0.65 relative to the recommendation. An explicit size selects Custom. A solve generates its mesh automatically; mesh preview is a separate operation.

### Physical validation

Before writing the deck, the worker validates material values, load values, face references, support directions, and nonzero loading. It constructs the six rigid-body motion modes and checks the rank of the constrained degrees of freedom. An incomplete restraint produces an actionable error. The application does not add artificial springs to conceal instability.

### Deck and load construction

Gmsh connectivity is converted to CalculiX C3D10 ordering by exchanging the final two midside nodes. Deck numbers use bounded significant-digit formatting to avoid fixed-width input problems.

Vector force means **one total force across all selected faces**. Seven-point triangle quadrature integrates the quadratic face shape functions and distributes consistent nodal forces, normalized by the combined loaded area. Selecting another face does not multiply the specified total.

Pressure maps each CAD boundary triangle to the appropriate tetrahedron face and writes CalculiX pressure loads. Positive pressure acts into the solid. Overlapping pressure definitions add. Gravity definitions also add and use the material density.

Remote forces and moments are carried by the selected faces as a deformable connection, the distribution of an RBE3 element or distributing coupling, computed in the engine rather than with solver constraints. The force becomes a uniform traction acting at the faces' area centroid C; the moment (including the moment (P − C) × F of a force acting at a remote point P) becomes a traction **a** × (**x** − C) that varies linearly over the faces, with **a** = J⁻¹M and J = ∫(|r|²I − r rᵀ) dA. Integrating these tractions against the quadratic face shape functions gives nodal forces whose resultant force and moment are exactly the specified ones. Faces that cannot resist a moment (J singular) are rejected.

A bearing load presses on the half of the selected cylinder that faces the load. The pressure varies as the cosine of the angle between the surface normal and the load direction, and is scaled so its resultant along the load equals the force. The engine finds the cylinder axis from the surface normals, rejects non-cylindrical faces, and rejects forces with a component along the axis. A bore split into two CAD faces can be selected as one bearing.

A point mass is carried by its faces the same way as a remote force. In a static study it contributes its weight (mass × gravity) and its centrifugal force (mass × ω² × distance from the axis), each acting at its center of mass. Its own rotational inertia is not modeled. The Checks tab reports the mass of the meshed part plus point masses.

Rotation is a centrifugal body load, `*DLOAD CENTRIF` with ω² in rad²/s² about an axis through a point, entered in rpm. Only one rotation per study is allowed. Its equivalent nodal forces use the same four-point tetrahedron rule as CalculiX, so reaction recovery stays exact.

Equivalent applied nodal contributions are retained for force, pressure, and gravity. They are required when interpreting the solver's nodal force output at supported nodes.

### Plasticity

A static study with `plasticity: true` lets the material yield. The hardening curve is bilinear and isotropic (`*PLASTIC`): yield strength at zero plastic strain, rising in a straight line to the ultimate strength at the plastic part of the elongation at break (elongation − ultimate/E), and flat beyond. Materials need yield, ultimate strength (above yield) and elongation at break; the presets include typical values. Points from a tensile test (`hardening`: [total strain %, stress MPa], stress not falling and plastic strain rising) replace the straight line: each becomes a `*PLASTIC` point at plastic strain = strain − stress/E, flat beyond the last; the tear warning then uses the elongation at break if given, else the last point. The load is applied in automatic steps, as for large deformation, and the two combine. With `unload: true` a second step removes every load (`*CLOAD, OP=NEW` and `*DLOAD, OP=NEW`), so the last frame shows the permanent displacement and residual stress; the result opens at full load. Results add equivalent plastic strain (PEEQ, clamped at zero after nodal averaging), the largest plastic strain, and the permanent displacement. It warns when the part does not yield and when plastic strain exceeds the elongation at break. A load beyond the collapse load cannot be applied and reports so. Engine tests check a bar pulled to 1.05 × yield: plastic strain (σ − σy)/H, stretch, and permanent set match to the precision of the `.frd` file.

CalculiX's own messages are streamed through a pipe into `solver.log`: written straight to a file, its final buffered lines, including the error that stopped it, were lost on an error exit.

### Large deformation

A static study with `largeDeformation: true` runs `*STEP, NLGEOM` with automatic load steps (start at 10% of the load, at most 25% per step, at most 200 steps): stiffness follows the deformed shape, so thin strips, clips and springs that bend or twist far are not overpredicted. The material stays linear elastic. Every load step becomes a result frame, shown at full load and true scale by default; a load–displacement chart compares the peak displacement with the straight line through the first step, which is what linear theory would predict. Pressure follows the deformed surface and rotation the deformed shape, so with either of them the force balance check is left out. A linear static study whose movement exceeds 5% of the smallest part dimension suggests turning large deformation on. Steps that cannot converge report that the load could not be applied in small enough steps. Against the Bisshopp–Drucker elastica for a cantilever with PL²/EI = 1, the beam's tip moves within 1% of 0.3017 L down and 0.0566 L inward.

### Natural frequencies

A natural frequency study (`analysis: "frequency"`, `modes`: 1–50, default 6) runs `*FREQUENCY` with SPOOLES and ARPACK; the study's equation-solver choice applies to static studies only. Loads are optional. When the study has any, Solve asks whether to include them, and the answer travels with the solve request as `preload` rather than in the study. Included loads need supports that hold the part; a linear `*STATIC` step under them, with no output, precedes `*STEP, PERTURBATION` `*FREQUENCY`, so the modes include the stress stiffness they leave (tension and spin raise frequencies, compression lowers them; a negative eigenvalue means the loads exceed buckling and is reported). Spin softening and gyroscopic effects are not modeled. An engine test checks f² ≈ f₀²(1 − P/Pcr) for an axially loaded cantilever. Supports are optional: the engine counts the rigid motions the supports leave free (the same rank check as static validation) and, for a free or partly held part, requests that many extra modes with a negative shift, since the stiffness matrix is singular. Those first modes are labelled rigid motions at 0 Hz and excluded from key results.

Frequencies come from the `.dat` eigenvalue table; effective modal mass per direction is reported as a fraction of CalculiX's total effective mass, which counts only mass that can move (mass on supported nodes is left out). Each mode shape is scaled to a 1 mm peak displacement and its von Mises stress alike, so modal stress reads in MPa per mm of peak motion; yield margin is not offered. The key result for mesh convergence is the first elastic frequency.

Point masses add inertia through RBE3 constraints: a `MASS` element on an extra node at the center of mass, tied by three `*EQUATION`s to its faces' area-weighted mean translation plus their mean rotation times the offset. At most 60 face nodes take part, thinned by farthest-point sampling with weights gathered to the nearest kept node. CalculiX cannot place mass on an equation's dependent side in an eigenvalue analysis, so each equation eliminates the face-node direction with the largest coefficient that is neither supported nor already eliminated; a mass on fully supported faces is rejected.

The results panel lists modes with frequency and effective mass, and animates the selected mode shape.

### Buckling

A buckling study (`analysis: "buckling"`, `modes` default 3) runs `*BUCKLE` with the study's supports and loads as the reference load. Each factor multiplies all loads together; the first positive factor is the key result. The first `.frd` frame is the reference state, whose peak stress times the first factor is compared with the yield strength: above it, the part yields before it buckles. A first factor below 1 means buckling under the applied loads; negative factors mean buckling with the loads reversed, and a study with only negative factors has no key result. Shapes are scaled to a 1 mm peak and shown still. The panel reminds the user that imperfections and yielding make real buckling loads lower, and recommends a factor of at least 2 to 3.

### Heat transfer and thermal stress

Thermal studies use thermal conditions on faces: a fixed temperature (°C), a total heat flow into the faces (W, spread as a uniform flux over their area), convection (film coefficient in W/(m²·K) with an air or fluid temperature), and radiation (emissivity 0–1 with a surroundings temperature, `*RADIATE` with `*PHYSICAL CONSTANTS`, absolute zero −273.15 °C and σ = 5.670374e-11 N·mm/(s·mm²·K⁴)); heat generation (W) acts evenly through the whole part. A settled (steady) study needs at least one fixed temperature, convection or radiation, or no steady state exists. Where faces with different fixed temperatures meet, the later condition sets the shared edge. The material needs thermal conductivity (W/(m·K), unchanged in the mm–N–s deck), and thermal stress also needs expansion (µm/(m·°C), × 1e-6 in the deck). In deck units 1 W is 1000 N·mm/s, film coefficients are multiplied by 1e-3 and specific heat (J/(kg·K)) by 1e6. A material's temperature table (`byTemperature`) gives elastic modulus, conductivity and expansion at temperatures; a property with values at two or more temperatures is written as a CalculiX table in thermal studies, and every other analysis uses the constants.

With `transient: {on, duration, start}` temperatures are followed over time from a uniform start, every condition switched on at time zero; the material then needs specific heat. CalculiX's automatic incrementation fails on a sudden temperature at time zero, so the duration is split into three stages of fixed increments, finest at the start (to 1%, 10% and 100% of the duration with 25, 25 and 75 increments), and about 50 frames are stored. Results add a chart of the highest and lowest temperature (and, for thermal stress, peak stress) over time whose points pick the frame, open at the end, and warn when temperatures are still changing over the last tenth of the time. Heat balance is not checked over time, since stored heat makes in and out differ. Engine tests check an insulated part warming at P/(mc) and a bar's end against the series solution.

Heat transfer runs `*HEAT TRANSFER, STEADY STATE` with `*BOUNDARY` on degree of freedom 11, `*DFLUX` surface and body flux, and `*FILM`. Results are temperature and heat flux magnitude (W/m²). Thermal stress runs `*COUPLED TEMPERATURE-DISPLACEMENT, STEADY STATE` with the supports, any loads and point masses, `*EXPANSION, ZERO` at the stress-free temperature (default 20 °C), and initial temperatures at that value. Its results add temperature to the static fields and checks.

The heat balance check adds up heat flowing in and out: heat flows and generation, convection integrated from nodal temperatures with the quadratic face shape functions, and the heat supplied at fixed temperatures. CalculiX's `RFL` at those nodes, like force reactions, also contains the share of distributed heat landing on them, which is subtracted. A purely thermal stress study has no applied force, so its force balance compares the reactions with their own size. The `.frd` file stores five significant digits, which bounds the precision of every result read from it.

### Harmonic response

A harmonic response study (`analysis: "harmonic"`) finds how much the part vibrates under sinusoidal excitation across a frequency range (`harmonic.min`, `harmonic.max` in Hz). CalculiX first finds `modes` natural modes (default 20, `*FREQUENCY, STORAGE=YES`), then sums their responses (`*STEADY STATE DYNAMICS`) with the same modal damping ratio in every mode (`harmonic.damping`, default 2% of critical), at frequencies it places between the natural frequencies (3–12 per interval, fewer with many modes). Point masses add inertia as in vibration studies.

The excitation is either the study's loads, each the amplitude of a sinusoidal load, or base shaking: an acceleration in g along X, Y and Z at the supports. Base shaking is solved relative to the base, as the equivalent uniform inertial load −ρa (and −m·a on point masses). CalculiX's own `*BASE MOTION` was not used: its modal damping acts on absolute motion, which corrupted the response well below resonance (the beam's relative tip motion at 20 Hz came out nearly twice the static value).

Results at each frequency are complex. The displacement amplitude is √(|uₓ|² + |u_y|² + |u_z|²) at each node; stress amplitude is the largest von Mises stress over twelve phases of a cycle; the displayed shape is the instant when the most-moving node peaks. Response charts (log scale) plot peak displacement and stress amplitude against frequency; clicking them shows the nearest stored frequency. At most 40 frequencies keep nodal fields: every local maximum, the ends, then evenly spaced points. The study opens at the largest response. It warns when the highest mode found is below 1.5 × the top of the range, and when stress at resonance exceeds yield. Key results are the peak displacement and stress amplitudes.

### Solve and result decoding

CalculiX runs as a native subprocess with no time limit; long jobs can be cancelled. Its output streams to `solver.log` rather than memory, because iterative solves log every iteration.

The study chooses the linear equation solver, written to the deck as `*STATIC, SOLVER=…`:

| Study value | CalculiX solver | Use |
|---|---|---|
| `spooles` (default) | `SPOOLES` | Direct sparse factorization. Most robust, equilibrium to round-off; memory grows quickly with model size |
| `iterative-cholesky` | `ITERATIVE CHOLESKY` | Conjugate gradients with incomplete-Cholesky preconditioning. Much less memory |
| `iterative-scaling` | `ITERATIVE SCALING` | Conjugate gradients with diagonal scaling. Least memory; most iterations |

PARDISO and PaStiX are not offered: the bundled CalculiX build does not link them. CalculiX returns the last conjugate-gradient iterate without an error when it stops short of its tolerance, so the worker reads the final residual and limit from the log and rejects an unconverged solve. Iterative results match the direct solver within about 10⁻⁴ of peak displacement with diagonal scaling, and within 10⁻³ with incomplete Cholesky (which on some meshes stops about 10% earlier), and 0.1% of peak stress on the test beam, and equilibrium closes to about 0.1% (with incomplete Cholesky, which uses a looser CalculiX tolerance and sometimes stops early, up to about 1%; a result above 0.5% warns and suggests the direct solver). The result records the solver and iteration count, shown in the console's Checks tab. Studies saved before solver choice use SPOOLES. Threads are a per-machine preference, not part of the study, because they do not change results: **Auto** (default) uses the performance cores (all logical cores where the platform does not distinguish them), **1** uses a single thread, and **All** uses every logical core. The renderer stores the choice locally and sends it with each mesh or solve request (`?threads=N`, validated against the core count reported by `GET /api/health`). The worker applies it to Gmsh meshing and to CalculiX stiffness assembly, SPOOLES factorization and stress recovery (`CCX_NPROC_STIFFNESS`, `CCX_NPROC_EQUATION_SOLVER`, `CCX_NPROC_RESULTS`). OpenMP stays at one thread (`OMP_NUM_THREADS=1`, `NUMBER_OF_CPUS=1`): in repeated identical solves, CalculiX's own thread controls at up to 8 threads gave bit-identical displacement, stress and nodal forces, but OpenMP above one thread combined with any of them made stress and reactions vary between runs, once reporting an 866 N reaction for a 1000 N load. Earlier versions pinned every stage to one thread because of that interaction. CalculiX's iterative solvers iterate on one thread regardless. Gmsh meshes can differ slightly between runs with more than one thread; with one thread they are repeatable. The result records the thread count, shown in the Checks tab.

The worker retains the input deck, mesh, FRD output, DAT output, and solver log. The FRD reader returns every result frame (consecutive blocks with the same step number and value: one load step, mode, increment, or frequency) and rejects incomplete fields.

Stress measures come from CalculiX's averaged nodal stress tensor: von Mises, the eigenvalues of the tensor (largest and smallest principal stress) and half their difference (Tresca maximum shear). Strain measures come from its total strain tensor (`*EL FILE` `E`, shear stored as tensor components): the largest and smallest principal strain and the von Mises equivalent strain √(2/3 e:e) of the deviatoric part, all in µm/m. In thermal stress studies this is total strain, including free thermal expansion. The minimum principal stress and strain are critical at their lowest (most compressive) value, so their peak, threshold and legend work from below, as the yield margin does. Natural frequency results keep von Mises modal stress only.

Every analysis produces the same result schema (version 2):

| Field | Meaning |
|---|---|
| `analysis` | Analysis type of the study that produced it |
| `frames` | One entry per frame: label, value and unit (for example a mode's frequency in Hz) |
| `fields` | Nodal arrays stored for each frame in `view.bin` (`displacement`, `vonMises`, …); frame *k* > 0 stores `name@k` |
| `summary` | Analysis-specific numbers; always includes `seconds` |
| `checks` | Rows for the console's Checks tab: label, values, unit |
| `charts` | X–Y series for plots, such as a response curve |
| `warnings` | Plain-language limits of the result |

Results saved before schema 2 are read as one linear static frame, with checks rebuilt from the summary. Equivalent stress is calculated from the averaged nodal stress tensor; movement is the displacement-vector magnitude.

Support reactions subtract equivalent applied loads from the constrained components of CalculiX RF output. The force-balance residual is divided by the larger of the applied resultant magnitude and the sum of equivalent nodal load magnitudes, with a small numerical floor. This handles pressure cases whose resultant cancels around a bore.

## 5. Interface state and result validity

Condition editors use drafts: selecting faces and changing values does not modify the study until Save. Cancel (or Escape) discards the draft. While a draft is open the view shows the part rather than any result, so faces can be picked; saving changes the study and invalidates the result, while cancelling shows the result again. Editors that take a position (remote force, rotation, point mass, refinement region) show the part's origin with X, Y and Z arrows over the model. Every X/Y/Z input and button uses the arrows' colors: red X, green Y, blue Z. Saved conditions can be named, edited, and removed. The face list exposes surface type, area, and position and highlights the corresponding model surface.

Physical study edits invalidate results. Mesh-size edits invalidate both mesh and results. Camera movement, plot choice, node probing, and deformation display do not change the physical setup. Undo/redo stores up to 30 study edits; undoing a physical edit does not silently resurrect a previously computed result, and keeps the mesh when the element size is unchanged. In the desktop app, Edit > Undo and Redo apply to the focused text field, or otherwise to the study history. Jobs don't block the window: the view stays usable and the inspector is inert until the job finishes or is cancelled.

The viewer provides stress, movement, and yield-margin plots; original, true-scale, and magnified shape display; and an explicit deformation multiplier. Left-drag rotates freely (trackball, no fixed up axis), right-drag pans, and scroll zooms. Perspective is the default; an orthographic projection can be chosen in the view toolbar and is remembered. Resizing the view keeps the camera. Clicking the model, a section, an iso-surface or a threshold boundary probes there: stress and displacement are interpolated inside the containing quadratic tetrahedron, and the undeformed position is reported. Show in view probes the extreme node for the active plot exactly. The probed value is labelled in the view.

Result filters act on the volume. A section plane normal to X, Y or Z clips the part and shows the cut colored by the plotted quantity, with its area. For static and thermal stress results it also shows the normal and shear force, bending moment and torque carried through the cut, about its center: the sum of the nodal forces (CalculiX `RF`, stored as the `force` vector of each frame) on the cut-away side, which at equilibrium are its loads and reactions. An iso-surface shows where the plotted quantity equals a level. A threshold shows the critical region: stress or displacement above a level, or yield margin below it. Filters act on the displayed (deformed) shape and combine with the section. Their design is recorded in [vtk-wasm.md](docs/vtk-wasm.md). Force balance, reactions, and solver details are in the console's Checks tab. The yield-margin scale runs from 0 to 5 when the part yields and widens (to 10, 20, 50, …) for safer parts, so variation stays visible.

A mesh convergence study solves on successively finer meshes, each with 0.75 times the element size of the previous one, starting from the study's size. After each mesh it compares the result's key results (for static studies, maximum displacement and peak stress) with the previous mesh, and stops when every one changed by less than the tolerance (1, 2 or 5%; default 2%) or after the chosen number of meshes (3 to 5; the service accepts 2 to 6). The report lists every mesh, a verdict per quantity, and a chart of each quantity against element count. With three or more meshes whose changes shrink monotonically, it adds a Richardson extrapolation of the limit and the observed order of convergence. A peak that keeps rising by similar or growing steps is reported as a likely singularity: sharp inside corners and support edges have no finite stress in the ideal model, so refinement cannot settle it. The study adopts the finest mesh's size; undo returns to the starting size. Element counts do not always scale with size, because curvature-based sizing keeps curved faces fine at every size.

A single refinement (0.7 times the current size) remains available as a quick comparison of the key results.

Refine a region (submodeling) re-solves a box of a solved static study on a finer mesh. The worker intersects the STEP solid with the box in OpenCASCADE and meshes the result. Each region face is classified by its mesh: a face lying on a box plane is a cut face, unless the part has a coplanar face there; other faces take the ID of the nearest whole-part boundary face. Supports and pressures carry over to the region faces that lie on their original faces; a total force keeps its traction, so the region carries its area share; gravity and rotation apply unchanged. Remote forces, moments, bearing loads and point masses whose faces enter the region are rejected, because their distribution depends on all of their faces. Cut-face nodes get the whole-part displacements through CalculiX `*SUBMODEL, TYPE=NODE` and `*BOUNDARY, SUBMODEL`, interpolated from the whole-part `.frd`. The result compares the whole-part peak stress inside the box with the refined peak, and checks Saint-Venant agreement: the 95th percentile of the difference between refined cut-face stress and the whole-part stress interpolated there (quadratic shape functions of the containing element), as a share of the peak. Above 10%, the cut faces are too close to the hot spot and the region should be larger. The region's files live in the document's `region/` folder and can be exported. Region results are not saved in projects.

Exports available in the interface are portable projects, surface-node CSV, viewport PNG, solver input, FRD results, and solver log. The service also exposes the raw mesh and the binary view file.

## 6. Service and worker protocol

The service binds to `127.0.0.1`: port 4318 during normal browser development and an allocated port inside the desktop application. Workers receive a command and document directory as arguments, and study JSON on stdin. Stdout contains the final JSON response (mesh metadata and the result summary); stderr carries progress messages and diagnostics. Mesh and nodal arrays go to `view.bin` in the document directory instead of stdout.

| Endpoint | Behavior |
|---|---|
| `GET /api/health` | Report service status, platform, and engine availability |
| `POST /api/import` | Accept multipart STEP data and return document/job IDs |
| `POST /api/sample/:name` | Import the included beam or perforated bracket example |
| `GET /api/jobs/:id` | Poll job status, stage, message, result, or error |
| `DELETE /api/jobs/:id` | Cancel a running job |
| `POST /api/documents/:id/mesh` | Generate a mesh for the submitted study |
| `POST /api/documents/:id/solve` | Mesh and solve the submitted study with its analysis type |
| `POST /api/documents/:id/submodel` | Re-solve a box `{study, region: {center, size, meshSize}}` of the solved study on a finer mesh |
| `POST /api/documents/:id/converge?runs=N&tolerance=T` | Mesh convergence study: solve on up to N finer meshes until key results change by less than T |
| `GET /api/documents/:id/view` | Binary mesh and nodal results for the viewer (`view.bin`, layout in [vtk-wasm.md](docs/vtk-wasm.md)); `?region=1` serves the refined region |
| `POST /api/documents/:id/save` | Serialize the embedded STEP and study |
| `POST /api/open` | Validate and import a portable project |
| `GET`/`POST /api/recovery` | Read or update the autosaved study |
| `POST /api/recovery/open` | Import the autosaved study as a new document |
| `GET /api/documents/:id/export/:file` | Download an allowed analysis artifact |

One mesh/solve job may run per document. On macOS, cancellation and service shutdown terminate worker process groups, including solver children. The renderer tracks operation sequences so an old job's completion cannot clear the busy state of a newer operation. Completed in-memory job records expire after one hour. Document directories are pruned at startup and hourly: the 40 most recently used are kept unless older than seven days, and documents used in the last hour or with a running job are never removed. Errors map to 400 (invalid request), 404 (missing document or artifact), 413 (too large), or 500 (logged, with a generic message).

The service limits STEP uploads to 50 MB, JSON request bodies to 70 MB (enough for a 50 MB STEP encoded in a project), and does not cap worker output; nodal arrays travel in `view.bin`, not on stdout. Electron disables renderer Node integration, enables context isolation and sandboxing, denies permission requests and new windows, and restricts navigation to the application origin. The service validates local hosts and request origins and rejects cross-site requests. Its Content Security Policy allows `'wasm-unsafe-eval'` and `'unsafe-eval'` for scripts because VTK.wasm's Emscripten glue generates functions at runtime; this is a deliberate relaxation, explained in [vtk-wasm.md](docs/vtk-wasm.md). These protections do not constitute a completed independent security audit.

## 7. Persistence and recovery

A `.sfea` file is JSON with `format: "sprung-fea"`, `version: 1`, a display name, base64 STEP bytes, and the study definition. Opening checks the format/version, study schema, STEP header, and file-size limit, then reimports the embedded geometry.

Saving after a solve also embeds the binary view file (volume mesh and nodal results, base64) and the result summary with the geometry hash and study they belong to. Opening shows them again only when both match exactly; otherwise they are skipped. Solver artifacts are not embedded, so their exports need a new solve.

Autosave keeps one recovery copy, STEP and study, in the service's `recovery/` directory, outside pruning (`GET`/`POST /api/recovery`, `POST /api/recovery/open`). It is a convenience, not a substitute for saving a portable project.

Development document data lives in `.sprung-fea/`. Packaged desktop document data lives under Electron's user-data directory in `studies/`. Native analysis artifacts remain available there for diagnosis.

## 8. Build and distribution

### Running from source on macOS

```sh
npm ci
npm run setup
brew install costerwi/calculix/calculix-ccx
npm run dev:desktop
```

`npm run setup` creates the Python engine environment (`.venv`) and downloads the pinned VTK.wasm runtime (13 MB, checksum-verified) into `public/vtk-wasm/`. The 3D view needs WebGL 2.

For a browser development session, use `npm run dev` and visit http://127.0.0.1:5173. After `npm run build`, `npm start` opens the desktop application with its own local service. `SPRUNG_FEA_PYTHON` overrides the development worker interpreter, and `SPRUNG_FEA_CCX` selects a solver executable when CalculiX is installed elsewhere. `SPRUNG_FEA_CHROMIUM` overrides the browser executable used by end-to-end tests.

### Standalone Mac app

```sh
.venv/bin/pip install pyinstaller
npm run package:mac
```

The Mac build freezes Python, Gmsh, and NumPy into a standalone worker. The bundler copies CalculiX and its non-system dynamic dependencies, rewrites library references to adjacent bundled files, and signs the relocated binaries. Electron Builder packages the renderer (including the VTK.wasm runtime, about 87 MB), service, engine, sample STEP files, offline fonts, and license notices. A final script ad-hoc signs and verifies the application.

Output is `release/mac-arm64/Sprung FEA.app`. The tested app needs neither Python nor Homebrew on the destination PATH. `npm run dist:mac` additionally produces a DMG. The build is ad-hoc signed for local testing, not Apple-notarized. Intel Mac packaging requires an Intel runtime and solver built on that architecture.

### Windows and Linux

```sh
.venv/bin/pip install pyinstaller   # .venv\Scripts\pip on Windows
npm run package:win                 # or: npm run package:linux
npm run test:packaged               # solves with only the packaged engine and solver
```

These bundle the CalculiX found by `SPRUNG_FEA_CCX` (or on `PATH`) together with its shared libraries; CI uses conda-forge `calculix=2.23` (`micromamba create -n calculix calculix=2.23`). Linux packaging needs `patchelf`. Windows produces `release/Sprung-FEA-Setup-<version>.exe`, a one-click installer that installs for the current user without administrator rights. Linux produces `release/Sprung-FEA-<version>-x86_64.AppImage`, which runs without installation. Builds are unsigned.

### Continuous integration

[.github/workflows/build.yml](.github/workflows/build.yml) builds the macOS DMG, Windows installer and Linux AppImage on every push and pull request, runs a static and a frequency solve with each packaged engine, and uploads the installers as workflow artifacts. The README's download instructions point users to these artifacts until tagged releases exist.

### README media

The GIFs and video in `docs/media/` are recorded from the running app, not mocked. With `npm run dev` running:

```sh
node scripts/record-demo.mjs        # drives the app headless, frames to output/demo/
.venv/bin/python scripts/demo-media.py   # cuts docs/media/*.gif and demo.mp4 (needs ffmpeg)
```

Controls are found by role and label, and CAD faces by number: before recording, the recorder sweeps the cursor over the mounting bracket in its opening view and reads which face the status bar reports at each point. Each GIF runs between the start and end marks of its clip; steps between clips appear only in the MP4.

Sprung FEA is GPL-3.0-or-later. Dependency notices and public binary corresponding-source requirements are recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## 9. Acceptance evidence

After the VTK.wasm viewer rewrite (3 October 2026), 19 engine subsystem tests, the local-service and study-logic tests, ten browser scenarios, and a packaged Electron workflow covering the beam and four complex parts passed. These tests exercise real Gmsh and CalculiX execution.

| Test source | Coverage |
|---|---|
| [tests/test_engine.py](tests/test_engine.py) | Analytical bending/extension, units, face identity, supports, forces, pressures, gravity, invalid input, refinement, nine repeated fixed-mesh solves, and the viewer file's VTK tetrahedron order |
| [tests/test_complex_parts.py](tests/test_complex_parts.py) | Independent STEP exporter checks, curved geometry, quadratic mesh quality, equilibrium, load scaling, refinement, and curved pressure references |
| [tests/server.test.mjs](tests/server.test.mjs) | Import, portable save/open, solve, binary view decoded by the client decoder, exports, request/project validation, recovery, error statuses, size limits, and pruning |
| [tests/logic.test.ts](tests/logic.test.ts) | Undo history invariants and the guard against showing saved results for a different study |
| [tests/e2e.spec.ts](tests/e2e.spec.ts) | Full study setup, probing, section area and section probing, iso-surface, threshold, refinement, project reopening with results, invalidation, undo, malformed import, complex parts, and toroidal pressure reactions |
| [tests/desktop.mjs](tests/desktop.mjs) | Packaged app with restricted PATH, bundled engine/solver, VTK.wasm under the service CSP, complex imports, solves, contours, sections, and peak probes |

The complex fixtures are a bearing block with fillets and counterbores, a gusseted bracket, a pocketed housing with intersecting bores, and a toroidal elbow with end collars. They contain 10–35 CAD faces. Recorded refined meshes contain up to about 56,000 quadratic elements, with maximum movement changes below 0.5% for these setups. Peak stress on the bracket changes by about 20%, so peak stress convergence is not claimed.

CadQuery generates these fixtures through a separate STEP exporter, although both exporters/importers use OpenCASCADE. Committed STEP files allow normal tests to run without installing CadQuery. Exact measurements and numerical tolerances are in [validation.md](docs/validation.md) and [complex-validation.json](docs/complex-validation.json).

```sh
npm run test:engine  # real STEP → mesh → CalculiX; analytical and conservation checks
npm test             # local-service subsystem and study-logic invariants
npm run test:e2e     # real browser interaction and solves
npm run test:all
npm run test:desktop # packaged .app, using only its bundled engine and solver
```

Browser tests use installed Chrome by default; set `SPRUNG_FEA_CHROMIUM` to another Chromium executable. Screenshots and failure traces are written under `output/playwright/`. No mock solver substitutes for these acceptance tests.

To regenerate the fixtures (optional; ordinary tests need no CadQuery installation):

```sh
.venv/bin/python scripts/generate-assembly-samples.py  # assembly fixtures (Gmsh)
python3 -m venv .cad-venv
.cad-venv/bin/pip install cadquery==2.7.0
.cad-venv/bin/python scripts/generate-complex-samples.py
```

The generator credits the official [CadQuery quickstart](https://cadquery.readthedocs.io/en/stable/quickstart.html) for the bearing-block construction approach; the fixture dimensions and remaining constructions are specific to this project.

The evidence does not yet include physical correlation, an independent commercial solver comparison, or a representative customer CAD corpus. Automated browser and packaged desktop checks passed; a separate manual native click-through was unavailable because the Mac was locked.

## 10. Remaining implementation work

The following is a proposed extension sequence, not functionality shipped in 0.1:

1. **Strengthen the single-part release.** Expand external CAD fixtures and numerical references; add resource budgeting before meshing, richer mesh-quality guidance, and independent solver/physical comparisons. Complete signing/notarization and public binary source distribution. Add platform-specific packaging and acceptance runs for Intel Mac, Windows, and Linux.
2. **Separate application and solver boundaries.** Introduce explicit job/result schemas, project migrations, and a solver adapter contract around validation, deck generation, execution, and decoding. Preserve the current end-to-end tests through the refactor.
3. **Introduce assemblies deliberately.** Model bodies, instances, transforms, materials per body, and selections scoped by body identity. Define bonded/contact interactions and connectivity checks before exposing assembly controls. Add fixtures for disconnected bodies and invalid interactions.
4. **Add analysis-specific models.** Thermal requires temperatures, heat inputs, and thermal materials; frequency requires eigenmodes and modal result display; buckling requires a reference load state and eigenvalue interpretation. Nonlinear and dynamic analysis require increments/time histories, solver controls, and result sequences. Fatigue requires an explicit method and validated material/load-cycle data.
5. **Handle CAD revisions.** Introduce topology matching with confidence and unresolved-selection review. Never reuse a face number from changed geometry without verifying its meaning.

Extensions should retain the product contract: understandable physical inputs, explicit assumptions and units, inspectable native solver artifacts, honest result validity, and subsystem/end-to-end acceptance evidence.
