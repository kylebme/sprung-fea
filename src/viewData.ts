// Arrays the viewer draws: the engine's binary view (mesh and nodal results)
// or the setup triangulation. Only type imports, so Node can test it directly.
import type { Interface, Surface } from "./types";
import { toShown, unitLabel, type UnitSystem } from "./units.ts";

/**
 * Nodal results of one frame (a load step, mode, increment or frequency):
 * vectors with three components per node (`displacement`, and `force`, the
 * nodal forces of static results) and scalar fields such as `vonMises` or
 * `temperature`, one value per node.
 */
export type Frame = Record<string, Float64Array>;

/**
 * Indices refer to `points`. Tetrahedra are ten-node quadratic cells in VTK
 * order. Boundary triangles carry the CAD face they belong to. Results are
 * present after a solve: `frames` holds every frame, and `displacement` and
 * `fields` the displayed one (see atFrame).
 */
export type ViewData = {
  /** The engine's bytes, kept so a project can embed them unchanged. */
  buffer: ArrayBuffer | null;
  nodeIds: Int32Array;
  points: Float64Array;
  triangles: Int32Array;
  triangleFaces: Int32Array;
  /**
   * Per triangle, its body and the body behind it (0 for the outside).
   * Faces two bodies share appear once per side, drawn only while the
   * other body is hidden. Absent in results saved before it.
   */
  triangleBodies: Int32Array | null;
  tets: Int32Array | null;
  /** Each tetrahedron's body; absent in results saved before it. */
  tetBodies: Int32Array | null;
  /**
   * Each node's yield strength (MPa), from its own body's material: the
   * lowest where bodies meet, NaN without one. Absent without stress
   * results and in results saved before it; the study material applies.
   */
  yieldStrength: Float64Array | null;
  frames: Frame[];
  frame: number;
  displacement: Float64Array | null;
  /** Scalar fields of the displayed frame, by engine name. */
  fields: Record<string, Float64Array>;
};

/** Values at a point of the part, in its undeformed position. */
export type Probe = {
  point: number[];
  /** Mesh node tag when the probe sits exactly on a node. */
  node: number | null;
  /** Scalar fields at the point, by engine name. */
  values: Record<string, number>;
  displacement: number[] | null;
};

export type Plot =
  | "stress"
  | "movement"
  | "safety"
  | "temperature"
  | "plastic"
  | "heatflux"
  | "principalMax"
  | "principalMin"
  | "shear"
  | "strain"
  | "strainMax"
  | "strainMin"
  | "amplitude"
  | "contact";
/**
 * A plot shows one scalar per node: an engine field, or a quantity derived
 * from them (displacement magnitude, yield margin). Ranges start at zero
 * except where `signed` is set.
 */
export const PLOT_SOURCES: Record<
  Plot,
  { field: string; derived?: boolean; signed?: boolean }
> = {
  stress: { field: "vonMises" },
  principalMax: { field: "principalMax", signed: true },
  principalMin: { field: "principalMin", signed: true },
  shear: { field: "shear" },
  strain: { field: "strain" },
  strainMax: { field: "strainMax", signed: true },
  strainMin: { field: "strainMin", signed: true },
  amplitude: { field: "amplitude" },
  movement: { field: "displacement", derived: true },
  safety: { field: "vonMises", derived: true },
  temperature: { field: "temperature", signed: true },
  plastic: { field: "peeq" },
  heatflux: { field: "heatFlux" },
  contact: { field: "contactPressure" },
};

const MAGIC = "SFEAVIEW";
const TYPES = { float64: Float64Array, int32: Int32Array } as const;
type Header = {
  version: number;
  arrays: { name: string; type: keyof typeof TYPES; shape: number[] }[];
};

