// Arrays the viewer draws: the engine's binary view (mesh and nodal results)
// or the setup triangulation. Only type imports, so Node can test it directly.
import type { Surface } from "./types";

/**
 * Indices refer to `points`. Tetrahedra are ten-node quadratic cells in VTK
 * order. Boundary triangles carry the CAD face they belong to. Results are
 * present after a solve.
 */
export type ViewData = {
  /** The engine's bytes, kept so a project can embed them unchanged. */
  buffer: ArrayBuffer | null;
  nodeIds: Int32Array;
  points: Float64Array;
  triangles: Int32Array;
  triangleFaces: Int32Array;
  tets: Int32Array | null;
  displacement: Float64Array | null;
  vonMises: Float64Array | null;
};

/** Values at a point of the part, in its undeformed position. */
export type Probe = {
  point: number[];
  /** Mesh node tag when the probe sits exactly on a node. */
  node: number | null;
  stress: number;
  displacement: number[];
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
  const view: ViewData = {
    buffer,
    nodeIds: arrays.nodeIds as Int32Array,
    points: arrays.points as Float64Array,
    triangles: arrays.triangles as Int32Array,
    triangleFaces: arrays.triangleFaces as Int32Array,
    tets: (arrays.tets as Int32Array) || null,
    displacement: (arrays.displacement as Float64Array) || null,
    vonMises: (arrays.vonMises as Float64Array) || null,
  };
  validate(view);
  return view;
}

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
    (v.displacement && v.displacement.length !== n * 3) ||
    (v.vonMises && v.vonMises.length !== n) ||
    !v.displacement !== !v.vonMises
  )
    throw Error("The view file has inconsistent array sizes.");
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
    displacement: null,
    vonMises: null,
  };
}

/** Displacement magnitude at each node. */
export function movement(view: ViewData) {
  const d = view.displacement!;
  const out = new Float64Array(d.length / 3);
  for (let i = 0; i < out.length; i++)
    out[i] = Math.hypot(d[i * 3], d[i * 3 + 1], d[i * 3 + 2]);
  return out;
}

/** Yield margin at each node, capped at the top of the color scale. */
export function margin(view: ViewData, yieldStrength: number, cap: number) {
  return view.vonMises!.map((s) =>
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
  if (i < 0 || !view.vonMises || !view.displacement) return null;
  return {
    point: Array.from(view.points.subarray(i * 3, i * 3 + 3)),
    node,
    stress: view.vonMises[i],
    displacement: Array.from(view.displacement.subarray(i * 3, i * 3 + 3)),
  };
}

/** Nodes on the part surface with their results, as CSV text. */
export function surfaceCsv(view: ViewData) {
  const lines = [
    "surface_node,x_mm,y_mm,z_mm,ux_mm,uy_mm,uz_mm,displacement_mm,von_mises_MPa",
  ];
  const used = new Uint8Array(view.nodeIds.length);
  for (const i of view.triangles) used[i] = 1;
  const d = view.displacement!;
  used.forEach((on, i) => {
    if (!on) return;
    const u = d.subarray(i * 3, i * 3 + 3);
    lines.push(
      [
        view.nodeIds[i],
        ...view.points.subarray(i * 3, i * 3 + 3),
        ...u,
        Math.hypot(...u),
        view.vonMises![i],
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
