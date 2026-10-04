import { useState } from "react";
import {
  Camera,
  Check,
  ChevronRight,
  Download,
  FileText,
  Grid3X3,
  Layers,
  Play,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { editMaterial, fmt, type Draft } from "./logic";
import {
  DETAILS,
  DETAIL_NAMES,
  CONDITIONS,
  LOAD_KINDS,
  conditionValue,
  isBodyLoad,
  PLOTS,
  SOLVERS,
  facesLabel,
  loadValue,
  stripExt,
} from "./labels";
import { Head, NumberField, Row } from "./ui";
import { probeValue, type Probe } from "./viewData";
import { ConvergenceControls, ConvergenceReport } from "./Convergence";
import {
  MATERIALS,
  type Axis,
  type Filters,
  type Condition,
  type ConditionKind,
  type ConvergenceOptions,
  type Load,
  type LoadKind,
  type PointMass,
  type Region,
  type RegionResult,
  type Material,
  type Mesh,
  type Part,
  type Plot,
  type Result,
  type Study,
  type Support,
  type Threads,
  type Cpus,
} from "./types";

export function PartPanel({
  part,
  onMaterial,
  onExample,
}: {
  part: Part;
  onMaterial: () => void;
  onExample: () => void;
}) {
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
          STEP lengths are converted to millimetres. Check the size against your
          CAD model.
        </p>
      </div>
      <div className="sec">
        <button className="btn primary full" onClick={onMaterial}>
          Set material
          <ChevronRight size={14} />
        </button>
        {part.sample && (
          <button className="btn full" onClick={onExample}>
            Use example setup
          </button>
        )}
      </div>
    </>
  );
}

const PRESET_NAMES = MATERIALS.map((m) => m.name);

