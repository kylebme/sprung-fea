import { useState, useRef, useEffect } from "react";
import {
  Box,
  Upload,
  FolderOpen,
  Save,
  ChevronRight,
  Check,
  Plus,
  X,
  ArrowDown,
  Play,
  RotateCcw,
  Maximize,
  Grid3X3,
  Layers,
  SlidersHorizontal,
  ShieldCheck,
  ArrowUpRight,
  Download,
  Camera,
  LoaderCircle,
  Trash2,
  Pencil,
  Undo2,
  Redo2,
  Info,
  MousePointer2,
  Search,
  Activity,
  ChevronDown,
  FileText,
  ExternalLink,
} from "lucide-react";
import { Viewer, palette, type ViewerHandle } from "./Viewer";
import { api, post, saveFile } from "./api";
import {
  MATERIALS,
  emptyStudy,
  fmt,
  type Part,
  type Study,
  type Material,
  type Support,
  type Load,
  type Mesh,
  type Result,
  type Plot,
} from "./types";
type Section = "part" | "material" | "supports" | "loads" | "mesh" | "results";
type Draft =
  { kind: "support"; value: Support } | { kind: "load"; value: Load };
type Job = { id: string; stage: string; message: string; started: number };
const uid = () => crypto.randomUUID();
const blankSupport = (): Support => ({
  id: uid(),
  name: "Held in place",
  faces: [],
  axes: [true, true, true],
});
const blankLoad = (): Load => ({
  id: uid(),
  name: "Applied force",
  kind: "force",
  faces: [],
  vector: [0, 0, -100],
  magnitude: 1,
});
const copy = <T,>(x: T): T => structuredClone(x);
const labels: Record<Section, string> = {
  part: "Part",
  material: "Material",
  supports: "Supports",
  loads: "Loads",
  mesh: "Mesh",
  results: "Results",
};
const PLOT_LABELS = {
  stress: "Stress",
  movement: "Movement",
  safety: "Yield margin",
};
export default function App() {
  const [part, setPart] = useState<Part | null>(null),
    [study, setStudy] = useState<Study>(emptyStudy),
    [mesh, setMesh] = useState<Mesh | null>(null),
    [result, setResult] = useState<Result | null>(null);
  const [section, setSection] = useState<Section>("part"),
    [selected, setSelected] = useState<number[]>([]),
    [hover, setHover] = useState<number | null>(null),
    [draft, setDraft] = useState<Draft | null>(null),
    [material, setMaterial] = useState<Material>(copy(MATERIALS[0]));
  const [job, setJob] = useState<Job | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [plot, setPlot] = useState<Plot>("stress"),
    [deform, setDeform] = useState<"off" | "true" | "auto">("off"),
    [wire, setWire] = useState(false),
    [probe, setProbe] = useState<number | null>(null),
    [query, setQuery] = useState("");
  const [history, setHistory] = useState<Study[]>([]),
    [future, setFuture] = useState<Study[]>([]),
    [comparison, setComparison] = useState<{
      before: Result;
      after: Result;
    } | null>(null),
    [recovery, setRecovery] = useState(
      () => !!localStorage.getItem("bettersim-recovery"),
    );
  const sequence = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null),
    projectInput = useRef<HTMLInputElement>(null),
    viewer = useRef<ViewerHandle>(null),
    active = useRef<string | null>(null),
    partRef = useRef(part);
  partRef.current = part;
  const [recoveryStatus, setRecoveryStatus] = useState("saving");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!job) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [job]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(t);
  }, [notice]);
  const invalidate = (clearMesh = false) => {
    setResult(null);
    setProbe(null);
    setComparison(null);
    setSection((s) => (s === "results" ? "mesh" : s));
    if (clearMesh) setMesh(null);
  };
  const update = (next: Study) => {
    setHistory((h) => [...h.slice(-29), copy(study)]);
    setFuture([]);
    setStudy(next);
    invalidate(next.meshSize !== study.meshSize);
  };
  const undo = () => {
    if (!history.length || job) return;
    const previous = history.at(-1)!;
    setFuture((f) => [copy(study), ...f]);
    setHistory((h) => h.slice(0, -1));
    setStudy(previous);
    setDraft(null);
    invalidate(true);
  };
  const redo = () => {
    if (!future.length || job) return;
    setHistory((h) => [...h, copy(study)]);
    setStudy(future[0]);
    setFuture((f) => f.slice(1));
    setDraft(null);
    invalidate(true);
  };
  const poll = async (id: string) => {
    active.current = id;
    setJob({
      id,
      stage: "starting",
      message: "Preparing the part…",
      started: Date.now(),
    });
    for (;;) {
      await new Promise((r) => setTimeout(r, 350));
      if (active.current !== id) return null;
      const j = await api("/jobs/" + id);
      setJob(j);
      if (j.status === "error") throw Error(j.error);
      if (j.status === "cancelled") return null;
      if (j.status === "done") return j.data;
    }
  };
  const finish = () => {
    active.current = null;
    setJob(null);
  };
  const importPart = async (action: () => Promise<any>) => {
    const operation = ++sequence.current;
    setError("");
    setDraft(null);
    try {
      const info = await action();
      const geometry = await poll(info.job);
      if (!geometry) return;
      const next: Part = { id: info.id, name: info.name, geometry };
      setPart(next);
      setStudy(
        info.study || { ...emptyStudy(), meshSize: geometry.recommendedSize },
      );
      setHistory([]);
      setFuture([]);
      setMesh(null);
      setResult(null);
      setComparison(null);
      setSelected([]);
      setProbe(null);
      setSection("part");
      setWire(false);
      setNotice("STEP imported. Select faces to set up your study.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (sequence.current === operation) finish();
    }
  };
  const importFile = (file: File) =>
    importPart(() => {
      const body = new FormData();
      body.append("file", file);
      return api("/import", { method: "POST", body });
    });
  const sample = (name: string) =>
    importPart(() => post("/sample/" + name, {}));
  const openProject = async (file: File) => {
    try {
      const project = JSON.parse(await file.text());
      await importPart(() => post("/open", project));
    } catch (e) {
      setError("Could not open the project: " + (e as Error).message);
    }
  };
  const save = async () => {
    if (!part) return;
    try {
      const data = await post("/documents/" + part.id + "/save", {
        name: part.name,
        study,
      });
      if (
        await saveFile(
          part.name.replace(/\.(step|stp)$/i, "") + ".bsim",
          JSON.stringify(data, null, 2),
        )
      )
        setNotice("Project saved with its STEP geometry and study setup.");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    if (!part || job) return;
    setRecoveryStatus("saving");
    const t = setTimeout(async () => {
      try {
        const data = await post("/documents/" + part.id + "/save", {
          name: part.name,
          study,
        });
        if (partRef.current?.id !== part.id) return;
        localStorage.setItem("bettersim-recovery", JSON.stringify(data));
        setRecovery(true);
        setRecoveryStatus("saved");
      } catch {
        setRecoveryStatus("unavailable");
      }
    }, 750);
    return () => clearTimeout(t);
  }, [part, study, job]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        save();
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key === "z" &&
        !(e.target instanceof HTMLInputElement)
      ) {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      }
      if (e.key === "Escape") {
        setDraft(null);
        setSelected([]);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
  const run = async (action: "mesh" | "solve", refine = false) => {
    if (!part || job) return;
    const operation = ++sequence.current;
    setError("");
    setDraft(null);
    const prior = result;
    let next = study;
    if (refine) {
      next = {
        ...study,
        detail: "custom",
        meshSize: (mesh?.size || study.meshSize) * 0.7,
      };
      update(next);
    }
    try {
      const j = await post("/documents/" + part.id + "/" + action, next);
      const data = await poll(j.job);
      if (!data) return;
      if (action === "mesh") {
        setMesh(data);
        setWire(true);
        setSection("mesh");
        setNotice("Mesh ready. Inspect it in the 3D view or run the analysis.");
      } else {
        setMesh(data.mesh);
        setResult(data.result);
        setWire(false);
        setPlot("stress");
        setDeform("off");
        setSection("results");
        setSelected([]);
        if (refine && prior)
          setComparison({ before: prior, after: data.result });
        setNotice("Analysis complete. Results are ready to inspect.");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (sequence.current === operation) finish();
    }
  };
  const cancel = async () => {
    if (!active.current) return;
    const id = active.current;
    sequence.current++;
    active.current = null;
    await api("/jobs/" + id, { method: "DELETE" });
    setJob(null);
    setNotice("Operation cancelled. Your study setup is preserved.");
  };
  const selectFace = (id: number) => {
    if (job || result) return;
    setSelected((s) =>
      s.includes(id) ? s.filter((f) => f !== id) : [...s, id],
    );
  };
  const chooseSection = (s: Section) => {
    if (job) return;
    setSection(s);
    setDraft(null);
    setQuery("");
    if (s === "material") setMaterial(copy(study.material || MATERIALS[0]));
  };
  const edit = (kind: "support" | "load", value: Support | Load) => {
    if (job) return;
    setSection(kind === "support" ? "supports" : "loads");
    setDraft({ kind, value: copy(value) } as Draft);
    setSelected(value.faces);
  };
  const add = (kind: "support" | "load") => {
    setDraft(
      kind === "support"
        ? { kind, value: blankSupport() }
        : { kind, value: blankLoad() },
    );
  };
  const commitDraft = () => {
    if (!draft) return;
    const faces =
      draft.kind === "load" && draft.value.kind === "gravity" ? [] : selected;
    if (
      !faces.length &&
      !(draft.kind === "load" && draft.value.kind === "gravity")
    )
      return;
    const value = { ...draft.value, faces };
    const key = draft.kind === "support" ? "supports" : "loads";
    const list = study[key];
    update({
      ...study,
      [key]: list.some((c) => c.id === value.id)
        ? list.map((c) => (c.id === value.id ? value : c))
        : [...list, value],
    });
    setDraft(null);
    setSelected([]);
  };
  const changeDraft = (changes: Record<string, unknown>) =>
    setDraft((d) =>
      d ? ({ ...d, value: { ...d.value, ...changes } } as Draft) : null,
    );
  const exampleSetup = () => {
    if (!part) return;
    const faces = part.geometry.faces;
    const held = faces.reduce((a, b) => (a.center[0] < b.center[0] ? a : b));
    const loaded = faces.reduce((a, b) => (a.center[0] > b.center[0] ? a : b));
    update({
      ...study,
      material: copy(MATERIALS[0]),
      supports: [{ ...blankSupport(), faces: [held.id] }],
      loads: [{ ...blankLoad(), faces: [loaded.id] }],
    });
    setSection("mesh");
    setSelected([]);
    setNotice(
      "Example setup: aluminum, fixed left end, and a total 100 N downward force.",
    );
  };
  const missing = [
    !study.material ? "Choose a material" : null,
    !study.supports.length ? "Add a support" : null,
    !study.loads.length ? "Add a load" : null,
  ].filter(Boolean);
  const ready = !!part && !missing.length && !draft;
  const selectedArea =
    part?.geometry.faces
      .filter((f) => selected.includes(f.id))
      .reduce((sum, f) => sum + f.area, 0) || 0;
  const deformation =
    result && mesh && part
      ? deform === "auto"
        ? (Math.max(...part.geometry.dimensions) * 0.08) /
          (result.summary.maxMovement || 1)
        : deform === "true"
          ? 1
          : 0
      : 0;
  const legendMax = result
    ? plot === "stress"
      ? result.summary.maxStress
      : plot === "movement"
        ? result.summary.maxMovement
        : 5
    : 0;
  const currentSurface = mesh?.surface || part?.geometry;
  const probeIndex =
    probe && currentSurface ? currentSurface.nodeIds.indexOf(probe) : -1;
  const csv = async () => {
    if (!result || !mesh) return;
    const lines = [
      "node,x_mm,y_mm,z_mm,ux_mm,uy_mm,uz_mm,movement_mm,von_mises_MPa",
    ];
    mesh.surface.nodeIds.forEach((n, i) =>
      lines.push(
        [
          n,
          ...mesh.surface.positions.slice(i * 3, i * 3 + 3),
          ...result.displacements[i],
          result.movement[i],
          result.stress[i],
        ].join(","),
      ),
    );
    await saveFile("bettersim-results.csv", lines.join("\n"));
  };
  const exportSolver = async (kind: string) => {
    if (!part) return;
    try {
      const response = await fetch(`/api/documents/${part.id}/export/${kind}`);
      if (!response.ok)
        throw Error("Run an analysis before exporting solver files.");
      await saveFile(
        kind === "deck" ? "analysis.inp" : "solver.log",
        await response.text(),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const screenshot = async () => {
    const content = viewer.current?.screenshot();
    if (content) await saveFile("bettersim-view.png", content, "base64");
  };
  const facesPanel = part && (
    <div className="face-picker">
      <div className="field-heading">
        <span>Choose faces</span>
        <button
          className="text-button"
          onClick={() => setSelected([])}
          disabled={!selected.length}
        >
          Clear
        </button>
      </div>
      <p className="hint">
        Click the part or use the list below. Click again to deselect.
      </p>
      <div className="selection-summary">
        <MousePointer2 size={14} />
        <b>{selected.length} selected</b>
        <span>{fmt(selectedArea, 1)} mm²</span>
      </div>
      {selected.length > 0 && (
        <div className="chips">
          {selected.map((id) => (
            <button key={id} onClick={() => selectFace(id)}>
              Face {id}
              <X size={11} />
            </button>
          ))}
        </div>
      )}
      <label className="search">
        <Search size={14} />
        <input
          aria-label="Search faces"
          placeholder="Find a face…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="face-list">
        {part.geometry.faces
          .filter((f) =>
            (f.name + " " + f.type).toLowerCase().includes(query.toLowerCase()),
          )
          .map((f) => (
            <button
              key={f.id}
              className={`face-row ${selected.includes(f.id) ? "selected" : ""} ${hover === f.id ? "hovered" : ""}`}
              onClick={() => selectFace(f.id)}
              onMouseEnter={() => setHover(f.id)}
              onMouseLeave={() => setHover(null)}
              aria-pressed={selected.includes(f.id)}
            >
              <span className="checkbox">
                {selected.includes(f.id) && <Check size={12} />}
              </span>
              <span>
                <b>{f.name}</b>
                <small>
                  {f.type} · {fmt(f.area, 1)} mm²
                </small>
              </span>
              <span className="face-center" title="Face center in mm">
                X {fmt(f.center[0], 1)}
              </span>
            </button>
          ))}
      </div>
    </div>
  );
  const renderEditor = () => {
    if (!part) return null;
    if (section === "part")
      return (
        <>
          <div className="editor-heading">
            <span className="eyebrow">GEOMETRY</span>
            <h2>Your part, ready.</h2>
            <p>
              One solid. Real CAD surfaces. A clear starting point for your
              analysis.
            </p>
          </div>
          <div className="info-card">
            <Box size={21} />
            <b>{part.name}</b>
            <span>STEP solid · millimetres</span>
          </div>
          <div className="dimension-grid">
            {["X", "Y", "Z"].map((a, i) => (
              <div key={a}>
                <small>{a} dimension</small>
                <b>
                  {fmt(part.geometry.dimensions[i], 2)}
                  <em> mm</em>
                </b>
              </div>
            ))}
          </div>
          <div className="property-row">
            <span>Surfaces</span>
            <b>{part.geometry.faces.length} faces</b>
          </div>
          <div className="property-row">
            <span>Volume</span>
            <b>{fmt(part.geometry.volume, 1)} mm³</b>
          </div>
          <div className="callout">
            <Info size={16} />
            <p>
              Check the dimensions against your CAD model. STEP length units are
              converted to millimetres.
            </p>
          </div>
          <button
            className="primary full"
            onClick={() => chooseSection("material")}
          >
            Choose a material
            <ChevronRight size={16} />
          </button>
          {/Cantilever beam|Mounting bracket/.test(part.name) && (
            <button className="secondary full" onClick={exampleSetup}>
              Use example setup
              <ArrowUpRight size={15} />
            </button>
          )}
          <details className="details">
            <summary>
              Browse part surfaces
              <ChevronDown size={14} />
            </summary>
            {facesPanel}
          </details>
        </>
      );
    if (section === "material")
      return (
        <>
          <div className="editor-heading">
            <span className="eyebrow">01 / MATERIAL</span>
            <h2>What is it made of?</h2>
            <p>
              Material stiffness determines how much the part moves under a
              load.
            </p>
          </div>
          <div className="material-list">
            {MATERIALS.map((m) => (
              <button
                key={m.name}
                onClick={() => setMaterial(copy(m))}
                className={material.name === m.name ? "selected" : ""}
              >
                <span>
                  <b>{m.name}</b>
                  <small>
                    {fmt(m.young / 1000, 1)} GPa · {fmt(m.density)} kg/m³
                  </small>
                </span>
                {material.name === m.name && <Check size={16} />}
              </button>
            ))}
          </div>
          <details
            className="details"
            open={material.name === "Custom material"}
          >
            <summary>
              Material properties
              <SlidersHorizontal size={14} />
            </summary>
            <label className="field">
              Material name
              <input
                value={material.name}
                onChange={(e) =>
                  setMaterial({ ...material, name: e.target.value })
                }
              />
            </label>
            <NumberField
              label="Elastic modulus"
              value={material.young}
              unit="MPa"
              onChange={(v) =>
                setMaterial({ ...material, name: "Custom material", young: v })
              }
            />
            <NumberField
              label="Poisson ratio"
              value={material.poisson}
              step="0.01"
              onChange={(v) =>
                setMaterial({
                  ...material,
                  name: "Custom material",
                  poisson: v,
                })
              }
            />
            <NumberField
              label="Density"
              value={material.density}
              unit="kg/m³"
              onChange={(v) =>
                setMaterial({
                  ...material,
                  name: "Custom material",
                  density: v,
                })
              }
            />
            <NumberField
              label="Yield strength (optional)"
              value={material.yield ?? 0}
              unit="MPa"
              onChange={(v) =>
                setMaterial({
                  ...material,
                  name: "Custom material",
                  yield: v || null,
                })
              }
            />
            <p className="hint">
              Preset values are representative. Use the specifications for your
              actual material and condition.
            </p>
          </details>
          <button
            className="primary full"
            disabled={
              !material.name ||
              material.young <= 0 ||
              material.density <= 0 ||
              material.poisson <= -1 ||
              material.poisson >= 0.499
            }
            onClick={() => {
              update({ ...study, material: copy(material) });
              setSection("supports");
            }}
          >
            Use this material
            <Check size={16} />
          </button>
        </>
      );
    if (section === "supports" || section === "loads") {
      const isSupport = section === "supports";
      const list = isSupport ? study.supports : study.loads;
      return (
        <>
          <div className="editor-heading">
            <span className="eyebrow">
              {isSupport ? "02 / SUPPORTS" : "03 / LOADS"}
            </span>
            <h2>{isSupport ? "How is it held?" : "What acts on it?"}</h2>
            <p>
              {isSupport
                ? "Hold faces where the real part is attached. Leave other faces free to move."
                : "Describe the force or pressure the part experiences in service."}
            </p>
          </div>
          {!draft && (
            <>
              <div className="condition-list">
                {list.map((c) => (
                  <div className="condition" key={c.id}>
                    <button
                      className="condition-main"
                      onClick={() => edit(isSupport ? "support" : "load", c)}
                    >
                      <span
                        className={
                          "condition-icon " + (isSupport ? "teal" : "amber")
                        }
                      >
                        {isSupport ? (
                          <ShieldCheck size={16} />
                        ) : (
                          <ArrowDown size={16} />
                        )}
                      </span>
                      <span>
                        <b>{c.name}</b>
                        <small>
                          {c.faces.length
                            ? c.faces.map((f) => "Face " + f).join(", ")
                            : "Whole part"}
                        </small>
                        {!isSupport && (
                          <small>
                            {(c as Load).kind === "pressure"
                              ? fmt((c as Load).magnitude) + " MPa"
                              : fmt(Math.hypot(...(c as Load).vector)) +
                                " " +
                                ((c as Load).kind === "gravity"
                                  ? "m/s²"
                                  : "N total")}
                          </small>
                        )}
                      </span>
                      <Pencil size={13} />
                    </button>
                    <button
                      className="icon-button delete"
                      aria-label={"Delete " + c.name}
                      onClick={() =>
                        update({
                          ...study,
                          [isSupport ? "supports" : "loads"]: list.filter(
                            (x) => x.id !== c.id,
                          ),
                        })
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
              {!list.length && (
                <div className="empty-editor">
                  {isSupport ? (
                    <ShieldCheck size={28} />
                  ) : (
                    <ArrowDown size={28} />
                  )}
                  <b>
                    {isSupport
                      ? "Give your part a foundation"
                      : "Add a real-world load"}
                  </b>
                  <p>
                    {isSupport
                      ? "A support prevents the part from drifting or rotating freely."
                      : "Start with a known total force. It will be spread over your selected faces."}
                  </p>
                </div>
              )}
              <button
                className="primary full"
                onClick={() => add(isSupport ? "support" : "load")}
              >
                <Plus size={16} />
                {isSupport ? "Add support" : "Add load"}
              </button>
              {facesPanel}
            </>
          )}
          {draft && (
            <>
              <label className="field">
                Name
                <input
                  value={draft.value.name}
                  onChange={(e) => changeDraft({ name: e.target.value })}
                />
              </label>
              {draft.kind === "support" ? (
                <>
                  <label className="field">
                    Support behavior
                    <select
                      value={
                        draft.value.axes.every(Boolean)
                          ? "fixed"
                          : "directional"
                      }
                      onChange={(e) =>
                        changeDraft({
                          axes:
                            e.target.value === "fixed"
                              ? [true, true, true]
                              : [false, false, true],
                          name:
                            e.target.value === "fixed"
                              ? "Held in place"
                              : "Directional support",
                        })
                      }
                    >
                      <option value="fixed">
                        Held in place — all directions
                      </option>
                      <option value="directional">
                        Block chosen directions
                      </option>
                    </select>
                  </label>
                  <div className="axis-options">
                    {["X", "Y", "Z"].map((a, i) => (
                      <button
                        key={a}
                        aria-pressed={draft.value.axes[i]}
                        className={draft.value.axes[i] ? "active" : ""}
                        onClick={() =>
                          changeDraft({
                            axes: draft.value.axes.map((v, j) =>
                              j === i ? !v : v,
                            ),
                          })
                        }
                      >
                        <b>{a}</b>
                        <span>{draft.value.axes[i] ? "Blocked" : "Free"}</span>
                      </button>
                    ))}
                  </div>
                  <p className="hint">
                    Directions use the part’s global coordinate system. The
                    solver checks whether the part can still move freely.
                  </p>
                </>
              ) : (
                <>
                  <div className="segmented load-tabs">
                    {(["force", "pressure", "gravity"] as const).map((k) => (
                      <button
                        key={k}
                        className={draft.value.kind === k ? "active" : ""}
                        onClick={() =>
                          changeDraft({
                            kind: k,
                            name:
                              k === "force"
                                ? "Applied force"
                                : k === "pressure"
                                  ? "Surface pressure"
                                  : "Gravity",
                            vector:
                              k === "gravity" ? [0, 0, -9.81] : [0, 0, -100],
                          })
                        }
                      >
                        {k.charAt(0).toUpperCase() + k.slice(1)}
                      </button>
                    ))}
                  </div>
                  {draft.value.kind === "pressure" ? (
                    <>
                      <NumberField
                        label="Pressure"
                        value={draft.value.magnitude}
                        unit="MPa"
                        onChange={(v) => changeDraft({ magnitude: v })}
                      />
                      <p className="hint">
                        Positive pressure pushes into each selected surface.
                        Negative pressure pulls outward.
                      </p>
                    </>
                  ) : (
                    <>
                      <div className="vector-label">
                        <b>
                          {draft.value.kind === "gravity"
                            ? "Acceleration"
                            : "Total force"}
                        </b>
                        <span>
                          {draft.value.kind === "gravity" ? "m/s²" : "N"}
                        </span>
                      </div>
                      <div className="vector-inputs">
                        {["X", "Y", "Z"].map((a, i) => (
                          <label key={a}>
                            <span>{a}</span>
                            <input
                              aria-label={
                                a +
                                " " +
                                (draft.value.kind === "gravity"
                                  ? "acceleration"
                                  : "force")
                              }
                              type="number"
                              value={draft.value.vector[i]}
                              onChange={(e) =>
                                changeDraft({
                                  vector: draft.value.vector.map((v, j) =>
                                    j === i ? Number(e.target.value) : v,
                                  ),
                                })
                              }
                            />
                          </label>
                        ))}
                      </div>
                      <p className="hint">
                        {draft.value.kind === "force"
                          ? "One total force, distributed across all selected faces. A negative value points along the negative axis."
                          : "Gravity acts on the entire solid. Density comes from your material."}
                      </p>
                    </>
                  )}
                </>
              )}
              {!(draft.kind === "load" && draft.value.kind === "gravity") &&
                facesPanel}
              <div className="draft-actions">
                <button
                  className="secondary"
                  onClick={() => {
                    setDraft(null);
                    setSelected([]);
                  }}
                >
                  Cancel
                </button>
                <button
                  className="primary"
                  disabled={
                    !draft.value.name ||
                    (!selected.length &&
                      !(
                        draft.kind === "load" && draft.value.kind === "gravity"
                      )) ||
                    (draft.kind === "support" &&
                      !draft.value.axes.some(Boolean)) ||
                    (draft.kind === "load" &&
                      (draft.value.kind === "pressure"
                        ? draft.value.magnitude === 0
                        : draft.value.vector.every((v) => v === 0)))
                  }
                  onClick={commitDraft}
                >
                  Save {draft.kind}
                  <Check size={14} />
                </button>
              </div>
            </>
          )}
        </>
      );
    }
    if (section === "mesh")
      return (
        <>
          <div className="editor-heading">
            <span className="eyebrow">04 / MESH</span>
            <h2>The right level of detail.</h2>
            <p>
              The part is divided into small solid elements. More detail takes
              longer, but helps resolve local changes.
            </p>
          </div>
          <div className="detail-options">
            {[
              {
                id: "quick",
                name: "Quick",
                text: "Explore your setup",
                factor: 1.5,
              },
              {
                id: "balanced",
                name: "Balanced",
                text: "A good starting point",
                factor: 1,
              },
              {
                id: "fine",
                name: "Fine",
                text: "Resolve smaller details",
                factor: 0.65,
              },
            ].map((d) => (
              <button
                key={d.id}
                className={study.detail === d.id ? "selected" : ""}
                onClick={() =>
                  update({
                    ...study,
                    detail: d.id as Study["detail"],
                    meshSize: part.geometry.recommendedSize * d.factor,
                  })
                }
              >
                <span>
                  <b>{d.name}</b>
                  <small>{d.text}</small>
                </span>
                {study.detail === d.id ? (
                  <Check size={16} />
                ) : (
                  <span className="radio" />
                )}
              </button>
            ))}
          </div>
          <details className="details" open={study.detail === "custom"}>
            <summary>
              Advanced mesh settings
              <SlidersHorizontal size={14} />
            </summary>
            <NumberField
              label="Target element size"
              unit="mm"
              value={study.meshSize}
              onChange={(v) =>
                update({ ...study, detail: "custom", meshSize: v })
              }
            />
            <p className="hint">
              Quadratic tetrahedra (C3D10), with curvature-based refinement.
              Smaller elements follow curved faces more closely.
            </p>
          </details>
          {mesh && (
            <div className="mesh-stats">
              <div>
                <span>Elements</span>
                <b>{fmt(mesh.elementCount)}</b>
              </div>
              <div>
                <span>Nodes</span>
                <b>{fmt(mesh.nodeCount)}</b>
              </div>
              <div>
                <span>Minimum quality</span>
                <b>{fmt(mesh.minQuality, 3)} / 1</b>
              </div>
            </div>
          )}
          <button
            className="secondary full"
            onClick={() => run("mesh")}
            disabled={!!job || study.meshSize <= 0}
          >
            <Grid3X3 size={16} />
            {mesh ? "Rebuild mesh" : "Preview mesh"}
          </button>
          <div className="callout">
            <Info size={16} />
            <p>
              Start balanced, then repeat with a finer mesh. Compare the results
              to see whether more detail changes your conclusion.
            </p>
          </div>
          {missing.length > 0 && (
            <div className="readiness">
              <b>Before you run</b>
              {missing.map((m) => (
                <span key={m}>
                  <span className="small-dot" />
                  {m}
                </span>
              ))}
            </div>
          )}
          <button
            className="primary full"
            disabled={!ready || !!job || study.meshSize <= 0}
            onClick={() => run("solve")}
          >
            <Play size={15} />
            Run analysis
          </button>
        </>
      );
    if (section === "results" && result)
      return (
        <>
          <div className="editor-heading">
            <span className="eyebrow">RESULTS / LINEAR STATIC</span>
            <h2>A clearer picture.</h2>
            <p>
              Calculated from your material, supports, and loads using CalculiX.
            </p>
          </div>
          <div className="result-cards">
            {[
              {
                plot: "stress",
                label: "Highest stress",
                value: fmt(result.summary.maxStress, 2),
                unit: "MPa",
              },
              {
                plot: "movement",
                label: "Largest movement",
                value: fmt(result.summary.maxMovement, 4),
                unit: "mm",
              },
              {
                plot: "safety",
                label: "Minimum yield margin",
                value: result.summary.minSafety
                  ? fmt(result.summary.minSafety, 2)
                  : "—",
                unit: result.summary.minSafety ? "× yield" : "",
              },
            ].map((r) => (
              <button
                key={r.plot}
                disabled={r.plot === "safety" && !study.material?.yield}
                className={plot === r.plot ? "active" : ""}
                onClick={() => setPlot(r.plot as Plot)}
              >
                <span>{r.label}</span>
                <strong>
                  {r.value}
                  <em>{r.unit}</em>
                </strong>
              </button>
            ))}
          </div>
          <label className="field">
            Shape display
            <select
              value={deform}
              onChange={(e) => setDeform(e.target.value as typeof deform)}
            >
              <option value="off">Original shape</option>
              <option value="true">Deformed — true scale (1×)</option>
              <option value="auto">Deformed — magnified for visibility</option>
            </select>
          </label>
          {deform === "auto" && (
            <div className="callout">
              <Info size={16} />
              <p>
                Movement is magnified <b>{fmt(deformation, 1)}×</b> in this
                view. Reported values are actual movement.
              </p>
            </div>
          )}
          <div className="probe-card">
            <div className="field-heading">
              <b>Inspect a point</b>
              <button
                className="text-button"
                onClick={() =>
                  setProbe(
                    plot === "movement"
                      ? result.summary.movementNode
                      : result.summary.stressNode,
                  )
                }
              >
                Show peak
              </button>
              {probe && (
                <button className="text-button" onClick={() => setProbe(null)}>
                  Clear
                </button>
              )}
            </div>
            {probeIndex >= 0 && mesh ? (
              <>
                <small>
                  Node {probe} ·{" "}
                  {mesh.surface.positions
                    .slice(probeIndex * 3, probeIndex * 3 + 3)
                    .map((n) => fmt(n, 2))
                    .join(", ")}{" "}
                  mm
                </small>
                <div className="property-row">
                  <span>Stress</span>
                  <b>{fmt(result.stress[probeIndex], 3)} MPa</b>
                </div>
                <div className="property-row">
                  <span>Movement</span>
                  <b>{fmt(result.movement[probeIndex], 5)} mm</b>
                </div>
              </>
            ) : (
              <p>Click the model to inspect the nearest surface node.</p>
            )}
          </div>
          <details className="details">
            <summary>
              How to interpret this result
              <Info size={14} />
            </summary>
            <p className="hint">
              Yield margin compares material yield strength with equivalent (von
              Mises) stress. Values below 1 exceed yield. It is not a design
              certification.
            </p>
            {result.warnings.map((w) => (
              <p className="interpretation" key={w}>
                {w}
              </p>
            ))}
            <p className="hint">
              These results assume a homogeneous elastic material, slowly
              applied loads, and small deformation.
            </p>
            <div className="property-row">
              <span>Force balance error</span>
              <b>{fmt(result.summary.forceBalanceError * 100, 4)}%</b>
            </div>
            <div className="property-row">
              <span>Support reaction X</span>
              <b>{fmt(result.summary.reactions[0], 2)} N</b>
            </div>
            <div className="property-row">
              <span>Support reaction Y</span>
              <b>{fmt(result.summary.reactions[1], 2)} N</b>
            </div>
            <div className="property-row">
              <span>Support reaction Z</span>
              <b>{fmt(result.summary.reactions[2], 2)} N</b>
            </div>
          </details>
          {comparison && (
            <div className="comparison">
              <b>Refinement comparison</b>
              <span>
                {fmt(comparison.before.elementCount)} →{" "}
                {fmt(result.elementCount)} elements
              </span>
              <div className="property-row">
                <span>Movement changed</span>
                <b>
                  {fmt(
                    Math.abs(
                      result.summary.maxMovement /
                        comparison.before.summary.maxMovement -
                        1,
                    ) * 100,
                    2,
                  )}
                  %
                </b>
              </div>
              <div className="property-row">
                <span>Peak stress changed</span>
                <b>
                  {fmt(
                    Math.abs(
                      result.summary.maxStress /
                        comparison.before.summary.maxStress -
                        1,
                    ) * 100,
                    2,
                  )}
                  %
                </b>
              </div>
              <p className="hint">
                One comparison is evidence, not proof of convergence. Support
                edges can produce stress singularities.
              </p>
            </div>
          )}
          <button
            className="secondary full"
            onClick={() => run("solve", true)}
            disabled={!!job}
          >
            <Layers size={16} />
            Compare with a finer mesh
          </button>
          <details className="details">
            <summary>
              Export results
              <Download size={14} />
            </summary>
            <div className="export-grid">
              <button onClick={csv}>
                <Download size={14} />
                Results CSV
              </button>
              <button onClick={screenshot}>
                <Camera size={14} />
                View image
              </button>
              <button onClick={() => exportSolver("deck")}>
                <FileText size={14} />
                Solver input
              </button>
              <button onClick={() => exportSolver("log")}>
                <FileText size={14} />
                Solver log
              </button>
            </div>
          </details>
        </>
      );
  };
  return (
    <div
      className={"app " + (window.desktop ? "desktop" : "")}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (job) return;
        const file = e.dataTransfer.files[0];
        if (file)
          /\.bsim$/i.test(file.name) ? openProject(file) : importFile(file);
      }}
    >
      <input
        className="hidden"
        ref={fileInput}
        type="file"
        accept=".step,.stp"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) importFile(file);
          e.target.value = "";
        }}
      />
      <input
        className="hidden"
        ref={projectInput}
        type="file"
        accept=".bsim"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) openProject(file);
          e.target.value = "";
        }}
      />
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <Box size={20} strokeWidth={1.8} />
          </div>
          <b>BetterSim</b>
          <span className="alpha">EARLY ACCESS</span>
        </div>
        <div className="document-title">
          {part
            ? part.name.replace(/\.(step|stp)$/i, "")
            : "A little clarity. A better design."}
          {part && <span>Linear static</span>}
        </div>
        <div className="document-actions">
          <button
            onClick={() => projectInput.current?.click()}
            disabled={!!job}
          >
            <FolderOpen size={16} />
            <span>Open</span>
          </button>
          <button onClick={() => fileInput.current?.click()} disabled={!!job}>
            <Upload size={16} />
            <span>Import STEP</span>
          </button>
          <button onClick={save} disabled={!part || !!job}>
            <Save size={16} />
            <span>Save</span>
          </button>
        </div>
      </header>
      {!part ? (
        <main className="welcome">
          <div className="welcome-content">
            <span className="eyebrow">
              <span className="green-dot" />
              OPEN-SOURCE MECHANICAL ANALYSIS
            </span>
            <h1>
              Understand your part.
              <br />
              <span>Build with confidence.</span>
            </h1>
            <p className="welcome-intro">
              From a CAD model to a clear view of stress and movement.
              <br />
              Thoughtful tools. Trusted open-source solvers. Less friction.
            </p>
            <button
              className="import-zone"
              onClick={() => fileInput.current?.click()}
              disabled={!!job}
            >
              <div className="upload-icon">
                <Upload size={26} />
              </div>
              <b>Bring your part into focus</b>
              <span>Drop a STEP file here, or click to browse</span>
              <small>.step or .stp · one solid part</small>
              <span className="primary">
                Import STEP
                <ArrowUpRight size={16} />
              </span>
            </button>
            <div className="example-heading">
              <span>Or get a feel for the workflow</span>
              <div />
            </div>
            <div className="examples">
              <button onClick={() => sample("beam")} disabled={!!job}>
                <div className="example-illustration beam">
                  <i />
                  <i />
                  <i />
                </div>
                <div>
                  <b>Cantilever beam</b>
                  <span>A simple, verifiable first study</span>
                </div>
                <ArrowUpRight size={18} />
              </button>
              <button onClick={() => sample("bracket")} disabled={!!job}>
                <div className="example-illustration bracket">
                  <i />
                  <i />
                  <i />
                </div>
                <div>
                  <b>Mounting bracket</b>
                  <span>Explore holes and curved faces</span>
                </div>
                <ArrowUpRight size={18} />
              </button>
            </div>
            {recovery && (
              <button
                className="restore"
                onClick={() => {
                  const saved = localStorage.getItem("bettersim-recovery");
                  if (saved) importPart(() => post("/open", JSON.parse(saved)));
                }}
              >
                <RotateCcw size={14} />
                Restore your last study
              </button>
            )}
            <div className="welcome-note">
              <ShieldCheck size={17} />
              <span>
                This version studies one solid part under slowly applied loads.
                <br />
                Linear elastic materials · small movements · local processing
              </span>
            </div>
          </div>
          <div className="welcome-art" aria-hidden="true">
            <div className="art-grid" />
            <div className="art-label">A BETTER WAY TO SEE</div>
            <div className="art-part">
              <div className="art-top" />
              <div className="art-front" />
              <div className="art-side" />
            </div>
            <div className="art-arrow">
              ↓<span>LOAD</span>
            </div>
            <div className="art-support">
              <i />
              <i />
              <i />
              <span>SUPPORT</span>
            </div>
            <div className="art-caption">
              <span className="green-dot" />
              Built around your engineering intent.
            </div>
            <div className="art-axes">
              <span>X</span>
              <span>Y</span>
              <span>Z</span>
            </div>
          </div>
        </main>
      ) : (
        <main className="workspace">
          <aside className="study-sidebar">
            <div className="study-name">
              <span className="eyebrow">YOUR STUDY</span>
              <h3>Static analysis</h3>
              <span className="subtle">Single part · solid elements</span>
            </div>
            <nav aria-label="Study setup">
              {(
                [
                  "part",
                  "material",
                  "supports",
                  "loads",
                  "mesh",
                  "results",
                ] as Section[]
              ).map((s, i) => {
                const done =
                  s === "part" ||
                  (s === "material" && !!study.material) ||
                  (s === "supports" && !!study.supports.length) ||
                  (s === "loads" && !!study.loads.length) ||
                  (s === "mesh" && !!mesh) ||
                  (s === "results" && !!result);
                const Icon = [
                  Box,
                  Layers,
                  ShieldCheck,
                  ArrowDown,
                  Grid3X3,
                  Activity,
                ][i];
                return (
                  <button
                    key={s}
                    className={"study-step " + (section === s ? "active" : "")}
                    onClick={() => chooseSection(s)}
                    disabled={!!job || (s === "results" && !result)}
                  >
                    <span className="step-icon">
                      <Icon size={17} />
                    </span>
                    <span>
                      <b>{labels[s]}</b>
                      <small>
                        {s === "part"
                          ? part.name.replace(/\.(step|stp)$/i, "")
                          : s === "material"
                            ? study.material?.name || "Choose a material"
                            : s === "supports"
                              ? study.supports.length
                                ? study.supports.length + " defined"
                                : "Hold the part"
                              : s === "loads"
                                ? study.loads.length
                                  ? study.loads.length + " defined"
                                  : "Apply a load"
                                : s === "mesh"
                                  ? mesh
                                    ? fmt(mesh.elementCount) + " elements"
                                    : study.detail.charAt(0).toUpperCase() +
                                      study.detail.slice(1)
                                  : result
                                    ? "Analysis complete"
                                    : "Run to see results"}
                      </small>
                    </span>
                    {done ? (
                      <Check className="step-check" size={14} />
                    ) : (
                      <span className="step-number">{i}</span>
                    )}
                  </button>
                );
              })}
            </nav>
            <div className="sidebar-bottom">
              <div className="undo-tools">
                <button
                  aria-label="Undo study edit"
                  onClick={undo}
                  disabled={!history.length || !!job}
                >
                  <Undo2 size={15} />
                </button>
                <button
                  aria-label="Redo study edit"
                  onClick={redo}
                  disabled={!future.length || !!job}
                >
                  <Redo2 size={15} />
                </button>
                <span>Study history</span>
              </div>
              <div className="solver-badge">
                <span className="green-dot" />
                <span>
                  Powered by <b>CalculiX</b>
                </span>
              </div>
              <p>Open source. Runs on your machine.</p>
            </div>
          </aside>
          <section className="viewport">
            <div className="view-heading">
              <div>
                <span className="eyebrow">
                  {result ? "RESULT VIEW" : "MODEL VIEW"}
                </span>
                <h3>
                  {result
                    ? PLOT_LABELS[plot]
                    : draft
                      ? draft.kind === "support"
                        ? "Select support faces"
                        : "Select load faces"
                      : "Make every condition clear."}
                </h3>
              </div>
              {result ? (
                <span className="view-badge">
                  <Check size={13} />
                  Solved
                </span>
              ) : (
                <span className="view-badge">
                  <Box size={13} />
                  {part.geometry.faces.length} CAD faces
                </span>
              )}
            </div>
            <Viewer
              ref={viewer}
              geometry={part.geometry}
              mesh={mesh}
              result={result}
              study={
                draft
                  ? ({
                      ...study,
                      [draft.kind === "support" ? "supports" : "loads"]: [
                        ...study[
                          draft.kind === "support" ? "supports" : "loads"
                        ].filter((c) => c.id !== draft.value.id),
                        { ...draft.value, faces: selected },
                      ],
                    } as Study)
                  : study
              }
              selected={selected}
              hovered={hover}
              onSelect={selectFace}
              onHover={setHover}
              onProbe={setProbe}
              plot={plot}
              deformation={deformation}
              wireframe={wire}
              probe={probe}
            />
            {result && (
              <div className="result-legend">
                <span>
                  {plot === "stress"
                    ? "Equivalent stress"
                    : plot === "movement"
                      ? "Total movement"
                      : "Yield margin"}
                </span>
                <b>
                  {plot === "stress"
                    ? "MPa"
                    : plot === "movement"
                      ? "mm"
                      : "× yield"}
                </b>
                <div className="legend-body">
                  <div
                    className="legend-bar"
                    style={{
                      background: `linear-gradient(to top,${(plot === "safety" ? [...palette].reverse() : palette).join(",")})`,
                    }}
                  />
                  <div className="legend-labels">
                    {[1, 0.75, 0.5, 0.25, 0].map((f) => (
                      <span key={f}>
                        {plot === "safety" && f === 1
                          ? "5+"
                          : fmt(f * legendMax, 3)}
                      </span>
                    ))}
                  </div>
                </div>
                <small>Nodal values</small>
              </div>
            )}
            {!result && selected.length > 0 && (
              <div className="selection-pill">
                <MousePointer2 size={14} />
                {selected.length} {selected.length === 1 ? "face" : "faces"}{" "}
                selected<span>{fmt(selectedArea, 1)} mm²</span>
                <button
                  aria-label="Clear selection"
                  onClick={() => setSelected([])}
                >
                  <X size={14} />
                </button>
              </div>
            )}
            {result && (
              <div className="deformation-label">
                {deform === "off"
                  ? "Original shape"
                  : `Movement shown at ${fmt(deformation, 1)}×`}
              </div>
            )}
            <div className="view-tools">
              <button
                aria-label="Fit part to view"
                title="Fit to view"
                onClick={() => viewer.current?.fit()}
              >
                <Maximize size={16} />
              </button>
              <span />
              <button onClick={() => viewer.current?.view("iso")}>3D</button>
              <button onClick={() => viewer.current?.view("front")}>
                Front
              </button>
              <button onClick={() => viewer.current?.view("top")}>Top</button>
              <button onClick={() => viewer.current?.view("right")}>
                Right
              </button>
              <span />
              <button
                aria-label="Toggle mesh edges"
                title="Mesh edges"
                className={wire ? "active" : ""}
                onClick={() => setWire(!wire)}
              >
                <Grid3X3 size={16} />
              </button>
              <button aria-label="Save view image" onClick={screenshot}>
                <Camera size={16} />
              </button>
            </div>
            <div className="view-navigation">
              Drag to rotate <span>·</span> Right-drag to pan <span>·</span>{" "}
              Scroll to zoom
            </div>
            <div className="axis-triad">
              <span className="axis-z">Z ↑</span>
              <span className="axis-y">Y ↙</span>
              <span className="axis-x">X →</span>
            </div>
          </section>
          <aside className="editor" aria-label={labels[section] + " editor"}>
            <div className="editor-content">{renderEditor()}</div>
          </aside>
        </main>
      )}
      <footer className="statusbar">
        <span>
          <span className="green-dot" />
          {job
            ? job.message
            : part
              ? result
                ? "Analysis complete · " + fmt(result.summary.seconds, 1) + " s"
                : recoveryStatus === "saved"
                  ? "Study saved locally"
                  : recoveryStatus === "saving"
                    ? "Saving study…"
                    : "Save a project to preserve your study"
              : "Ready when you are"}
        </span>
        <span>
          {hover
            ? `Face ${hover} · ${part?.geometry.faces.find((f) => f.id === hover)?.type}`
            : part
              ? `${part.geometry.dimensions.map((d) => fmt(d, 1)).join(" × ")} mm`
              : "STEP → Gmsh → CalculiX"}
          <span className="footer-separator">|</span>mm · N · MPa
        </span>
      </footer>
      {notice && (
        <div className="toast" role="status">
          <Check size={16} />
          {notice}
          <button
            onClick={() => setNotice("")}
            aria-label="Dismiss notification"
          >
            <X size={14} />
          </button>
        </div>
      )}
      {error && (
        <div className="error-panel" role="alert">
          <div>
            <Info size={19} />
            <b>Let’s resolve this.</b>
            <button
              className="icon-button"
              aria-label="Dismiss error"
              onClick={() => setError("")}
            >
              <X size={16} />
            </button>
          </div>
          <p>{error.split("\n")[0]}</p>
          {error.includes("\n") && (
            <details>
              <summary>Diagnostic details</summary>
              <pre>{error}</pre>
            </details>
          )}
          <button className="secondary" onClick={() => setError("")}>
            Back to the study
          </button>
          {part && (
            <button className="text-button" onClick={() => exportSolver("log")}>
              Save solver log
            </button>
          )}
        </div>
      )}
      {job && (
        <div className="busy-backdrop">
          <div className="busy-card" role="status">
            <div className="busy-icon">
              <LoaderCircle size={27} className="spin" />
            </div>
            <span className="eyebrow">{job.stage.toUpperCase()}</span>
            <h2>{job.message}</h2>
            <p>
              {job.stage === "solving"
                ? "Your study is running locally in CalculiX."
                : "Keeping the geometry and its surfaces connected."}
            </p>
            <div className="progress-track">
              <div />
            </div>
            <div className="busy-footer">
              <span>
                {Math.floor((Date.now() - job.started) / 1000)}s elapsed
              </span>
              <button onClick={cancel}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
function NumberField({
  label,
  value,
  unit,
  step = "any",
  onChange,
}: {
  label: string;
  value: number;
  unit?: string;
  step?: string;
  onChange: (n: number) => void;
}) {
  return (
    <label className="field">
      {label}
      <span className="number-field">
        <input
          type="number"
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        {unit && <span>{unit}</span>}
      </span>
    </label>
  );
}