/** Reads `view.bin`. Throws if the layout or array sizes are inconsistent. */
export function decodeView(buffer: ArrayBuffer): ViewData {
  const bytes = new Uint8Array(buffer);
  if (
    bytes.length < 12 ||
    new TextDecoder().decode(bytes.subarray(0, 8)) !== MAGIC
  )
    throw Error("Not a Sprung FEA view file.");
  const length = new DataView(buffer).getUint32(8, true);
  const header: Header = JSON.parse(
    new TextDecoder().decode(bytes.subarray(12, 12 + length)),
  );
  if (header.version !== 1) throw Error("Unsupported view file version.");
  const arrays: Record<string, Float64Array | Int32Array> = {};
  let offset = 12 + length;
  for (const { name, type, shape } of header.arrays) {
    const Type = TYPES[type];
    const count = shape.reduce((a, b) => a * b, 1);
    if (
      !Type ||
      offset % 8 ||
      offset + count * Type.BYTES_PER_ELEMENT > buffer.byteLength
    )
      throw Error("The view file is truncated or malformed.");
    arrays[name] = new Type(buffer, offset, count);
    offset += Math.ceil((count * Type.BYTES_PER_ELEMENT) / 8) * 8;
  }
  // Result arrays: frame 0 is unsuffixed, frame k stores `name@k`.
  const frames: Frame[] = [];
  for (const [name, data] of Object.entries(arrays)) {
    const [field, index] = name.split("@");
    if (MESH.includes(field)) continue;
    if (!(data instanceof Float64Array))
      throw Error("The view file is truncated or malformed.");
    const k = index === undefined ? 0 : Number(index);
    if (!Number.isInteger(k) || k < 0 || k > 100000)
      throw Error("The view file is truncated or malformed.");
    (frames[k] ??= {})[field] = data;
  }
  const view = atFrame(
    {
      buffer,
      nodeIds: arrays.nodeIds as Int32Array,
      points: arrays.points as Float64Array,
      triangles: arrays.triangles as Int32Array,
      triangleFaces: arrays.triangleFaces as Int32Array,
      triangleBodies: (arrays.triangleBodies as Int32Array) || null,
      tets: (arrays.tets as Int32Array) || null,
      tetBodies: (arrays.tetBodies as Int32Array) || null,
      yieldStrength: (arrays.yieldStrength as Float64Array) || null,
      frames: Array.from(frames, (f) => f || {}),
      frame: 0,
      displacement: null,
      fields: {},
    },
    0,
  );
  validate(view);
  return view;
}

const MESH = [
  "nodeIds",
  "points",
  "tets",
  "tetBodies",
  "triangles",
  "triangleFaces",
  "triangleBodies",
  "yieldStrength",
];
/** Frame arrays with three components per node; the rest are scalars. */
const VECTORS = ["displacement", "force"];

function validate(v: ViewData) {
  const n = v.nodeIds?.length;
  const inRange = (a: Int32Array) => a.every((i) => i >= 0 && i < n);
  if (
    !n ||
    v.points?.length !== n * 3 ||
    !v.triangles ||
    v.triangles.length % 3 ||
    v.triangleFaces?.length !== v.triangles.length / 3 ||
    (v.triangleBodies &&
      v.triangleBodies.length !== (v.triangles.length / 3) * 2) ||
    !inRange(v.triangles) ||
    (v.tets && (v.tets.length % 10 || !inRange(v.tets))) ||
    (v.tetBodies && v.tetBodies.length * 10 !== v.tets?.length) ||
    (v.yieldStrength && v.yieldStrength.length !== n) ||
    v.frames.some(
      (f) =>
        !Object.keys(f).length ||
        Object.entries(f).some(
          ([name, a]) => a.length !== (VECTORS.includes(name) ? n * 3 : n),
        ),
    )
  )
    throw Error("The view file has inconsistent array sizes.");
}

/** The view showing frame `k`; geometry arrays are shared, not copied. */
export function atFrame(view: ViewData, k: number): ViewData {
  const frame = view.frames[k];
  if (!frame) return { ...view, frame: 0, displacement: null, fields: {} };
  const { displacement, force: _force, ...fields } = frame;
  return { ...view, frame: k, displacement: displacement || null, fields };
}