export function MaterialPanel({
  study,
  onApply,
}: {
  study: Study;
  onApply: (m: Material) => void;
}) {
  const [material, setMaterial] = useState<Material>(() =>
    structuredClone(study.material || MATERIALS[0]),
  );
  const valid =
    !!material.name.trim() &&
    material.young > 0 &&
    material.density > 0 &&
    material.poisson > -1 &&
    material.poisson < 0.499;
  const edit = (changes: Partial<Material>) =>
    setMaterial(editMaterial(material, changes, PRESET_NAMES));
  return (
    <>
      <Head small="Material" title={study.material?.name || "Not set"} />
      <div className="sec">
        <h4>Presets</h4>
        <div className="presets">
          {MATERIALS.map((m) => (
            <button
              key={m.name}
              onClick={() => setMaterial(structuredClone(m))}
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
            onChange={(e) => setMaterial({ ...material, name: e.target.value })}
          />
        </label>
        <NumberField
          label="Elastic modulus"
          value={material.young}
          unit="MPa"
          onChange={(v) => edit({ young: v })}
        />
        <NumberField
          label="Poisson ratio"
          value={material.poisson}
          step="0.01"
          onChange={(v) => edit({ poisson: v })}
        />
        <NumberField
          label="Density"
          value={material.density}
          unit="kg/m³"
          onChange={(v) => edit({ density: v })}
        />
        <NumberField
          label="Yield strength (optional)"
          value={material.yield ?? 0}
          unit="MPa"
          onChange={(v) => edit({ yield: v || null })}
        />
        <p className="note">
          Preset values are typical. Use your material's specification.
        </p>
      </div>
      <div className="sec">
        <button
          className="btn primary full"
          disabled={!valid}
          onClick={() => onApply({ ...material, name: material.name.trim() })}
        >
          Apply material
        </button>
      </div>
    </>
  );
}

export function ConditionsPanel({
  kind,
  list,
  selectedCount,
  onAdd,
  onEdit,
  onRemove,
}: {
  kind: ConditionKind;
  list: Condition[];
  selectedCount: number;
  onAdd: () => void;
  onEdit: (c: Condition) => void;
  onRemove: (id: string) => void;
}) {
  const labels = CONDITIONS[kind];
  return (
    <>
      <Head
        small={labels.group}
        title={list.length ? list.length + " defined" : "None"}
      />
      <div className="sec">
        {list.map((c) => (
          <div className="list-item" key={c.id}>
            <button onClick={() => onEdit(c)}>
              <span className={"swatch " + kind} />
              {c.name}
              <span className="val">
                {kind !== "support" ? conditionValue(kind, c) + " · " : ""}
                {kind === "load" && isBodyLoad(c as Load)
                  ? "whole part"
                  : facesLabel(c.faces)}
              </span>
            </button>
            <button
              className="icon-button delete"
              aria-label={"Delete " + c.name}
              onClick={() => onRemove(c.id)}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        {!list.length && (
          <p className="note" style={{ marginTop: 0 }}>
            {labels.empty}
          </p>
        )}
      </div>
      <div className="sec">
        <button
          className={"btn full" + (list.length ? "" : " primary")}
          onClick={onAdd}
        >
          <Plus size={14} />
          {labels.add}
        </button>
        {selectedCount > 0 && (
          <p className="note">
            The {selectedCount} selected{" "}
            {selectedCount === 1 ? "face" : "faces"} will be used.
          </p>
        )}
      </div>
    </>
  );
}

export function ConditionEditor({
  draft,
  exists,
  selected,
  selectedArea,
  center,
  onChange,
  onRemoveFace,
  onCancel,
  onSave,
  onDelete,
}: {
  draft: Draft;
  exists: boolean;
  selected: number[];
  selectedArea: number;
  /** Area-weighted center of the selected faces, and of the part. */
  center: { selection: number[] | null; part: number[] };
  onChange: (changes: Record<string, unknown>) => void;
  onRemoveFace: (id: number) => void;
  onCancel: () => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const v = draft.value;
  const body = draft.kind === "load" && isBodyLoad(draft.value);
  const zero = (v?: number[]) => !v || v.every((x) => x === 0);
  const invalid =
    !v.name.trim() ||
    (!selected.length && !body) ||
    (draft.kind === "mass" &&
      (!(draft.value.mass > 0) ||
        draft.value.point.some((x) => !isFinite(x)))) ||
    (draft.kind === "support" && !draft.value.axes.some(Boolean)) ||
    (draft.kind === "load" &&
      (draft.value.kind === "pressure"
        ? draft.value.magnitude === 0
        : draft.value.kind === "rotation"
          ? draft.value.magnitude === 0 || zero(draft.value.axis)
          : zero(draft.value.vector)));
  return (
    <>
      <Head
        small={(exists ? "Edit " : "New ") + draft.kind}
        title={v.name || "Untitled"}
      />
      <div className="sec">
        <label className="field">
          <span>Name</span>
          <input
            className="input"
            value={v.name}
            onChange={(e) => onChange({ name: e.target.value })}
          />
        </label>
        {draft.kind === "support" ? (
          <SupportFields support={draft.value} onChange={onChange} />
        ) : draft.kind === "load" ? (
          <LoadFields load={draft.value} center={center} onChange={onChange} />
        ) : (
          <MassFields mass={draft.value} center={center} onChange={onChange} />
        )}
      </div>
      {!body && (
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
                    onClick={() => onRemoveFace(id)}
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
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" disabled={invalid} onClick={onSave}>
            Save {draft.kind}
          </button>
        </div>
        {exists && (
          <button className="btn danger full" onClick={onDelete}>
            <Trash2 size={13} />
            Delete
          </button>
        )}
      </div>
    </>
  );
}

function MassFields({
  mass,
  center,
  onChange,
}: {
  mass: PointMass;
  center: { selection: number[] | null; part: number[] };
  onChange: (changes: Record<string, unknown>) => void;
}) {
  return (
    <>
      <NumberField
        label="Mass"
        value={mass.mass}
        unit="kg"
        onChange={(v) => onChange({ mass: v })}
      />
      <VectorField
        label="Center of mass, mm"
        name="center of mass"
        value={mass.point}
        onChange={(point) => onChange({ point })}
        action={
          center.selection
            ? {
                label: "Face center",
                onClick: () => onChange({ point: round(center.selection!) }),
              }
            : undefined
        }
      />
      <p className="note">
        Stands in for a component that is not modeled, such as a motor bolted to
        the selected faces. It adds its weight under gravity and its load under
        rotation. Treated as a point: its own rotational inertia is ignored.
      </p>
    </>
  );
}

function SupportFields({
  support,
  onChange,
}: {
  support: Support;
  onChange: (changes: Record<string, unknown>) => void;
}) {
  const fixed = support.axes.every(Boolean);
  return (
    <>
      <div className="field">
        <span>Type</span>
        <div className="seg">
          {(["Fixed", "Directional"] as const).map((t) => {
            const on = (t === "Fixed") === fixed;
            return (
              <button
                key={t}
                className={on ? "on" : ""}
                onClick={() =>
                  !on &&
                  onChange({
                    axes:
                      t === "Fixed" ? [true, true, true] : [false, false, true],
                    name: ["Fixed", "Directional"].includes(support.name)
                      ? t
                      : support.name,
                  })
                }
              >
                {t}
              </button>
            );
          })}
        </div>
      </div>
      {!fixed && (
        <div className="field">
          <span>Blocked directions</span>
          <div className="axes">
            {["X", "Y", "Z"].map((a, i) => (
              <button
                key={a}
                aria-pressed={support.axes[i]}
                className={support.axes[i] ? "on" : ""}
                onClick={() =>
                  onChange({
                    axes: support.axes.map((x, j) => (j === i ? !x : x)),
                  })
                }
              >
                <b className={"axis-" + a.toLowerCase()}>{a}</b>
                {support.axes[i] ? "Blocked" : "Free"}
              </button>
            ))}
          </div>
        </div>
      )}
      <p className="note">
        {fixed
          ? "Blocks movement in X, Y and Z."
          : "Global directions. The solver rejects supports that leave the part free to move."}
      </p>
    </>
  );
}

/** Editing positions and directions: three inputs labelled "<axis> <name>". */
function VectorField({
  label,
  name,
  value,
  onChange,
  action,
}: {
  label: string;
  name: string;
  value: number[];
  onChange: (v: number[]) => void;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="field">
      <span>
        {label}
        {action && (
          <button className="link field-action" onClick={action.onClick}>
            {action.label}
          </button>
        )}
      </span>
      <div className="vec">
        {["X", "Y", "Z"].map((a, i) => (
          <label key={a} className={"axis-" + a.toLowerCase()}>
            <span>{a}</span>
            <input
              aria-label={a + " " + name}
              type="number"
              value={value[i]}
              onChange={(e) =>
                onChange(
                  value.map((x, j) => (j === i ? Number(e.target.value) : x)),
                )
              }
            />
          </label>
        ))}
      </div>
    </div>
  );
}

const round = (v: number[]) => v.map((x) => Number(x.toPrecision(6)));
const FORCE_LIKE = ["force", "remote", "bearing"];

/** The changes for switching a load to another kind, keeping what still fits. */
function switchKind(
  load: Load,
  kind: LoadKind,
  center: { selection: number[] | null; part: number[] },
): Partial<Load> {
  const names = LOAD_KINDS.map((k) => k.name);
  const name = names.includes(load.name)
    ? LOAD_KINDS.find((k) => k.id === kind)!.name
    : load.name;
  const vector =
    FORCE_LIKE.includes(kind) && FORCE_LIKE.includes(load.kind)
      ? load.vector
      : kind === "gravity"
        ? [0, 0, -9.81]
        : kind === "moment"
          ? [0, 0, 10000]
          : [0, 0, -100];
  const changes: Partial<Load> = { kind, name, vector };
  if (kind === "remote") changes.point = round(center.selection || center.part);
  if (kind === "rotation") {
    changes.magnitude = 1000;
    changes.axis = [0, 0, 1];
    changes.point = round(center.part);
  }
  if (kind === "pressure") changes.magnitude = 1;
  return changes;
}

function LoadFields({
  load,
  center,
  onChange,
}: {
  load: Load;
  center: { selection: number[] | null; part: number[] };
  onChange: (changes: Record<string, unknown>) => void;
}) {
  const kind = LOAD_KINDS.find((k) => k.id === load.kind)!;
  const forceLike = FORCE_LIKE.includes(load.kind);
  return (
    <>
      <div className="field">
        <span>Type</span>
        <div className="seg wrap" role="group" aria-label="Load type">
          {LOAD_KINDS.map((k) => (
            <button
              key={k.id}
              className={load.kind === k.id ? "on" : ""}
              aria-pressed={load.kind === k.id}
              onClick={() =>
                load.kind !== k.id && onChange(switchKind(load, k.id, center))
              }
            >
              {k.name}
            </button>
          ))}
        </div>
      </div>
      {load.kind === "pressure" && (
        <NumberField
          label="Pressure"
          value={load.magnitude}
          unit="MPa"
          onChange={(v) => onChange({ magnitude: v })}
        />
      )}
      {load.kind === "rotation" && (
        <>
          <NumberField
            label="Speed"
            value={load.magnitude}
            unit="rpm"
            onChange={(v) => onChange({ magnitude: v })}
          />
          <div className="field">
            <span>Axis direction</span>
            <div className="seg" role="group" aria-label="Rotation axis">
              {["X", "Y", "Z"].map((a, i) => {
                const axis = [0, 0, 0].map((_, j) => +(i === j));
                const on = load.axis?.every((v, j) => v === axis[j]);
                return (
                  <button
                    key={a}
                    className={on ? "on" : ""}
                    aria-pressed={!!on}
                    onClick={() => onChange({ axis })}
                  >
                    <b className={"axis-" + a.toLowerCase()}>{a}</b>
                  </button>
                );
              })}
            </div>
          </div>
          <VectorField
            label="Custom direction"
            name="axis"
            value={load.axis || [0, 0, 1]}
            onChange={(axis) => onChange({ axis })}
          />
          <VectorField
            label="Axis passes through, mm"
            name="axis position"
            value={load.point || center.part}
            onChange={(point) => onChange({ point })}
            action={{
              label: "Part center",
              onClick: () => onChange({ point: round(center.part) }),
            }}
          />
        </>
      )}
      {(forceLike || load.kind === "gravity" || load.kind === "moment") && (
        <>
          <VectorField
            label={
              load.kind === "gravity"
                ? "Acceleration, m/s²"
                : load.kind === "moment"
                  ? "Moment, N·mm"
                  : "Total force, N"
            }
            name={
              load.kind === "gravity"
                ? "acceleration"
                : load.kind === "moment"
                  ? "moment"
                  : "force"
            }
            value={load.vector}
            onChange={(vector) => onChange({ vector })}
          />
          <Row label="Magnitude">
            {fmt(Math.hypot(...load.vector))}
            <em>
              {load.kind === "gravity"
                ? "m/s²"
                : load.kind === "moment"
                  ? "N·mm"
                  : "N"}
            </em>
          </Row>
        </>
      )}
      {load.kind === "remote" && (
        <VectorField
          label="Acts at, mm"
          name="position"
          value={load.point || center.part}
          onChange={(point) => onChange({ point })}
          action={
            center.selection
              ? {
                  label: "Face center",
                  onClick: () => onChange({ point: round(center.selection!) }),
                }
              : undefined
          }
        />
      )}
      <p className="note">{kind.note}</p>
    </>
  );
}

export function MeshPanel({
  part,
  study,
  mesh,
  missing,
  canSolve,
  busy,
  threads,
  cpus,
  onChange,
  onThreads,
  onPreview,
  onSolve,
}: {
  part: Part;
  study: Study;
  mesh: Mesh | null;
  missing: string[];
  canSolve: boolean;
  busy: boolean;
  threads: Threads;
  cpus: Cpus | null;
  onChange: (study: Study) => void;
  onThreads: (threads: Threads) => void;
  onPreview: () => void;
  onSolve: () => void;
}) {
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
                  onChange({
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
            onChange({ ...study, detail: "custom", meshSize: v })
          }
        />
        <p className="note">
          Quadratic tetrahedra (C3D10), refined on curved faces.
        </p>
      </div>
      <div className="sec">
        <h4>Solver</h4>
        <div className="presets" role="group" aria-label="Solver">
          {SOLVERS.map((s) => (
            <button
              key={s.id}
              aria-pressed={study.solver === s.id}
              className={study.solver === s.id ? "on" : ""}
              onClick={() => onChange({ ...study, solver: s.id })}
            >
              <span>
                {s.name}
                <small>{s.note}</small>
              </span>
              {study.solver === s.id && <Check size={14} />}
            </button>
          ))}
        </div>
        <div className="field" style={{ marginTop: 10 }}>
          <span>Threads</span>
          <div className="seg" role="group" aria-label="Threads">
            {(
              [
                ["auto", "Auto", cpus?.performance],
                ["single", "1", null],
                ["all", "All", cpus?.logical],
              ] as const
            ).map(([id, name, count]) => (
              <button
                key={id}
                aria-pressed={threads === id}
                className={threads === id ? "on" : ""}
                onClick={() => onThreads(id)}
              >
                {name}
                {count ? ` · ${count}` : ""}
              </button>
            ))}
          </div>
        </div>
        <p className="note">
          Auto uses the performance cores. Threads speed up meshing, assembly,
          the direct solver and stress recovery without changing results;
          iterative solvers iterate on one thread. Saved on this computer, not
          in the study.
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
          onClick={onPreview}
          disabled={busy || study.meshSize <= 0}
        >
          <Grid3X3 size={14} />
          {mesh ? "Rebuild mesh" : "Preview mesh"}
        </button>
        <button
          className="btn primary full"
          disabled={!canSolve}
          onClick={onSolve}
        >
          <Play size={12} fill="currentColor" />
          Solve
        </button>
      </div>
    </>
  );
}

export type Comparison = { before: Result; after: Result };
/** Peak, minimum and color-scale range of the displayed plot. */
export type PlotStats = {
  peak: { value: number; node: number };
  min: number;
  scale: { min: number; max: number };
};

export type RegionState = {
  draft: Region | null;
  result: RegionResult | null;
  showing: boolean;
  available: boolean;
  onStart: () => void;
  onDraft: (r: Region | null) => void;
  onSolve: () => void;
  onShow: (on: boolean) => void;
};

export function ResultsPanel({
  result,
  region,
  mesh,
  study,
  plot,
  stats,
  frame,
  onFrame,
  deform,
  autoScale,
  wire,
  probe,
  filters,
  bounds,
  scale,
  sectionArea,
  onFilters,
  comparison,
  fromProject,
  busy,
  onDeform,
  onWire,
  onProbe,
  onRefine,
  convergeOptions,
  onConvergeOptions,
  onConverge,
  onCsv,
  onImage,
  onSolverFile,
}: {
  result: Result;
  region: RegionState;
  mesh: Mesh | null;
  study: Study;
  plot: Plot;
  stats: PlotStats;
  frame: number;
  onFrame: (k: number) => void;
  deform: "off" | "true" | "auto";
  autoScale: number;
  wire: boolean;
  probe: Probe | null;
  filters: Filters;
  bounds: number[];
  scale: { min: number; max: number };
  sectionArea: number | null;
  onFilters: (f: Filters) => void;
  comparison: Comparison | null;
  fromProject: boolean;
  busy: boolean;
  onDeform: (d: "off" | "true" | "auto") => void;
  onWire: (on: boolean) => void;
  onProbe: (node: number | null) => void;
  onRefine: () => void;
  convergeOptions: ConvergenceOptions;
  onConvergeOptions: (o: ConvergenceOptions) => void;
  onConverge: () => void;
  onCsv: () => void;
  onImage: () => void;
  onSolverFile: (kind: "deck" | "log" | "frd") => void;
}) {
  const s = result.summary;
  const yieldStrength = study.material?.yield || null;
  const low = plot === "safety";
  const digits = plot === "stress" ? 2 : PLOTS[plot].digits;
  const peak = {
    value: fmt(stats.peak.value, digits),
    node: stats.peak.node,
    label: low ? "Minimum" : "Maximum",
  };
  const solverNote = fromProject
    ? "Loaded from the project. Solve again to regenerate solver files."
    : undefined;
  return (
    <>
      <Head small="Result" title={PLOTS[plot].name} />
      {result.frames.length > 1 && (
        <FramePicker result={result} frame={frame} onFrame={onFrame} />
      )}
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
            {fmt(stats.min, PLOTS[plot].digits)}
            <em>{PLOTS[plot].unit}</em>
          </Row>
        )}
        <div className="kv">
          <span>Location</span>
          <button className="link" onClick={() => onProbe(peak.node)}>
            Show in view
          </button>
        </div>
      </div>
      <div className="sec">
        <h4>Display</h4>
        {autoScale > 0 && (
          <div className="field">
            <span>Shape</span>
            <div className="seg" role="group" aria-label="Shape">
              <button
                className={deform === "off" ? "on" : ""}
                onClick={() => onDeform("off")}
              >
                Undeformed
              </button>
              <button
                className={deform === "true" ? "on" : ""}
                onClick={() => onDeform("true")}
              >
                1×
              </button>
              <button
                className={deform === "auto" ? "on" : ""}
                onClick={() => onDeform("auto")}
                aria-label="Magnified"
              >
                {fmt(autoScale, autoScale >= 100 ? 0 : 1)}×
              </button>
            </div>
          </div>
        )}
        <div className="switch-row">
          <span>Mesh edges</span>
          <button
            className={"switch" + (wire ? " on" : "")}
            role="switch"
            aria-checked={wire}
            aria-label="Mesh edges"
            onClick={() => onWire(!wire)}
          />
        </div>
      </div>
      <div className="sec probe-card">
        <h4>
          Probe
          {probe ? (
            <button className="link" onClick={() => onProbe(null)}>
              Clear
            </button>
          ) : (
            <span className="mono">click model</span>
          )}
        </h4>
        {probe ? (
          <>
            <Row label="At">
              {probe.node === null ? "Interpolated" : "Node " + probe.node}
            </Row>
            <Row label="Position">
              {probe.point.map((n) => fmt(n, 2)).join(", ")}
              <em>mm</em>
            </Row>
            {PROBE_ROWS.map(({ plot: p, label, digits }) => {
              const value = probeValue(probe, p, yieldStrength);
              return (
                value !== null && (
                  <Row key={p} label={label}>
                    {p === "safety" && value >= 1000
                      ? "> 1000"
                      : fmt(value, digits)}
                    <em>{p === "safety" ? "×" : PLOTS[p].unit}</em>
                  </Row>
                )
              );
            })}
          </>
        ) : (
          <p className="note" style={{ marginTop: 0 }}>
            Click the model or a section to read interpolated values.
          </p>
        )}
      </div>
      <FilterControls
        filters={filters}
        plot={plot}
        bounds={bounds}
        scale={scale}
        sectionArea={sectionArea}
        onChange={onFilters}
      />
      {!region.showing && (
        <div className="sec">
          <h4>Mesh convergence</h4>
          {result.convergence && (
            <ConvergenceReport report={result.convergence} />
          )}
          {comparison && !result.convergence && (
            <div className="comparison">
              <Row label="Elements">
                {fmt(comparison.before.elementCount)} →{" "}
                {fmt(result.elementCount)}
              </Row>
              {result.keys.map((k) => {
                const before = comparison.before.keys.find(
                  (b) => b.id === k.id,
                )?.value;
                return (
                  before !== undefined && (
                    <Row key={k.id} label={k.label + " change"}>
                      {fmt(Math.abs(k.value / before - 1) * 100, 2)}
                      <em>%</em>
                    </Row>
                  )
                );
              })}
              <div style={{ height: 8 }} />
            </div>
          )}
          {!result.convergence && !comparison && (
            <p className="note" style={{ marginTop: 0 }}>
              Results depend on the mesh. Solve on finer meshes until the
              numbers stop changing.
            </p>
          )}
          <ConvergenceControls
            options={convergeOptions}
            onChange={onConvergeOptions}
          />
          <button
            className="btn primary full"
            onClick={onConverge}
            disabled={busy}
          >
            <Layers size={14} />
            Check mesh convergence
          </button>
          <button className="btn full" onClick={onRefine} disabled={busy}>
            Re-solve once with {fmt((mesh?.size || study.meshSize) * 0.7, 2)} mm
            mesh
          </button>
        </div>
      )}
      <RegionControls region={region} />
      <div className="sec">
        <h4>Export</h4>
        <div className="exports">
          <button
            className="btn"
            onClick={onCsv}
            title="Node positions, displacement and stress on the part surface"
          >
            <Download size={13} />
            Surface CSV
          </button>
          <button className="btn" onClick={onImage}>
            <Camera size={13} />
            View PNG
          </button>
          {(
            [
              ["deck", "Deck .inp"],
              ["frd", "Results .frd"],
              ["log", "Solver log"],
            ] as const
          ).map(([kind, label]) => (
            <button
              key={kind}
              className="btn"
              onClick={() => onSolverFile(kind)}
              disabled={fromProject}
              title={solverNote}
            >
              <FileText size={13} />
              {label}
            </button>
          ))}
        </div>
        {fromProject && <p className="note">{solverNote}</p>}
      </div>
      {result.warnings
        .filter((w) => !w.startsWith("Peak stress"))
        .map((w) => (
          <p className="foot note warn" key={w}>
            {w}
          </p>
        ))}
      <p className="foot">
        Linear elastic, isotropic, small deformation, static load. Peak stress
        at supports and sharp corners can keep rising with refinement.
      </p>
    </>
  );
}

function FilterControls({
  filters,
  plot,
  bounds,
  scale,
  sectionArea,
  onChange,
}: {
  filters: Filters;
  plot: Plot;
  bounds: number[];
  scale: { min: number; max: number };
  sectionArea: number | null;
  onChange: (f: Filters) => void;
}) {
  const { section, iso, threshold } = filters;
  const unit = PLOTS[plot].unit;
  const digits =
    plot === "movement"
      ? 4
      : plot === "stress" || plot === "temperature"
        ? 2
        : 1;
  const [lo, hi] = [bounds[section.axis], bounds[section.axis + 3]];
  const set = <K extends keyof Filters>(key: K, changes: Partial<Filters[K]>) =>
    onChange({ ...filters, [key]: { ...filters[key], ...changes } });
  const toggle = (key: keyof Filters, label: string) => (
    <div className="switch-row">
      <span>{label}</span>
      <button
        className={"switch" + (filters[key].on ? " on" : "")}
        role="switch"
        aria-checked={filters[key].on}
        aria-label={label}
        onClick={() => set(key, { on: !filters[key].on })}
      />
    </div>
  );
  const level = (key: "iso" | "threshold", label: string) => (
    <label className="field">
      <span>
        {label}
        <b className="mono">
          {fmt(
            scale.min + filters[key].level * (scale.max - scale.min),
            digits,
          )}{" "}
          {unit}
        </b>
      </span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.005}
        aria-label={label}
        value={filters[key].level}
        onChange={(e) => set(key, { level: Number(e.target.value) })}
      />
    </label>
  );
  return (
    <div className="sec filters">
      <h4>Filters</h4>
      {toggle("section", "Section")}
      {section.on && (
        <>
          <div className="field">
            <span>Normal</span>
            <div className="seg" role="group" aria-label="Section normal">
              {(["X", "Y", "Z"] as const).map((a, i) => (
                <button
                  key={a}
                  className={section.axis === i ? "on" : ""}
                  onClick={() =>
                    set("section", {
                      axis: i as Axis,
                      position: (bounds[i] + bounds[i + 3]) / 2,
                    })
                  }
                >
                  <b className={"axis-" + a.toLowerCase()}>{a}</b>
                </button>
              ))}
              <button
                aria-pressed={section.flip}
                className={section.flip ? "on" : ""}
                onClick={() => set("section", { flip: !section.flip })}
                title="Keep the other side"
              >
                Flip
              </button>
            </div>
          </div>
          <label className="field">
            <span>
              Position
              <b className="mono">{fmt(section.position, 2)} mm</b>
            </span>
            <input
              type="range"
              aria-label="Section position"
              min={lo}
              max={hi}
              step={(hi - lo) / 400 || 1}
              value={section.position}
              onChange={(e) =>
                set("section", { position: Number(e.target.value) })
              }
            />
          </label>
          {sectionArea !== null && (
            <Row label="Section area">
              {fmt(sectionArea, 1)}
              <em>mm²</em>
            </Row>
          )}
        </>
      )}
      {toggle("iso", "Iso-surface")}
      {iso.on && level("iso", "Iso value")}
      {toggle("threshold", "Threshold")}
      {threshold.on &&
        level("threshold", plot === "safety" ? "Show below" : "Show above")}
      <p className="note">
        Filters use the plotted quantity. Click a section or surface to probe
        it.
      </p>
    </div>
  );
}

/** Probe card rows, shown when the probed frame has the quantity. */
const PROBE_ROWS: { plot: Plot; label: string; digits: number }[] = [
  { plot: "stress", label: "Stress", digits: 3 },
  { plot: "movement", label: "Displacement", digits: 5 },
  { plot: "safety", label: "Yield margin", digits: 2 },
  { plot: "temperature", label: "Temperature", digits: 2 },
  { plot: "plastic", label: "Plastic strain", digits: 5 },
];

/** Chooses the displayed frame: a mode, increment, or frequency. */
function FramePicker({
  result,
  frame,
  onFrame,
}: {
  result: Result;
  frame: number;
  onFrame: (k: number) => void;
}) {
  const frames = result.frames;
  const label = (k: number) => {
    const f = frames[k];
    return f.value === null
      ? f.label
      : `${f.label} · ${fmt(f.value, 4)} ${f.unit}`.trim();
  };
  return (
    <div className="sec">
      <label className="field">
        <span>
          Showing
          <b className="mono">{label(frame)}</b>
        </span>
        <input
          type="range"
          aria-label="Result frame"
          min={0}
          max={frames.length - 1}
          step={1}
          value={frame}
          onChange={(e) => onFrame(Number(e.target.value))}
        />
      </label>
    </div>
  );
}

/**
 * Submodeling: re-solve a box around a hot spot on a finer mesh, driven by
 * the whole-part solution at the box's cut faces.
 */
function RegionControls({ region }: { region: RegionState }) {
  const { draft, result } = region;
  const s = result?.summary;
  return (
    <div className="sec region">
      <h4>Refine a region</h4>
      {result && (
        <div className="seg" role="group" aria-label="Show result">
          {(
            [
              [false, "Whole part"],
              [true, "Region"],
            ] as const
          ).map(([on, label]) => (
            <button
              key={label}
              className={region.showing === on ? "on" : ""}
              aria-pressed={region.showing === on}
              onClick={() => region.onShow(on)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {result && s && (
        <div style={{ marginTop: 8 }}>
          <Row label="Peak stress, whole part">
            {fmt(s.globalPeak as number, 3)}
            <em>MPa</em>
          </Row>
          <Row label="Peak stress, refined region">
            {fmt(s.maxStress!, 3)}
            <em>MPa</em>
          </Row>
          <Row label="Cut-face agreement">
            {fmt((s.boundaryDifference as number) * 100, 1)}
            <em>% of peak</em>
          </Row>
          <p className="note">
            {(s.boundaryDifference as number) <= 0.1
              ? "The region's cut faces agree with the whole part, so the refined stress inside it can be trusted."
              : "The cut faces disagree with the whole part: they are too close to the hot spot. Make the region larger."}
          </p>
        </div>
      )}
      {!region.available ? (
        <p className="note" style={{ marginTop: 0 }}>
          Solve the whole part in this session to refine a region.
        </p>
      ) : draft ? (
        <>
          <VectorField
            label="Center, mm"
            name="region center"
            value={draft.center}
            onChange={(center) => region.onDraft({ ...draft, center })}
          />
          <VectorField
            label="Size, mm"
            name="region size"
            value={draft.size}
            onChange={(size) => region.onDraft({ ...draft, size })}
          />
          <NumberField
            label="Region element size"
            unit="mm"
            value={draft.meshSize}
            onChange={(meshSize) => region.onDraft({ ...draft, meshSize })}
          />
          <p className="note">
            Keep the box's faces away from the hot spot: they follow the
            whole-part solution.
          </p>
          <div className="row2" style={{ marginTop: 10 }}>
            <button className="btn" onClick={() => region.onDraft(null)}>
              Cancel
            </button>
            <button
              className="btn primary"
              onClick={region.onSolve}
              disabled={
                draft.size.some((v) => !(v > 0)) || !(draft.meshSize > 0)
              }
            >
              Solve region
            </button>
          </div>
        </>
      ) : (
        <>
          {!result && (
            <p className="note" style={{ marginTop: 0 }}>
              Re-solve a box around a hot spot with a much finer mesh. The rest
              of the part supplies its boundary.
            </p>
          )}
          <button
            className="btn full"
            style={{ marginTop: 8 }}
            onClick={() => {
              region.onShow(false);
              if (result) region.onDraft(result.region);
              else region.onStart();
            }}
          >
            {result ? "Edit region" : "Refine a region"}
          </button>
        </>
      )}
    </div>
  );
}
