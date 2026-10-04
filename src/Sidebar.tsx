import { Fragment } from "react";
import {
  Activity,
  Anchor,
  ArrowDown,
  Box,
  Grid3X3,
  Layers,
  Gauge,
  Search,
  Thermometer,
  Weight,
} from "lucide-react";
import { LISTS, conditionsOf, faceHint, fmt, type Draft } from "./logic";
import {
  ANALYSES,
  CONDITIONS,
  DETAIL_NAMES,
  analysisName,
  conditionValue,
  plotInfo,
  facesLabel,
  stripExt,
} from "./labels";
import { Group, Node, listKeys } from "./ui";
import type {
  Condition,
  ConditionKind,
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
  | "mesh"
  | "results";
const ICONS = {
  support: Anchor,
  load: ArrowDown,
  mass: Weight,
  thermal: Thermometer,
};
/** Condition groups the analysis uses, in tree order. */
export const conditionKinds = (study: Study) => {
  const a = ANALYSES[study.analysis];
  return (["thermal", "support", "load", "mass"] as const).filter((k) =>
    k === "thermal"
      ? a.thermal
      : k === "load"
        ? a.loads &&
          !(
            study.analysis === "harmonic" &&
            study.harmonic?.excitation === "base"
          )
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
  section: Section;
  plot: Plot;
  /** Plots the displayed result can show. */
  plots: Plot[];
  busy: boolean;
  onSection: (s: Section) => void;
  onAdd: (kind: ConditionKind) => void;
  onEdit: (kind: ConditionKind, c: Condition) => void;
  onPlot: (p: Plot) => void;
}) {
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
        value={part.geometry.dimensions.map((d) => fmt(d, 1)).join("×")}
        active={section === "part"}
        onClick={() => onSection("part")}
        disabled={busy}
      />
      <Node
        depth={1}
        icon={Gauge}
        label="Analysis"
        value={
          study.analysis === "static" && study.largeDeformation
            ? "Large deformation"
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
                  : conditionValue(kind, c)
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
            group
            onClick={() => onSection("results")}
            disabled={busy}
          />
          {plots.map((k) => (
            <Node
              key={k}
              depth={2}
              label={plotInfo(k, result.analysis).name}
              active={section === "results" && plot === k}
              disabled={busy}
              onClick={() => onPlot(k)}
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
}

export function FaceList({
  part,
  study,
  selected,
  hover,
  draftKind,
  disabled,
  query,
  onQuery,
  onSelect,
  onHover,
}: {
  part: Part;
  study: Study;
  selected: number[];
  hover: number | null;
  draftKind: ConditionKind | null;
  disabled: boolean;
  query: string;
  onQuery: (q: string) => void;
  onSelect: (id: number) => void;
  onHover: (id: number | null) => void;
}) {
  const use = new Map<number, { kind: ConditionKind; name: string }>();
  for (const kind of conditionKinds(study))
    for (const c of conditionsOf(study, kind))
      for (const f of c.faces)
        if (!use.has(f)) use.set(f, { kind, name: c.name });
  const q = query.trim().toLowerCase();
  return (
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
        {part.geometry.faces
          .filter((f) => (f.id + " " + f.type).toLowerCase().includes(q))
          .map((f) => {
            const u = use.get(f.id);
            const isSelected = selected.includes(f.id);
            return (
              <button
                key={f.id}
                className={
                  "face-row" +
                  (isSelected ? " selected " + (draftKind || "") : "") +
                  (hover === f.id ? " hovered" : "")
                }
                onClick={() => onSelect(f.id)}
                onMouseEnter={() => onHover(f.id)}
                onMouseLeave={() => onHover(null)}
                onFocus={() => onHover(f.id)}
                onBlur={() => onHover(null)}
                aria-pressed={isSelected}
                aria-label={`Face ${f.id}, ${f.type}, ${fmt(f.area, 1)} mm²${u ? ", " + u.name : ""}`}
                title={`Center ${f.center.map((c) => fmt(c, 1)).join(", ")} mm`}
                disabled={disabled}
              >
                <b>{f.id}</b>
                <span>
                  {faceHint(f)}
                  {(part.geometry.bodies?.length ?? 1) > 1 &&
                    ` · ${part.geometry.bodies!.find((b) => b.id === f.body)?.name}`}
                </span>
                {u ? (
                  <span className={"tag " + u.kind}>{u.name}</span>
                ) : (
                  <span className="tag">{fmt(f.area, 1)}</span>
                )}
              </button>
            );
          })}
      </div>
    </div>
  );
}
