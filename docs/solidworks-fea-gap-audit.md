# Sprung FEA versus SOLIDWORKS Simulation

Assessment date: 5 October 2026. Evaluated the current working tree, including uncommitted contact/bolt changes, on top of `49cd375`. This is a product capability assessment, not a certification, benchmark against a running SOLIDWORKS installation, or estimate of engineering work remaining.

## Completion estimate

| Comparison scope | Estimated coverage | Interpretation |
|---|---:|---|
| SOLIDWORKS Simulation Standard | **50–60%, midpoint 55%** | Substantial static capability; missing fatigue, motion, many connectors, and study-management depth. Features from higher tiers do not replace these gaps. |
| SOLIDWORKS Simulation Professional | **45–55%, midpoint 50%** | Modal, buckling, thermal and limited submodeling are present; optimization, topology, drop testing, pressure-vessel workflows and assembly breadth are missing. |
| SOLIDWORKS Simulation Premium | **35–45%, midpoint 40%** | Nonlinear static and harmonic response provide some advanced coverage; broader dynamic analyses, nonlinear materials and composites are missing. |
| Everyday homogeneous solid-part static workflow | **75–85%, midpoint 80%** | Import, supports, common loads, solve, inspect, refine and save are well covered. This intentionally excludes shells, beams, complex joints and the other missing study families. |