export const hasResults = (view: ViewData | null) =>
  !!view && view.frames.length > 0;

/**
 * Each node's yield strength (MPa): the view's own, from each body's
 * material, else the study material's everywhere. Null without any.
 */
export function nodeYield(
  view: ViewData,
  yieldStrength: number | null,
): ArrayLike<number> | null {
  if (view.yieldStrength) return view.yieldStrength;
  return yieldStrength
    ? new Float64Array(view.nodeIds.length).fill(yieldStrength)
    : null;
}

/** Plots this frame can show. The yield margin needs a yield strength. */
export function availablePlots(view: ViewData, yieldStrength: number | null) {
  const rated = view.yieldStrength
    ? view.yieldStrength.some(Number.isFinite)
    : !!yieldStrength;
  return (Object.keys(PLOT_SOURCES) as Plot[]).filter((p) => {
    const source = PLOT_SOURCES[p].field;
    const present =
      source === "displacement" ? !!view.displacement : !!view.fields[source];
    return present && (p !== "safety" || rated);
  });
}

/** One value per node for a plot of the displayed frame. */
export function plotValues(
  view: ViewData,
  plot: Plot,
  yieldStrength: number | null = null,
  marginCap = Infinity,
): Float64Array {
  if (plot === "movement") return movement(view);
  if (plot === "safety") return margin(view, yieldStrength, marginCap);
  return view.fields[PLOT_SOURCES[plot].field];
}

/**
 * Automatic color-scale limits of the displayed frame: zero to the
 * maximum, or the true range for signed quantities such as temperature;
 * the yield margin uses its own cap.
 */
export function plotRange(
  view: ViewData,
  plot: Plot,
  yieldStrength: number | null,
  marginCap: number,
) {
  if (plot === "safety") return { min: 0, max: marginCap };
  const r = range(plotValues(view, plot, yieldStrength, marginCap));
  if (PLOT_SOURCES[plot].signed)
    return r.max > r.min ? r : { min: r.min - 1, max: r.max + 1 };
  return { min: 0, max: r.max || 1 };
}

/**
 * How the viewer colors a plot. `limits` are user ends by plot (SI working
 * units; null follows the result). With `allFrames`, automatic ends span
 * every frame, so frames share one scale. `bands` above 0 makes the scale
 * that many flat steps.
 */
export type ColorScale = {
  limits: Partial<Record<Plot, { min: number | null; max: number | null }>>;
  allFrames: boolean;
  bands: number;
  palette: "standard" | "viridis";
};
export const defaultColorScale = (): ColorScale => ({
  limits: {},
  allFrames: false,
  bands: 0,
  palette: "standard",
});

/**
 * The plotted range: automatic ends (of the displayed frame, or of every
 * frame), replaced by the user's where set. `fixed` says which ends the
 * user set; an inverted pair keeps the automatic ends.
 */
export function colorRange(
  view: ViewData,
  plot: Plot,
  yieldStrength: number | null,
  marginCap: number,
  scale: ColorScale,
) {
  let auto = plotRange(view, plot, yieldStrength, marginCap);
  if (scale.allFrames && view.frames.length > 1 && plot !== "safety")
    auto = view.frames
      .map((_, k) => atFrame(view, k))
      .filter((v) => availablePlots(v, yieldStrength).includes(plot))
      .map((v) => plotRange(v, plot, yieldStrength, marginCap))
      .reduce(
        (a, r) => ({ min: Math.min(a.min, r.min), max: Math.max(a.max, r.max) }),
        auto,
      );
  const user = scale.limits[plot];
  const min = Number.isFinite(user?.min) ? user!.min! : auto.min;
  const max = Number.isFinite(user?.max) ? user!.max! : auto.max;
  if (!(max > min)) return { ...auto, auto, fixed: { min: false, max: false } };
  return {
    min,
    max,
    auto,
    fixed: {
      min: Number.isFinite(user?.min),
      max: Number.isFinite(user?.max),
    },
  };
}

