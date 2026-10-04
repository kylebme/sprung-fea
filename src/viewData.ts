// Arrays the viewer draws: the engine's binary view (mesh and nodal results)
// or the setup triangulation. Only type imports, so Node can test it directly.
import type { Surface } from "./types";

/**
 * Nodal results of one frame (a load step, mode, increment or frequency):
 * `displacement` (three components per node) and scalar fields such as
 * `vonMises` or `temperature`, one value per node.
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
  tets: Int32Array | null;
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
  | "amplitude";
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
};

const MAGIC = "BSIMVIEW";
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
    throw Error("Not a BetterSim view file.");
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
      tets: (arrays.tets as Int32Array) || null,
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

const MESH = ["nodeIds", "points", "tets", "triangles", "triangleFaces"];

function validate(v: ViewData) {
  const n = v.nodeIds?.length;
  const inRange = (a: Int32Array) => a.every((i) => i >= 0 && i < n);
  if (
    !n ||
    v.points?.length !== n * 3 ||
    !v.triangles ||
    v.triangles.length % 3 ||
    v.triangleFaces?.length !== v.triangles.length / 3 ||
    !inRange(v.triangles) ||
    (v.tets && (v.tets.length % 10 || !inRange(v.tets))) ||
    v.frames.some(
      (f) =>
        !Object.keys(f).length ||
        Object.entries(f).some(
          ([name, a]) => a.length !== (name === "displacement" ? n * 3 : n),
        ),
    )
  )
    throw Error("The view file has inconsistent array sizes.");
}

/** The view showing frame `k`; geometry arrays are shared, not copied. */
export function atFrame(view: ViewData, k: number): ViewData {
  const frame = view.frames[k];
  if (!frame) return { ...view, frame: 0, displacement: null, fields: {} };
  const { displacement, ...fields } = frame;
  return { ...view, frame: k, displacement: displacement || null, fields };
}

export const hasResults = (view: ViewData | null) =>
  !!view && view.frames.length > 0;

/** Plots this frame can show. The yield margin needs a yield strength. */
export function availablePlots(view: ViewData, yieldStrength: number | null) {
  return (Object.keys(PLOT_SOURCES) as Plot[]).filter((p) => {
    const source = PLOT_SOURCES[p].field;
    const present =
      source === "displacement" ? !!view.displacement : !!view.fields[source];
    return present && (p !== "safety" || !!yieldStrength);
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
  if (plot === "safety") return margin(view, yieldStrength || 0, marginCap);
  return view.fields[PLOT_SOURCES[plot].field];
}

/**
 * Color-scale limits: zero to the maximum, or the true range for signed
 * quantities such as temperature; the yield margin uses its own cap.
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

/** Plots whose critical value is the lowest: margin, compression. */
export const lowIsCritical = (plot: Plot) =>
  plot === "safety" || plot === "principalMin" || plot === "strainMin";

/** The node with the extreme value: lowest margin, highest otherwise. */
export function peak(view: ViewData, plot: Plot, yieldStrength: number | null) {
  const values = plotValues(view, plot, yieldStrength);
  let best = 0;
  const low = lowIsCritical(plot);
  for (let i = 1; i < values.length; i++)
    if (low ? values[i] < values[best] : values[i] > values[best]) best = i;
  return { value: values[best], node: view.nodeIds[best] };
}

/** The setup triangulation, before any analysis mesh exists. */
export function geometryView(surface: Surface): ViewData {
  return {
    buffer: null,
    nodeIds: Int32Array.from(surface.nodeIds),
    points: Float64Array.from(surface.positions),
    triangles: Int32Array.from(surface.faces.flatMap((f) => f.indices)),
    triangleFaces: Int32Array.from(
      surface.faces.flatMap((f) => Array(f.indices.length / 3).fill(f.id)),
    ),
    tets: null,
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

/** Yield margin at each node, capped at the top of the color scale. */
export function margin(view: ViewData, yieldStrength: number, cap: number) {
  return view.fields.vonMises.map((s) =>
    s > 0 ? Math.min(cap, yieldStrength / s) : cap,
  );
}

export function range(values: ArrayLike<number>) {
  let min = Infinity,
    max = -Infinity;
  for (let i = 0; i < values.length; i++) {
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
    values: Object.fromEntries(
      Object.entries(view.fields).map(([k, a]) => [k, a[i]]),
    ),
    displacement: view.displacement
      ? Array.from(view.displacement.subarray(i * 3, i * 3 + 3))
      : null,
  };
}

/** CSV column names and units of engine fields. */
const CSV_COLUMNS: Record<string, string> = {
  vonMises: "von_mises_MPa",
  temperature: "temperature_C",
  peeq: "plastic_strain",
  heatFlux: "heat_flux_W_m2",
  principalMax: "max_principal_MPa",
  principalMin: "min_principal_MPa",
  shear: "max_shear_tresca_MPa",
  strain: "equivalent_strain_um_per_m",
  strainMax: "max_principal_strain_um_per_m",
  strainMin: "min_principal_strain_um_per_m",
  amplitude: "displacement_amplitude_mm",
};

/** Nodes on the part surface with the displayed frame's results, as CSV. */
export function surfaceCsv(view: ViewData) {
  const names = Object.keys(view.fields);
  const d = view.displacement;
  const lines = [
    [
      "surface_node,x_mm,y_mm,z_mm",
      ...(d ? ["ux_mm,uy_mm,uz_mm,displacement_mm"] : []),
      ...names.map((n) => CSV_COLUMNS[n] || n),
    ].join(","),
  ];
  const used = new Uint8Array(view.nodeIds.length);
  for (const i of view.triangles) used[i] = 1;
  used.forEach((on, i) => {
    if (!on) return;
    const u = d ? Array.from(d.subarray(i * 3, i * 3 + 3)) : [];
    lines.push(
      [
        view.nodeIds[i],
        ...view.points.subarray(i * 3, i * 3 + 3),
        ...(d ? [...u, Math.hypot(...u)] : []),
        ...names.map((n) => view.fields[n][i]),
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
  if (plot === "safety")
    return yieldStrength && stress > 0 ? yieldStrength / stress : null;
  return probe.values[PLOT_SOURCES[plot].field] ?? null;
}
