# Viewer on VTK.wasm: decisions

3 October 2026 · replaces the Three.js viewer

This records the decisions made when the 3D viewer moved from Three.js to VTK compiled to WebAssembly (VTK.wasm), and what each one was based on. The Three.js viewer was removed rather than kept alongside it.

## 1. Standalone session in the renderer; no native VTK backend

VTK.wasm can run in two modes. A **standalone session** builds and runs VTK pipelines in the browser. A **remote session** mirrors a scene built by a native VTK process (C++ or Python) and only renders it locally. The remote session was to be used only if a required filter could not run in the browser, and then for all rendering, not split across both.

The browser build has everything the result filters need. Each was checked in a spike against the pinned bundle, using a quadratic tetrahedron built from typed arrays, before the viewer was written:

| Need | VTK class in the WebAssembly bundle | Result |
|---|---|---|
| Volume mesh with results | `vtkUnstructuredGrid` of `VTK_QUADRATIC_TETRA`, arrays from `toVTKAoSArray` | Works |
| Cross-section cap | `vtkCutter` with a `vtkPlane` | Works |
| Section cut-away | Mapper clipping planes (`vtkMapper.AddClippingPlane`) | Works; `vtkCellPicker` honours them |
| Point probe | `vtkProbeFilter` against the volume, quadratic interpolation | Works |
| Iso-surface | `vtkContourFilter` on the volume | Works |
| Threshold region | `vtkClipPolyData` by scalar on the surface, plus a contour cap | Works |
| Picking | `vtkCellPicker` (cell, position, parametric coordinates) | Works |
| Screen projection | `vtkRenderer` world-to-display | Works |

So **no native VTK backend was added and the remote session is not used.** The Python engine is unchanged in its role (CAD, meshing, solving) and gains no VTK dependency. A remote session would have added a second native process, a scene synchronization protocol, and server-side rendering state per document, with nothing the browser cannot already do for single-part models of up to 150,000 elements.

Revisit this if a future need cannot run in the browser: models beyond the memory of a 32-bit WebAssembly heap (4 GB), or filters absent from the bundle. If that happens, move all scene construction to the native side and use the remote session for every view, as originally intended, rather than splitting features between modes.

## 2. Classes that do not work in this bundle, and the substitutes

| Not usable | Symptom | Used instead |
|---|---|---|
| `vtkPlaneCutter` | `RuntimeError: null function` on update | `vtkCutter` with a `vtkPlane` |
| `vtkDataSetMapper` | `null function` on construction | Explicit boundary triangles from the engine, drawn with `vtkPolyDataMapper` |
| `vtkDataSetSurfaceFilter`, `vtkGeometryFilter`, `vtkTableBasedClipDataSet`, `vtkClipDataSet`, `vtkWarpVector` | Not in the bundle | Engine-supplied boundary triangles; clipping planes on the mapper; deformation computed in JavaScript and written in place to the shared `vtkPoints` |
| `vtkMassProperties` | Works, but its proxy logs an output-port error when created | Section area summed in JavaScript from the cut polygons (`vtkCellArray.ExportLegacyFormat`) |
| Reading `vtkCellArray` offsets and connectivity with `toJSTypedArray` | `vtkAOSDataArrayTemplate<int>` is unknown to the method table | `ExportLegacyFormat` into a `vtkIdTypeArray` |
| Dual depth peeling | Not supported on WebGL 2 (OpenGL ES 3) | Disabled; translucent "ghost" surfaces blend unsorted, which is acceptable for a single faint context surface |

## 3. Runtime version, hosting, and integrity

- **Loader:** `@kitware/vtk-wasm` 3.0.5 (npm, Apache-2.0), pinned exactly.
- **Runtime:** `vtk-wasm32-emscripten` **9.7.20260927**, from Kitware's VTK package registry, verified by SHA-256. The 9.7.1 release bundle was rejected because it lacks the per-class method manifests (`types/*.json`) that loader 3.x needs to dispatch method calls. Registry nightlies keep stable, versioned URLs. The `dist` branch of the GitHub mirror is resynced and was not used as the pin.
- **Offline:** BetterSim is a desktop app with offline fonts, so the runtime is never loaded from a CDN. `scripts/fetch-vtk-wasm.mjs` (run by `npm run setup` and `npm run build`) downloads and verifies it once and writes the files to `public/vtk-wasm/`. Vite copies them to `dist/`, and the local service serves them. The files are not committed (an 87 MB `.wasm`).
- **Loose files, not the tarball:** the loader can unpack the `.tar.gz` in the page. Instead, the runtime is served as plain `.mjs` and `.wasm` files with one merged method index (`vtk-methods.json`, generated from the 846 manifests). This avoids gunzipping 90 MB on every start and avoids importing the glue code from a `blob:` URL. The runtime loads in about 0.2–0.5 s.
- **Sessions:** the WebAssembly runtime is loaded once per page. Each viewer instance creates its own standalone session and disposes it on unmount, which frees its C++ objects.
- **Types:** the loader can generate TypeScript declarations from the manifests. They were not adopted because the manifests collapse C++ overloads to one signature (for example `vtkMapper.SelectColorArray(name)` is missing; only the index form survives). The scene module uses the proxies untyped. Unknown method names still throw at call time, and the end-to-end tests exercise every pipeline.

## 4. Content Security Policy

The service previously allowed `script-src 'self'`. VTK.wasm needs:

- `'wasm-unsafe-eval'` to compile WebAssembly, and
- `'unsafe-eval'` because the Emscripten embind glue generates invoker functions with `new Function`. Without it, the session constructors fail and the viewer reports that it could not start; this was confirmed against the production build.