/** Plots whose critical value is the lowest: margin, compression. */
export const lowIsCritical = (plot: Plot) =>
  plot === "safety" || plot === "principalMin" || plot === "strainMin";

/** The node with the extreme value: lowest margin, highest otherwise. */
export function peak(view: ViewData, plot: Plot, yieldStrength: number | null) {
  const values = plotValues(view, plot, yieldStrength);
  let best = 0;
  const low = lowIsCritical(plot);
  // Nodes without a value (no yield strength) never count.
  while (best < values.length - 1 && Number.isNaN(values[best])) best++;
  for (let i = best + 1; i < values.length; i++)
    if (low ? values[i] < values[best] : values[i] > values[best]) best = i;
  return { value: values[best], node: view.nodeIds[best] };
}

/** The setup triangulation, before any analysis mesh exists. */
export function geometryView(
  surface: Surface & { interfaces?: Interface[] },
): ViewData {
  // Outer faces, then each shared face once per side.
  const sides = [
    ...surface.faces.map((f) => ({
      id: f.id,
      indices: f.indices,
      bodies: [f.body ?? 0, 0],
    })),
    ...(surface.interfaces ?? []).flatMap((i) =>
      [i.bodies, [i.bodies[1], i.bodies[0]]].map((bodies) => ({
        id: i.id,
        indices: i.indices ?? [],
        bodies,
      })),
    ),
  ];
  return {
    buffer: null,
    nodeIds: Int32Array.from(surface.nodeIds),
    points: Float64Array.from(surface.positions),
    triangles: Int32Array.from(sides.flatMap((f) => f.indices)),
    triangleFaces: Int32Array.from(
      sides.flatMap((f) => Array(f.indices.length / 3).fill(f.id)),
    ),
    triangleBodies: Int32Array.from(
      sides.flatMap((f) =>
        Array.from({ length: f.indices.length / 3 }, () => f.bodies).flat(),
      ),
    ),
    tets: null,
    tetBodies: null,
    yieldStrength: null,
    frames: [],
    frame: 0,
    displacement: null,
    fields: {},
  };
}

/** Displacement magnitude at each node. */
export function movement(view: ViewData) {
  const d = view.displacement;
  if (!d) return new Float64Array(view.nodeIds.length);
  const out = new Float64Array(d.length / 3);
  for (let i = 0; i < out.length; i++)
    out[i] = Math.hypot(d[i * 3], d[i * 3 + 1], d[i * 3 + 2]);
  return out;
}

/**
 * Yield margin at each node against its own body's yield strength, capped
 * at the top of the color scale; NaN where no yield strength applies.
 */
export function margin(
  view: ViewData,
  yieldStrength: number | null,
  cap: number,
) {
  const strength = nodeYield(view, yieldStrength);
  return view.fields.vonMises.map((s, i) => {
    const y = strength ? strength[i] : NaN;
    return !Number.isFinite(y) ? NaN : s > 0 ? Math.min(cap, y / s) : cap;
  });
}

/** The lowest uncapped yield margin of the displayed frame, or null. */
export function minMargin(view: ViewData, yieldStrength: number | null) {
  const strength = nodeYield(view, yieldStrength);
  const stress = view.fields.vonMises;
  if (!strength || !stress) return null;
  let low = Infinity;
  for (let i = 0; i < stress.length; i++)
    if (stress[i] > 0 && Number.isFinite(strength[i]))
      low = Math.min(low, strength[i] / stress[i]);
  return Number.isFinite(low) ? low : null;
}

/** Lowest and highest value, skipping NaN (nodes without a value). */
export function range(values: ArrayLike<number>) {
  let min = Infinity,
    max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    if (Number.isNaN(values[i])) continue;
    min = Math.min(min, values[i]);
    max = Math.max(max, values[i]);
  }
  return { min, max };
}

