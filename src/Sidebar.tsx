import {
  Fragment,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  Activity,
  Anchor,
  ArrowDown,
  Box,
  Grid3X3,
  Layers,
  Eye,
  EyeOff,
  Gauge,
  Nut,
  Scan,
  Search,
  Spline,
  Thermometer,
  TrendingDown,
  Weight,
} from "lucide-react";
import { LISTS, conditionsOf, faceHint, fmt, type Draft } from "./logic";
import {
  ANALYSES,
  CONDITIONS,
  CONTACT_KINDS,
  contactActive,
  contactOf,
  contactPairs,
  DETAIL_NAMES,
  analysisName,
  conditionValue,
  plotInfo,
  facesLabel,
  stripExt,
} from "./labels";
import { Group, Node, listKeys, useUnits } from "./ui";
import type {
  Condition,
  ConditionKind,
  Face,
  Mesh,
  Part,
  Plot,
  Result,
  Study,
} from "./types";

export type Section =
  | "analysis"
  | "part"
  | "material"
  | "supports"
  | "loads"
  | "masses"
  | "thermal"
  | "contacts"
  | "bolts"
  | "mesh"
  | "results"
  | "convergence"
  | "region";
const ICONS = {
  support: Anchor,
  load: ArrowDown,
  mass: Weight,
  thermal: Thermometer,
  bolt: Nut,
};
/** Condition groups the analysis uses, in tree order. */
export const conditionKinds = (study: Study) => {
  const a = ANALYSES[study.analysis];
  return (["thermal", "support", "load", "mass", "bolt"] as const).filter(
    (k) =>
      k === "thermal"
        ? a.thermal
        : k === "load"
          ? a.loads &&
            !(
              study.analysis === "harmonic" &&
              study.harmonic?.excitation === "base"
            )
          : k === "bolt"
            ? contactActive(study)
            : a.mechanical,
  );
};

