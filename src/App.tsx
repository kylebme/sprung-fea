import { useState, useRef, useEffect, useMemo } from "react";
import {
  Camera,
  FolderOpen,
  Grid3X3,
  Maximize,
  Moon,
  MousePointer2,
  Play,
  Redo2,
  Save,
  Sun,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import {
  Viewer,
  palette,
  type Projection,
  type ViewerHandle,
  type Theme,
} from "./Viewer";
import { api, post, saveFile } from "./api";
import { SYSTEM_LABEL, unitLabel, type UnitSystem } from "./units";
import { UnitsContext } from "./ui";
import {
  fmt,
  history,
  conditionsOf,
  LISTS,
  marginScale,
  meshStillValid,
  normalizeResult,
  previewStudy,
  restoreResults,
  type Draft,
  type History,
  type HistoryAction,
  type SavedResults,
} from "./logic";
import {
  ANALYSES,
  analysisName,
  quantity,
  plotInfo,
  STAGES,
  blankLoad,
  blankMass,
  blankSupport,
  blankThermal,
  isBodyLoad,
  stripExt,
} from "./labels";
import { StartScreen, type Recovery } from "./StartScreen";
import { FaceList, StudyTree, type Section } from "./Sidebar";
import { Console, JobCard, type Job, type LogEntry } from "./Console";
import {
  AnalysisPanel,
  ConditionEditor,
  ConditionsPanel,
  MaterialPanel,
  MeshPanel,
  PartPanel,
  ResultsPanel,
  type Comparison,
} from "./Inspector";
import {
  MATERIALS,
  emptyStudy,
  type Filters,
  type Geometry,
  type Load,
  type Mesh,
  type MeshInfo,
  type Part,
  type Plot,
  type Result,
  type ResultInfo,
  type Study,
  type Condition,
  type ConditionKind,
  type ConvergenceOptions,
  type Region,
  type RegionResult,
  type Threads,
  type Cpus,
} from "./types";
import {
  atFrame,
  availablePlots,
  decodeView,
  fromBase64,
  hasResults,
  movement,
  nodeProbe,
  peak,
  plotRange,
  plotValues,
  probeValue,
  range,
  surfaceCsv,
  toBase64,
  type Probe,
} from "./viewData";

type Failure = { title: string; message: string };
// Autosave used browser storage before it moved to the local service. These
// keys keep the project's former name so older autosaves can still be found.
const LEGACY_RECOVERY = "bettersim-recovery";
const LEGACY_RECOVERY_META = "bettersim-recovery-meta";
const readStorage = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const systemTheme = (): Theme =>
  matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
/** Filters start off, with the section through the middle of the part. */
const defaultFilters = (geometry: Geometry): Filters => ({
  section: {
    on: false,
    axis: 0,
    position: (geometry.bounds[0] + geometry.bounds[3]) / 2,
    flip: false,
  },
  iso: { on: false, level: 0.5 },
  threshold: { on: false, level: 0.75 },
});
const fetchView = async (id: string, region = false) => {
  const response = await fetch(
    `/api/documents/${id}/view${region ? "?region=1" : ""}`,
  );
  if (!response.ok) throw Error((await response.json()).error);
  return decodeView(await response.arrayBuffer());
};
const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLInputElement ||
  el instanceof HTMLTextAreaElement ||
  el instanceof HTMLSelectElement;

export default function App() {
  const [part, setPart] = useState<Part | null>(null),
    [hist, setHist] = useState<History>({
      study: emptyStudy(),
      past: [],
      future: [],
    }),
    [mesh, setMesh] = useState<Mesh | null>(null),
    [result, setResult] = useState<Result | null>(null),
    [fromProject, setFromProject] = useState(false);
  const [section, setSection] = useState<Section>("part"),
    [selected, setSelected] = useState<number[]>([]),
    [hover, setHover] = useState<number | null>(null),
    [draft, setDraft] = useState<Draft | null>(null);
  const [job, setJob] = useState<Job | null>(null),
    [error, setError] = useState<Failure | null>(null),
    [notice, setNotice] = useState(""),
    [plot, setPlot] = useState<Plot>("stress"),
    [frame, setFrame] = useState(0),
    [animate, setAnimate] = useState(false),
    // Submodel: the box being edited, its solved result, and which is shown.
    [regionDraft, setRegionDraft] = useState<Region | null>(null),
    [regionResult, setRegionResult] = useState<RegionResult | null>(null),
    [showRegion, setShowRegion] = useState(false),
    [convergeOptions, setConvergeOptions] = useState<ConvergenceOptions>({
      runs: 3,
      tolerance: 0.02,
    }),
    [deform, setDeform] = useState<"off" | "true" | "auto">("off"),
    [wire, setWire] = useState(false),
    [probe, setProbe] = useState<Probe | null>(null),
    [filters, setFilters] = useState<Filters | null>(null),
    [sectionArea, setSectionArea] = useState<number | null>(null),
    [query, setQuery] = useState(""),
    [comparison, setComparison] = useState<Comparison | null>(null),
    [recovery, setRecovery] = useState<Recovery | null>(null),
    [recoveryStatus, setRecoveryStatus] = useState("saving");
  const [theme, setTheme] = useState<Theme>(
    () => (readStorage("sprung-fea-theme") as Theme | null) || systemTheme(),
  );
  const [projection, setProjection] = useState<Projection>(() =>
    readStorage("sprung-fea-projection") === "orthographic"
      ? "orthographic"
      : "perspective",
  );
  // Units are a display preference kept on this computer; studies and
  // results stay in SI working units.
  const [units, setUnits] = useState<UnitSystem>(() =>
    readStorage("sprung-fea-units") === "us" ? "us" : "si",
  );
  const unitsRef = useRef(units);
  unitsRef.current = units;
  const chooseUnits = (next: UnitSystem) => {
    try {
      localStorage.setItem("sprung-fea-units", next);
    } catch {}
    setUnits(next);
  };
  const [threads, setThreads] = useState<Threads>(() => {
    const saved = readStorage("sprung-fea-threads");
    return saved === "single" || saved === "all" ? saved : "auto";
  });
  const [cpus, setCpus] = useState<Cpus | null>(null);
  const chooseThreads = (next: Threads) => {
    try {
      localStorage.setItem("sprung-fea-threads", next);
    } catch {}
    setThreads(next);
  };
  const chooseProjection = (next: Projection) => {
    try {
      localStorage.setItem("sprung-fea-projection", next);
    } catch {}
    setProjection(next);
  };
  const [log, setLog] = useState<LogEntry[]>([]),
    [consoleOpen, setConsoleOpen] = useState(false),
    [consoleTab, setConsoleTab] = useState<"output" | "checks">("output");
  const [, setTick] = useState(0);
  const study = hist.study;
  const sequence = useRef(0),
    lastHistoryKey = useRef({ type: "", time: 0 });
  const fileInput = useRef<HTMLInputElement>(null),
    projectInput = useRef<HTMLInputElement>(null),
    viewer = useRef<ViewerHandle>(null),
    active = useRef<string | null>(null),
    partRef = useRef(part);
  partRef.current = part;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    if (readStorage("sprung-fea-theme")) return;
    const media = matchMedia("(prefers-color-scheme: dark)");
    const change = () => setTheme(media.matches ? "dark" : "light");
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    try {
      localStorage.setItem("sprung-fea-theme", next);
    } catch {}
    setTheme(next);
  };
  useEffect(() => {
    api("/health")
      .then((h) => setCpus(h.cpus))
      .catch(() => {});
  }, []);
  useEffect(() => {
    api("/recovery")
      .then((meta: Recovery | null) => {
        if (meta) return setRecovery(meta);
        if (!readStorage(LEGACY_RECOVERY)) return;
        let name = "Last study";
        try {
          name = JSON.parse(readStorage(LEGACY_RECOVERY_META) || "").name;
        } catch {}
        setRecovery({ name, at: 0, legacy: true });
      })
      .catch(() => {});
  }, []);
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
  const clearResults = () => {
    setResult(null);
    setRegionResult(null);
    setRegionDraft(null);
    setShowRegion(false);
    setFromProject(false);
    setProbe(null);
    setComparison(null);
    setSection((s) => (s === "results" ? "mesh" : s));
  };
  /** Applies a study history action and invalidates what it affects. */
  const change = (action: HistoryAction) => {
    const next = history(hist, action);
    if (next === hist) return;
    setHist(next);
    clearResults();
    if (!meshStillValid(hist.study, next.study)) setMesh(null);
    if (action.type !== "edit") setDraft(null);
  };
  const update = (next: Study) => change({ type: "edit", study: next });
  // The Electron menu and the page can both report one keystroke.
  const step = (type: "undo" | "redo") => {
    if (job) return;
    const now = performance.now();
    const last = lastHistoryKey.current;
    if (last.type === type && now - last.time < 150) return;
    lastHistoryKey.current = { type, time: now };
    change({ type });
  };
  const stepRef = useRef(step);
  stepRef.current = step;
  useEffect(
    () =>
      window.desktop?.onMenu?.((command) => {
        if (command !== "undo" && command !== "redo") return;
        if (isTyping(document.activeElement)) document.execCommand(command);
        else stepRef.current(command);
      }),
    [],
  );

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
  /** Display defaults for a new result: mode shapes animate. */
  const present = (r: Result) => {
    // Mode shapes read best moving; show the first elastic mode.
    const eigen = ANALYSES[r.analysis].eigen;
    const harmonic = r.analysis === "harmonic";
    setPlot(
      eigen
        ? "movement"
        : r.analysis === "thermal"
          ? "temperature"
          : harmonic
            ? "amplitude"
            : "stress",
    );
    setFrame(
      eigen
        ? Math.min(
            (r.summary.rigidModes as number | undefined) ?? 0,
            r.frames.length - 1,
          )
        : 0,
    );
    setAnimate(r.analysis === "frequency" || harmonic);
    // Harmonic response: open at the largest response.
    if (harmonic) {
      const peak = r.summary.peakFrequency as number;
      setFrame(
        r.frames.reduce(
          (best, f, i) =>
            Math.abs((f.value ?? 0) - peak) <
            Math.abs((r.frames[best].value ?? 0) - peak)
              ? i
              : best,
          0,
        ),
      );
    }
    // Load steps of a large-deformation solve: show full load, true scale.
    const steps = r.charts.some((c) => c.id === "loadPath");
    if (steps) {
      // Full load: the last step at the highest load, before any unloading.
      const loads = r.charts.find((c) => c.id === "loadPath")!.x.values;
      setFrame(loads.lastIndexOf(Math.max(...loads)));
    }
    setDeform(eigen || harmonic ? "auto" : steps ? "true" : "off");
  };
  const importPart = async (
    action: () => Promise<any>,
    title: string,
    saved?: unknown,
  ) => {
    const operation = ++sequence.current;
    setError(null);
    setDraft(null);
    try {
      const info = await action();
      write("import", info.name);
      const geometry = await poll(info.job, "importing");
      if (!geometry) return;
      const nextStudy: Study = info.study || {
        ...emptyStudy(),
        meshSize: geometry.recommendedSize,
      };
      setPart({ id: info.id, name: info.name, geometry, sample: info.sample });
      setFilters(defaultFilters(geometry));
      setHist(history(hist, { type: "reset", study: nextStudy }));
      setMesh(null);
      setResult(null);
      setFromProject(false);
      setComparison(null);
      setSelected([]);
      setProbe(null);
      setSection("part");
      setWire(false);
      write(
        "import",
        `${geometry.dimensions.map((d: number) => quantity(d, "mm", unitsRef.current, 2)).join(" × ")} · ${geometry.faces.length} faces · ${quantity(geometry.volume, "mm³", unitsRef.current, 1)}`,
        "done",
      );
      const restored = saved
        ? restoreResults(saved, geometry.hash, nextStudy)
        : null;
      let view = null;
      try {
        view = restored && decodeView(fromBase64(restored.view));
      } catch {}
      if (restored && hasResults(view)) {
        setMesh({ ...restored.mesh, view: view! });
        const r = { ...restored.result, view: view! };
        setResult(r);
        setFromProject(true);
        present(r);
        setSection("results");
        write("open", "Results loaded from the project", "done");
      } else if (saved)
        write("open", "Saved results don't match this study and were skipped");
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
      const { results, ...project } = JSON.parse(await file.text());
      await importPart(
        () => post("/open", project),
        "Could not open project",
        results,
      );
    } catch (e) {
      fail("Could not open project", e);
    }
  };
  const restore = () => {
    if (!recovery?.legacy)
      return importPart(
        () => post("/recovery/open", {}),
        "Could not restore autosave",
      );
    const saved = readStorage(LEGACY_RECOVERY);
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
      if (result?.view.buffer && mesh) {
        const { view: _mesh, ...meshInfo } = mesh;
        const { view, ...resultInfo } = result;
        data.results = {
          hash: part.geometry.hash,
          study,
          mesh: meshInfo,
          result: resultInfo,
          view: toBase64(view.buffer!),
        } satisfies SavedResults;
      }
      if (
        await saveFile(
          stripExt(part.name) + ".sfea",
          JSON.stringify(data, null, data.results ? 0 : 2),
        )
      )
        announce(data.results ? "Project saved with results" : "Project saved");
    } catch (e) {
      fail("Save failed", e);
    }
  };
  useEffect(() => {
    if (!part || job) return;
    setRecoveryStatus("saving");
    const t = setTimeout(async () => {
      try {
        const { at } = await post("/recovery", {
          id: part.id,
          name: part.name,
          study,
          sample: part.sample,
        });
        if (partRef.current?.id !== part.id) return;
        setRecovery({ name: part.name, at });
        setRecoveryStatus("saved");
        try {
          localStorage.removeItem(LEGACY_RECOVERY);
          localStorage.removeItem(LEGACY_RECOVERY_META);
        } catch {}
      } catch {
        setRecoveryStatus("unavailable");
      }
    }, 750);
    return () => clearTimeout(t);
  }, [part, study, job]);

  const needs = ANALYSES[study.analysis];
  const missing = [
    !study.material ? "Material" : null,
    needs.thermal && study.material && !study.material.conductivity
      ? "Thermal conductivity"
      : null,
    study.analysis === "static" &&
    study.plasticity &&
    study.material &&
    (!study.material.yield ||
      !study.material.ultimate ||
      !study.material.elongation)
      ? "Yield, ultimate strength and elongation"
      : null,
    study.analysis === "thermalStress" &&
    study.material &&
    study.material.expansion == null
      ? "Thermal expansion"
      : null,
    needs.supports && !study.supports.length ? "Support" : null,
    // Thermal stress can come from temperatures alone.
    needs.loads &&
    !needs.thermal &&
    !(study.analysis === "harmonic" && study.harmonic?.excitation === "base") &&
    !study.loads.length
      ? "Load"
      : null,
    needs.thermal &&
    !study.thermal.some(
      (c) => c.kind === "temperature" || c.kind === "convection",
    )
      ? "Temperature or convection"
      : null,
  ].filter(Boolean) as string[];
  const ready = !!part && !missing.length && !draft;
  const run = async (action: "mesh" | "solve" | "converge", refine = false) => {
    if (!part || job || (action !== "mesh" && !ready)) return;
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
      const count =
        threads === "single" ? 1 : threads === "all" && cpus ? cpus.logical : 0;
      const query = new URLSearchParams();
      if (count) query.set("threads", String(count));
      if (action === "converge") {
        query.set("runs", String(convergeOptions.runs));
        query.set("tolerance", String(convergeOptions.tolerance));
      }
      const j = await post(
        `/documents/${part.id}/${action}${query.size ? "?" + query : ""}`,
        next,
      );
      const data = await poll(j.job, action === "mesh" ? "meshing" : "solve");
      if (!data) return;
      const view = await fetchView(part.id);
      if (sequence.current !== operation) return;
      const info: MeshInfo = action === "mesh" ? data : data.mesh;
      const m: Mesh = { ...info, view };
      write(
        "mesh",
        `${fmt(m.elementCount)} elements · ${fmt(m.nodeCount)} nodes · min quality ${fmt(m.minQuality, 3)}`,
      );
      setMesh(m);
      if (action === "mesh") {
        setWire(true);
        setSection("mesh");
      } else {
        const r: Result = {
          ...normalizeResult(data.result as ResultInfo),
          view,
        };
        if (r.convergence) {
          // The study adopts the finest mesh, which the result belongs to;
          // later solves reuse it. Recorded as an edit so undo returns to
          // the starting size.
          const size = r.convergence.meshes.at(-1)!.size;
          setHist((h) =>
            history(h, {
              type: "edit",
              study: { ...h.study, detail: "custom", meshSize: size },
            }),
          );
          const settled = r.convergence.quantities.every((q) => q.converged);
          write(
            "converge",
            `${r.convergence.meshes.length} meshes · ${settled ? "converged" : "not fully converged"} · element size now ${fmt(size, 3)} mm`,
            "done",
          );
        }
        setResult(r);
        setProbe(null);
        setFromProject(false);
        setWire(false);
        present(r);
        setSection("results");
        setSelected([]);
        if (refine && prior) setComparison({ before: prior, after: r });
        const balance = r.summary.forceBalanceError;
        write(
          "solve",
          `done in ${fmt(r.summary.seconds, 2)} s` +
            (balance === undefined
              ? ""
              : ` · force balance error ${fmt(balance * 100, 4)}%`),
          "done",
        );
      }
    } catch (e) {
      fail(
        action === "mesh"
          ? "Meshing failed"
          : action === "converge"
            ? "Convergence study failed"
            : "Solve failed",
        e,
      );
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
      const key = e.key.toLowerCase();
      if (mod && key === "s") {
        e.preventDefault();
        save();
      } else if (mod && key === "o" && !job) {
        e.preventDefault();
        projectInput.current?.click();
      } else if (mod && key === "i" && !job) {
        e.preventDefault();
        fileInput.current?.click();
      } else if (mod && key === "enter") {
        e.preventDefault();
        run("solve");
      } else if (mod && key === "z") {
        // Text fields keep their own undo.
        if (isTyping(e.target)) return;
        e.preventDefault();
        step(e.shiftKey ? "redo" : "undo");
      } else if (e.key === "Escape" && !job) {
        cancelDraft();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  const selectFace = (id: number) => {
    if (job || (result && !draft)) return;
    setSelected((s) =>
      s.includes(id) ? s.filter((f) => f !== id) : [...s, id],
    );
  };
  const chooseSection = (s: Section) => {
    if (job) return;
    setSection(s);
    setDraft(null);
  };
  const edit = (kind: ConditionKind, value: Condition) => {
    if (job) return;
    setSection(LISTS[kind]);
    setDraft({ kind, value: structuredClone(value) } as Draft);
    setSelected(value.faces);
  };
  const add = (kind: ConditionKind) => {
    if (job) return;
    setSection(LISTS[kind]);
    setDraft(
      kind === "support"
        ? { kind, value: blankSupport() }
        : kind === "load"
          ? { kind, value: blankLoad() }
          : kind === "thermal"
            ? { kind, value: blankThermal() }
            : { kind, value: blankMass(center.selection || center.part) },
    );
  };
  const remove = (kind: ConditionKind, id: string) => {
    update({
      ...study,
      [LISTS[kind]]: conditionsOf(study, kind).filter((c) => c.id !== id),
    });
    if (draft?.value.id === id) {
      setDraft(null);
      setSelected([]);
    }
  };
  const isBody =
    (draft?.kind === "load" && isBodyLoad(draft.value)) ||
    (draft?.kind === "thermal" && draft.value.kind === "generation");
  /** Leaves the editor unchanged; an existing result is shown again. */
  const cancelDraft = () => {
    setDraft(null);
    setSelected([]);
    if (result) setSection("results");
  };
  const commitDraft = () => {
    if (!draft) return;
    const faces = isBody ? [] : selected;
    if (!faces.length && !isBody) return;
    const value = { ...draft.value, faces, name: draft.value.name.trim() };
    const list = conditionsOf(study, draft.kind);
    update({
      ...study,
      [LISTS[draft.kind]]: list.some((c) => c.id === value.id)
        ? list.map((c) => (c.id === value.id ? value : c))
        : [...list, value],
    });
    setDraft(null);
    setSelected([]);
  };
  const exampleSetup = () => {
    if (!part) return;
    const faces = part.geometry.faces;
    // The post stands on the plate: hold the plate's underside and push
    // the top of the post sideways. Otherwise hold one end, load the other.
    const tower = part.sample === "post-plate";
    const axis = tower ? 2 : 0;
    const held = faces.reduce((a, b) =>
      a.center[axis] < b.center[axis] ? a : b,
    );
    const loaded = faces.reduce((a, b) =>
      a.center[axis] > b.center[axis] ? a : b,
    );
    update({
      ...study,
      material: structuredClone(MATERIALS[0]),
      supports: [{ ...blankSupport(), faces: [held.id] }],
      loads: [
        {
          ...blankLoad(),
          faces: [loaded.id],
          vector: tower ? [100, 0, 0] : [0, 0, -100],
        },
      ],
    });
    setSection("mesh");
    setSelected([]);
    announce(
      `Example setup: ${MATERIALS[0].name}, Face ${held.id} fixed, ${quantity(100, "N", units)} ${tower ? "sideways" : "downward"} on Face ${loaded.id}`,
    );
  };

  // The view annotates only the conditions this analysis uses.
  const shownStudy = useMemo(() => {
    const s = previewStudy(study, draft, selected);
    const a = ANALYSES[s.analysis];
    return {
      ...s,
      supports: a.mechanical ? s.supports : [],
      masses: a.mechanical ? s.masses : [],
      loads: a.loads ? s.loads : [],
      thermal: a.thermal ? s.thermal : [],
    };
  }, [study, draft, selected]);
  const selectedFaces =
    part?.geometry.faces.filter((f) => selected.includes(f.id)) || [];
  const selectedArea = selectedFaces.reduce((sum, f) => sum + f.area, 0);
  const center = {
    selection: selectedArea
      ? [0, 1, 2].map(
          (i) =>
            selectedFaces.reduce((sum, f) => sum + f.center[i] * f.area, 0) /
            selectedArea,
        )
      : null,
    part: part
      ? [0, 1, 2].map(
          (i) => (part.geometry.bounds[i] + part.geometry.bounds[i + 3]) / 2,
        )
      : [0, 0, 0],
  };
  // The displayed result (the whole part or a refined region), its frame,
  // and what it can show.
  const regionShown = showRegion && !!regionResult;
  const displayed: Result | null = regionShown ? regionResult : result;
  const shown = useMemo(
    () => (displayed ? atFrame(displayed.view, frame) : null),
    [displayed, frame],
  );
  const regionBox = useMemo(() => {
    const r = regionDraft || (!regionShown && regionResult?.region) || null;
    return r
      ? {
          lo: r.center.map((c, i) => c - r.size[i] / 2),
          hi: r.center.map((c, i) => c + r.size[i] / 2),
        }
      : null;
  }, [regionDraft, regionResult, regionShown]);
  const viewGeometry = useMemo(
    () =>
      part && regionShown && regionResult
        ? { ...part.geometry, bounds: regionResult.bounds, faces: [] }
        : part?.geometry,
    [part, regionShown, regionResult],
  );
  /** A starting box: a quarter of the part around the peak stress. */
  const startRegion = () => {
    if (!part || !result) return;
    const node = peak(atFrame(result.view, 0), "stress", null).node;
    const i = result.view.nodeIds.indexOf(node);
    const center = Array.from(result.view.points.subarray(i * 3, i * 3 + 3));
    const side = Math.max(
      Math.max(...part.geometry.dimensions) / 4,
      3 * (mesh?.size || study.meshSize),
    );
    setRegionDraft({
      center: center.map((c) => Number(c.toPrecision(4))),
      size: [side, side, side].map((v) => Number(v.toPrecision(3))),
      meshSize: Number(((mesh?.size || study.meshSize) / 3).toPrecision(3)),
    });
  };
  const solveRegion = async () => {
    if (!part || !regionDraft || job) return;
    const operation = ++sequence.current;
    setError(null);
    try {
      const count =
        threads === "single" ? 1 : threads === "all" && cpus ? cpus.logical : 0;
      const j = await post(
        `/documents/${part.id}/submodel${count ? "?threads=" + count : ""}`,
        { study, region: regionDraft },
      );
      const data = await poll(j.job, "solve");
      if (!data) return;
      const view = await fetchView(part.id, true);
      if (sequence.current !== operation) return;
      setRegionResult({
        ...normalizeResult(data.result as ResultInfo),
        view,
        region: regionDraft,
        bounds: data.geometry.bounds,
        faces: data.geometry.faces,
      });
      setRegionDraft(null);
      setShowRegion(true);
      setProbe(null);
      setFrame(0);
      const s = data.result.summary;
      write(
        "region",
        `${fmt(data.mesh.elementCount)} elements · peak ${quantity(s.globalPeak, "MPa", units)} → ${quantity(s.maxStress, "MPa", units)}`,
        "done",
      );
    } catch (e) {
      fail("Region solve failed", e);
    } finally {
      if (sequence.current === operation) finish();
    }
  };
  const yieldStrength = study.material?.yield || null;
  const resultAnalysis = displayed?.analysis ?? study.analysis;
  // A yield margin means nothing for mode shapes scaled to 1 mm.
  const plots = shown
    ? availablePlots(shown, yieldStrength).filter(
        (p) =>
          !(ANALYSES[resultAnalysis].eigen && p === "safety") &&
          // A harmonic shape is one instant; its amplitude is the measure.
          !(resultAnalysis === "harmonic" && p === "movement"),
      )
    : [];
  const activePlot: Plot = plots.includes(plot) ? plot : plots[0] || plot;
  const info = plotInfo(activePlot, resultAnalysis);
  const stats = useMemo(() => {
    if (!shown || !plots.length) return null;
    const stress = shown.fields.vonMises;
    const minSafety =
      yieldStrength && stress ? yieldStrength / (range(stress).max || 1) : null;
    const marginMax = marginScale(minSafety);
    const values = plotValues(shown, activePlot, yieldStrength, marginMax);
    return {
      marginMax,
      maxMovement: shown.displacement ? range(movement(shown)).max : 0,
      peak: peak(shown, activePlot, yieldStrength),
      min: range(values).min,
      scale: plotRange(shown, activePlot, yieldStrength, marginMax),
    };
  }, [shown, activePlot, yieldStrength, plots.length]);
  const marginMax = stats?.marginMax ?? 5;
  const autoScale =
    part && stats?.maxMovement
      ? (Math.max(...part.geometry.dimensions) * 0.08) / stats.maxMovement
      : 0;
  // Editing a condition needs the part itself, to pick faces: the result is
  // hidden until the draft is saved (which invalidates it) or cancelled.
  const showingResult = !!result && !draft;
  const deformation =
    showingResult && mesh && shown?.displacement
      ? deform === "auto"
        ? autoScale
        : deform === "true"
          ? 1
          : 0
      : 0;
  const probeAt =
    result && probe ? probeValue(probe, activePlot, yieldStrength) : null;
  const probeLabel =
    probeAt === null
      ? null
      : activePlot === "safety"
        ? fmt(probeAt, 2) + "×"
        : quantity(probeAt, info.unit, units, info.digits);
  const csv = async () => {
    if (shown)
      await saveFile("sprung-fea-surface-nodes.csv", surfaceCsv(shown, units));
  };
  const exportSolver = async (kind: "deck" | "log" | "frd") => {
    if (!part) return;
    const prefix = regionShown ? "region-" : "";
    try {
      const response = await fetch(
        `/api/documents/${part.id}/export/${prefix}${kind}`,
      );
      if (!response.ok) throw Error((await response.json()).error);
      await saveFile(
        prefix +
          { deck: "analysis.inp", log: "solver.log", frd: "analysis.frd" }[
            kind
          ],
        await response.text(),
      );
    } catch (e) {
      fail("Export failed", e);
    }
  };
  const screenshot = async () => {
    const content = viewer.current?.screenshot();
    if (content) await saveFile("sprung-fea-view.png", content, "base64");
  };

  const inspector = () => {
    if (!part) return null;
    if (draft)
      return (
        <ConditionEditor
          draft={draft}
          exists={conditionsOf(study, draft.kind).some(
            (c) => c.id === draft.value.id,
          )}
          selected={selected}
          selectedArea={selectedArea}
          center={center}
          onChange={(changes) =>
            setDraft((d) =>
              d ? ({ ...d, value: { ...d.value, ...changes } } as Draft) : null,
            )
          }
          onRemoveFace={selectFace}
          onCancel={cancelDraft}
          onSave={commitDraft}
          onDelete={() => remove(draft.kind, draft.value.id)}
        />
      );
    switch (section) {
      case "part":
        return (
          <PartPanel
            part={part}
            onMaterial={() => chooseSection("material")}
            onExample={exampleSetup}
          />
        );
      case "analysis":
        return (
          <AnalysisPanel
            study={study}
            onChange={(next) => {
              update(next);
              if (next.analysis !== study.analysis)
                announce(`${ANALYSES[next.analysis].name} study`);
            }}
          />
        );
      case "material":
        return (
          <MaterialPanel
            key={study.material?.name}
            study={study}
            bodies={part.geometry.bodies || []}
            onApply={(material) => {
              update({ ...study, material });
              if (!study.supports.length) setSection("supports");
            }}
            onBodies={(bodyMaterials) => update({ ...study, bodyMaterials })}
          />
        );
      case "supports":
      case "loads":
      case "masses":
      case "thermal": {
        const kind = (
          {
            supports: "support",
            loads: "load",
            masses: "mass",
            thermal: "thermal",
          } as const
        )[section];
        return (
          <ConditionsPanel
            kind={kind}
            list={conditionsOf(study, kind)}
            selectedCount={selected.length}
            onAdd={() => add(kind)}
            onEdit={(c) => edit(kind, c)}
            onRemove={(id) => remove(kind, id)}
          />
        );
      }
      case "mesh":
        return (
          <MeshPanel
            part={part}
            study={study}
            mesh={mesh}
            missing={missing}
            canSolve={ready && !job && study.meshSize > 0}
            busy={!!job}
            onChange={update}
            threads={threads}
            cpus={cpus}
            onThreads={chooseThreads}
            onPreview={() => run("mesh")}
            onSolve={() => run("solve")}
          />
        );
      case "results":
        return (
          result &&
          shown &&
          stats && (
            <ResultsPanel
              result={displayed!}
              region={{
                draft: regionDraft,
                result: regionResult,
                showing: regionShown,
                available:
                  !fromProject &&
                  result.analysis === "static" &&
                  (part.geometry.bodies?.length ?? 1) <= 1,
                unavailable:
                  (part.geometry.bodies?.length ?? 1) > 1
                    ? "Region refinement works on single parts for now, not assemblies."
                    : "Solve the whole part in this session to refine a region.",
                onStart: startRegion,
                onDraft: setRegionDraft,
                onSolve: solveRegion,
                onShow: (on: boolean) => {
                  setShowRegion(on);
                  setProbe(null);
                  setFrame(0);
                },
              }}
              mesh={mesh}
              study={study}
              plot={activePlot}
              stats={stats}
              frame={frame}
              onFrame={(k) => {
                setFrame(k);
                setProbe(null);
              }}
              deform={deform}
              autoScale={autoScale}
              wire={wire}
              animate={animate}
              onAnimate={setAnimate}
              probe={probe}
              filters={filters!}
              bounds={viewGeometry!.bounds}
              scale={stats.scale}
              sectionArea={sectionArea}
              onFilters={setFilters}
              comparison={comparison}
              fromProject={fromProject}
              busy={!!job}
              onDeform={setDeform}
              onWire={setWire}
              onProbe={(node) =>
                setProbe(node === null ? null : nodeProbe(shown, node))
              }
              onRefine={() => run("solve", true)}
              convergeOptions={convergeOptions}
              onConvergeOptions={setConvergeOptions}
              onConverge={() => run("converge")}
              onCsv={csv}
              onImage={screenshot}
              onSolverFile={exportSolver}
            />
          )
        );
    }
  };

  const status = job
    ? job.message
    : notice ||
      (part
        ? result
          ? fromProject
            ? "Results loaded from project"
            : `Solved · ${fmt(result.summary.seconds, 2)} s`
          : recoveryStatus === "saved"
            ? "Saved locally"
            : recoveryStatus === "saving"
              ? "Saving…"
              : "Autosave unavailable. Save a project to keep this study."
        : "Ready");
  const jobCard = job && <JobCard job={job} onCancel={cancel} />;
  return (
    <UnitsContext.Provider value={units}>
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
            /\.sfea$/i.test(file.name) ? openProject(file) : importFile(file);
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
          accept=".sfea"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) openProject(file);
            e.target.value = "";
          }}
        />
        <header className="titlebar">
          <div className="crumb">
            <b>Sprung FEA</b>
            {part && (
              <>
                <span className="sep">/</span>
                <span>{stripExt(part.name)}</span>
                <span className="sep">/</span>
                <span className="faint">{analysisName(study)}</span>
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
                onClick={() => change({ type: "undo" })}
                disabled={!hist.past.length || !!job}
              >
                <Undo2 size={14} />
              </button>
              <button
                className="tb"
                aria-label="Redo study edit"
                title="Redo (⇧⌘Z)"
                onClick={() => change({ type: "redo" })}
                disabled={!hist.future.length || !!job}
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
          <StartScreen
            recovery={recovery}
            busy={!!job}
            onImport={() => fileInput.current?.click()}
            onOpen={() => projectInput.current?.click()}
            onRestore={restore}
            onSample={sample}
          >
            {jobCard}
          </StartScreen>
        ) : (
          <main className="main">
            <aside className="pane left">
              <div className="phead">Study</div>
              <StudyTree
                part={part}
                study={study}
                mesh={mesh}
                result={result}
                draft={draft}
                section={section}
                plot={activePlot}
                plots={plots}
                busy={!!job}
                onSection={chooseSection}
                onAdd={add}
                onEdit={edit}
                onPlot={(k) => {
                  setPlot(k);
                  chooseSection("results");
                }}
              />
              <FaceList
                part={part}
                study={study}
                selected={selected}
                hover={hover}
                draftKind={draft?.kind || null}
                disabled={!!job || (!!result && !draft)}
                query={query}
                onQuery={setQuery}
                onSelect={selectFace}
                onHover={setHover}
              />
            </aside>

            <section className="center">
              <div className="viewport">
                <Viewer
                  ref={viewer}
                  geometry={draft ? part.geometry : viewGeometry!}
                  view={draft ? null : shown || mesh?.view || null}
                  region={draft ? null : regionBox}
                  origin={
                    !!regionDraft ||
                    draft?.kind === "mass" ||
                    (draft?.kind === "load" &&
                      (draft.value.kind === "remote" ||
                        draft.value.kind === "rotation"))
                  }
                  plot={showingResult && plots.length ? activePlot : null}
                  study={shownStudy}
                  selected={selected}
                  hovered={hover}
                  onSelect={selectFace}
                  onHover={setHover}
                  onProbe={setProbe}
                  onSectionArea={setSectionArea}
                  filters={filters!}
                  deformation={deformation}
                  wireframe={wire && !draft}
                  animate={animate && showingResult && deformation !== 0}
                  probe={draft ? null : probe}
                  probeLabel={probeLabel}
                  theme={theme}
                  projection={projection}
                  draftKind={draft?.kind || null}
                  marginMax={marginMax}
                  yieldStrength={yieldStrength}
                />
                <div className="vlabel">
                  {showingResult ? (
                    <>
                      <b>{info.name}</b>
                      <span>
                        {unitLabel(info.unit, units)} · nodal
                        {regionShown
                          ? " · refined region"
                          : result.frames.length > 1
                            ? " · " + result.frames[frame]?.label
                            : ""}
                      </span>
                    </>
                  ) : draft && isBody ? (
                    <>
                      <b>{draft.value.name || "Load"}</b>
                      <span>acts on the whole part</span>
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
                        {fmt(mesh.elementCount)} elements · {fmt(mesh.size, 2)}{" "}
                        mm
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
                  {(
                    [
                      ["perspective", "Persp", "Perspective"],
                      ["orthographic", "Ortho", "Orthographic"],
                    ] as const
                  ).map(([mode, name, full]) => (
                    <button
                      key={mode}
                      className={projection === mode ? "on" : ""}
                      aria-pressed={projection === mode}
                      aria-label={full}
                      title={full}
                      onClick={() => chooseProjection(mode)}
                    >
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
                {showingResult && stats && (
                  <div className="legend" aria-label={info.name + " scale"}>
                    <div
                      className="bar"
                      style={{
                        background: `linear-gradient(to top,${(activePlot === "safety" ? [...palette].reverse() : palette).join(",")})`,
                      }}
                    />
                    {[1, 0.75, 0.5, 0.25, 0].map((f) => (
                      <span key={f}>
                        {activePlot === "safety" && f === 1
                          ? marginMax + "+"
                          : quantity(
                              stats.scale.min +
                                f * (stats.scale.max - stats.scale.min),
                              info.unit,
                              units,
                            ).replace(/ \S+$/, "")}
                      </span>
                    ))}
                  </div>
                )}
                {showingResult && shown?.displacement && (
                  <div className="vchip">
                    {deform === "off"
                      ? "Undeformed"
                      : deform === "true"
                        ? "True scale"
                        : `${ANALYSES[resultAnalysis].eigen ? "Shape" : "Displacement"} ×${fmt(deformation, deformation >= 100 ? 0 : 1)}${animate && ANALYSES[resultAnalysis].eigen ? " · animated" : ""}`}
                  </div>
                )}
                {(!result || draft) && !job && selected.length > 0 && (
                  <div className="selpill">
                    <MousePointer2 size={13} />
                    {selected.length === 1
                      ? "Face " + selected[0]
                      : selected.length + " faces"}{" "}
                    · {quantity(selectedArea, "mm²", units, 1)}
                    <button
                      aria-label="Clear selection"
                      onClick={() => setSelected([])}
                    >
                      <X size={13} />
                    </button>
                  </div>
                )}
                {jobCard}
              </div>
              <Console
                log={log}
                result={displayed}
                open={consoleOpen}
                tab={consoleTab}
                onOpen={setConsoleOpen}
                onTab={setConsoleTab}
              />
            </section>

            <aside
              className={"pane right" + (job ? " busy" : "")}
              aria-label="Inspector"
              inert={!!job}
            >
              {inspector()}
            </aside>
          </main>
        )}

        <footer className="status">
          <span>
            {(job || part) && <span className={"dot" + (job ? " busy" : "")} />}
            {status}
          </span>
          <span className="spacer" />
          {part && (
            <span>
              {hover
                ? `Face ${hover} · ${part.geometry.faces.find((f) => f.id === hover)?.type}`
                : part.geometry.dimensions
                    .map((d) =>
                      quantity(d, "mm", units, 1).replace(/ \S+$/, ""),
                    )
                    .join(" × ") +
                  " " +
                  unitLabel("mm", units)}
            </span>
          )}
          <button
            className="units-toggle"
            aria-label={`Units: ${SYSTEM_LABEL[units]}. Switch to ${units === "si" ? "US" : "SI"} units`}
            title={`Switch to ${units === "si" ? "US" : "SI"} units`}
            onClick={() => chooseUnits(units === "si" ? "us" : "si")}
          >
            {SYSTEM_LABEL[units]}
          </button>
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
      </div>
    </UnitsContext.Provider>
  );
}