/** Exact nodal values for a node tag, or null if the mesh lacks it. */
export function nodeProbe(view: ViewData, node: number): Probe | null {
  const i = view.nodeIds.indexOf(node);
  if (i < 0 || !hasResults(view)) return null;
  return {
    point: Array.from(view.points.subarray(i * 3, i * 3 + 3)),
    node,
    values: {
      ...Object.fromEntries(
        Object.entries(view.fields).map(([k, a]) => [k, a[i]]),
      ),
      ...(view.yieldStrength && { yieldStrength: view.yieldStrength[i] }),
    },
    displacement: view.displacement
      ? Array.from(view.displacement.subarray(i * 3, i * 3 + 3))
      : null,
  };
}

/** CSV column names and SI working units of engine fields. */
const CSV_COLUMNS: Record<string, [string, string]> = {
  vonMises: ["von_mises", "MPa"],
  principalMax: ["max_principal", "MPa"],
  principalMin: ["min_principal", "MPa"],
  shear: ["max_shear_tresca", "MPa"],
  temperature: ["temperature", "°C"],
  peeq: ["plastic_strain", "mm/mm"],
  heatFlux: ["heat_flux", "W/m²"],
  strain: ["equivalent_strain", "µm/m"],
  strainMax: ["max_principal_strain", "µm/m"],
  strainMin: ["min_principal_strain", "µm/m"],
  amplitude: ["displacement_amplitude", "mm"],
  contactPressure: ["contact_pressure", "MPa"],
};
/** Unit labels as column-name suffixes. */
const SLUG: Record<string, string> = {
  "°C": "C",
  "°F": "F",
  "W/m²": "W_m2",
  "Btu/(hr·ft²)": "Btu_hr_ft2",
  "µm/m": "um_per_m",
  "µin/in": "uin_per_in",
  "mm/mm": "mm_per_mm",
  "in/in": "in_per_in",
};

/** Nodes on the part surface with the displayed frame's results, as CSV,
 * in the chosen unit system. */
export function surfaceCsv(view: ViewData, system: UnitSystem = "si") {
  const names = Object.keys(view.fields);
  const d = view.displacement;
  const suffix = (unit: string) => {
    const label = unitLabel(unit, system);
    return SLUG[label] ?? label;
  };
  const mm = suffix("mm");
  const show = (v: number, unit: string) => toShown(v, unit, system);
  const lines = [
    [
      `surface_node,x_${mm},y_${mm},z_${mm}`,
      ...(d ? [`ux_${mm},uy_${mm},uz_${mm},displacement_${mm}`] : []),
      ...names.map((n) =>
        CSV_COLUMNS[n]
          ? `${CSV_COLUMNS[n][0]}_${suffix(CSV_COLUMNS[n][1])}`
          : n,
      ),
    ].join(","),
  ];
  // Nodes of the outer faces; shared faces are inside the part.
  const used = new Uint8Array(view.nodeIds.length);
  view.triangles.forEach((i, k) => {
    if (!view.triangleBodies?.[Math.floor(k / 3) * 2 + 1]) used[i] = 1;
  });
  used.forEach((on, i) => {
    if (!on) return;
    const u = d ? Array.from(d.subarray(i * 3, i * 3 + 3)) : [];
    lines.push(
      [
        view.nodeIds[i],
        ...Array.from(view.points.subarray(i * 3, i * 3 + 3), (v) =>
          show(v, "mm"),
        ),
        ...(d ? [...u, Math.hypot(...u)].map((v) => show(v, "mm")) : []),
        ...names.map((n) =>
          CSV_COLUMNS[n]
            ? show(view.fields[n][i], CSV_COLUMNS[n][1])
            : view.fields[n][i],
        ),
      ].join(","),
    );
  });
  return lines.join("\n");
}

export function toBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

export function fromBase64(text: string) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0)).buffer;
}

