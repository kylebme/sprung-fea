import {
  Activity,
  Anchor,
  ArrowDown,
  Box,
  Grid3X3,
  Layers,
  Search,
} from "lucide-react";
import { faceHint, fmt, type Draft } from "./logic";
import { DETAIL_NAMES, PLOTS, facesLabel, loadValue, stripExt } from "./labels";
import { Group, Node, listKeys } from "./ui";
import type { Load, Mesh, Part, Plot, Result, Study, Support } from "./types";

export type Section =
  "part" | "material" | "supports" | "loads" | "mesh" | "results";

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
  onAdd: (kind: "support" | "load") => void;
  onEdit: (kind: "support" | "load", c: Support | Load) => void;
  onPlot: (p: Plot) => void;
}) {
  const isNew =
    draft &&
    !(draft.kind === "support" ? study.supports : study.loads).some(
      (c) => c.id === draft.value.id,
    );
  const draftRow = (kind: "support" | "load") =>
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
        icon={Layers}
        label="Material"
        value={study.material?.name || "not set"}
        active={section === "material"}
        onClick={() => onSection("material")}
        disabled={busy}
      />
      <Group
        icon={Anchor}
        label="Supports"
        active={section === "supports" && !draft}
        onClick={() => onSection("supports")}
        onAdd={() => onAdd("support")}
        addLabel="Add support"
        disabled={busy}
      />
      {study.supports.map((s) => (
        <Node
          key={s.id}
          depth={2}
          swatch="support"
          label={s.name}
          value={facesLabel(s.faces)}
          active={draft?.value.id === s.id}
          onClick={() => onEdit("support", s)}
          disabled={busy}
        />
      ))}
      {draftRow("support")}
      <Group
        icon={ArrowDown}
        label="Loads"
        active={section === "loads" && !draft}
        onClick={() => onSection("loads")}
        onAdd={() => onAdd("load")}
        addLabel="Add load"
        disabled={busy}
      />
      {study.loads.map((l) => (
        <Node
          key={l.id}
          depth={2}
          swatch="load"
          label={l.name}
          value={loadValue(l)}
          active={draft?.value.id === l.id}
          onClick={() => onEdit("load", l)}
          disabled={busy}
        />
      ))}
      {draftRow("load")}
      <Node
        depth={1}
        icon={Grid3X3}
        label="Mesh"
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
              label={PLOTS[k].name}
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
  draftKind: "support" | "load" | null;
  disabled: boolean;
  query: string;
  onQuery: (q: string) => void;
  onSelect: (id: number) => void;
  onHover: (id: number | null) => void;
}) {
  const use = new Map<number, { kind: "support" | "load"; name: string }>();
  for (const s of study.supports)
    for (const f of s.faces) use.set(f, { kind: "support", name: s.name });
  for (const l of study.loads)
    for (const f of l.faces)
      if (!use.has(f)) use.set(f, { kind: "load", name: l.name });
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
                <span>{faceHint(f)}</span>
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
