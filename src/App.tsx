import {
  useState,
  useRef,
  useEffect,
  useMemo,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  Box,
  Upload,
  FolderOpen,
  Save,
  Check,
  Plus,
  X,
  Play,
  Maximize,
  Grid3X3,
  Layers,
  ArrowDown,
  Anchor,
  Activity,
  Download,
  Camera,
  LoaderCircle,
  Trash2,
  Undo2,
  Redo2,
  MousePointer2,
  Search,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  FileText,
  Sun,
  Moon,
  type LucideIcon,
} from "lucide-react";
import { Viewer, palette, type ViewerHandle, type Theme } from "./Viewer";
import { api, post, saveFile } from "./api";
import {
  MATERIALS,
  emptyStudy,
  fmt,
  type Face,
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
type LogEntry = {
  time: number;
  kind: string;
  text: string;
  level?: "error" | "done";
};
type Failure = { title: string; message: string };
const uid = () => crypto.randomUUID();
const blankSupport = (): Support => ({
  id: uid(),
  name: "Fixed",
  faces: [],
  axes: [true, true, true],
});
const blankLoad = (): Load => ({
  id: uid(),
  name: "Force",
  kind: "force",
  faces: [],
  vector: [0, 0, -100],
  magnitude: 1,
});
const copy = <T,>(x: T): T => structuredClone(x);
const DETAILS = [
  { id: "coarse", name: "Coarse", factor: 1.5 },
  { id: "medium", name: "Medium", factor: 1 },
  { id: "fine", name: "Fine", factor: 0.65 },
] as const;
const DETAIL_NAMES: Record<Study["detail"], string> = {
  coarse: "Coarse",
  medium: "Medium",
  fine: "Fine",
  custom: "Custom",
};
const PLOTS: Record<Plot, { name: string; unit: string }> = {
  stress: { name: "von Mises stress", unit: "MPa" },
  movement: { name: "Displacement", unit: "mm" },
  safety: { name: "Yield margin", unit: "× yield" },
};
const STAGES: Record<string, string> = {
  import: "import",
  importing: "import",
  mesh: "mesh",
  meshing: "mesh",
  solve: "solve",
  checking: "check",
  solving: "solve",
  reading: "read",
};
const stripExt = (name: string) => name.replace(/\.(step|stp)$/i, "");
const facesLabel = (faces: number[]) =>
  faces.length === 1 ? "Face " + faces[0] : faces.length + " faces";
const loadValue = (l: Load) =>
  l.kind === "pressure"
    ? fmt(l.magnitude) + " MPa"
    : fmt(Math.hypot(...l.vector)) + (l.kind === "gravity" ? " m/s²" : " N");
const faceHint = (f: Face) => {
  // Planes facing a global axis are easiest to find by their position on it.
  const axis = f.normal.findIndex((n) => Math.abs(n) > 0.999);
  return f.type === "Plane" && axis >= 0
    ? `Plane · ${"xyz"[axis]} ${fmt(f.center[axis], 1)}`
    : f.type;
};
const clock = (t: number) =>
  new Date(t).toLocaleTimeString("en-GB", { hour12: false });
const readStorage = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const writeStorage = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {}
};
const systemTheme = (): Theme =>
  matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
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
    [error, setError] = useState<Failure | null>(null),
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
    [recovery, setRecovery] = useState(() => {
      if (!readStorage("bettersim-recovery")) return null;
      try {
        return JSON.parse(readStorage("bettersim-recovery-meta") || "") as {
          name: string;
          at: number;
        };
      } catch {
        return { name: "Last study", at: 0 };
      }
    });
  const [theme, setTheme] = useState<Theme>(
    () => (readStorage("bettersim-theme") as Theme | null) || systemTheme(),
  );
  const [log, setLog] = useState<LogEntry[]>([]),
    [consoleOpen, setConsoleOpen] = useState(false),
    [consoleTab, setConsoleTab] = useState<"output" | "checks">("output");
  const sequence = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null),
    projectInput = useRef<HTMLInputElement>(null),
    viewer = useRef<ViewerHandle>(null),
    active = useRef<string | null>(null),
    partRef = useRef(part),
    consoleEnd = useRef<HTMLDivElement>(null);
  partRef.current = part;
  const [recoveryStatus, setRecoveryStatus] = useState("saving");
  const [, setTick] = useState(0);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    if (readStorage("bettersim-theme")) return;
    const media = matchMedia("(prefers-color-scheme: dark)");
    const change = () => setTheme(media.matches ? "dark" : "light");
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    writeStorage("bettersim-theme", next);
    setTheme(next);
  };
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
  useEffect(() => {
    consoleEnd.current?.scrollIntoView({ block: "end" });
  }, [log, consoleOpen, consoleTab]);
  const write = (kind: string, text: string, level?: LogEntry["level"]) =>
    setLog((l) => [...l.slice(-299), { time: Date.now(), kind, text, level }]);
  const fail = (title: string, e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    setError({ title, message });
    write("error", title + ": " + message.split("\n")[0], "error");
  };
  const announce = (text: string) => {
    setNotice(text);
    write("info", text);
  };
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
  const poll = async (id: string, stage: string) => {
    active.current = id;
    let last = "";
    setJob({ id, stage, message: "Starting", started: Date.now() });
    for (;;) {
      await new Promise((r) => setTimeout(r, 350));
      if (active.current !== id) return null;
      const j = await api("/jobs/" + id);
      if (j.status === "running" && j.message !== last) {
        last = j.message;
        write(STAGES[j.stage] || j.stage, j.message);
      }
      setJob((current) =>
        current?.id === id
          ? { ...current, stage: j.stage, message: j.message }
          : current,
      );
      if (j.status === "error") throw Error(j.error);
      if (j.status === "cancelled") return null;
      if (j.status === "done") return j.data;
    }
  };
  const finish = () => {
    active.current = null;
    setJob(null);
  };
  const importPart = async (action: () => Promise<any>, title: string) => {
    const operation = ++sequence.current;
    setError(null);
    setDraft(null);
    try {
      const info = await action();
      write("import", info.name);
      const geometry = await poll(info.job, "importing");
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
      write(
        "import",
        `${geometry.dimensions.map((d: number) => fmt(d, 2)).join(" × ")} mm · ${geometry.faces.length} faces · ${fmt(geometry.volume, 1)} mm³`,
        "done",
      );
    } catch (e) {
      fail(title, e);
    } finally {
      if (sequence.current === operation) finish();
    }
  };
  const importFile = (file: File) =>
    importPart(() => {
      const body = new FormData();
      body.append("file", file);
      return api("/import", { method: "POST", body });
    }, "Import failed");
  const sample = (name: string) =>
    importPart(() => post("/sample/" + name, {}), "Could not open example");
  const openProject = async (file: File) => {
    try {
      const project = JSON.parse(await file.text());
      await importPart(() => post("/open", project), "Could not open project");
    } catch (e) {
      fail("Could not open project", e);
    }
  };
  const restore = () => {
    const saved = readStorage("bettersim-recovery");
    if (saved)
      importPart(
        () => post("/open", JSON.parse(saved)),
        "Could not restore autosave",
      );
  };
  const save = async () => {
    if (!part || job) return;
    try {
      const data = await post("/documents/" + part.id + "/save", {
        name: part.name,
        study,
      });
      if (
        await saveFile(
          stripExt(part.name) + ".bsim",
          JSON.stringify(data, null, 2),
        )
      )
        announce("Project saved");
    } catch (e) {
      fail("Save failed", e);
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
        const meta = { name: stripExt(part.name), at: Date.now() };
        localStorage.setItem("bettersim-recovery", JSON.stringify(data));
        localStorage.setItem("bettersim-recovery-meta", JSON.stringify(meta));
        setRecovery(meta);
        setRecoveryStatus("saved");
      } catch {
        setRecoveryStatus("unavailable");
      }
    }, 750);
    return () => clearTimeout(t);
  }, [part, study, job]);
  const missing = [
    !study.material ? "Material" : null,
    !study.supports.length ? "Support" : null,
    !study.loads.length ? "Load" : null,
  ].filter(Boolean) as string[];
  const ready = !!part && !missing.length && !draft;
  const run = async (action: "mesh" | "solve", refine = false) => {
    if (!part || job || (action === "solve" && !ready)) return;
    const operation = ++sequence.current;
    setError(null);
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
      const data = await poll(j.job, action === "mesh" ? "meshing" : "solve");
      if (!data) return;
      const m: Mesh = action === "mesh" ? data : data.mesh;
      write(
        "mesh",
        `${fmt(m.elementCount)} elements · ${fmt(m.nodeCount)} nodes · min quality ${fmt(m.minQuality, 3)}`,
      );
      if (action === "mesh") {
        setMesh(data);
        setWire(true);
        setSection("mesh");
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
        write(
          "solve",
          `done in ${fmt(data.result.summary.seconds, 2)} s · force balance error ${fmt(data.result.summary.forceBalanceError * 100, 4)}%`,
          "done",
        );
      }
    } catch (e) {
      fail(action === "mesh" ? "Meshing failed" : "Solve failed", e);
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
    announce("Cancelled");
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const typing =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLSelectElement;
      if (mod && e.key === "s") {
        e.preventDefault();
        save();
      } else if (mod && e.key === "o" && !job) {
        e.preventDefault();
        projectInput.current?.click();
      } else if (mod && e.key === "i" && !job) {
        e.preventDefault();
        fileInput.current?.click();
      } else if (mod && e.key === "Enter") {
        e.preventDefault();
        run("solve");
      } else if (mod && e.key === "z" && !typing) {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if (e.key === "Escape") {
        setDraft(null);
        setSelected([]);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
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
    if (s === "material") setMaterial(copy(study.material || MATERIALS[0]));
  };
  const edit = (kind: "support" | "load", value: Support | Load) => {
    if (job) return;
    setSection(kind === "support" ? "supports" : "loads");
    setDraft({ kind, value: copy(value) } as Draft);
    setSelected(value.faces);
  };
  const add = (kind: "support" | "load") => {
    if (job) return;
    setSection(kind === "support" ? "supports" : "loads");
    setDraft(
      kind === "support"
        ? { kind, value: blankSupport() }
        : { kind, value: blankLoad() },
    );
  };
  const remove = (kind: "support" | "load", id: string) => {
    const key = kind === "support" ? "supports" : "loads";
    update({ ...study, [key]: study[key].filter((c) => c.id !== id) });
    if (draft?.value.id === id) {
      setDraft(null);
      setSelected([]);
    }
  };
  const isGravity = draft?.kind === "load" && draft.value.kind === "gravity";
  const commitDraft = () => {
    if (!draft) return;
    const faces = isGravity ? [] : selected;
    if (!faces.length && !isGravity) return;
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
    announce(
      `Example setup: Aluminum 6061-T6, Face ${held.id} fixed, 100 N downward on Face ${loaded.id}`,
    );
  };
  const selectedArea =
    part?.geometry.faces
      .filter((f) => selected.includes(f.id))
      .reduce((sum, f) => sum + f.area, 0) || 0;
  const autoScale =
    result && part
      ? (Math.max(...part.geometry.dimensions) * 0.08) /
        (result.summary.maxMovement || 1)
      : 0;
  const deformation =
    result && mesh
      ? deform === "auto"
        ? autoScale
        : deform === "true"
          ? 1
          : 0
      : 0;
  const yieldStrength = study.material?.yield || null;
  const extremes = useMemo(() => {
    if (!result) return null;
    let minStress = Infinity,
      minMovement = Infinity;
    for (const v of result.stress) minStress = Math.min(minStress, v);
    for (const v of result.movement) minMovement = Math.min(minMovement, v);
    return { minStress, minMovement };
  }, [result]);
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
  const probeValues =
    result && probeIndex >= 0
      ? {
          stress: result.stress[probeIndex],
          movement: result.movement[probeIndex],
          margin:
            yieldStrength && result.stress[probeIndex] > 0
              ? yieldStrength / result.stress[probeIndex]
              : null,
        }
      : null;
  const probeLabel = probeValues
    ? plot === "stress"
      ? fmt(probeValues.stress, 3) + " MPa"
      : plot === "movement"
        ? fmt(probeValues.movement, 4) + " mm"
        : probeValues.margin
          ? fmt(probeValues.margin, 2) + "×"
          : null
    : null;
  const faceUse = useMemo(() => {
    const use = new Map<number, { kind: "support" | "load"; name: string }>();
    for (const s of study.supports)
      for (const f of s.faces) use.set(f, { kind: "support", name: s.name });
    for (const l of study.loads)
      for (const f of l.faces)
        if (!use.has(f)) use.set(f, { kind: "load", name: l.name });
    return use;
  }, [study]);
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
      if (!response.ok) throw Error("Solve the study before exporting.");
      await saveFile(
        kind === "deck" ? "analysis.inp" : "solver.log",
        await response.text(),
      );
    } catch (e) {
      fail("Export failed", e);
    }
  };
  const screenshot = async () => {
    const content = viewer.current?.screenshot();
    if (content) await saveFile("bettersim-view.png", content, "base64");
  };

  const renderInspector = () => {
    if (!part) return null;
    if (section === "part")
      return (
        <>
          <Head small="Part" title={stripExt(part.name)} />
          <div className="sec">
            <Row label="Size">
              {part.geometry.dimensions.map((d) => fmt(d, 2)).join(" × ")}
              <em>mm</em>
            </Row>
            <Row label="Volume">
              {fmt(part.geometry.volume, 1)}
              <em>mm³</em>
            </Row>
            <Row label="Faces">{part.geometry.faces.length}</Row>
            <Row label="Units">mm · N · MPa</Row>
            <p className="note">
              STEP lengths are converted to millimetres. Check the size against
              your CAD model.
            </p>
          </div>
          <div className="sec">
            <button
              className="btn primary full"
              onClick={() => chooseSection("material")}
            >
              Set material
              <ChevronRight size={14} />
            </button>
            {/Cantilever beam|Mounting bracket/.test(part.name) && (
              <button className="btn full" onClick={exampleSetup}>
                Use example setup
              </button>
            )}
          </div>
        </>
      );
    if (section === "material") {
      const valid =
        !!material.name &&
        material.young > 0 &&
        material.density > 0 &&
        material.poisson > -1 &&
        material.poisson < 0.499;
      const custom = (changes: Partial<Material>) =>
        setMaterial({ ...material, name: "Custom material", ...changes });
      return (
        <>
          <Head small="Material" title={study.material?.name || "Not set"} />
          <div className="sec">
            <h4>Presets</h4>
            <div className="presets">
              {MATERIALS.map((m) => (
                <button
                  key={m.name}
                  onClick={() => setMaterial(copy(m))}
                  className={material.name === m.name ? "on" : ""}
                >
                  <span>
                    {m.name}
                    <small>
                      {fmt(m.young / 1000, 1)} GPa · {fmt(m.density)} kg/m³
                    </small>
                  </span>
                  {material.name === m.name && <Check size={14} />}
                </button>
              ))}
            </div>
          </div>
          <div className="sec">
            <h4>Properties</h4>
            <label className="field">
              <span>Name</span>
              <input
                className="input"
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
              onChange={(v) => custom({ young: v })}
            />
            <NumberField
              label="Poisson ratio"
              value={material.poisson}
              step="0.01"
              onChange={(v) => custom({ poisson: v })}
            />
            <NumberField
              label="Density"
              value={material.density}
              unit="kg/m³"
              onChange={(v) => custom({ density: v })}
            />
            <NumberField
              label="Yield strength (optional)"
              value={material.yield ?? 0}
              unit="MPa"
              onChange={(v) => custom({ yield: v || null })}
            />
            <p className="note">
              Preset values are typical. Use your material's specification.
            </p>
          </div>
          <div className="sec">
            <button
              className="btn primary full"
              disabled={!valid}
              onClick={() => {
                update({ ...study, material: copy(material) });
                if (!study.supports.length) setSection("supports");
              }}
            >
              Apply material
            </button>
          </div>
        </>
      );
    }
    if ((section === "supports" || section === "loads") && !draft) {
      const kind = section === "supports" ? "support" : "load";
      const list: (Support | Load)[] =
        kind === "support" ? study.supports : study.loads;
      return (
        <>
          <Head
            small={kind === "support" ? "Supports" : "Loads"}
            title={list.length ? list.length + " defined" : "None"}
          />
          <div className="sec">
            {list.map((c) => (
              <div className="list-item" key={c.id}>
                <button onClick={() => edit(kind, c)}>
                  <span className={"swatch " + kind} />
                  {c.name}
                  <span className="val">
                    {kind === "load" ? loadValue(c as Load) + " · " : ""}
                    {(c as Load).kind === "gravity"
                      ? "whole part"
                      : facesLabel(c.faces)}
                  </span>
                </button>
                <button
                  className="icon-button delete"
                  aria-label={"Delete " + c.name}
                  onClick={() => remove(kind, c.id)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            {!list.length && (
              <p className="note" style={{ marginTop: 0 }}>
                {kind === "support"
                  ? "Supports hold faces in place. A study needs at least one."
                  : "Loads are forces, pressures or gravity acting on the part."}
              </p>
            )}
          </div>
          <div className="sec">
            <button
              className={"btn full" + (list.length ? "" : " primary")}
              onClick={() => add(kind)}
            >
              <Plus size={14} />
              {kind === "support" ? "Add support" : "Add load"}
            </button>
            {selected.length > 0 && (
              <p className="note">
                The {selected.length} selected{" "}
                {selected.length === 1 ? "face" : "faces"} will be used.
              </p>
            )}
          </div>
        </>
      );
    }
    if (draft) {
      const exists = (
        draft.kind === "support" ? study.supports : study.loads
      ).some((c) => c.id === draft.value.id);
      const invalid =
        !draft.value.name ||
        (!selected.length && !isGravity) ||
        (draft.kind === "support" && !draft.value.axes.some(Boolean)) ||
        (draft.kind === "load" &&
          (draft.value.kind === "pressure"
            ? draft.value.magnitude === 0
            : draft.value.vector.every((v) => v === 0)));
      return (
        <>
          <Head
            small={
              (exists ? "Edit " : "New ") +
              (draft.kind === "support" ? "support" : "load")
            }
            title={draft.value.name || "Untitled"}
          />
          <div className="sec">
            <label className="field">
              <span>Name</span>
              <input
                className="input"
                value={draft.value.name}
                onChange={(e) => changeDraft({ name: e.target.value })}
              />
            </label>
            {draft.kind === "support" ? (
              <>
                <div className="field">
                  <span>Type</span>
                  <div className="seg">
                    {(["Fixed", "Directional"] as const).map((t) => {
                      const fixed = draft.value.axes.every(Boolean);
                      const on = (t === "Fixed") === fixed;
                      return (
                        <button
                          key={t}
                          className={on ? "on" : ""}
                          onClick={() =>
                            !on &&
                            changeDraft({
                              axes:
                                t === "Fixed"
                                  ? [true, true, true]
                                  : [false, false, true],
                              name:
                                draft.value.name === "Fixed" ||
                                draft.value.name === "Directional"
                                  ? t
                                  : draft.value.name,
                            })
                          }
                        >
                          {t}
                        </button>
                      );
                    })}
                  </div>
                </div>
                {!draft.value.axes.every(Boolean) && (
                  <div className="field">
                    <span>Blocked directions</span>
                    <div className="axes">
                      {["X", "Y", "Z"].map((a, i) => (
                        <button
                          key={a}
                          aria-pressed={draft.value.axes[i]}
                          className={draft.value.axes[i] ? "on" : ""}
                          onClick={() =>
                            changeDraft({
                              axes: draft.value.axes.map((v, j) =>
                                j === i ? !v : v,
                              ),
                            })
                          }
                        >
                          <b>{a}</b>
                          {draft.value.axes[i] ? "Blocked" : "Free"}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <p className="note">
                  {draft.value.axes.every(Boolean)
                    ? "Blocks movement in X, Y and Z."
                    : "Global directions. The solver rejects supports that leave the part free to move."}
                </p>
              </>
            ) : (
              <>
                <div className="field">
                  <span>Type</span>
                  <div className="seg">
                    {(["force", "pressure", "gravity"] as const).map((k) => (
                      <button
                        key={k}
                        className={draft.value.kind === k ? "on" : ""}
                        onClick={() =>
                          draft.value.kind !== k &&
                          changeDraft({
                            kind: k,
                            name: ["Force", "Pressure", "Gravity"].includes(
                              draft.value.name,
                            )
                              ? k[0].toUpperCase() + k.slice(1)
                              : draft.value.name,
                            vector:
                              k === "gravity" ? [0, 0, -9.81] : [0, 0, -100],
                          })
                        }
                      >
                        {k[0].toUpperCase() + k.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
                {draft.value.kind === "pressure" ? (
                  <>
                    <NumberField
                      label="Pressure"
                      value={draft.value.magnitude}
                      unit="MPa"
                      onChange={(v) => changeDraft({ magnitude: v })}
                    />
                    <p className="note">
                      Positive pressure pushes into the surface.
                    </p>
                  </>
                ) : (
                  <>
                    <div className="field">
                      <span>
                        {draft.value.kind === "gravity"
                          ? "Acceleration, m/s²"
                          : "Total force, N"}
                      </span>
                      <div className="vec">
                        {["X", "Y", "Z"].map((a, i) => (
                          <label key={a}>
                            <span>{a}</span>
                            <input
                              aria-label={
                                a +
                                (draft.value.kind === "gravity"
                                  ? " acceleration"
                                  : " force")
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
                    </div>
                    <Row label="Magnitude">
                      {fmt(Math.hypot(...draft.value.vector))}
                      <em>{draft.value.kind === "gravity" ? "m/s²" : "N"}</em>
                    </Row>
                    <p className="note">
                      {draft.value.kind === "force"
                        ? "Split across the selected faces by area."
                        : "Acts on the whole part using the material density."}
                    </p>
                  </>
                )}
              </>
            )}
          </div>
          {!isGravity && (
            <div className="sec">
              <h4>
                Faces
                <span className="mono">
                  {selected.length
                    ? `${selected.length} · ${fmt(selectedArea, 1)} mm²`
                    : "none"}
                </span>
              </h4>
              {selected.length > 0 && (
                <div className="chips">
                  {selected.map((id) => (
                    <span className={"chip " + draft.kind} key={id}>
                      Face {id}
                      <button
                        aria-label={"Remove face " + id}
                        onClick={() => selectFace(id)}
                      >
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <p className="note">Click faces in the view or the face list.</p>
            </div>
          )}
          <div className="sec">
            <div className="row2">
              <button
                className="btn"
                onClick={() => {
                  setDraft(null);
                  setSelected([]);
                }}
              >
                Cancel
              </button>
              <button
                className="btn primary"
                disabled={invalid}
                onClick={commitDraft}
              >
                Save {draft.kind}
              </button>
            </div>
            {exists && (
              <button
                className="btn danger full"
                onClick={() => remove(draft.kind, draft.value.id)}
              >
                <Trash2 size={13} />
                Delete
              </button>
            )}
          </div>
        </>
      );
    }
    if (section === "mesh")
      return (
        <>
          <Head small="Mesh" title={DETAIL_NAMES[study.detail]} />
          <div className="sec">
            <div className="field">
              <span>Density</span>
              <div className="seg">
                {DETAILS.map((d) => (
                  <button
                    key={d.id}
                    className={study.detail === d.id ? "on" : ""}
                    onClick={() =>
                      update({
                        ...study,
                        detail: d.id,
                        meshSize: part.geometry.recommendedSize * d.factor,
                      })
                    }
                  >
                    {d.name}
                  </button>
                ))}
              </div>
            </div>
            <NumberField
              label="Element size"
              unit="mm"
              value={Number(study.meshSize.toPrecision(4))}
              onChange={(v) =>
                update({ ...study, detail: "custom", meshSize: v })
              }
            />
            <p className="note">
              Quadratic tetrahedra (C3D10), refined on curved faces.
            </p>
          </div>
          {mesh && (
            <div className="sec">
              <Row label="Elements">{fmt(mesh.elementCount)}</Row>
              <Row label="Nodes">{fmt(mesh.nodeCount)}</Row>
              <Row label="Minimum quality">{fmt(mesh.minQuality, 3)}</Row>
            </div>
          )}
          <div className="sec">
            {missing.length > 0 && (
              <>
                <h4>Needed before solving</h4>
                <ul className="missing">
                  {missing.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </>
            )}
            <button
              className="btn full"
              onClick={() => run("mesh")}
              disabled={!!job || study.meshSize <= 0}
            >
              <Grid3X3 size={14} />
              {mesh ? "Rebuild mesh" : "Preview mesh"}
            </button>
            <button
              className="btn primary full"
              disabled={!ready || !!job || study.meshSize <= 0}
              onClick={() => run("solve")}
            >
              <Play size={12} fill="currentColor" />
              Solve
            </button>
          </div>
        </>
      );
    if (section === "results" && result && extremes) {
      const s = result.summary;
      const peak =
        plot === "stress"
          ? { value: fmt(s.maxStress, 2), node: s.stressNode, label: "Maximum" }
          : plot === "movement"
            ? {
                value: fmt(s.maxMovement, 4),
                node: s.movementNode,
                label: "Maximum",
              }
            : {
                value: s.minSafety ? fmt(s.minSafety, 2) : "—",
                node: s.stressNode,
                label: "Minimum",
              };
      return (
        <>
          <Head small="Result" title={PLOTS[plot].name} />
          <div className="sec">
            <div className="big">
              <strong>{peak.value}</strong>
              <span>{PLOTS[plot].unit}</span>
            </div>
            <Row label={peak.label}>node {peak.node}</Row>
            {plot === "safety" ? (
              <Row label="Yield strength">
                {fmt(yieldStrength || 0)}
                <em>MPa</em>
              </Row>
            ) : (
              <Row label="Minimum">
                {plot === "stress"
                  ? fmt(extremes.minStress, 3)
                  : fmt(extremes.minMovement, 4)}
                <em>{PLOTS[plot].unit}</em>
              </Row>
            )}
            <div className="kv">
              <span>Location</span>
              <button className="link" onClick={() => setProbe(peak.node)}>
                Show in view
              </button>
            </div>
          </div>
          <div className="sec">
            <h4>Display</h4>
            <div className="field">
              <span>Shape</span>
              <div className="seg" role="group" aria-label="Shape">
                <button
                  className={deform === "off" ? "on" : ""}
                  onClick={() => setDeform("off")}
                >
                  Undeformed
                </button>
                <button
                  className={deform === "true" ? "on" : ""}
                  onClick={() => setDeform("true")}
                >
                  1×
                </button>
                <button
                  className={deform === "auto" ? "on" : ""}
                  onClick={() => setDeform("auto")}
                  aria-label="Magnified"
                >
                  {fmt(autoScale, autoScale >= 100 ? 0 : 1)}×
                </button>
              </div>
            </div>
            <div className="switch-row">
              <span>Mesh edges</span>
              <button
                className={"switch" + (wire ? " on" : "")}
                role="switch"
                aria-checked={wire}
                aria-label="Mesh edges"
                onClick={() => setWire(!wire)}
              />
            </div>
          </div>
          <div className="sec probe-card">
            <h4>
              Probe
              {probeValues ? (
                <button className="link" onClick={() => setProbe(null)}>
                  Clear
                </button>
              ) : (
                <span className="mono">click model</span>
              )}
            </h4>
            {probeValues && mesh ? (
              <>
                <Row label="Node">{probe}</Row>
                <Row label="Position">
                  {mesh.surface.positions
                    .slice(probeIndex * 3, probeIndex * 3 + 3)
                    .map((n) => fmt(n, 2))
                    .join(", ")}
                  <em>mm</em>
                </Row>
                <Row label="Stress">
                  {fmt(probeValues.stress, 3)}
                  <em>MPa</em>
                </Row>
                <Row label="Displacement">
                  {fmt(probeValues.movement, 5)}
                  <em>mm</em>
                </Row>
                {probeValues.margin && (
                  <Row label="Yield margin">
                    {probeValues.margin >= 1000
                      ? "> 1000"
                      : fmt(probeValues.margin, 2)}
                    <em>×</em>
                  </Row>
                )}
              </>
            ) : (
              <p className="note" style={{ marginTop: 0 }}>
                Click the model to read values at the nearest node.
              </p>
            )}
          </div>
          <div className="sec">
            <h4>Mesh sensitivity</h4>
            {comparison && (
              <div className="comparison">
                <Row label="Elements">
                  {fmt(comparison.before.elementCount)} →{" "}
                  {fmt(result.elementCount)}
                </Row>
                <Row label="Displacement change">
                  {fmt(
                    Math.abs(
                      s.maxMovement / comparison.before.summary.maxMovement - 1,
                    ) * 100,
                    2,
                  )}
                  <em>%</em>
                </Row>
                <Row label="Peak stress change">
                  {fmt(
                    Math.abs(
                      s.maxStress / comparison.before.summary.maxStress - 1,
                    ) * 100,
                    2,
                  )}
                  <em>%</em>
                </Row>
                <div style={{ height: 8 }} />
              </div>
            )}
            <button
              className="btn full"
              onClick={() => run("solve", true)}
              disabled={!!job}
            >
              <Layers size={14} />
              Re-solve with {fmt((mesh?.size || study.meshSize) * 0.7, 2)} mm
              mesh
            </button>
          </div>
          <div className="sec">
            <h4>Export</h4>
            <div className="exports">
              <button className="btn" onClick={csv}>
                <Download size={13} />
                Nodes CSV
              </button>
              <button className="btn" onClick={screenshot}>
                <Camera size={13} />
                View PNG
              </button>
              <button className="btn" onClick={() => exportSolver("deck")}>
                <FileText size={13} />
                Deck .inp
              </button>
              <button className="btn" onClick={() => exportSolver("log")}>
                <FileText size={13} />
                Solver log
              </button>
            </div>
          </div>
          {result.warnings
            .filter((w) => !w.startsWith("Peak stress"))
            .map((w) => (
              <p className="foot note warn" key={w}>
                {w}
              </p>
            ))}
          <p className="foot">
            Linear elastic, isotropic, small deformation, static load. Peak
            stress at supports and sharp corners can keep rising with
            refinement.
          </p>
        </>
      );
    }
    return null;
  };

  const renderTree = () => {
    if (!part) return null;
    const newDraft =
      draft &&
      !(draft.kind === "support" ? study.supports : study.loads).some(
        (c) => c.id === draft.value.id,
      );
    return (
      <nav className="tree" aria-label="Study">
        <Node
          icon={Box}
          label={stripExt(part.name)}
          value={part.geometry.dimensions.map((d) => fmt(d, 1)).join("×")}
          active={section === "part"}
          onClick={() => chooseSection("part")}
          disabled={!!job}
        />
        <Node
          depth={1}
          icon={Layers}
          label="Material"
          value={study.material?.name || "not set"}
          active={section === "material"}
          onClick={() => chooseSection("material")}
          disabled={!!job}
        />
        <Group
          label="Supports"
          active={section === "supports" && !draft}
          onClick={() => chooseSection("supports")}
          onAdd={() => add("support")}
          addLabel="Add support"
          disabled={!!job}
        />
        {study.supports.map((s) => (
          <Node
            key={s.id}
            depth={2}
            swatch="support"
            label={s.name}
            value={facesLabel(s.faces)}
            active={draft?.value.id === s.id}
            onClick={() => edit("support", s)}
            disabled={!!job}
          />
        ))}
        {newDraft && draft.kind === "support" && (
          <Node
            depth={2}
            swatch="support"
            label={draft.value.name || "Untitled"}
            value="new"
            active
          />
        )}
        <Group
          label="Loads"
          active={section === "loads" && !draft}
          onClick={() => chooseSection("loads")}
          onAdd={() => add("load")}
          addLabel="Add load"
          disabled={!!job}
        />
        {study.loads.map((l) => (
          <Node
            key={l.id}
            depth={2}
            swatch="load"
            label={l.name}
            value={loadValue(l)}
            active={draft?.value.id === l.id}
            onClick={() => edit("load", l)}
            disabled={!!job}
          />
        ))}
        {newDraft && draft.kind === "load" && (
          <Node
            depth={2}
            swatch="load"
            label={draft.value.name || "Untitled"}
            value="new"
            active
          />
        )}
        <Node
          depth={1}
          icon={Grid3X3}
          label="Mesh"
          value={
            mesh ? fmt(mesh.elementCount) + " el" : DETAIL_NAMES[study.detail]
          }
          active={section === "mesh"}
          onClick={() => chooseSection("mesh")}
          disabled={!!job}
        />
        {result ? (
          <>
            <Node
              depth={1}
              icon={Activity}
              label="Results"
              value={fmt(result.summary.seconds, 2) + " s"}
              group
              onClick={() => chooseSection("results")}
              disabled={!!job}
            />
            {(Object.keys(PLOTS) as Plot[]).map((k) => (
              <Node
                key={k}
                depth={2}
                label={PLOTS[k].name}
                active={section === "results" && plot === k}
                disabled={!!job || (k === "safety" && !yieldStrength)}
                onClick={() => {
                  setPlot(k);
                  chooseSection("results");
                }}
              />
            ))}
          </>
        ) : (
          <Node
            depth={1}
            icon={Activity}
            label="Results"
            value="not solved"
            dim
            disabled
          />
        )}
      </nav>
    );
  };

  const lastLog = log.at(-1);
  const status = job
    ? job.message
    : notice ||
      (part
        ? result
          ? `Solved · ${fmt(result.summary.seconds, 2)} s`
          : recoveryStatus === "saved"
            ? "Saved locally"
            : recoveryStatus === "saving"
              ? "Saving…"
              : "Autosave unavailable. Save a project to keep this study."
        : "Ready");
  return (
    <div
      className={
        "app " + (window.desktop?.platform === "darwin" ? "desktop" : "")
      }
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
      <header className="titlebar">
        <div className="crumb">
          <b>BetterSim</b>
          {part && (
            <>
              <span className="sep">/</span>
              <span>{stripExt(part.name)}</span>
              <span className="sep">/</span>
              <span className="faint">Linear static</span>
            </>
          )}
        </div>
        <div className="spacer" />
        {part && (
          <>
            <button
              className="tb"
              onClick={() => projectInput.current?.click()}
              disabled={!!job}
              title="Open project (⌘O)"
            >
              <FolderOpen size={14} />
              Open
            </button>
            <button
              className="tb"
              onClick={() => fileInput.current?.click()}
              disabled={!!job}
              title="Import STEP (⌘I)"
            >
              <Upload size={14} />
              Import
            </button>
            <button
              className="tb"
              onClick={save}
              disabled={!!job}
              title="Save project (⌘S)"
            >
              <Save size={14} />
              Save
            </button>
            <span className="divider" />
            <button
              className="tb"
              aria-label="Undo study edit"
              title="Undo (⌘Z)"
              onClick={undo}
              disabled={!history.length || !!job}
            >
              <Undo2 size={14} />
            </button>
            <button
              className="tb"
              aria-label="Redo study edit"
              title="Redo (⇧⌘Z)"
              onClick={redo}
              disabled={!future.length || !!job}
            >
              <Redo2 size={14} />
            </button>
          </>
        )}
        <button
          className="tb"
          aria-label={theme === "dark" ? "Use light theme" : "Use dark theme"}
          title={theme === "dark" ? "Light theme" : "Dark theme"}
          onClick={toggleTheme}
        >
          {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
        </button>
        {part && (
          <button
            className="solve"
            onClick={() => run("solve")}
            disabled={!ready || !!job}
            title={
              draft
                ? "Save or cancel the " + draft.kind + " first"
                : missing.length
                  ? "Needs: " + missing.join(", ").toLowerCase()
                  : "Solve (⌘↵)"
            }
          >
            <Play size={11} />
            Solve
            <kbd>⌘↵</kbd>
          </button>
        )}
      </header>

      {!part ? (
        <main className="start">
          <div className="start-card">
            <div className="start-left">
              <div className="start-name">
                <div className="mark">
                  <Box size={16} />
                </div>
                <div>
                  <h1>BetterSim</h1>
                  <span>0.1.0</span>
                </div>
              </div>
              <button
                className="act"
                onClick={() => fileInput.current?.click()}
                disabled={!!job}
              >
                <Upload size={15} />
                Import STEP…
                <kbd>⌘I</kbd>
              </button>
              <button
                className="act"
                onClick={() => projectInput.current?.click()}
                disabled={!!job}
              >
                <FolderOpen size={15} />
                Open project…
                <kbd>⌘O</kbd>
              </button>
              <p className="scope">
                Linear static analysis of one solid part. Units: mm, N, MPa.
                Solves locally with CalculiX.
              </p>
            </div>
            <div className="start-right">
              {recovery && (
                <>
                  <h2>Recent</h2>
                  <div className="start-list">
                    <button onClick={restore} disabled={!!job}>
                      <b>{recovery.name}</b>
                      <small>
                        {recovery.at
                          ? "Autosaved " +
                            new Date(recovery.at).toLocaleString([], {
                              dateStyle: "medium",
                              timeStyle: "short",
                            })
                          : "Autosave"}
                      </small>
                      <span className="r">Restore</span>
                    </button>
                  </div>
                </>
              )}
              <h2>Examples</h2>
              <div className="start-list">
                <button onClick={() => sample("beam")} disabled={!!job}>
                  <b>Cantilever beam</b>
                  <small>100 × 20 × 10 mm · 6 faces</small>
                  <span className="r">Open</span>
                </button>
                <button onClick={() => sample("bracket")} disabled={!!job}>
                  <b>Mounting bracket</b>
                  <small>70 × 45 × 50 mm · 4 holes</small>
                  <span className="r">Open</span>
                </button>
              </div>
              <p className="dropnote">
                Drop a .step, .stp or .bsim file anywhere in this window.
              </p>
            </div>
          </div>
        </main>
      ) : (
        <main className="main">
          <aside className="pane left">
            <div className="phead">Study</div>
            {renderTree()}
            <div className="faces">
              <div className="phead">
                Faces
                <span className="mono faint">{part.geometry.faces.length}</span>
              </div>
              {part.geometry.faces.length > 8 && (
                <label className="face-search">
                  <Search size={12} />
                  <input
                    aria-label="Filter faces"
                    placeholder="Filter by number or type"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
              )}
              <div className="face-list">
                {part.geometry.faces
                  .filter((f) =>
                    (f.id + " " + f.type)
                      .toLowerCase()
                      .includes(query.trim().toLowerCase()),
                  )
                  .map((f) => {
                    const use = faceUse.get(f.id);
                    const isSelected = selected.includes(f.id);
                    return (
                      <button
                        key={f.id}
                        className={
                          "face-row" +
                          (isSelected
                            ? " selected " + (draft?.kind || "")
                            : "") +
                          (hover === f.id ? " hovered" : "")
                        }
                        onClick={() => selectFace(f.id)}
                        onMouseEnter={() => setHover(f.id)}
                        onMouseLeave={() => setHover(null)}
                        aria-pressed={isSelected}
                        aria-label={`Face ${f.id}, ${f.type}, ${fmt(f.area, 1)} mm²${use ? ", " + use.name : ""}`}
                        title={`Center ${f.center.map((c) => fmt(c, 1)).join(", ")} mm`}
                        disabled={!!job || !!result}
                      >
                        <b>{f.id}</b>
                        <span>{faceHint(f)}</span>
                        {use ? (
                          <span className={"tag " + use.kind}>{use.name}</span>
                        ) : (
                          <span className="tag">{fmt(f.area, 1)}</span>
                        )}
                      </button>
                    );
                  })}
              </div>
            </div>
          </aside>

          <section className="center">
            <div className="viewport">
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
                probeLabel={probeLabel}
                theme={theme}
                draftKind={draft?.kind || null}
              />
              <div className="vlabel">
                {result ? (
                  <>
                    <b>{PLOTS[plot].name}</b>
                    <span>{PLOTS[plot].unit} · nodal</span>
                  </>
                ) : draft ? (
                  <>
                    <b>Select faces for {draft.value.name || draft.kind}</b>
                    <span>click to add or remove</span>
                  </>
                ) : mesh ? (
                  <>
                    <b>Mesh</b>
                    <span>
                      {fmt(mesh.elementCount)} elements · {fmt(mesh.size, 2)} mm
                    </span>
                  </>
                ) : (
                  <>
                    <b>Model</b>
                    <span>{part.geometry.faces.length} faces</span>
                  </>
                )}
              </div>
              <div className="vbar">
                <button
                  aria-label="Fit part to view"
                  title="Fit"
                  onClick={() => viewer.current?.fit()}
                >
                  <Maximize size={14} />
                </button>
                <span className="div" />
                {(
                  [
                    ["iso", "Iso"],
                    ["front", "Front"],
                    ["top", "Top"],
                    ["right", "Right"],
                  ] as const
                ).map(([v, name]) => (
                  <button key={v} onClick={() => viewer.current?.view(v)}>
                    {name}
                  </button>
                ))}
                <span className="div" />
                <button
                  aria-label="Toggle mesh edges"
                  title="Mesh edges"
                  className={wire ? "on" : ""}
                  onClick={() => setWire(!wire)}
                >
                  <Grid3X3 size={14} />
                </button>
                <button
                  aria-label="Save view image"
                  title="Save image"
                  onClick={screenshot}
                >
                  <Camera size={14} />
                </button>
              </div>
              {result && (
                <div
                  className="legend"
                  aria-label={PLOTS[plot].name + " scale"}
                >
                  <div
                    className="bar"
                    style={{
                      background: `linear-gradient(to top,${(plot === "safety" ? [...palette].reverse() : palette).join(",")})`,
                    }}
                  />
                  {[1, 0.75, 0.5, 0.25, 0].map((f) => (
                    <span key={f}>
                      {plot === "safety" && f === 1
                        ? "5+"
                        : fmt(f * legendMax, 3)}
                    </span>
                  ))}
                </div>
              )}
              {result && (
                <div className="vchip">
                  {deform === "off"
                    ? "Undeformed"
                    : deform === "true"
                      ? "True scale"
                      : `Displacement ×${fmt(deformation, deformation >= 100 ? 0 : 1)}`}
                </div>
              )}
              {!result && selected.length > 0 && (
                <div className="selpill">
                  <MousePointer2 size={13} />
                  {selected.length === 1
                    ? "Face " + selected[0]
                    : selected.length + " faces"}{" "}
                  · {fmt(selectedArea, 1)} mm²
                  <button
                    aria-label="Clear selection"
                    onClick={() => setSelected([])}
                  >
                    <X size={13} />
                  </button>
                </div>
              )}
            </div>
            <div className={"console" + (consoleOpen ? " open" : "")}>
              <div className="console-tabs">
                {(["output", "checks"] as const).map((t) => (
                  <button
                    key={t}
                    className={consoleTab === t ? "on" : ""}
                    onClick={() => {
                      if (consoleOpen && consoleTab === t)
                        setConsoleOpen(false);
                      else {
                        setConsoleTab(t);
                        setConsoleOpen(true);
                      }
                    }}
                  >
                    {t === "output" ? "Output" : "Checks"}
                  </button>
                ))}
                <span className="last">
                  {!consoleOpen && lastLog ? lastLog.text : ""}
                </span>
                <button
                  className="toggle"
                  aria-label={consoleOpen ? "Hide console" : "Show console"}
                  onClick={() => setConsoleOpen(!consoleOpen)}
                >
                  {consoleOpen ? (
                    <ChevronDown size={14} />
                  ) : (
                    <ChevronUp size={14} />
                  )}
                </button>
              </div>
              {consoleOpen && (
                <div className="console-body">
                  {consoleTab === "output" ? (
                    log.length ? (
                      log.map((l, i) => (
                        <div className={"log-line " + (l.level || "")} key={i}>
                          <span className="t">{clock(l.time)}</span>
                          <span className="k">{l.kind}</span>
                          <span className="m">{l.text}</span>
                        </div>
                      ))
                    ) : (
                      <div className="console-empty">No output yet.</div>
                    )
                  ) : result ? (
                    <>
                      <Check2 label="Solver" value={result.solver} />
                      <Check2
                        label="Mesh"
                        value={`${fmt(result.elementCount)} C3D10 · ${fmt(result.nodeCount)} nodes · ${fmt(result.meshSize, 3)} mm`}
                      />
                      <Check2
                        label="Applied force X, Y, Z"
                        value={
                          result.summary.appliedForce
                            .map((v) => fmt(v, 2))
                            .join(", ") + " N"
                        }
                      />
                      <Check2
                        label="Reaction X, Y, Z"
                        value={
                          result.summary.reactions
                            .map((v) => fmt(v, 2))
                            .join(", ") + " N"
                        }
                      />
                      <Check2
                        label="Force balance error"
                        value={
                          fmt(result.summary.forceBalanceError * 100, 4) + "%"
                        }
                      />
                      <Check2
                        label="Solve time"
                        value={fmt(result.summary.seconds, 2) + " s"}
                      />
                      {result.warnings.map((w) => (
                        <div key={w} className="check-row">
                          {w}
                        </div>
                      ))}
                    </>
                  ) : (
                    <div className="console-empty">
                      Checks appear after a solve.
                    </div>
                  )}
                  <div ref={consoleEnd} />
                </div>
              )}
            </div>
          </section>

          <aside className="pane right" aria-label="Inspector">
            {renderInspector()}
          </aside>
        </main>
      )}

      <footer className="statusbar status">
        <span>
          {(job || part) && <span className={"dot" + (job ? " busy" : "")} />}
          {status}
        </span>
        <span className="spacer" />
        {part && (
          <span>
            {hover
              ? `Face ${hover} · ${part.geometry.faces.find((f) => f.id === hover)?.type}`
              : part.geometry.dimensions.map((d) => fmt(d, 1)).join(" × ") +
                " mm"}
          </span>
        )}
        <span>mm · N · MPa</span>
      </footer>

      {error && (
        <div
          className={"error-panel" + (part ? "" : " start-error")}
          role="alert"
        >
          <h2>{error.title}</h2>
          <p>{error.message.split("\n")[0]}</p>
          {error.message.includes("\n") && (
            <details>
              <summary>Details</summary>
              <pre>{error.message}</pre>
            </details>
          )}
          <div className="row">
            <button className="btn" onClick={() => setError(null)}>
              Dismiss
            </button>
            {part && error.title === "Solve failed" && (
              <button className="btn" onClick={() => exportSolver("log")}>
                Save solver log
              </button>
            )}
          </div>
        </div>
      )}
      {job && (
        <div className="busy-backdrop">
          <div className="busy-card" role="status">
            <div className="stage">
              <LoaderCircle size={13} className="spin" />
              {STAGES[job.stage] || job.stage}
            </div>
            <h2>{job.message}</h2>
            <div className="progress">
              <div />
            </div>
            <div className="busy-foot">
              <span>{Math.floor((Date.now() - job.started) / 1000)} s</span>
              <button className="btn" onClick={cancel}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
function Head({ small, title }: { small: string; title: string }) {
  return (
    <div className="ihead">
      <small>{small}</small>
      <h2>{title}</h2>
    </div>
  );
}
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="kv">
      <span>{label}</span>
      <b>{children}</b>
    </div>
  );
}
function Check2({ label, value }: { label: string; value: string }) {
  return (
    <div className="check-row">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}
function Node({
  depth = 0,
  icon: Icon,
  swatch,
  label,
  value,
  active,
  dim,
  group,
  disabled,
  onClick,
}: {
  depth?: number;
  icon?: LucideIcon;
  swatch?: "support" | "load";
  label: string;
  value?: string;
  active?: boolean;
  dim?: boolean;
  group?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      className={
        "node" +
        (active ? " active" : "") +
        (dim ? " dim" : "") +
        (group ? " group" : "")
      }
      style={{ "--d": depth } as CSSProperties}
      onClick={onClick}
      disabled={disabled}
    >
      {Icon && <Icon size={14} />}
      {swatch && <span className={"swatch " + swatch} />}
      <span className="label">{label}</span>
      {value && <span className="val">{value}</span>}
    </button>
  );
}
function Group({
  label,
  active,
  onClick,
  onAdd,
  addLabel,
  disabled,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  onAdd: () => void;
  addLabel: string;
  disabled: boolean;
}) {
  return (
    <div className="group-row">
      <Node
        depth={1}
        icon={label === "Supports" ? Anchor : ArrowDown}
        label={label}
        group
        active={active}
        onClick={onClick}
        disabled={disabled}
      />
      <button
        className="add"
        aria-label={addLabel}
        title={addLabel}
        onClick={onAdd}
        disabled={disabled}
      >
        <Plus size={13} />
      </button>
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
      <span>{label}</span>
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
