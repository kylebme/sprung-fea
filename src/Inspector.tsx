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
  PLOTS,
  facesLabel,
  loadValue,
  stripExt,
} from "./labels";
import { Head, NumberField, Row } from "./ui";
import type { Probe } from "./viewData";
import {
  MATERIALS,
  type Axis,
  type Filters,
  type Load,
  type Material,
  type Mesh,
  type Part,
  type Plot,
  type Result,
  type Study,
  type Support,
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
  kind: "support" | "load";
  list: (Support | Load)[];
  selectedCount: number;
  onAdd: () => void;
  onEdit: (c: Support | Load) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <>
      <Head
        small={kind === "support" ? "Supports" : "Loads"}
        title={list.length ? list.length + " defined" : "None"}
      />
      <div className="sec">
        {list.map((c) => (
          <div className="list-item" key={c.id}>
            <button onClick={() => onEdit(c)}>
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
              onClick={() => onRemove(c.id)}
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
          onClick={onAdd}
        >
          <Plus size={14} />
          {kind === "support" ? "Add support" : "Add load"}
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
  onChange: (changes: Record<string, unknown>) => void;
  onRemoveFace: (id: number) => void;
  onCancel: () => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const v = draft.value;
  const gravity = draft.kind === "load" && draft.value.kind === "gravity";
  const invalid =
    !v.name.trim() ||
    (!selected.length && !gravity) ||
    (draft.kind === "support" && !draft.value.axes.some(Boolean)) ||
    (draft.kind === "load" &&
      (draft.value.kind === "pressure"
        ? draft.value.magnitude === 0
        : draft.value.vector.every((x) => x === 0)));
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
        ) : (
          <LoadFields load={draft.value} onChange={onChange} />
        )}
      </div>
      {!gravity && (
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
                <b>{a}</b>
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

function LoadFields({
  load,
  onChange,
}: {
  load: Load;
  onChange: (changes: Record<string, unknown>) => void;
}) {
  return (
    <>
      <div className="field">
        <span>Type</span>
        <div className="seg">
          {(["force", "pressure", "gravity"] as const).map((k) => (
            <button
              key={k}
              className={load.kind === k ? "on" : ""}
              onClick={() =>
                load.kind !== k &&
                onChange({
                  kind: k,
                  name: ["Force", "Pressure", "Gravity"].includes(load.name)
                    ? k[0].toUpperCase() + k.slice(1)
                    : load.name,
                  vector: k === "gravity" ? [0, 0, -9.81] : [0, 0, -100],
                })
              }
            >
              {k[0].toUpperCase() + k.slice(1)}
            </button>
          ))}
        </div>
      </div>
      {load.kind === "pressure" ? (
        <>
          <NumberField
            label="Pressure"
            value={load.magnitude}
            unit="MPa"
            onChange={(v) => onChange({ magnitude: v })}
          />
          <p className="note">Positive pressure pushes into the surface.</p>
        </>
      ) : (
        <>
          <div className="field">
            <span>
              {load.kind === "gravity"
                ? "Acceleration, m/s²"
                : "Total force, N"}
            </span>
            <div className="vec">
              {["X", "Y", "Z"].map((a, i) => (
                <label key={a}>
                  <span>{a}</span>
                  <input
                    aria-label={
                      a + (load.kind === "gravity" ? " acceleration" : " force")
                    }
                    type="number"
                    value={load.vector[i]}
                    onChange={(e) =>
                      onChange({
                        vector: load.vector.map((x, j) =>
                          j === i ? Number(e.target.value) : x,
                        ),
                      })
                    }
                  />
                </label>
              ))}
            </div>
          </div>
          <Row label="Magnitude">
            {fmt(Math.hypot(...load.vector))}
            <em>{load.kind === "gravity" ? "m/s²" : "N"}</em>
          </Row>
          <p className="note">
            {load.kind === "force"
              ? "Split across the selected faces by area."
              : "Acts on the whole part using the material density."}
          </p>
        </>
      )}
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
  onChange,
  onPreview,
  onSolve,
}: {
  part: Part;
  study: Study;
  mesh: Mesh | null;
  missing: string[];
  canSolve: boolean;
  busy: boolean;
  onChange: (study: Study) => void;
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

export type ProbeValues = {
  stress: number;
  movement: number;
  margin: number | null;
};
export type Comparison = { before: Result; after: Result };

export function ResultsPanel({
  result,
  mesh,
  study,
  plot,
  extremes,
  deform,
  autoScale,
  wire,
  probe,
  probeValues,
  filters,
  bounds,
  scaleMax,
  sectionArea,
  onFilters,
  comparison,
  fromProject,
  busy,
  onDeform,
  onWire,
  onProbe,
  onRefine,
  onCsv,
  onImage,
  onSolverFile,
}: {
  result: Result;
  mesh: Mesh | null;
  study: Study;
  plot: Plot;
  extremes: { minStress: number; minMovement: number };
  deform: "off" | "true" | "auto";
  autoScale: number;
  wire: boolean;
  probe: Probe | null;
  probeValues: ProbeValues | null;
  filters: Filters;
  bounds: number[];
  scaleMax: number;
  sectionArea: number | null;
  onFilters: (f: Filters) => void;
  comparison: Comparison | null;
  fromProject: boolean;
  busy: boolean;
  onDeform: (d: "off" | "true" | "auto") => void;
  onWire: (on: boolean) => void;
  onProbe: (node: number | null) => void;
  onRefine: () => void;
  onCsv: () => void;
  onImage: () => void;
  onSolverFile: (kind: "deck" | "log" | "frd") => void;
}) {
  const s = result.summary;
  const yieldStrength = study.material?.yield || null;
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
  const solverNote = fromProject
    ? "Loaded from the project. Solve again to regenerate solver files."
    : undefined;
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
          <button className="link" onClick={() => onProbe(peak.node)}>
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
          {probeValues ? (
            <button className="link" onClick={() => onProbe(null)}>
              Clear
            </button>
          ) : (
            <span className="mono">click model</span>
          )}
        </h4>
        {probeValues && probe ? (
          <>
            <Row label="At">
              {probe.node === null ? "Interpolated" : "Node " + probe.node}
            </Row>
            <Row label="Position">
              {probe.point.map((n) => fmt(n, 2)).join(", ")}
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
            Click the model or a section to read interpolated values.
          </p>
        )}
      </div>
      <FilterControls
        filters={filters}
        plot={plot}
        bounds={bounds}
        scaleMax={scaleMax}
        sectionArea={sectionArea}
        onChange={onFilters}
      />
      <div className="sec">
        <h4>Mesh sensitivity</h4>
        {comparison && (
          <div className="comparison">
            <Row label="Elements">
              {fmt(comparison.before.elementCount)} → {fmt(result.elementCount)}
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
        <button className="btn full" onClick={onRefine} disabled={busy}>
          <Layers size={14} />
          Re-solve with {fmt((mesh?.size || study.meshSize) * 0.7, 2)} mm mesh
        </button>
      </div>
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
  scaleMax,
  sectionArea,
  onChange,
}: {
  filters: Filters;
  plot: Plot;
  bounds: number[];
  scaleMax: number;
  sectionArea: number | null;
  onChange: (f: Filters) => void;
}) {
  const { section, iso, threshold } = filters;
  const unit = PLOTS[plot].unit;
  const digits = plot === "movement" ? 4 : plot === "stress" ? 2 : 1;
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
          {fmt(filters[key].level * scaleMax, digits)} {unit}
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
                  {a}
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