The reference is **desktop SOLIDWORKS Simulation**, including its CAD integration. This does not include the entire SOLIDWORKS CAD feature set, Flow Simulation, Plastics, or the wider Abaqus-based SIMULIA portfolio. SOLIDWORKS differentiates Standard, Professional and Premium by supported study families; see the [official product overview](https://www.solidworks.com/product/solidworks-simulation) and [2026 desktop feature matrix](https://www.solidworks.com/sites/default/filesd10/26docs06/solidworks-simulation-feature-matrix.pdf).

These percentages are judgment-based ranges. They measure usable breadth and depth, rather than counting menu entries or solver keywords. A narrow implementation gets partial credit, and capabilities of CalculiX or Gmsh that the application does not expose get no credit. They do not mean that 40% of development effort is complete or that numerical accuracy is 40% of SOLIDWORKS.

An illustrative weighting behind the Premium estimate is:

| Area | Weight | Current coverage within area | Weighted contribution |
|---|---:|---:|---:|
| CAD association and model preparation | 10 | 30% | 3.00 |
| Element formulations and meshing | 15 | 40% | 6.00 |
| Material models | 10 | 35% | 3.50 |
| Loads and constraints | 10 | 70% | 7.00 |
| Assembly contact and connectors | 15 | 35% | 5.25 |
| Analysis families and controls | 20 | 40% | 8.00 |
| Results and engineering diagnostics | 10 | 60% | 6.00 |
| Study management, automation and communication | 10 | 20% | 2.00 |
| **Total** | **100** | | **40.75 / 100** |

The category scores are expert estimates, not independently measured constants. Different customer workloads would justify different weights. Standard and Professional ranges are separate estimates for their narrower scopes; the application’s higher-tier capabilities are listed separately below.

## Working capability inventory

| Area | Implemented behavior | Scope limits |
|---|---|---|
| Static | Linear elasticity; large deformation; isotropic plasticity from bilinear or tabulated hardening; loading/unloading frames and permanent set | Limited material families and fixed load-control procedure |
| Modal | Free and restrained modes, rigid-motion identification, stress stiffening from optional mechanical preload, effective mass, animation, point masses | 1–50 modes; no transfer of a solved nonlinear contact/bolt state |
| Buckling | Linear eigenvalue factors and shapes; overload and yield-before-buckling warnings | No dedicated imperfection/postbuckling workflow |
| Thermal | Steady and transient conduction, fixed temperature, total heat input, global heat generation, convection, radiation to ambient, heat-flux magnitude | Uniform initial temperature; conditions switch on at time zero; no thermal interface resistance |
| Thermal stress | Coupled temperature/displacement solve, thermal expansion with stress-free temperature, mechanical loading, time frames | Linear elastic mechanical response; no full contact/plastic/large-deformation coupling |
| Harmonic | Modal response to sinusoidal loads or equivalent base acceleration; damping ratio; stress/displacement amplitude curves | Uniform modal damping, fixed sampling strategy, at most 40 frequencies with stored nodal fields |
| Assembly | Multiple STEP solids, bonded shared interfaces, material per body, per-connected-group restraint checks | Flattened body representation, no full assembly hierarchy or revision association |
| Contact and bolts | Initially touching interfaces can separate/slide, frictional or frictionless penalty contact, solid-bolt pretension, torque-to-preload helper, bolt-force charts and contact-force/state/pressure results | Static only; contact settings grouped by body pair; solid bolt geometry required |
| Supports and loads | Fixed, directional, normal/frictionless and cylindrical supports; force, pressure, gravity, remote force, moment, bearing load, centrifugal rotation; point mass | Face selection; limited reference frames and distribution options |
| Mesh | Curvature-aware quadratic tetrahedra, size presets/custom size, preview, minimum signed quality, direct/iterative static solver choice, thread controls | One solid formulation and one exposed mesh-sizing workflow |
| Convergence | Repeated global refinement with tolerance, charts, conditional Richardson estimate and likely-singularity detection | Global size reduction rather than local error-driven adaptation |
| Submodel | Finer boxed single-part region driven by parent displacement; stress and cut-boundary comparison | Linear local formulation; restrictions on split remote/bearing/moment loads and point masses |
| Results | von Mises, largest/smallest principal stress, maximum shear, equivalent/principal strain, displacement, yield margin, plastic strain, temperatures, flux, contact pressure | Averaged nodal fields; narrower result selection than SOLIDWORKS |
| Viewer | Probe interpolated or extreme-node values, axis-aligned section with forces/moments, iso-surface, threshold, deformation and animation, mesh edges, standard views, perspective/orthographic | No arbitrary section orientation, persistent probe sets or editable contour scale |
| Usability | SI/US conversion, draft editors, face search, naming/edit/delete, undo/redo, shortcuts, cancellation, themes, autosave recovery, embedded-geometry projects, saved results | One active study, one recovery copy; incomplete result presentation/artifact persistence |
| Export | Surface CSV, viewport PNG, enlarged chart CSV/PNG, CalculiX deck, FRD and log | No generated engineering report or complete portable solver archive |

Implementation evidence: [analysis registry and static/modal/buckling implementations](../engine/analyses.py), [thermal](../engine/thermal.py), [harmonic](../engine/harmonic.py), [contact](../engine/contact.py), [CAD and mesh](../engine/cad.py), [submodel](../engine/submodel.py), [convergence](../engine/convergence.py), [domain types](../src/types.ts), [inspector](../src/Inspector.tsx), [viewer](../src/scene.ts), [application state](../src/App.tsx), and [chart exports](../src/Chart.tsx).

## Missing features and incomplete depth

The following lists inventory missing application behavior. Some operations can be approximated manually or by exporting/editing a CalculiX deck; that is not application feature parity. Entries concerning native geometry tools refer to their role in preparing or maintaining a simulation, not a request to build a complete CAD modeler.

**Attribution qualification:** the major analysis families and linked SOLIDWORKS functions are confirmed reference capabilities. The long tail also includes proposed product improvements for Sprung FEA, such as a general job queue, comprehensive portable solver archives and broader nonlinear thermomechanical handoffs. These should not be read as a claim that every listed behavior is a native Premium feature, or that every feature works in every study/element/contact combination. The coverage estimate is a rough weighted product assessment, not an exact count of confirmed SOLIDWORKS checkboxes.

### Analysis and optimization

- **Fatigue:** S–N data, constant/variable-amplitude events, imported load histories, cycle counting, damage and life plots, mean-stress corrections and cumulative damage. Existing plastic unloading is not fatigue. SOLIDWORKS documents the event/history/S–N workflow in [Performing Fatigue Analysis](https://help.solidworks.com/2023/english/SolidWorks/cworks/t_Performing_Fatigue_Analysis.htm).
- **Structural time history:** modal transient dynamics, time-dependent mechanical loads and base excitation, velocity/acceleration output and damping controls. Transient temperature frames do not supply this capability.
- **Other dynamics:** random vibration/PSD, response spectrum and nonlinear transient dynamics. Harmonic response covers one part of the desktop dynamic suite; see the [official analysis-family overview](https://www.solidworks.com/lp/3d-simulation).
- **Drop tests and impact:** drop orientation, target/contact setup, impact response and time-dependent result inspection.
- **Motion:** rigid-body mechanisms, mates, motors and time/event-driven motion; transfer of motion-generated loads to stress analysis.
- **Parametric design studies:** parameter tables, batch evaluation, goals/constraints, scenario ranking and optimization.
- **Topology optimization:** minimum-material design, preserved regions, design constraints, manufacturing restrictions and optimized-geometry output. SOLIDWORKS describes these controls in its [topology workflow](https://blogs.solidworks.com/products/solidworks/best-setups-for-manufacturing-controls-in-topology-study/).
- **Pressure-vessel studies:** combinations of solved stress states, stress classification/linearization and vessel-specific assessment. Applying pressure and integrating section forces does not implement this study type.
- **Nonlinear controls:** prescribed-displacement driving, user-defined load sequences, fixture activation/release, configurable increments/convergence, force/displacement/arc-length control and restart workflows. Large-deformation capability alone does not establish robust postbuckling/snap-through support.
- **Analysis combinations:** supported handoff of a nonlinear contact/bolt solution into modal/dynamic studies, and nonlinear thermomechanical contact/plasticity workflows.

### Elements, geometry and meshing

- Shells, midsurface extraction, shell thickness/offset/orientation, top/bottom and through-thickness results.
- Beams/trusses, section libraries, weldment idealization, beam joints/releases and beam force/moment diagrams.
- Mixed solid/shell/beam models and their connection rules.
- Plane stress, plane strain and axisymmetric simplification.
- Selectable linear/quadratic element quality and formulation choices beyond C3D10.
- **Local mesh controls** on a face, edge, vertex, component or region within the original global mesh. A separate boxed submodel is different. SOLIDWORKS exposes entity-specific size and transition ratio through [mesh controls](https://help.solidworks.com/2024/english/SolidWorks/cworks/t_Applying_Mesh_Control_to_Mixed_Types.htm?id=7767cf4ff3d04bf785a329cdaa6bcefc).
- Error-driven adaptive refinement; the current convergence tool reduces global mesh size. Adaptive availability should be assessed for the particular SOLIDWORKS release/mesher rather than treated as a timeless license promise.
- Mesh-quality distributions and plots, aspect-ratio/Jacobian views, bad-element localization and actionable mesh-failure diagnostics. Current minimum signed quality is useful but much narrower; see [SOLIDWORKS mesh options](https://help.solidworks.com/2024/english/SolidWorks/cworks/IDC_HELP_PREFERENCE_MESH.htm?id=26.10.5.3).
- Choice of meshing strategies and transition/minimum-size/curvature tolerances.
- CAD repair, small-feature suppression, simulation-specific defeaturing and split-face tools for applying loads to part of a CAD face.
- Native CAD/configuration association, load/support selection remapping after geometry revisions, and unresolved-selection review.
- Direct native SOLIDWORKS/Parasolid/IGES intake. The public application currently accepts STEP solids; the presence of OpenCASCADE does not expose all of its file readers.
- Preservation of CAD component names, nested assembly hierarchy, instance identity and study-specific exclusions.

### Materials and thermal depth

- Orthotropic/anisotropic elasticity and conductivity, material orientation and laminate composites.
- Composite ply stacks, ply results and composite failure criteria.
- Hyperelastic rubber models, nonlinear elastic materials, viscoelasticity and creep; broader plasticity/hardening choices. The existing model is isotropic hardening. SOLIDWORKS lists its nonlinear material families in [Nonlinear Static Analysis Overview](https://help.solidworks.com/2023/english/SolidWorks/cworks/c_nonlinear_static_analysis_overview.htm).
- A substantial searchable material database and saved reusable custom-material library; currently four presets plus study-local edits.
- Material-data import, provenance and reusable curve datasets.
- Temperature tables for properties beyond the existing modulus/conductivity/expansion subset, including temperature-dependent heat capacity and strength.
- Thermal contact resistance/conductance, imperfect interfaces and imported pressure/temperature fields from external analyses.
- Surface-to-surface radiation and enclosure/view-factor treatment; ambient radiation is already implemented. Compare [SOLIDWORKS surface-to-surface radiation](https://help.solidworks.com/2024/English/SolidWorks/Cworks/t_Defining_Surface_to_Surface_Radiation.htm).
- Thermal conditions varying with time or position, nonuniform initial temperatures, body-specific heat sources and finer control of output/time increments.

### Contact, connectors, supports and loads

- Contact across initial clearances, independently meshed nonmatching interfaces, user-selected face-to-face contact sets and contact scoped more finely than a body pair.
- Shrink/interference fits, virtual walls, self-contact and broader contact-search/adjustment controls.
- Idealized bolt connectors without meshing a solid bolt, automatic fastener conversion, thread tensile-area/proof-strength setup and connector safety checks. Current solid-bolt pretension is valuable but solves a different setup problem. Compare [automatic fastener conversion](https://help.solidworks.com/2023/english/SolidWorks/cworks/c_wn2014_automatic_conversion_fasteners.htm?format=P&value=).
- Pins, bearing connectors with stiffness, user-defined springs/dampers, elastic foundations, weld connectors, rigid links, linkage rods, general springs and cables. A bearing pressure load is not a bearing connector; internal contact stabilization springs are not user-defined spring connectors. See the [connector summary](https://help.solidworks.com/2020/English/SolidWorks/cworks/c_Summary_of_Connectors.htm) and [2026 matrix](https://www.solidworks.com/sites/default/filesd10/26docs06/solidworks-simulation-feature-matrix.pdf).
- Prescribed nonzero translations/rotations, dedicated symmetry/cyclic-symmetry constraints and general reference-coordinate fixtures. A planar frictionless fixture can represent the normal restraint in some solid symmetry models, but there is no dedicated symmetry workflow. Compare [cyclic symmetry](https://help.solidworks.com/2025/English/SolidWorks/cworks/c_creating_valid_sections_circular_symmetry.htm?id=d50c63eeea104f1eb57030c741c5cf7c).
- Edge/vertex selection for applicable loads and constraints, reusable local coordinate systems, and reference-axis/plane selection for load directions.
- Nonuniform/hydrostatic or equation-driven pressure/force fields and imported load maps. Current pressure is uniform per selected face set; remote/moment/bearing loads have their own predefined distributions.
- Rigid versus distributed remote coupling choices, general remote constraints and point-mass rotational inertia tensors.
- Load combinations, envelopes and a load-case manager. Multiple loads currently act together within one study.
- Inertial relief for otherwise free static models. Free-body modes in a frequency analysis do not provide inertial relief.

### Results and smaller usability gaps

- Individual stress/shear/strain components and the middle principal value as selectable contours; displacement components as contours; principal direction/tensor and heat-flux vector plots.
- Element/energy-error results and controls for averaging at boundaries. Current results are derived from averaged nodal tensors. SOLIDWORKS provides separate [node/element result treatment](https://help.solidworks.com/2020/english/SolidWorks/cworks/c_Node_Values_versus_Element_Values.htm?id=27.19.0.13.1).
- Multiple failure criteria and separate tensile/compressive limits. The current safety plot is a von-Mises-based yield ratio; plotting Tresca stress does not add a Tresca-based safety calculation. See the [factor-of-safety options](https://help.solidworks.com/2021/english/SolidWorks/cworks/IDH_HELP_DESIGNCHECK.htm?id=8fc4d024f4954e8aa58496661476fe2b).
- **Per-body yield margins and warnings:** current display and summary use `study.material.yield`, even with per-body materials. This is a concrete correctness gap for heterogeneous assemblies, not just a missing UI preference (`src/App.tsx:984`, `engine/analyses.py:307`).
- Reactions split by support/body/selected entity and a fuller free-body result workflow. Current aggregate reactions and section forces are partial coverage.
- Saved multiple probes, probe tables, edge/path plots, point histories, result sensors and alert thresholds.
- Arbitrarily oriented sections using a plane/normal/reference entity; current section normals are X/Y/Z. Compare [section plots](https://help.solidworks.com/2019/english/SolidWorks/cworks/t_Creating_Section_Plots.htm?id=e18975a5a9f04f369f896979a7ee4cd0).
- Editable contour limits, discrete bands, alternate/colorblind palettes, legend positioning/formatting and common scales across frames/studies. Current frame-dependent autoscaling makes comparisons less convenient. SOLIDWORKS exposes [color-chart settings](https://help.solidworks.com/2023/english/SolidWorks/cworks/idh_help_preference_color_chart.htm) and a [colorblind option](https://help.solidworks.com/2015/english/WhatsNew/wn2015_viewing_sim_results_colorblind.htm?id=23.9).
- User-specified deformation multiplier, original/deformed overlays, saved named views, plot definitions and persisted presentation state.
- Body hide/show/isolate, transparency, exploding an assembly and selection of obscured interfaces.
- Named selection sets, box/lasso selection, select-through and richer face filtering/grouping.
- Duplicate/suppress conditions and bulk editing; named study templates.
- Multiple named studies per geometry, copying definitions between studies, configuration association, side-by-side comparison and iteration trend tracking. Switching analysis preserves much of the setup, but replaces the active study. See [copying definitions between studies](https://help.solidworks.com/2025/english/SolidWorks/Cworks/c_Drag_and_Drop_Functionality.htm).
- Batch solve/queue management, retained run history and a supported user-facing scripting/automation interface. The internal HTTP/worker interfaces are a starting point, not a finished automation product.
- Live nonlinear intermediate-result inspection, richer residual/contact-convergence diagnostics, configurable result sampling and restart/recovery of solver jobs.
- Automatic engineering reports with assumptions, inputs, mesh, results, warnings and convergence evidence; interactive review/sharing such as eDrawings.
- Full volumetric/multiframe export through the UI and animation-video export. Existing surface and chart CSV/PNG exports should receive credit.
- Portable archives retaining solver inputs/logs and submodel results. Saved whole-part results work, but solver artifacts require another solve after opening; region results are not embedded.
- Multiple recent projects/recovery histories rather than the current single autosave entry.
- Predictive memory/DOF budgeting and richer progress/resource feedback before large jobs. STEP intake is limited to 50 MB; the viewer uses a 32-bit WASM heap. These are scale constraints, not reasons to claim all large models fail.

## What goes beyond SOLIDWORKS?

### Clear product advantages

1. **Native macOS execution**, including Apple Silicon, with packaging configured for Windows and Linux. Desktop SOLIDWORKS client requirements are Windows-based; the macOS product listed separately is eDrawings. The strongest demonstrated platform claim here is the existing Apple Silicon acceptance evidence; this assessment does not establish fresh Windows/Linux acceptance. See [SOLIDWORKS system requirements](https://www.solidworks.com/support/system-requirements) and the repository [build workflow](../.github/workflows/build.yml).
2. **GPL-licensed source and no Simulation license-tier gating.** Users can inspect, modify and redistribute under the license. The SOLIDWORKS tiered commercial offering is described in its [product overview](https://www.solidworks.com/product/solidworks-simulation).
3. **A standalone, CAD-independent application** with inspectable CalculiX inputs/results/logs and an editable source pipeline. This supports customization without needing SOLIDWORKS CAD. Importing neutral CAD files itself is not unique.

### Distinctive implementations, without an exclusivity claim

- The convergence workflow combines separate quantity verdicts, conditional Richardson extrapolation and a plain-language likely-singularity warning.
- A boxed submodel reports explicit cut-boundary agreement with the parent solution.
- The UI places section force/moment integration near visual section controls and labels deformation magnification plainly.
- Geometry/setup/results fit into a portable project, with conservative invalidation when the physical setup changes.
- A focused interface and bundled local runtime can reduce setup complexity for occasional users; this is a design advantage hypothesis, not a measured usability finding.

SOLIDWORKS also has convergence/hot-spot diagnostics, submodeling, section results, local solving, undo, unit conversion, probes, animation and automation APIs. Those should not be presented as unique physics or automatically superior features. No code/source evidence in this audit establishes better speed, accuracy or robustness than SOLIDWORKS Simulation Premium.

Relative to **Standard's license scope**, the project offers modal, buckling, thermal, harmonic and nonlinear-material workflows normally associated with higher SOLIDWORKS tiers. That is valuable accessible breadth, while those same capabilities remain partial parity against Premium.

## Highest-value next steps

1. Fix heterogeneous-body yield assessment and constrain/validate nonlinear-parent submodel use; refresh validation documentation to match current code.
2. Add named studies, duplication/suppression, load cases, body isolation, saved probes and editable/shared contour limits.
3. Add local mesh controls, quality localization, richer material reuse and automatic reports. These improve most existing studies.
4. For assembly parity, add gaps/nonmatching contact, prescribed displacement, simplified bolts and pin/spring/weld connectors.
5. Choose the next physics family by customer work: shells/beams for thin structures and frames; fatigue for repeated loading; random/time-history dynamics for vibration; design/topology optimization for weight reduction.

Feature completion and engineering confidence are separate. The repository has meaningful analytic and equilibrium tests, including real solver executions, but its recorded validation lacks independent commercial-solver comparison, physical correlation and a representative customer CAD corpus. The validation page also predates several currently implemented analysis families; its old exclusions should not be mistaken for current feature absence.

## Verification performed for this assessment

- TypeScript project compilation passed.
- `npm test`: all 7 tests passed after allowing the local test server to bind outside the sandbox. The initial restricted run passed the pure tests and failed two service tests because loopback binding was unavailable.
- Full existing engine suite: **86 tests passed in 384 seconds**, including real Gmsh/CalculiX executions for assemblies, contact/bolts, convergence, static, modal, buckling, harmonic, thermal, plasticity, supports/loads and submodeling. Gmsh/PETSc emitted nonfatal hostname-access diagnostics under the sandbox; the test assertions completed successfully.
- Browser and packaged application tests were inspected as evidence of coverage but were not rerun for this assessment. No commercial SOLIDWORKS solve or comparative timing benchmark was performed.