/** A plot's value at a probe, or null where the probe lacks it. */
export function probeValue(
  probe: Probe,
  plot: Plot,
  yieldStrength: number | null,
): number | null {
  if (plot === "movement")
    return probe.displacement ? Math.hypot(...probe.displacement) : null;
  const stress = probe.values.vonMises;
  // The probe's own yield strength, of the body it lies in, where known.
  const strength = probe.values.yieldStrength ?? yieldStrength;
  if (plot === "safety")
    return strength && Number.isFinite(strength) && stress > 0
      ? strength / stress
      : null;
  return probe.values[PLOT_SOURCES[plot].field] ?? null;
}

/** Area (mm²) and center of a section cut through the part. */
export type SectionCut = { area: number; center: number[] | null };

/**
 * Force (N) and moment (N·mm, about the section center) carried through a
 * section plane, from the displayed frame's nodal forces: what the cut-away
 * side exerts on the kept side. At equilibrium the nodal forces are the
 * external loads and support reactions, so this is their resultant on the
 * cut-away side. Normal force is positive in tension, torque positive
 * about the outward normal of the kept side. Null without nodal forces.
 */
export function sectionLoads(
  view: ViewData,
  section: { axis: number; position: number; flip: boolean },
  center: number[],
) {
  const f = view.frames[view.frame]?.force;
  if (!f) return null;
  const force = [0, 0, 0],
    moment = [0, 0, 0];
  const p = view.points;
  // Sizes of what was summed, so round-off shows as zero. The .frd file
  // keeps about six significant digits of each nodal force.
  let size = 0,
    reach = 0;
  for (let i = 0; i < view.nodeIds.length; i++) {
    const x = p[i * 3 + section.axis];
    if (section.flip ? x >= section.position : x <= section.position) continue;
    const r = [0, 1, 2].map((k) => p[i * 3 + k] - center[k]);
    const [fx, fy, fz] = [f[i * 3], f[i * 3 + 1], f[i * 3 + 2]];
    size += Math.hypot(fx, fy, fz);
    reach = Math.max(reach, Math.hypot(...r));
    force[0] += fx;
    force[1] += fy;
    force[2] += fz;
    moment[0] += r[1] * fz - r[2] * fy;
    moment[1] += r[2] * fx - r[0] * fz;
    moment[2] += r[0] * fy - r[1] * fx;
  }
  const clean = (v: number[], scale: number) =>
    v.map((x) => (Math.abs(x) <= 1e-4 * scale ? 0 : x));
  force.splice(0, 3, ...clean(force, size));
  moment.splice(0, 3, ...clean(moment, size * reach));
  const a = section.axis,
    out = section.flip ? -1 : 1;
  const across = (v: number[]) => Math.hypot(...v.filter((_, k) => k !== a));
  return {
    force,
    moment,
    normal: out * force[a] || 0,
    shear: across(force),
    torque: out * moment[a] || 0,
    bending: across(moment),
  };
}

/** A saved probe: a named point of the part, in its undeformed position. */
export type Pin = { id: string; name: string; point: number[] };

/**
 * Where a point lies in the mesh: the tetrahedron around it and the
 * weights of its ten nodes (quadratic shape functions, straight edges
 * assumed for locating it). Points just outside a curved face take the
 * nearest tetrahedron; null for a point away from the mesh, such as a
 * saved probe outside a refined region.
 */
export type Location = { nodes: number[]; weights: number[] };

