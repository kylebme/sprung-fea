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
import { Viewer, palette, type ViewerHandle, type Theme } from "./Viewer";
import { api, post, saveFile } from "./api";
import {
  fmt,
  history,
  marginScale,
  meshStillValid,
  previewStudy,
  restoreResults,
  type Draft,
  type History,
  type HistoryAction,
  type SavedResults,
} from "./logic";
import { PLOTS, STAGES, blankLoad, blankSupport, stripExt } from "./labels";
import { StartScreen, type Recovery } from "./StartScreen";
import { FaceList, StudyTree, type Section } from "./Sidebar";
import { Console, JobCard, type Job, type LogEntry } from "./Console";
import {
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
  type Load,
  type Mesh,
  type Part,
  type Plot,
  type Result,
  type Study,
  type Support,
} from "./types";

type Failure = { title: string; message: string };
// Autosave used browser storage before it moved to the local service.
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
    [deform, setDeform] = useState<"off" | "true" | "auto">("off"),
    [wire, setWire] = useState(false),
    [probe, setProbe] = useState<number | null>(null),
    [query, setQuery] = useState(""),
    [comparison, setComparison] = useState<Comparison | null>(null),
    [recovery, setRecovery] = useState<Recovery | null>(null),
    [recoveryStatus, setRecoveryStatus] = useState("saving");
  const [theme, setTheme] = useState<Theme>(
    () => (readStorage("bettersim-theme") as Theme | null) || systemTheme(),
  );
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
    if (readStorage("bettersim-theme")) return;
    const media = matchMedia("(prefers-color-scheme: dark)");
    const change = () => setTheme(media.matches ? "dark" : "light");
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    try {
      localStorage.setItem("bettersim-theme", next);
    } catch {}
    setTheme(next);
  };
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
        `${geometry.dimensions.map((d: number) => fmt(d, 2)).join(" × ")} mm · ${geometry.faces.length} faces · ${fmt(geometry.volume, 1)} mm³`,
        "done",
      );
      const restored = saved
        ? restoreResults(saved, geometry.hash, nextStudy)
        : null;
      if (restored) {
        setMesh(restored.mesh);
        setResult(restored.result);
        setFromProject(true);
        setPlot("stress");
        setDeform("off");
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
      if (result && mesh) {
        const { surface, size, nodeCount, elementCount, minQuality } = mesh;
        data.results = {
          hash: part.geometry.hash,
          study,
          mesh: { surface, size, nodeCount, elementCount, minQuality },
          result,
        } satisfies SavedResults;
      }
      if (
        await saveFile(
          stripExt(part.name) + ".bsim",
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
      setMesh(m);
      if (action === "mesh") {
        setWire(true);
        setSection("mesh");
      } else {
        setResult(data.result);
        setFromProject(false);
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
  };
  const edit = (kind: "support" | "load", value: Support | Load) => {
    if (job) return;
    setSection(kind === "support" ? "supports" : "loads");
    setDraft({ kind, value: structuredClone(value) } as Draft);
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
    update({
      ...study,
      [key]: (study[key] as (Support | Load)[]).filter((c) => c.id !== id),
    });
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
    const value = { ...draft.value, faces, name: draft.value.name.trim() };
    const key = draft.kind === "support" ? "supports" : "loads";
    const list = study[key] as (Support | Load)[];
    update({
      ...study,
      [key]: list.some((c) => c.id === value.id)
        ? list.map((c) => (c.id === value.id ? value : c))
        : [...list, value],
    });
    setDraft(null);
    setSelected([]);
  };
  const exampleSetup = () => {
    if (!part) return;
    const faces = part.geometry.faces;
    const held = faces.reduce((a, b) => (a.center[0] < b.center[0] ? a : b));
    const loaded = faces.reduce((a, b) => (a.center[0] > b.center[0] ? a : b));
    update({
      ...study,
      material: structuredClone(MATERIALS[0]),
      supports: [{ ...blankSupport(), faces: [held.id] }],
      loads: [{ ...blankLoad(), faces: [loaded.id] }],
    });
    setSection("mesh");
    setSelected([]);
    announce(
      `Example setup: Aluminum 6061-T6, Face ${held.id} fixed, 100 N downward on Face ${loaded.id}`,
    );
  };

  const shownStudy = useMemo(
    () => previewStudy(study, draft, selected),
    [study, draft, selected],
  );
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
  const marginMax = marginScale(result?.summary.minSafety ?? null);
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
        : marginMax
    : 0;
  const surface = mesh?.surface || part?.geometry;
  const probeIndex = probe && surface ? surface.nodeIds.indexOf(probe) : -1;
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
  const csv = async () => {
    if (!result || !mesh) return;
    const lines = [
      "surface_node,x_mm,y_mm,z_mm,ux_mm,uy_mm,uz_mm,displacement_mm,von_mises_MPa",
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
    await saveFile("bettersim-surface-nodes.csv", lines.join("\n"));
  };
  const exportSolver = async (kind: "deck" | "log" | "frd") => {
    if (!part) return;
    try {
      const response = await fetch(`/api/documents/${part.id}/export/${kind}`);
      if (!response.ok) throw Error((await response.json()).error);
      await saveFile(
        { deck: "analysis.inp", log: "solver.log", frd: "analysis.frd" }[kind],
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

  const inspector = () => {
    if (!part) return null;
    if (draft)
      return (
        <ConditionEditor
          draft={draft}
          exists={(draft.kind === "support"
            ? study.supports
            : study.loads
          ).some((c) => c.id === draft.value.id)}
          selected={selected}
          selectedArea={selectedArea}
          onChange={(changes) =>
            setDraft((d) =>
              d ? ({ ...d, value: { ...d.value, ...changes } } as Draft) : null,
            )
          }
          onRemoveFace={selectFace}
          onCancel={() => {
            setDraft(null);
            setSelected([]);
          }}
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
      case "material":
        return (
          <MaterialPanel
            key={study.material?.name}
            study={study}
            onApply={(material) => {
              update({ ...study, material });
              if (!study.supports.length) setSection("supports");
            }}
          />
        );
      case "supports":
      case "loads": {
        const kind = section === "supports" ? "support" : "load";
        return (
          <ConditionsPanel
            kind={kind}
            list={kind === "support" ? study.supports : study.loads}
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
            onPreview={() => run("mesh")}
            onSolve={() => run("solve")}
          />
        );
      case "results":
        return (
          result &&
          extremes && (
            <ResultsPanel
              result={result}
              mesh={mesh}
              study={study}
              plot={plot}
              extremes={extremes}
              deform={deform}
              autoScale={autoScale}
              wire={wire}
              probe={probe}
              probeIndex={probeIndex}
              probeValues={probeValues}
              comparison={comparison}
              fromProject={fromProject}
              busy={!!job}
              onDeform={setDeform}
              onWire={setWire}
              onProbe={setProbe}
              onRefine={() => run("solve", true)}
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
              plot={plot}
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
              disabled={!!job || !!result}
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
                geometry={part.geometry}
                mesh={mesh}
                result={result}
                study={shownStudy}
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
                marginMax={marginMax}
                yieldStrength={yieldStrength}
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
                        ? marginMax + "+"
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
              {!result && !job && selected.length > 0 && (
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
              {jobCard}
            </div>
            <Console
              log={log}
              result={result}
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
    </div>
  );
}