This weakens the policy: injected script could now use `eval`. The mitigating facts are that the service serves only its own files from loopback, validates hosts and origins, and renders no remote content. `'wasm-unsafe-eval'` is redundant while `'unsafe-eval'` is present, but is kept so that removing `'unsafe-eval'` later (with a runtime built without dynamic execution, `-sDYNAMIC_EXECUTION=0`) leaves WebAssembly working. Rebuilding VTK.wasm that way is the route to restoring the stricter policy.

## 5. Data path: a binary view file instead of JSON arrays

Sections, probes, iso-surfaces and thresholds need the **volume** mesh and nodal results, not just the surface. Previously, mesh and result arrays travelled in the job's JSON response, and the volume connectivity was unused by the client.

The engine now writes `view.bin` after meshing (geometry only) and after solving (with results). The service serves it at `GET /api/documents/:id/view`, and job responses carry only metadata and the result summary.

```
"BSIMVIEW" | uint32 header length | JSON header | arrays (each 8-byte aligned)
header: {"version": 1, "arrays": [{"name", "type": "float64"|"int32", "shape"}]}
```

| Array | Shape | Meaning |
|---|---|---|
| `nodeIds` | N | Gmsh/CalculiX node tags |
| `points` | N × 3 | Node coordinates, mm |
| `tets` | E × 10 | Quadratic tetrahedra, **VTK node order**, indices into `points` |
| `triangles` | T × 3 | Boundary triangles (each quadratic face split into four), indices into `points` |
| `triangleFaces` | T | CAD face of each boundary triangle |
| `displacement` | N × 3 | After solving: nodal displacement, mm |
| `vonMises` | N | After solving: von Mises stress from the averaged nodal tensor, MPa |

Reasons: the arrays go straight into VTK and typed-array views without parsing; the format is self-describing and versioned; and the same bytes are embedded (base64) in saved projects. Gmsh's ten-node tetrahedron differs from VTK's (and CalculiX's) in its last two midside nodes, so the engine reorders once, sharing `TET10_ORDER` with the deck writer. An engine test checks the order geometrically, and the service test decodes the file with the client's own decoder.

A VTU file was considered so that results could open directly in ParaView, but boundary triangles with CAD face IDs do not fit one unstructured grid cleanly, and reading it in the browser would mean staging it in the Emscripten file system. A VTU export can be added later from the same arrays.

**Project compatibility:** projects saved by the Three.js version embedded surface-only JSON arrays. They still open with their geometry and study, but their saved results are skipped (the app already says so) and need a new solve. There was no other format change.

## 6. Viewer structure and interaction

- `src/scene.ts` owns all VTK objects. React passes it a state snapshot; it applies only what changed (model, deformation, colors, annotations, filters, probe marker, projection), then renders once on the next animation frame. Nothing renders continuously.
- The surface, the volume grid and the CAD edge lines share **one `vtkPoints`**. Deformation rewrites those coordinates in place, so sections, iso-surfaces and probes always act on the displayed (deformed) shape, while a `Position` point array carries undeformed coordinates for probe readouts.
- Camera controls are implemented in JavaScript on the VTK camera rather than with VTK's interactor. This keeps the existing interaction (left-drag trackball rotation with no fixed up axis, right- or middle-drag and Shift-drag pan, scroll zoom, perspective/orthographic toggle that preserves the visible size) and lets the app decide when to render and when a click is a pick.
- Setup face colors are a per-triangle color array updated in place, so selection and hover don't rebuild geometry. Hover picking runs at most once per frame.
- The probe marker draws in an overlay renderer layer, so it stays visible through the part. The axis triad is a `vtkAxesActor` in a second small layer that follows the main camera.
- The legend, labels and probe tag stay HTML, so they follow the app's theme, remain accessible, and are testable.

## 7. Result filters

| Filter | Behaviour |
|---|---|
| **Probe** | A click on any displayed result surface (outer surface, section, iso-surface or threshold boundary) interpolates stress and displacement inside the containing quadratic tetrahedron with `vtkProbeFilter`. "Show in view" still reports exact nodal values at the extreme node. |
| **Section** | A plane normal to X, Y or Z at any position within the part bounds. The surface beyond it is clipped away, and the cut through the volume is shown colored by the plotted quantity. Flip keeps the other side. The section area is displayed, which is a direct check of the cut (200 mm² for the sample beam). |
| **Iso-surface** | The surface where the plotted quantity equals a chosen level, inside a translucent outline of the part. |
| **Threshold** | The region where stress or displacement is above a level, or yield margin is below it (the critical side in each case). It is drawn as the clipped outer surface plus the iso-surface cap, which gives a smooth boundary instead of whole blocky cells. |

Iso and threshold levels are stored as a fraction of the active color scale, so switching plots keeps them meaningful. The section clips every result actor, so filters combine.

## 8. Testing approach

As requested, no new unit tests. Coverage of the rewrite comes from:

- **Engine module test:** `view.bin` layout and VTK tetrahedron order (midside nodes lie exactly on their VTK edges for the planar beam).
- **Service test:** a real solve, then `/view` decoded with the client decoder; counts match the mesh, `max(vonMises)` equals the solver summary, and the CSP is present.
- **End-to-end (Playwright, real Chrome and WebGL):** the existing scenarios, adapted for interpolated probes, plus a filters scenario. It checks section areas of 200 mm² (X normal) and 2,000 mm² (Z normal) on the beam; a click on the section probes exactly (50, 10, 5) mm; iso-surface and threshold render without errors; and a saved project restores results that the filters still work on.
- The existing `logic.test.ts` was adapted to the new saved-results shape, including the case of an older project's results.
