import { useState } from "react";
import {
  Check,
  ChevronRight,
  Grid3X3,
  Layers,
  Play,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { editMaterial, fmt, sig, type Draft } from "./logic";
import {
  DETAILS,
  DETAIL_NAMES,
  ANALYSES,
  CONDITIONS,
  CONTACT_KINDS,
  DEFAULT_FRICTION,
  contactOf,
  contactPairs,
  type BoltCandidate,
  DEFAULT_HARMONIC,
  DEFAULT_MODES,
  DEFAULT_TRANSIENT,
  LOAD_KINDS,
  THERMAL_KINDS,
  plotInfo,
  conditionValue,
  supportType,
  SUPPORT_TYPES,
  isBodyLoad,
  PLOTS,
  SOLVERS,
  facesLabel,
  loadValue,
  stripExt,
} from "./labels";
import {
  Head,
  More,
  NumberCell,
  NumberField,
  Qty,
  Row,
  VectorInput,
  useUnits,
} from "./ui";
import {
  atFrame,
  lowIsCritical,
  probeValue,
  sectionLoads,
  type Probe,
  type SectionCut,
} from "./viewData";
import { ConvergenceControls, ConvergenceReport } from "./Convergence";
import { LineChart } from "./Chart";
import {
  MATERIALS,
  type Analysis,
  type Axis,
  type Harmonic,
  type Filters,
  type Condition,
  type ConditionKind,
  type ConvergenceOptions,
  type Load,
  type LoadKind,
  type PointMass,
  type ThermalCondition,
  type Region,
  type RegionResult,
  type Material,
  type Bolt,
  type Contact,
  type Face,
  type TemperatureRow,
  type Mesh,
  type Part,
  type Plot,
  type Result,
  type Study,
  type Support,
  type Threads,
  type Cpus,
  type Transient,
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
  const u = useUnits();
  return (
    <>
      <Head small="Part" title={stripExt(part.name)} />
      <div className="sec">
        <Row label="Size">
          {part.geometry.dimensions.map((d) => u.show(d, "mm", 2)).join(" × ")}
          <em>{u.label("mm")}</em>
        </Row>
        <Row label="Volume">
          <Qty value={part.geometry.volume} unit="mm³" digits={1} />
        </Row>
        <Row label="Faces">{part.geometry.faces.length}</Row>
        {(part.geometry.bodies?.length ?? 1) > 1 && (
          <Row label="Bodies">
            {part.geometry.bodies!.length}
            <em>bonded where they touch</em>
          </Row>
        )}
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

/** Chooses the analysis type and its settings. */
export function AnalysisPanel({
  study,
  touching,
  onChange,
}: {
  study: Study;
  /** Whether the part has bodies that touch. */
  touching: boolean;
  onChange: (s: Study) => void;
}) {
  const current = ANALYSES[study.analysis];
  return (
    <>
      <Head small="Analysis" title={current.name} />
      <div className="sec">
        <div className="presets" role="group" aria-label="Analysis type">
          {(Object.keys(ANALYSES) as Analysis[]).map((id) => (
            <button
              key={id}
              aria-pressed={study.analysis === id}
              className={study.analysis === id ? "on" : ""}
              onClick={() =>
                study.analysis !== id &&
                onChange({
                  ...study,
                  analysis: id,
                  modes: DEFAULT_MODES[id] ?? study.modes,
                  harmonic:
                    id === "harmonic"
                      ? (study.harmonic ?? DEFAULT_HARMONIC)
                      : study.harmonic,
                })
              }
            >
              <span>
                {ANALYSES[id].name}
                <small>{ANALYSES[id].note}</small>
              </span>
              {study.analysis === id && <Check size={14} />}
            </button>
          ))}
        </div>
      </div>
      {study.analysis === "thermalStress" && (
        <div className="sec">
          <NumberField
            label="Stress-free temperature"
            value={study.referenceTemperature ?? 20}
            unit="°C"
            onChange={(v) => onChange({ ...study, referenceTemperature: v })}
          />
          <p className="note">
            The temperature at which the part, as modeled, has no thermal
            stress: usually the assembly or room temperature.
          </p>
        </div>
      )}
      {current.thermal && (
        <TimeSettings
          transient={study.transient}
          onChange={(transient) => onChange({ ...study, transient })}
        />
      )}
      {study.analysis === "harmonic" && (
        <HarmonicSettings
          settings={study.harmonic ?? DEFAULT_HARMONIC}
          modes={study.modes ?? 20}
          onChange={(harmonic, modes) =>
            onChange({ ...study, harmonic, modes })
          }
        />
      )}
      {study.analysis === "static" && (
        <div className="sec">
          <div className="switch-row">
            <span>Large deformation</span>
            <button
              className={"switch" + (study.largeDeformation ? " on" : "")}
              role="switch"
              aria-checked={!!study.largeDeformation}
              aria-label="Large deformation"
              onClick={() =>
                onChange({
                  ...study,
                  largeDeformation: !study.largeDeformation,
                })
              }
            />
          </div>
          <p className="note">
            For parts that bend or twist far enough to change how they carry
            load, such as thin strips, clips and springs. The load is applied in
            steps and the solve takes longer.
          </p>
          <div className="switch-row" style={{ marginTop: 10 }}>
            <span>Plasticity</span>
            <button
              className={"switch" + (study.plasticity ? " on" : "")}
              role="switch"
              aria-checked={!!study.plasticity}
              aria-label="Plasticity"
              onClick={() =>
                onChange({ ...study, plasticity: !study.plasticity })
              }
            />
          </div>
          <p className="note">
            Lets the material yield: beyond the yield strength it hardens in a
            straight line up to the ultimate strength at the elongation at
            break. Shows plastic strain, and how loads beyond yield spread.
          </p>
          {study.plasticity && (
            <div className="switch-row" style={{ marginTop: 10 }}>
              <span>Then remove the loads</span>
              <button
                className={"switch" + (study.unload ? " on" : "")}
                role="switch"
                aria-checked={!!study.unload}
                aria-label="Then remove the loads"
                onClick={() => onChange({ ...study, unload: !study.unload })}
              />
            </div>
          )}
          {study.plasticity && (
            <p className="note">
              Unloading shows the permanent bend left behind, and the residual
              stress locked in.
            </p>
          )}
          {touching && (
            <>
              <div className="switch-row" style={{ marginTop: 10 }}>
                <span>Contact and bolts</span>
                <button
                  className={"switch" + (study.contact ? " on" : "")}
                  role="switch"
                  aria-checked={!!study.contact}
                  aria-label="Contact and bolts"
                  onClick={() =>
                    onChange({ ...study, contact: !study.contact })
                  }
                />
              </div>
              <p className="note">
                Off, touching bodies are bonded. On, you choose under Contacts
                whether each touching pair can separate and slide, and you can
                add bolts to tighten. The load is then applied in steps, so the
                solve takes longer.
              </p>
            </>
          )}
        </div>
      )}
      {current.eigen && (
        <div className="sec">
          <NumberField
            label="Modes to find"
            value={study.modes ?? DEFAULT_MODES[study.analysis]!}
            step="1"
            onChange={(v) =>
              onChange({
                ...study,
                modes: Math.max(1, Math.min(50, Math.round(v) || 1)),
              })
            }
          />
          {study.analysis === "frequency" ? (
            <>
              <p className="note">
                Natural frequencies depend on stiffness, mass and supports.
                Supports are optional. Without any, the part vibrates freely, as
                if hung on soft springs. Point masses add their inertia.
              </p>
              <p className="note">
                Loads are optional. If there are any, Solve asks whether to
                include them: tension and spin stiffen a part and raise its
                frequencies, compression lowers them.
              </p>
            </>
          ) : (
            <p className="note">
              The loads are the reference: each buckling factor multiplies all
              of them together. Usually only the first mode matters.
            </p>
          )}
        </div>
      )}
    </>
  );
}

/**
 * Heat transfer and thermal stress: the settled state, or temperatures
 * followed over time from a uniform start.
 */
function TimeSettings({
  transient,
  onChange,
}: {
  transient: Transient | undefined;
  onChange: (t: Transient) => void;
}) {
  const t = transient ?? { ...DEFAULT_TRANSIENT, on: false };
  return (
    <div className="sec">
      <div className="field">
        <span>Temperatures</span>
        <div className="seg" role="group" aria-label="Temperatures">
          {(
            [
              [false, "Settled"],
              [true, "Over time"],
            ] as const
          ).map(([on, label]) => (
            <button
              key={label}
              className={t.on === on ? "on" : ""}
              aria-pressed={t.on === on}
              onClick={() => t.on !== on && onChange({ ...t, on })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {t.on && (
        <>
          <NumberField
            label="Duration"
            value={t.duration}
            unit="s"
            onChange={(duration) => onChange({ ...t, duration })}
          />
          <NumberField
            label="Starting temperature"
            value={t.start}
            unit="°C"
            onChange={(start) => onChange({ ...t, start })}
          />
        </>
      )}
      <p className="note">
        Settled: the temperatures the part reaches in the end; at least one
        fixed temperature, convection or radiation is needed, so heat can leave.
        Over time: the part starts at one temperature everywhere, every
        condition switches on at time zero, and the material needs its specific
        heat.
      </p>
    </div>
  );
}

const PRESET_NAMES = MATERIALS.map((m) => m.name);

export function MaterialPanel({
  study,
  bodies,
  onApply,
  onBodies,
}: {
  study: Study;
  /** Bodies of an assembly; empty for a single part. */
  bodies: { id: number; name: string; volume: number }[];
  onApply: (m: Material) => void;
  onBodies: (own: Record<string, Material> | undefined) => void;
}) {
  const u = useUnits();
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
      {bodies.length > 1 && (
        <div className="sec">
          <h4>Bodies</h4>
          {bodies.map((b) => {
            const own = study.bodyMaterials?.[String(b.id)];
            return (
              <label className="field" key={b.id}>
                <span>
                  {b.name}
                  <b className="mono">
                    {u.show(b.volume, "mm³", 0)} {u.label("mm³")}
                  </b>
                </span>
                <select
                  className="input"
                  aria-label={`${b.name} material`}
                  value={own?.name ?? ""}
                  onChange={(e) => {
                    const next = { ...(study.bodyMaterials || {}) };
                    const preset = MATERIALS.find(
                      (m) => m.name === e.target.value,
                    );
                    if (preset) next[String(b.id)] = structuredClone(preset);
                    else delete next[String(b.id)];
                    onBodies(Object.keys(next).length ? next : undefined);
                  }}
                >
                  <option value="">
                    Part material
                    {study.material ? ` (${study.material.name})` : ""}
                  </option>
                  {MATERIALS.map((m) => (
                    <option key={m.name} value={m.name}>
                      {m.name}
                    </option>
                  ))}
                  {own && !MATERIALS.some((m) => m.name === own.name) && (
                    <option value={own.name}>{own.name}</option>
                  )}
                </select>
              </label>
            );
          })}
          <p className="note">
            Bodies are bonded where their faces touch. The material below
            applies to every body not given its own.
          </p>
        </div>
      )}
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
                  {u.system === "si"
                    ? `${fmt(m.young / 1000, 1)} GPa`
                    : `${fmt(u.value(m.young, "MPa") / 1e6, 2)} Msi`}{" "}
                  · {u.show(m.density, "kg/m³", 0)} {u.label("kg/m³")}
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
          value={material.yield ?? NaN}
          unit="MPa"
          onChange={(v) => edit({ yield: v || null })}
        />
        <More
          title="Thermal properties"
          open={ANALYSES[study.analysis].thermal}
        >
          <NumberField
            label="Thermal conductivity"
            value={material.conductivity ?? NaN}
            unit="W/(m·K)"
            onChange={(v) => edit({ conductivity: v || null })}
          />
          <NumberField
            label="Thermal expansion"
            value={material.expansion ?? NaN}
            unit="µm/(m·°C)"
            onChange={(v) => edit({ expansion: v || null })}
          />
          <NumberField
            label="Specific heat"
            value={material.specificHeat ?? NaN}
            unit="J/(kg·K)"
            onChange={(v) => edit({ specificHeat: v || null })}
          />
          <p className="note">
            Specific heat sets how quickly temperatures change over time.
          </p>
        </More>
        <More
          title="Plasticity"
          open={study.analysis === "static" && !!study.plasticity}
        >
          <NumberField
            label="Ultimate strength"
            value={material.ultimate ?? NaN}
            unit="MPa"
            onChange={(v) => edit({ ultimate: v || null })}
          />
          <NumberField
            label="Elongation at break"
            value={material.elongation ?? NaN}
            unit="%"
            onChange={(v) => edit({ elongation: v || null })}
          />
          <HardeningPoints
            material={material}
            onChange={(hardening) => edit({ hardening })}
          />
        </More>
        <More
          title="Values at temperatures"
          open={!!material.byTemperature?.length}
        >
          <TemperatureTable
            material={material}
            onChange={(byTemperature) => edit({ byTemperature })}
          />
        </More>
        <p className="note">
          Preset values are typical. Use your material's specification.
        </p>
      </div>
      <div className="sec actions">
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

/**
 * Stress–strain points beyond yield from a tensile test. Without any,
 * hardening is a straight line from yield to the ultimate strength.
 */
function HardeningPoints({
  material,
  onChange,
}: {
  material: Material;
  onChange: (points: number[][] | null) => void;
}) {
  const u = useUnits();
  const points = material.hardening ?? [];
  const set = (k: number, i: number, v: number) =>
    onChange(
      points.map((p, j) => (j === k ? p.map((x, m) => (m === i ? v : x)) : p)),
    );
  const last = points.at(-1);
  return (
    <div className="field">
      <span>Stress–strain points</span>
      {points.length > 0 && (
        <table className="point-table" aria-label="Stress–strain points">
          <thead>
            <tr>
              <th>Strain, %</th>
              <th>Stress, {u.label("MPa")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {points.map((p, k) => (
              <tr key={k}>
                <td>
                  <NumberCell
                    label={`Strain ${k + 1}`}
                    value={p[0]}
                    onChange={(v) => set(k, 0, v)}
                  />
                </td>
                <td>
                  <NumberCell
                    label={`Stress ${k + 1}`}
                    value={p[1]}
                    unit="MPa"
                    onChange={(v) => set(k, 1, v)}
                  />
                </td>
                <td>
                  <button
                    className="icon-button delete"
                    aria-label={`Remove point ${k + 1}`}
                    onClick={() => {
                      const next = points.filter((_, j) => j !== k);
                      onChange(next.length ? next : null);
                    }}
                  >
                    <X size={12} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button
        className="btn full"
        onClick={() =>
          onChange([
            ...points,
            last
              ? [last[0] * 2, last[1]]
              : [
                  material.elongation ?? 10,
                  material.ultimate ?? material.yield ?? 0,
                ],
          ])
        }
      >
        <Plus size={13} />
        Add point
      </button>
      <p className="note">
        Optional: total strain and stress beyond yield from a tensile test, as
        true values (below about 5% strain, engineering values are close). They
        replace the straight line to the ultimate strength; stress stays flat
        beyond the last point.
      </p>
    </div>
  );
}

/** Columns of the temperature table: property, label and SI unit. */
const TABLE_COLUMNS = [
  ["young", "E", "Elastic modulus", "MPa"],
  ["conductivity", "k", "Conductivity", "W/(m·K)"],
  ["expansion", "α", "Expansion", "µm/(m·°C)"],
] as const;

/**
 * Properties at temperatures, for heat transfer and thermal stress. A
 * property with values at two or more temperatures follows them.
 */
function TemperatureTable({
  material,
  onChange,
}: {
  material: Material;
  onChange: (rows: TemperatureRow[] | null) => void;
}) {
  const u = useUnits();
  const rows = material.byTemperature ?? [];
  const set = (k: number, changes: Partial<TemperatureRow>) =>
    onChange(rows.map((r, j) => (j === k ? { ...r, ...changes } : r)));
  return (
    <div className="field">
      {rows.length > 0 && (
        <table className="point-table" aria-label="Values at temperatures">
          <thead>
            <tr>
              <th>{u.label("°C")}</th>
              {TABLE_COLUMNS.map(([key, symbol, name, unit]) => (
                <th key={key} title={`${name}, ${u.label(unit)}`}>
                  {symbol}
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, k) => (
              <tr key={k}>
                <td>
                  <NumberCell
                    label={`Temperature ${k + 1}`}
                    value={r.temperature}
                    unit="°C"
                    onChange={(temperature) => set(k, { temperature })}
                  />
                </td>
                {TABLE_COLUMNS.map(([key, , name, unit]) => (
                  <td key={key}>
                    <NumberCell
                      label={`${name} ${k + 1}`}
                      value={r[key] ?? NaN}
                      unit={unit}
                      onChange={(v) =>
                        set(k, { [key]: Number.isFinite(v) ? v : null })
                      }
                    />
                  </td>
                ))}
                <td>
                  <button
                    className="icon-button delete"
                    aria-label={`Remove row ${k + 1}`}
                    onClick={() => {
                      const next = rows.filter((_, j) => j !== k);
                      onChange(next.length ? next : null);
                    }}
                  >
                    <X size={12} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button
        className="btn full"
        onClick={() => {
          const last = rows.at(-1);
          onChange([
            ...rows,
            {
              temperature: last ? last.temperature + 100 : 20,
              young: last?.young ?? material.young,
              conductivity: last?.conductivity ?? material.conductivity ?? null,
              expansion: last?.expansion ?? material.expansion ?? null,
            },
          ]);
        }}
      >
        <Plus size={13} />
        Add temperature
      </button>
      <p className="note">
        For heat transfer and thermal stress: a property with values at two or
        more temperatures follows them. Blank cells, and other analyses, use the
        constant values above. E: elastic modulus, {u.label("MPa")}; k:
        conductivity, {u.label("W/(m·K)")}; α: expansion, {u.label("µm/(m·°C)")}
        .
      </p>
    </div>
  );
}

/**
 * How each pair of touching bodies interacts. Pairs not set stay bonded.
 */
export function ContactsPanel({
  part,
  study,
  onChange,
  onShow,
}: {
  part: Part;
  study: Study;
  onChange: (s: Study) => void;
  /** Highlights the bodies of a pair. */
  onShow: (bodies: number[]) => void;
}) {
  const u = useUnits();
  const pairs = contactPairs(part.geometry);
  const name = (id: number) =>
    part.geometry.bodies?.find((b) => b.id === id)?.name ?? `Body ${id}`;
  const set = (id: string, changes: Partial<Contact>) => {
    const next = { ...contactOf(study, id), ...changes };
    const others = (study.contacts ?? []).filter((c) => c.id !== id);
    onChange({
      ...study,
      contacts: next.kind === "bonded" ? others : [...others, next],
    });
  };
  const frictional = pairs.some(
    (p) => contactOf(study, p.id).kind === "frictional",
  );
  return (
    <>
      <Head
        small="Contacts"
        title={`${pairs.length} touching pair${pairs.length === 1 ? "" : "s"}`}
      />
      <div className="sec">
        {pairs.map((p) => {
          const c = contactOf(study, p.id);
          const label = `${name(p.bodies[0])} · ${name(p.bodies[1])}`;
          return (
            <div className="contact-pair" key={p.id}>
              <h4>
                <button className="link" onClick={() => onShow(p.bodies)}>
                  {label}
                </button>
                <span className="mono">
                  {u.show(p.area, "mm²", 0)} {u.label("mm²")}
                </span>
              </h4>
              <div className="seg" role="group" aria-label={`${label} contact`}>
                {CONTACT_KINDS.map((k) => (
                  <button
                    key={k.id}
                    className={c.kind === k.id ? "on" : ""}
                    aria-pressed={c.kind === k.id}
                    onClick={() =>
                      set(p.id, {
                        kind: k.id,
                        friction:
                          k.id === "frictional"
                            ? (c.friction ?? DEFAULT_FRICTION)
                            : undefined,
                      })
                    }
                  >
                    {k.name}
                  </button>
                ))}
              </div>
              {c.kind === "frictional" && (
                <NumberField
                  label="Friction coefficient"
                  value={c.friction ?? DEFAULT_FRICTION}
                  step="0.05"
                  onChange={(friction) => set(p.id, { friction })}
                />
              )}
            </div>
          );
        })}
      </div>
      <div className="sec">
        {CONTACT_KINDS.map((k) => (
          <p className="note" key={k.id} style={{ marginTop: 0 }}>
            <b>{k.name}.</b> {k.note}
          </p>
        ))}
        {frictional && (
          <p className="note">
            Typical friction coefficients: dry machined steel on steel 0.15–0.2,
            aluminum on steel about 0.3, lubricated 0.05–0.1. Bolted joints are
            usually checked for slip with 0.1–0.15, to be safe.
          </p>
        )}
        <More title="Contact stiffness">
          <NumberField
            label="Stiffness factor"
            value={study.contactStiffness ?? 1}
            step="0.5"
            onChange={(v) =>
              onChange({
                ...study,
                contactStiffness: v > 0 && v !== 1 ? v : undefined,
              })
            }
          />
          <p className="note">
            Contact is enforced by stiff springs between the surfaces, so they
            overlap slightly where pressed: by about the pressure ÷ (20 ×
            elastic modulus) of an element. A higher factor overlaps less but
            converges more slowly; lower it if a solve with contact fails.
          </p>
        </More>
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
  const u = useUnits();
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
                {kind !== "support"
                  ? conditionValue(kind, c, u.system) + " · "
                  : ""}
                {(kind === "load" && isBodyLoad(c as Load)) ||
                (kind === "thermal" &&
                  (c as ThermalCondition).kind === "generation")
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

const DRAFT_NAMES = {
  support: "support",
  load: "load",
  mass: "mass",
  thermal: "condition",
  bolt: "bolt",
} as const;

export function ConditionEditor({
  draft,
  exists,
  selected,
  selectedFaces,
  selectedArea,
  center,
  boltCandidates,
  onPick,
  onChange,
  onRemoveFace,
  onCancel,
  onSave,
  onDelete,
}: {
  draft: Draft;
  exists: boolean;
  selected: number[];
  selectedFaces: Face[];
  selectedArea: number;
  /** Likely bolts, offered when editing a bolt. */
  boltCandidates: (BoltCandidate & { name: string })[];
  /** Replaces the selected faces. */
  onPick: (faces: number[]) => void;
  /** Area-weighted center of the selected faces, and of the part. */
  center: { selection: number[] | null; part: number[] };
  onChange: (changes: Record<string, unknown>) => void;
  onRemoveFace: (id: number) => void;
  onCancel: () => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const u = useUnits();
  const v = draft.value;
  const body =
    (draft.kind === "load" && isBodyLoad(draft.value)) ||
    (draft.kind === "thermal" && draft.value.kind === "generation");
  const zero = (v?: number[]) => !v || v.every((x) => x === 0);
  const invalid =
    !v.name.trim() ||
    (!selected.length && !body) ||
    (draft.kind === "mass" &&
      (!(draft.value.mass > 0) ||
        draft.value.point.some((x) => !isFinite(x)))) ||
    (draft.kind === "support" && !draft.value.axes.some(Boolean)) ||
    (draft.kind === "thermal" &&
      draft.value.kind === "radiation" &&
      !(draft.value.value > 0 && draft.value.value <= 1)) ||
    (draft.kind === "load" &&
      (draft.value.kind === "pressure"
        ? draft.value.magnitude === 0
        : draft.value.kind === "rotation"
          ? draft.value.magnitude === 0 || zero(draft.value.axis)
          : zero(draft.value.vector)));
  return (
    <>
      <Head
        small={(exists ? "Edit " : "New ") + DRAFT_NAMES[draft.kind]}
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
        ) : draft.kind === "thermal" ? (
          <ThermalFields condition={draft.value} onChange={onChange} />
        ) : draft.kind === "bolt" ? (
          <BoltFields
            bolt={draft.value}
            faces={selectedFaces}
            candidates={boltCandidates}
            selected={selected}
            onPick={onPick}
            onChange={onChange}
          />
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
                ? `${selected.length} · ${u.show(selectedArea, "mm²", 1)} ${u.label("mm²")}`
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
      <div className="sec actions">
        <div className="row2">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" disabled={invalid} onClick={onSave}>
            Save {DRAFT_NAMES[draft.kind]}
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

function ThermalFields({
  condition,
  onChange,
}: {
  condition: ThermalCondition;
  onChange: (changes: Record<string, unknown>) => void;
}) {
  const kind = THERMAL_KINDS.find((k) => k.id === condition.kind)!;
  return (
    <>
      <div className="field">
        <span>Type</span>
        <div className="seg wrap" role="group" aria-label="Thermal type">
          {THERMAL_KINDS.map((k) => (
            <button
              key={k.id}
              className={condition.kind === k.id ? "on" : ""}
              aria-pressed={condition.kind === k.id}
              onClick={() =>
                condition.kind !== k.id &&
                onChange({
                  kind: k.id,
                  name: THERMAL_KINDS.some((t) => t.name === condition.name)
                    ? k.name
                    : condition.name,
                  value:
                    k.id === "temperature"
                      ? 100
                      : k.id === "radiation"
                        ? 0.9
                        : 10,
                  ambient: condition.ambient ?? 20,
                })
              }
            >
              {k.name}
            </button>
          ))}
        </div>
      </div>
      <NumberField
        label={kind.label}
        value={condition.value}
        unit={kind.unit || undefined}
        step={condition.kind === "radiation" ? "0.05" : undefined}
        onChange={(value) => onChange({ value })}
      />
      {(condition.kind === "convection" || condition.kind === "radiation") && (
        <NumberField
          label={
            condition.kind === "convection"
              ? "Air or fluid temperature"
              : "Surroundings temperature"
          }
          value={condition.ambient ?? 20}
          unit="°C"
          onChange={(ambient) => onChange({ ambient })}
        />
      )}
      <p className="note">{kind.note}</p>
    </>
  );
}

/**
 * A bolt: its preload, the stress that puts in the shank, and the preload
 * a tightening torque gives.
 */
function BoltFields({
  bolt,
  faces,
  candidates,
  selected,
  onPick,
  onChange,
}: {
  bolt: Bolt;
  faces: Face[];
  /** Likely bolts in the part, with their body's name. */
  candidates: (BoltCandidate & { name: string })[];
  selected: number[];
  onPick: (faces: number[]) => void;
  onChange: (changes: Record<string, unknown>) => void;
}) {
  const u = useUnits();
  const picked = (c: BoltCandidate) =>
    c.faces.length === selected.length &&
    c.faces.every((f) => selected.includes(f));
  const radius = faces.find((f) => f.radius)?.radius;
  const [torque, setTorque] = useState(50);
  const [factor, setFactor] = useState(0.2);
  const diameter = radius ? 2 * radius : NaN;
  // T = K F d, with T in N·m and d in mm.
  const fromTorque = (torque * 1000) / (factor * diameter);
  return (
    <>
      {candidates.length > 0 && (
        <div className="field">
          <span>Bolts found</span>
          <div className="presets" role="group" aria-label="Bolts found">
            {candidates.map((c) => (
              <button
                key={c.faces.join("-")}
                className={picked(c) ? "on" : ""}
                aria-pressed={picked(c)}
                onClick={() => onPick(c.faces)}
              >
                <span>
                  {c.name}
                  <small>
                    {u.show(c.diameter, "mm", 2)} {u.label("mm")} shank through
                    a hole · face{c.faces.length > 1 ? "s" : ""}{" "}
                    {c.faces.join(", ")}
                  </small>
                </span>
                {picked(c) && <Check size={14} />}
              </button>
            ))}
          </div>
        </div>
      )}
      <NumberField
        label="Preload"
        value={bolt.preload}
        unit="N"
        onChange={(preload) => onChange({ preload })}
      />
      {radius && (
        <Row label="Shank stress">
          <Qty value={bolt.preload / (Math.PI * radius ** 2)} unit="MPa" />
        </Row>
      )}
      {faces.some((f) => f.type !== "Cylinder") && (
        <p className="note warn">
          Select only the bolt’s shank: cylindrical faces of the bolt.
        </p>
      )}
      <p className="note">
        Select the plain shank between the head and the nut, where it does not
        touch the clamped parts. The bolt is cut there, pulled to the preload,
        then held at that length while the loads act. A typical preload is
        70–75% of the bolt’s proof load: about 25 kN for an M10 class 8.8 bolt.
      </p>
      <More title="Preload from tightening torque">
        <NumberField
          label="Tightening torque"
          value={torque}
          unit="N·m"
          onChange={setTorque}
        />
        <NumberField
          label="Nut factor"
          value={factor}
          step="0.01"
          onChange={setFactor}
        />
        <button
          className="btn full"
          disabled={!(fromTorque > 0 && Number.isFinite(fromTorque))}
          onClick={() =>
            onChange({ preload: Number(fromTorque.toPrecision(3)) })
          }
        >
          {fromTorque > 0 && Number.isFinite(fromTorque)
            ? `Use ${u.show(fromTorque, "N", 0)} ${u.label("N")}`
            : "Select the shank first"}
        </button>
        <p className="note">
          Preload = torque ÷ (nut factor × shank diameter
          {radius ? `, ${u.show(diameter, "mm", 2)} ${u.label("mm")}` : ""}).
          Nut factor: about 0.2 for plain or black-oxide steel, 0.15 zinc plated
          or lightly oiled, 0.1–0.12 with anti-seize. Torque tightening scatters
          the preload by ±25% or more.
        </p>
      </More>
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
        label="Center of mass"
        unit="mm"
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
  const type = supportType(support);
  const info = SUPPORT_TYPES.find((t) => t.id === type)!;
  const names = SUPPORT_TYPES.map((t) => t.name);
  const directions =
    type === "directional"
      ? [
          ["X", "axis-x"],
          ["Y", "axis-y"],
          ["Z", "axis-z"],
        ]
      : type === "cylindrical"
        ? [
            ["Radial", ""],
            ["Around", ""],
            ["Along", ""],
          ]
        : null;
  return (
    <>
      <div className="field">
        <span>Type</span>
        <div className="seg wrap" role="group" aria-label="Support type">
          {SUPPORT_TYPES.map((t) => (
            <button
              key={t.id}
              className={type === t.id ? "on" : ""}
              aria-pressed={type === t.id}
              onClick={() =>
                type !== t.id &&
                onChange({
                  frame: t.frame,
                  axes: t.axes,
                  name: names.includes(support.name) ? t.name : support.name,
                })
              }
            >
              {t.name}
            </button>
          ))}
        </div>
      </div>
      {directions && (
        <div className="field">
          <span>Blocked directions</span>
          <div className="axes">
            {directions.map(([a, cls], i) => (
              <button
                key={a}
                aria-pressed={support.axes[i]}
                aria-label={`${a}: ${support.axes[i] ? "blocked" : "free"}`}
                className={support.axes[i] ? "on" : ""}
                onClick={() =>
                  onChange({
                    axes: support.axes.map((x, j) => (j === i ? !x : x)),
                  })
                }
              >
                <b className={cls}>{a}</b>
                {support.axes[i] ? "Blocked" : "Free"}
              </button>
            ))}
          </div>
        </div>
      )}
      <p className="note">{info.note}</p>
    </>
  );
}

/** Editing positions and directions: three inputs labelled "<axis> <name>". */
function VectorField({
  label,
  name,
  value,
  unit,
  onChange,
  action,
}: {
  label: string;
  name: string;
  /** In SI working units, converted for display when `unit` is given. */
  value: number[];
  unit?: string;
  onChange: (v: number[]) => void;
  action?: { label: string; onClick: () => void };
}) {
  const u = useUnits();
  return (
    <div className="field">
      <span>
        {label}
        {unit ? `, ${u.label(unit)}` : ""}
        {action && (
          <button className="link field-action" onClick={action.onClick}>
            {action.label}
          </button>
        )}
      </span>
      <div className="vec">
        {["X", "Y", "Z"].map((a, i) => (
          <VectorInput
            key={a}
            axis={a}
            name={name}
            unit={unit}
            value={value[i]}
            onChange={(n) =>
              // An emptied component counts as zero.
              onChange(value.map((x, j) => (j === i ? (isNaN(n) ? 0 : n) : x)))
            }
          />
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
  const u = useUnits();
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
            label="Axis passes through"
            unit="mm"
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
                ? "Acceleration"
                : load.kind === "moment"
                  ? "Moment"
                  : "Total force"
            }
            unit={
              load.kind === "gravity"
                ? "m/s²"
                : load.kind === "moment"
                  ? "N·mm"
                  : "N"
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
            <Qty
              value={Math.hypot(...load.vector)}
              unit={
                load.kind === "gravity"
                  ? "m/s²"
                  : load.kind === "moment"
                    ? "N·mm"
                    : "N"
              }
            />
          </Row>
        </>
      )}
      {load.kind === "remote" && (
        <VectorField
          label="Acts at"
          unit="mm"
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
      <Head small="Mesh + Solver" title={DETAIL_NAMES[study.detail]} />
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
        {ANALYSES[study.analysis].eigen && (
          <p className="note" style={{ marginTop: 0, marginBottom: 8 }}>
            {ANALYSES[study.analysis].name} always use the direct solver; this
            choice applies to static studies.
          </p>
        )}
        <div className="presets" role="group" aria-label="Solver">
          {SOLVERS.map((s) => (
            <button
              key={s.id}
              disabled={ANALYSES[study.analysis].eigen}
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
  /** Why refinement is unavailable, shown when it is. */
  unavailable: string;
  onStart: () => void;
  onDraft: (r: Region | null) => void;
  onSolve: () => void;
  onShow: (on: boolean) => void;
};

export function ResultsPanel({
  result,
  study,
  plot,
  stats,
  frame,
  onFrame,
  deform,
  autoScale,
  wire,
  animate,
  onAnimate,
  filters,
  bounds,
  scale,
  section,
  onFilters,
  onDeform,
  onWire,
  onProbe,
}: {
  result: Result;
  study: Study;
  plot: Plot;
  stats: PlotStats;
  frame: number;
  onFrame: (k: number) => void;
  deform: "off" | "true" | "auto";
  autoScale: number;
  wire: boolean;
  animate: boolean;
  onAnimate: (on: boolean) => void;
  filters: Filters;
  bounds: number[];
  scale: { min: number; max: number };
  section: SectionCut | null;
  onFilters: (f: Filters) => void;
  onDeform: (d: "off" | "true" | "auto") => void;
  onWire: (on: boolean) => void;
  onProbe: (node: number | null) => void;
}) {
  const u = useUnits();
  const s = result.summary;
  const yieldStrength = study.material?.yield || null;
  const low = lowIsCritical(plot);
  const info = plotInfo(plot, result.analysis);
  const digits =
    plot === "stress" && !ANALYSES[result.analysis].eigen ? 2 : info.digits;
  const peak = {
    value: u.show(stats.peak.value, info.unit, digits),
    node: stats.peak.node,
    label: low ? "Minimum" : "Maximum",
  };
  return (
    <>
      <Head small="Result" title={info.name} />
      {ANALYSES[result.analysis].eigen ? (
        <ModeTable result={result} frame={frame} onFrame={onFrame} />
      ) : (
        result.frames.length > 1 && (
          <FramePicker result={result} frame={frame} onFrame={onFrame} />
        )
      )}
      <div className="sec">
        {ANALYSES[result.analysis].eigen ? (
          <>
            <div className="big">
              <strong>{sig(result.frames[frame]?.value ?? 0, 5)}</strong>
              <span>{result.frames[frame]?.unit}</span>
            </div>
            <Row label={result.frames[frame]?.label || ""}>
              peak at node {peak.node}
            </Row>
          </>
        ) : (
          <>
            <div className="big">
              <strong>{peak.value}</strong>
              <span>{u.label(info.unit)}</span>
            </div>
            <Row label={peak.label}>node {peak.node}</Row>
          </>
        )}
        {plot === "safety" ? (
          <Row label="Yield strength">
            <Qty value={yieldStrength || 0} unit="MPa" />
          </Row>
        ) : (
          <Row label="Minimum">
            <Qty value={stats.min} unit={info.unit} digits={info.digits} />
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
              {!ANALYSES[result.analysis].eigen && (
                <button
                  className={deform === "true" ? "on" : ""}
                  onClick={() => onDeform("true")}
                >
                  1×
                </button>
              )}
              {(autoScale > 1 || ANALYSES[result.analysis].eigen) && (
                <button
                  className={deform === "auto" ? "on" : ""}
                  onClick={() => onDeform("auto")}
                  aria-label="Magnified"
                >
                  {fmt(autoScale, autoScale >= 100 ? 0 : 1)}×
                </button>
              )}
            </div>
          </div>
        )}
        {(ANALYSES[result.analysis].eigen ||
          result.analysis === "harmonic") && (
          <div className="switch-row">
            <span>Animate</span>
            <button
              className={"switch" + (animate ? " on" : "")}
              role="switch"
              aria-checked={animate}
              aria-label="Animate"
              onClick={() => onAnimate(!animate)}
            />
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
        <p className="note">Click the model to read values at a point.</p>
      </div>
      {plot === "contact" && (
        <p className="foot note" style={{ marginTop: 0 }}>
          Contact faces lie inside the assembly, where the bodies meet. Cut a
          section through the joint under Filters to see the pressure across
          them.
        </p>
      )}
      <JointTables result={result} />
      {result.charts.map((c) => (
        <div className="sec" key={c.id}>
          <h4>{c.title}</h4>
          <LineChart
            label={c.title}
            x={c.x.values.map((v) => u.value(v, c.x.unit))}
            series={c.series.map((s) => ({
              label: s.label,
              values: s.values.map((v) => u.value(v, s.unit)),
            }))}
            xLabel={`${c.x.label}, ${u.label(c.x.unit)}`}
            yLabel={u.label(c.series[0].unit)}
            logY={RESPONSE.includes(c.id)}
            selected={
              c.frames
                ? c.frames.includes(frame)
                  ? c.frames.indexOf(frame)
                  : undefined
                : FRAME_CHARTS.includes(c.id)
                  ? frame
                  : RESPONSE.includes(c.id)
                    ? nearest(c.x.values, result.frames[frame]?.value ?? 0)
                    : undefined
            }
            onSelect={
              c.frames
                ? (i) => onFrame(c.frames![i])
                : FRAME_CHARTS.includes(c.id)
                  ? onFrame
                  : RESPONSE.includes(c.id)
                    ? (i) =>
                        onFrame(
                          nearest(
                            result.frames.map((f) => f.value ?? 0),
                            c.x.values[i],
                          ),
                        )
                    : undefined
            }
          />
          <p className="legend-note">
            {c.series.map((s, k) => (
              <span key={s.label} className={"key s" + k}>
                {s.label}
              </span>
            ))}
          </p>
        </div>
      ))}
      <FilterControls
        filters={filters}
        plot={plot}
        unitOf={info.unit}
        bounds={bounds}
        scale={scale}
        cut={section}
        loads={
          section?.center && filters.section.on
            ? sectionLoads(
                atFrame(result.view, frame),
                filters.section,
                section.center,
              )
            : null
        }
        onChange={onFilters}
      />
      {result.warnings
        .filter((w) => !w.startsWith("Peak stress"))
        .map((w) => (
          <p className="foot note warn" key={w}>
            {w}
          </p>
        ))}
      <p className="foot">{assumptions(study, result)}</p>
    </>
  );
}

/** Values at the probed point, shown over the view. */
export function ProbeReadout({
  probe,
  result,
  yieldStrength,
  onClear,
}: {
  probe: Probe;
  result: Result;
  yieldStrength: number | null;
  onClear: () => void;
}) {
  const u = useUnits();
  return (
    <div className="probe-card" role="group" aria-label="Probe">
      <h4>
        Probe
        <button className="link" onClick={onClear}>
          Clear
        </button>
      </h4>
      <Row label="At">
        {probe.node === null ? "Interpolated" : "Node " + probe.node}
      </Row>
      <Row label="Position">
        {probe.point.map((n) => u.show(n, "mm", 2)).join(", ")}
        <em>{u.label("mm")}</em>
      </Row>
      {PROBE_ROWS.map(({ plot: p, label: plain, digits }) => {
        const label = ANALYSES[result.analysis].eigen
          ? plotInfo(p, result.analysis).name
          : plain;
        const value = probeValue(probe, p, yieldStrength);
        return (
          value !== null && (
            <Row key={p} label={label}>
              {p === "safety" ? (
                <>
                  {value >= 1000 ? "> 1000" : fmt(value, digits)}
                  <em>×</em>
                </>
              ) : (
                <Qty
                  value={value}
                  unit={plotInfo(p, result.analysis).unit}
                  digits={digits}
                />
              )}
            </Row>
          )
        );
      })}
    </div>
  );
}

/**
 * Mesh convergence of the whole-part result: solve on finer meshes until
 * the numbers stop changing, or compare one finer re-solve.
 */
export function ConvergencePanel({
  result,
  comparison,
  mesh,
  study,
  busy,
  convergeOptions,
  onConvergeOptions,
  onConverge,
  onRefine,
}: {
  result: Result;
  comparison: Comparison | null;
  mesh: Mesh | null;
  study: Study;
  busy: boolean;
  convergeOptions: ConvergenceOptions;
  onConvergeOptions: (o: ConvergenceOptions) => void;
  onConverge: () => void;
  onRefine: () => void;
}) {
  const u = useUnits();
  return (
    <>
      <Head small="Result" title="Mesh convergence" />
      <div className="sec">
        {result.convergence && (
          <ConvergenceReport report={result.convergence} />
        )}
        {comparison && !result.convergence && (
          <div className="comparison">
            <Row label="Elements">
              {fmt(comparison.before.elementCount)} → {fmt(result.elementCount)}
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
            Results depend on the mesh. Solve on finer meshes until the numbers
            stop changing.
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
          Re-solve once with{" "}
          {u.show((mesh?.size || study.meshSize) * 0.7, "mm", 2)}{" "}
          {u.label("mm")} mesh
        </button>
      </div>
    </>
  );
}

/** Region refinement in its own card: the box, its solve and the result. */
export function RegionPanel({ region }: { region: RegionState }) {
  return (
    <>
      <Head small="Result" title="Refined region" />
      <RegionControls region={region} />
    </>
  );
}

function FilterControls({
  filters,
  plot,
  unitOf,
  bounds,
  scale,
  cut,
  loads,
  onChange,
}: {
  filters: Filters;
  plot: Plot;
  unitOf: string;
  bounds: number[];
  scale: { min: number; max: number };
  cut: SectionCut | null;
  loads: ReturnType<typeof sectionLoads>;
  onChange: (f: Filters) => void;
}) {
  const { section, iso, threshold } = filters;
  const u = useUnits();
  const unit = u.label(unitOf);
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
          {u.show(
            scale.min + filters[key].level * (scale.max - scale.min),
            unitOf,
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
              <b className="mono">
                {u.show(section.position, "mm", 2)} {u.label("mm")}
              </b>
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
          {cut && (
            <Row label="Section area">
              <Qty value={cut.area} unit="mm²" digits={1} />
            </Row>
          )}
          {loads && (
            <>
              {(
                [
                  ["Normal force", loads.normal, "N"],
                  ["Shear force", loads.shear, "N"],
                  ["Bending moment", loads.bending, "N·mm"],
                  ["Torque", loads.torque, "N·mm"],
                ] as const
              ).map(([label, value, unit]) => (
                <Row key={label} label={label}>
                  {sig(u.value(value, unit), 4)}
                  <em>{u.label(unit)}</em>
                </Row>
              ))}
              <p className="note">
                Carried through the section, about its center: the loads and
                reactions on the cut-away side. Tension is positive. Use them to
                size bolts, welds or a cross-section.
              </p>
            </>
          )}
        </>
      )}
      {toggle("iso", "Iso-surface")}
      {iso.on && level("iso", "Iso value")}
      {toggle("threshold", "Threshold")}
      {threshold.on &&
        level("threshold", lowIsCritical(plot) ? "Show below" : "Show above")}
      <p className="note">
        Filters use the plotted quantity. Click a section or surface to probe
        it.
      </p>
    </div>
  );
}

/** Probe card rows, shown when the probed frame has the quantity. */
const PROBE_ROWS: { plot: Plot; label: string; digits: number }[] = [
  { plot: "stress", label: "von Mises", digits: 3 },
  { plot: "principalMax", label: "Max principal", digits: 3 },
  { plot: "principalMin", label: "Min principal", digits: 3 },
  { plot: "shear", label: "Max shear", digits: 3 },
  { plot: "strain", label: "Equivalent strain", digits: 1 },
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
    return f.label;
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
  const u = useUnits();
  const { draft, result } = region;
  const s = result?.summary;
  return (
    <div className="sec region">
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
            <Qty value={s.globalPeak as number} unit="MPa" />
          </Row>
          <Row label="Peak stress, refined region">
            <Qty value={s.maxStress!} unit="MPa" />
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
          {region.unavailable}
        </p>
      ) : draft ? (
        <>
          <VectorField
            label="Center"
            unit="mm"
            name="region center"
            value={draft.center}
            onChange={(center) => region.onDraft({ ...draft, center })}
          />
          <VectorField
            label="Size"
            unit="mm"
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

/**
 * Modes of an eigenvalue study: frequency and effective mass per direction
 * for vibration, the load factor for buckling.
 */
function ModeTable({
  result,
  frame,
  onFrame,
}: {
  result: Result;
  frame: number;
  onFrame: (k: number) => void;
}) {
  const mass = (result.summary.effectiveMass as number[][] | undefined) || [];
  const vibration = result.analysis === "frequency";
  return (
    <div className="sec">
      <h4>
        Modes
        {vibration && <span className="mono">effective mass, %</span>}
      </h4>
      <table className="mesh-table modes" aria-label="Modes">
        <thead>
          <tr>
            <th>Mode</th>
            <th>{vibration ? "Hz" : "Load factor"}</th>
            {vibration && (
              <>
                <th className="axis-x">X</th>
                <th className="axis-y">Y</th>
                <th className="axis-z">Z</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {result.frames.map((f, k) => (
            <tr
              key={k}
              className={
                (k === frame ? "on " : "") +
                (f.label === "Rigid motion" ? "dim" : "")
              }
              onClick={() => onFrame(k)}
              aria-selected={k === frame}
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && onFrame(k)}
            >
              <td>{f.label.replace("Mode ", "")}</td>
              <td>{sig(f.value ?? 0, 5)}</td>
              {vibration &&
                (mass[k] || [0, 0, 0]).map((v, i) => (
                  <td key={i}>{v < 5e-4 ? "0" : fmt(v * 100, 1)}</td>
                ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="note">
        {vibration
          ? "A mode with a large effective mass in a direction responds strongly to shaking in that direction."
          : "The part buckles when all loads are multiplied by the first factor. A negative factor means buckling with the loads reversed."}
      </p>
    </div>
  );
}

type BoltResult = {
  name: string;
  preload: number;
  tightened: number;
  loaded: number;
};
type ContactResult = {
  id: string;
  label: string;
  bodies: number[];
  kind: string;
  normal: number;
  shear: number;
  peak: number;
  touching: number;
  state: keyof typeof STATES;
};
const STATES = {
  open: "Open",
  pressed: "Pressed",
  stuck: "Stuck",
  sliding: "Sliding",
};

/** Bolt forces and contact forces of a static study with contact. */
function JointTables({ result }: { result: Result }) {
  const u = useUnits();
  const bolts = result.summary.bolts as BoltResult[] | undefined;
  const contacts = result.summary.contacts as ContactResult[] | undefined;
  const force = (v: number) => u.show(v, "N", 0);
  return (
    <>
      {bolts && (
        <div className="sec">
          <h4>
            Bolts<span className="mono">force, {u.label("N")}</span>
          </h4>
          <table className="result-table" aria-label="Bolt forces">
            <thead>
              <tr>
                <th>Bolt</th>
                <th>Tightened</th>
                <th>Loaded</th>
              </tr>
            </thead>
            <tbody>
              {bolts.map((b) => (
                <tr key={b.name}>
                  <td>{b.name}</td>
                  <td>{force(b.tightened)}</td>
                  <td>{force(b.loaded)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="note">
            Loads that pull a joint apart raise the bolt force only a little:
            mostly they unload the clamped parts. The joint opens when the bolt
            force starts rising steeply.
          </p>
        </div>
      )}
      {contacts && (
        <div className="sec">
          <h4>
            Contacts<span className="mono">force, {u.label("N")}</span>
          </h4>
          <table className="result-table" aria-label="Contact forces">
            <thead>
              <tr>
                <th>Bodies</th>
                <th>Normal</th>
                <th>Shear</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id}>
                  <td>{c.label}</td>
                  <td>{force(c.normal)}</td>
                  <td>{force(c.shear)}</td>
                  <td>{STATES[c.state]}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="note">
            Normal force presses the bodies together. Frictional contact is
            stuck until its shear reaches the friction coefficient times the
            normal force, then slides; open contact has separated. Peak
            pressures and the area in contact are in the console’s Checks tab.
          </p>
        </div>
      )}
    </>
  );
}

/** Charts with one point per frame, whose points pick the frame shown. */
const FRAME_CHARTS = ["loadPath", "history", "stressHistory"];
/** Response charts, whose points pick the frequency shown. */
const RESPONSE = ["response", "stressResponse"];
const nearest = (values: number[], x: number) =>
  values.reduce(
    (best, v, i) => (Math.abs(v - x) < Math.abs(values[best] - x) ? i : best),
    0,
  );

/** Frequency range, damping and excitation of a harmonic response study. */
function HarmonicSettings({
  settings,
  modes,
  onChange,
}: {
  settings: Harmonic;
  modes: number;
  onChange: (h: Harmonic, modes: number) => void;
}) {
  const set = (changes: Partial<Harmonic>) =>
    onChange({ ...settings, ...changes }, modes);
  return (
    <div className="sec">
      <div className="row2">
        <NumberField
          label="From"
          value={settings.min}
          unit="Hz"
          onChange={(min) => set({ min })}
        />
        <NumberField
          label="To"
          value={settings.max}
          unit="Hz"
          onChange={(max) => set({ max })}
        />
      </div>
      <NumberField
        label="Damping"
        value={Number((settings.damping * 100).toPrecision(4))}
        unit="% of critical"
        onChange={(v) => set({ damping: v / 100 })}
      />
      <p className="note">
        Typical: 1–2% for a solid metal part, 3–5% for bolted assemblies.
      </p>
      <div className="field" style={{ marginTop: 10 }}>
        <span>Shaken by</span>
        <div className="seg" role="group" aria-label="Excitation">
          {(
            [
              ["loads", "Its loads"],
              ["base", "Base shaking"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              className={settings.excitation === id ? "on" : ""}
              aria-pressed={settings.excitation === id}
              onClick={() => set({ excitation: id })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {settings.excitation === "base" && (
        <VectorField
          label="Base acceleration, g"
          name="base acceleration"
          value={settings.base}
          onChange={(base) => set({ base })}
        />
      )}
      <p className="note">
        By its loads: each load is the amplitude of a sinusoidal load at every
        frequency. By base shaking: the supports shake with the acceleration
        given, and the loads play no part.
      </p>
      <NumberField
        label="Modes to use"
        value={modes}
        step="1"
        onChange={(v) =>
          onChange(settings, Math.max(1, Math.min(50, Math.round(v) || 1)))
        }
      />
      <p className="note">
        The response is built from the part’s natural modes. Use enough that the
        highest is well above the top of the range.
      </p>
    </div>
  );
}

/** The modeling assumptions behind a result, in one line. */
function assumptions(study: Study, result: Result) {
  const material = study.plasticity
    ? "Elastic–plastic, isotropic"
    : "Linear elastic, isotropic";
  const peak =
    " Peak stress at supports and sharp corners can keep rising with refinement.";
  switch (result.analysis) {
    case "static":
      return (
        `${material}, ${study.largeDeformation ? "large" : "small"} deformation, slowly applied loads.` +
        (study.contact
          ? " Contact through stiff springs between the surfaces; bolts are tightened before the loads act."
          : "") +
        peak
      );
    case "thermalStress":
      return (
        `Linear elastic, isotropic, small deformation, ${study.transient?.on ? "temperatures over time" : "steady temperatures"}.` +
        peak
      );
    case "thermal":
      return study.transient?.on
        ? "Heat conduction over time from a uniform start; conditions switch on at time zero."
        : "Steady heat conduction" +
            (study.thermal.some((c) => c.kind === "radiation")
              ? ", with radiation to the surroundings."
              : "; no radiation unless added to faces.");
    case "frequency":
      return result.summary.preloaded
        ? "Linear elastic, small vibrations about the loaded shape, with stress stiffening from the loads; no damping."
        : "Linear elastic, small vibrations about the unloaded shape; no damping.";
    case "buckling":
      return "Linear buckling of a perfect shape: real parts buckle at lower loads.";
    case "harmonic":
      return "Linear elastic, steady sinusoidal vibration, the same damping in every mode.";
  }
}