export function locate(view: ViewData, point: number[]): Location | null {
  const t = view.tets,
    p = view.points;
  if (!t) return null;
  const [x, y, z] = point;
  let best: { k: number; lam: number[]; worst: number } | null = null;
  for (let k = 0; k < t.length; k += 10) {
    const a = t[k] * 3,
      b = t[k + 1] * 3,
      c = t[k + 2] * 3,
      d = t[k + 3] * 3;
    // Bounding-box test first, with a little slack for curved faces.
    let lo = Math.min(p[a], p[b], p[c], p[d]),
      hi = Math.max(p[a], p[b], p[c], p[d]);
    const slack = (hi - lo) * 0.25;
    if (x < lo - slack || x > hi + slack) continue;
    lo = Math.min(p[a + 1], p[b + 1], p[c + 1], p[d + 1]);
    hi = Math.max(p[a + 1], p[b + 1], p[c + 1], p[d + 1]);
    if (y < lo - slack || y > hi + slack) continue;
    lo = Math.min(p[a + 2], p[b + 2], p[c + 2], p[d + 2]);
    hi = Math.max(p[a + 2], p[b + 2], p[c + 2], p[d + 2]);
    if (z < lo - slack || z > hi + slack) continue;
    const lam = barycentric(p, [a, b, c, d], point);
    if (!lam) continue;
    const worst = Math.min(...lam);
    if (!best || worst > best.worst) best = { k, lam, worst };
    if (worst >= -1e-9) break;
  }
  if (!best || best.worst < -0.25) return null;
  // Clamped to the element, as region refinement interpolates.
  const lam = best.lam.map((l) => Math.min(1, Math.max(0, l)));
  const sum = lam.reduce((s, l) => s + l, 0);
  const l = lam.map((v) => v / sum);
  // VTK quadratic tetra: corners, then edges 01, 12, 20, 03, 13, 23.
  const edges = [
    [0, 1],
    [1, 2],
    [2, 0],
    [0, 3],
    [1, 3],
    [2, 3],
  ];
  return {
    nodes: Array.from(t.subarray(best.k, best.k + 10)),
    weights: [
      ...l.map((v) => v * (2 * v - 1)),
      ...edges.map(([i, j]) => 4 * l[i] * l[j]),
    ],
  };
}

/** Barycentric coordinates of a point in the tetrahedron of corner offsets. */
function barycentric(p: Float64Array, c: number[], q: number[]) {
  const o = c[0];
  const e = [1, 2, 3].map((i) => [0, 1, 2].map((k) => p[c[i] + k] - p[o + k]));
  const r = [0, 1, 2].map((k) => q[k] - p[o + k]);
  const det = (m: number[][]) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  // Columns are the edge vectors; Cramer's rule for each coordinate.
  const columns = (cols: number[][]) =>
    [0, 1, 2].map((row) => cols.map((col) => col[row]));
  const D = det(columns(e));
  if (!D) return null;
  const s = [0, 1, 2].map(
    (i) => det(columns(e.map((col, j) => (j === i ? r : col)))) / D,
  );
  return [1 - s[0] - s[1] - s[2], ...s];
}

/** Values of the displayed frame at a located point. */
export function probeAt(
  view: ViewData,
  point: number[],
  at: Location | null,
): Probe | null {
  if (!at || !hasResults(view)) return null;
  const mix = (a: ArrayLike<number>, size = 1, k = 0) =>
    at.nodes.reduce((s, n, j) => s + at.weights[j] * a[n * size + k], 0);
  const values: Record<string, number> = Object.fromEntries(
    Object.entries(view.fields).map(([name, a]) => [name, mix(a)]),
  );
  // The element's own body's yield strength: nodes on a face shared with a
  // weaker body carry that body's, the element's other nodes its own.
  if (view.yieldStrength) {
    const strengths = at.nodes
      .map((n) => view.yieldStrength![n])
      .filter(Number.isFinite);
    values.yieldStrength = strengths.length ? Math.max(...strengths) : NaN;
  }
  return {
    point,
    node: null,
    values,
    displacement: view.displacement
      ? [0, 1, 2].map((k) => mix(view.displacement!, 3, k))
      : null,
  };
}