export function StudyTree({
  part,
  study,
  mesh,
  result,
  draft,
  section,
  plot,
  plots,
  busy,
  tools,
  onSection,
  onAdd,
  onEdit,
  onPlot,
}: {
  part: Part;
  study: Study;
  mesh: Mesh | null;
  result: Result | null;
  draft: Draft | null;
  section: Section | null;
  plot: Plot;
  /** Plots the displayed result can show. */
  plots: Plot[];
  busy: boolean;
  /** States of the result's tools; `region` is null where it can't apply. */
  tools: { convergence: string; region: string | null };
  onSection: (s: Section) => void;
  onAdd: (kind: ConditionKind) => void;
  onEdit: (kind: ConditionKind, c: Condition) => void;
  onPlot: (p: Plot) => void;
}) {
  const units = useUnits();
  const isNew =
    draft &&
    !conditionsOf(study, draft.kind).some((c) => c.id === draft.value.id);
  const draftRow = (kind: ConditionKind) =>
    isNew &&
    draft.kind === kind && (
      <Node
        depth={2}
        swatch={kind}
        label={draft.value.name || "Untitled"}
        value="new"
        active
      />
    );
  return (
    <nav className="tree" aria-label="Study" onKeyDown={listKeys(".node")}>
      <Node
        icon={Box}
        label={stripExt(part.name)}
        value={part.geometry.dimensions
          .map((d) => units.show(d, "mm", 1))
          .join("×")}
        active={section === "part"}
        onClick={() => onSection("part")}
        disabled={busy}
      />
      <Node
        depth={1}
        icon={Gauge}
        label="Analysis"
        value={
          study.analysis === "static" &&
          (study.largeDeformation || study.plasticity || study.contact)
            ? [
                study.largeDeformation && "large deformation",
                study.plasticity && "plastic",
                study.contact && "contact",
              ]
                .filter(Boolean)
                .join(", ")
                .replace(/^./, (c) => c.toUpperCase())
            : analysisName(study)
        }
        active={section === "analysis"}
        onClick={() => onSection("analysis")}
        disabled={busy}
      />
      <Node
        depth={1}
        icon={Layers}
        label="Material"
        value={study.material?.name || "not set"}
        active={section === "material"}
        onClick={() => onSection("material")}
        disabled={busy}
      />
      {contactActive(study) && (
        <Node
          depth={1}
          icon={Spline}
          label="Contacts"
          value={contactSummary(part, study)}
          active={section === "contacts"}
          onClick={() => onSection("contacts")}
          disabled={busy}
        />
      )}
      {conditionKinds(study).map((kind) => (
        <Fragment key={kind}>
          <Group
            icon={ICONS[kind]}
            label={CONDITIONS[kind].group}
            active={section === LISTS[kind] && !draft}
            onClick={() => onSection(LISTS[kind])}
            onAdd={() => onAdd(kind)}
            addLabel={CONDITIONS[kind].add}
            disabled={busy}
          />
          {conditionsOf(study, kind).map((c) => (
            <Node
              key={c.id}
              depth={2}
              swatch={kind}
              label={c.name}
              value={
                kind === "support"
                  ? facesLabel(c.faces)
                  : conditionValue(kind, c, units.system)
              }
              active={draft?.value.id === c.id}
              onClick={() => onEdit(kind, c)}
              disabled={busy}
            />
          ))}
          {draftRow(kind)}
        </Fragment>
      ))}
      <Node
        depth={1}
        icon={Grid3X3}
        label="Mesh + Solver"
        value={
          mesh ? fmt(mesh.elementCount) + " el" : DETAIL_NAMES[study.detail]
        }
        active={section === "mesh"}
        onClick={() => onSection("mesh")}
        disabled={busy}
      />
      {result ? (
        <>
          <Node
            depth={1}
            icon={Activity}
            label="Results"
            value={fmt(result.summary.seconds, 2) + " s"}
            active={section === "results"}
            onClick={() => onSection("results")}
            disabled={busy}
          />
          {/* Which quantity the view plots: one Results panel shows them all. */}
          <div role="radiogroup" aria-label="Plotted result">
            {plots.map((k) => (
              <button
                key={k}
                role="radio"
                aria-checked={plot === k}
                className="node plot"
                style={{ "--d": 2 } as CSSProperties}
                disabled={busy}
                onClick={() => onPlot(k)}
              >
                <span className="radio" />
                <span className="label">
                  {plotInfo(k, result.analysis).name}
                </span>
              </button>
            ))}
          </div>
          <Node
            depth={1}
            icon={TrendingDown}
            label="Convergence"
            value={tools.convergence}
            active={section === "convergence"}
            onClick={() => onSection("convergence")}
            disabled={busy}
          />
          {tools.region !== null && (
            <Node
              depth={1}
              icon={Scan}
              label="Refined region"
              value={tools.region}
              active={section === "region"}
              onClick={() => onSection("region")}
              disabled={busy}
            />
          )}
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
}

/** "2 frictional, 1 bonded": how many touching pairs of each kind. */
function contactSummary(part: Part, study: Study) {
  const pairs = contactPairs(part.geometry);
  return (
    CONTACT_KINDS.map(({ id }) => {
      const n = pairs.filter((p) => contactOf(study, p.id).kind === id).length;
      return n ? `${n} ${id}` : "";
    })
      .filter(Boolean)
      .join(", ") || "none"
  );
}

const FACES_HEIGHT = "sprung-fea-faces-height";

/**
 * The face list's height, set by dragging the splitter above it (or with
 * the arrow keys) and kept on this computer. Null leaves the list the room
 * the study tree doesn't need.
 */
function useFacesHeight() {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(() => {
    try {
      const saved = Number(localStorage.getItem(FACES_HEIGHT));
      return saved > 0 ? saved : null;
    } catch {
      return null;
    }
  });
  const resize = (next: number | null) => {
    const pane = ref.current?.parentElement;
    // Room for the Study header and a few tree rows above.
    const max = pane ? pane.clientHeight - 150 : Infinity;
    const value =
      next === null ? null : Math.round(Math.max(96, Math.min(next, max)));
    setHeight(value);
    try {
      if (value === null) localStorage.removeItem(FACES_HEIGHT);
      else localStorage.setItem(FACES_HEIGHT, String(value));
    } catch {}
  };
  const startResize = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !ref.current) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const start = { y: e.clientY, height: ref.current.offsetHeight };
    handle.setPointerCapture(e.pointerId);
    const move = (m: globalThis.PointerEvent) =>
      resize(start.height - (m.clientY - start.y));
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  const resizeKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowUp" ? 24 : e.key === "ArrowDown" ? -24 : 0;
    if (!step || !ref.current) return;
    e.preventDefault();
    resize(ref.current.offsetHeight + step);
  };
  return { ref, height, resize, startResize, resizeKeys };
}

export function FaceList({
  part,
  study,
  selected,
  hover,
  draftKind,
  disabled,
  busy,
  query,
  hidden,
  onQuery,
  onSelect,
  onSelectBody,
  onHidden,
  onHover,
}: {
  part: Part;
  study: Study;
  selected: number[];
  hover: number | null;
  draftKind: ConditionKind | null;
  /** Faces cannot be picked (a result is shown, or a job runs). */
  disabled: boolean;
  /** A job runs: body visibility cannot change either. */
  busy: boolean;
  query: string;
  /** Bodies hidden from the view. */
  hidden: number[];
  onQuery: (q: string) => void;
  onSelect: (id: number) => void;
  /** Adds every face of a body to the selection (or removes them all). */
  onSelectBody: (body: number) => void;
  onHidden: (bodies: number[]) => void;
  onHover: (id: number | null) => void;
}) {
  const units = useUnits();
  const { ref, height, resize, startResize, resizeKeys } = useFacesHeight();
  const use = new Map<number, { kind: ConditionKind; name: string }>();
  for (const kind of conditionKinds(study))
    for (const c of conditionsOf(study, kind))
      for (const f of c.faces)
        if (!use.has(f)) use.set(f, { kind, name: c.name });
  const q = query.trim().toLowerCase();
  const bodies = part.geometry.bodies ?? [];
  const grouped = bodies.length > 1;
  const row = (f: Face) => {
    const u = use.get(f.id);
    const isSelected = selected.includes(f.id);
    return (
      <button
        key={f.id}
        className={
          "face-row" +
          (isSelected ? " selected " + (draftKind || "") : "") +
          (hover === f.id ? " hovered" : "") +
          (hidden.includes(f.body ?? -1) ? " dim" : "")
        }
        onClick={() => onSelect(f.id)}
        onMouseEnter={() => onHover(f.id)}
        onMouseLeave={() => onHover(null)}
        onFocus={() => onHover(f.id)}
        onBlur={() => onHover(null)}
        aria-pressed={isSelected}
        aria-label={`Face ${f.id}, ${f.type}, ${units.show(f.area, "mm²", 1)} ${units.label("mm²")}${u ? ", " + u.name : ""}`}
        title={`Center ${f.center.map((c) => fmt(c, 1)).join(", ")} mm`}
        disabled={disabled}
      >
        <b>{f.id}</b>
        <span>{faceHint(f, (mm) => units.show(mm, "mm", 1))}</span>
        {u ? (
          <span className={"tag " + u.kind}>{u.name}</span>
        ) : (
          <span className="tag">{units.show(f.area, "mm²", 1)}</span>
        )}
      </button>
    );
  };
  const matching = part.geometry.faces.filter((f) =>
    (f.id + " " + f.type).toLowerCase().includes(q),
  );
  return (
    <div
      className={"faces" + (height === null ? "" : " sized")}
      ref={ref}
      style={height === null ? undefined : { height }}
    >
      <div
        className="splitter"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize face list"
        aria-valuenow={height ?? undefined}
        tabIndex={0}
        title="Drag to resize. Double-click to reset."
        onPointerDown={startResize}
        onKeyDown={resizeKeys}
        onDoubleClick={() => resize(null)}
      />
      <div className="phead">
        Faces
        {grouped && hidden.length > 0 ? (
          <button className="link" disabled={busy} onClick={() => onHidden([])}>
            Show all
          </button>
        ) : (
          <span className="mono faint">{part.geometry.faces.length}</span>
        )}
      </div>
      {part.geometry.faces.length > 8 && (
        <label className="face-search">
          <Search size={12} />
          <input
            aria-label="Filter faces"
            placeholder="Filter by number or type"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
          />
        </label>
      )}
      <div
        className="face-list"
        role="group"
        aria-label="Faces"
        onKeyDown={listKeys(".face-row")}
      >
        {grouped
          ? bodies.map((b) => {
              const off = hidden.includes(b.id);
              const own = matching.filter((f) => f.body === b.id);
              return (
                <Fragment key={b.id}>
                  <div className={"body-row" + (off ? " dim" : "")}>
                    <button
                      className="icon-button"
                      aria-label={(off ? "Show " : "Hide ") + b.name}
                      aria-pressed={!off}
                      title={off ? "Show" : "Hide"}
                      disabled={busy}
                      onClick={() =>
                        onHidden(
                          off
                            ? hidden.filter((h) => h !== b.id)
                            : [...hidden, b.id],
                        )
                      }
                    >
                      {off ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                    <b>{b.name}</b>
                    {draftKind && !disabled && (
                      <button
                        className="link"
                        aria-label={`Select all faces of ${b.name}`}
                        onClick={() => onSelectBody(b.id)}
                      >
                        All faces
                      </button>
                    )}
                    <button
                      className="link"
                      aria-label={`Isolate ${b.name}`}
                      disabled={busy}
                      onClick={() =>
                        onHidden(
                          bodies.filter((o) => o.id !== b.id).map((o) => o.id),
                        )
                      }
                    >
                      Isolate
                    </button>
                  </div>
                  {own.map(row)}
                </Fragment>
              );
            })
          : matching.map(row)}
      </div>
    </div>
  );
}