/** Plots in the saved-probe CSV, with their column names. */
export const PROBE_COLUMNS: { plot: Plot; column: string }[] = [
  { plot: "movement", column: "displacement" },
  { plot: "amplitude", column: "displacement_amplitude" },
  { plot: "stress", column: "von_mises" },
  { plot: "principalMax", column: "max_principal" },
  { plot: "principalMin", column: "min_principal" },
  { plot: "shear", column: "max_shear_tresca" },
  { plot: "strain", column: "equivalent_strain" },
  { plot: "strainMax", column: "max_principal_strain" },
  { plot: "strainMin", column: "min_principal_strain" },
  { plot: "safety", column: "yield_margin" },
  { plot: "plastic", column: "plastic_strain" },
  { plot: "temperature", column: "temperature" },
  { plot: "heatflux", column: "heat_flux" },
  { plot: "contact", column: "contact_pressure" },
];

/**
 * Saved probes over every frame, as CSV in the chosen units: one row per
 * probe and frame, with each plot the frame has.
 */
export function probesCsv(
  view: ViewData,
  pins: Pin[],
  frames: { label: string }[],
  plots: { plot: Plot; column: string; unit: string }[],
  yieldStrength: number | null,
  system: UnitSystem = "si",
) {
  const mm = SLUG[unitLabel("mm", system)] ?? unitLabel("mm", system);
  // Ratios (the yield margin) take no unit in their column name.
  const suffix = (unit: string) => {
    if (!unit || unit.includes("×")) return "";
    const label = unitLabel(unit, system);
    return "_" + (SLUG[label] ?? label.replace(/[^A-Za-z0-9]+/g, "_"));
  };
  const lines = [
    [
      "probe",
      `x_${mm}`,
      `y_${mm}`,
      `z_${mm}`,
      "frame",
      ...plots.map((p) => p.column + suffix(p.unit)),
    ].join(","),
  ];
  const quote = (text: string) =>
    /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  const located = pins.map((pin) => locate(view, pin.point));
  view.frames.forEach((_, k) => {
    const frame = atFrame(view, k);
    pins.forEach((pin, i) => {
      const probe = probeAt(frame, pin.point, located[i]);
      lines.push(
        [
          quote(pin.name),
          ...pin.point.map((v) => toShown(v, "mm", system)),
          quote(frames[k]?.label ?? String(k + 1)),
          ...plots.map((p) => {
            const v = probe && probeValue(probe, p.plot, yieldStrength);
            return v === null || !Number.isFinite(v)
              ? ""
              : p.unit
                ? toShown(v, p.unit, system)
                : v;
          }),
        ].join(","),
      );
    });
  });
  return lines.join("\n");
}

/** Result display saved in a project: the color scale and saved probes. */
export type SavedDisplay = { colorScale: ColorScale; pins: Pin[] };

/** A project's saved display, checked; defaults where it is missing or bad. */
export function restoreDisplay(saved: unknown): SavedDisplay {
  const d = (saved && typeof saved === "object" ? saved : {}) as {
    colorScale?: Partial<ColorScale>;
    pins?: unknown;
  };
  const c = d.colorScale ?? {};
  const end = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const limits: ColorScale["limits"] = {};
  for (const [plot, l] of Object.entries(c.limits ?? {}))
    if (plot in PLOT_SOURCES && l && typeof l === "object")
      limits[plot as Plot] = { min: end(l.min), max: end(l.max) };
  const bands =
    typeof c.bands === "number" && Number.isInteger(c.bands)
      ? Math.min(20, Math.max(0, c.bands))
      : 0;
  const pins = (Array.isArray(d.pins) ? d.pins : []).filter(
    (p): p is Pin =>
      !!p &&
      typeof p.id === "string" &&
      typeof p.name === "string" &&
      Array.isArray(p.point) &&
      p.point.length === 3 &&
      p.point.every((v: unknown) => typeof v === "number" && Number.isFinite(v)),
  );
  return {
    colorScale: {
      limits,
      allFrames: c.allFrames === true,
      bands,
      palette: c.palette === "viridis" ? "viridis" : "standard",
    },
    pins: pins.map(({ id, name, point }) => ({ id, name, point })),
  };
}
