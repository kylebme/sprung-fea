import type { Plot, ViewData } from "./viewData";
export type { Plot };
export type Face = {
  id: number;
  name: string;
  type: string;
  area: number;
  center: number[];
  anchor: number[];
  normal: number[];
  indices: number[];
};
export type Surface = { positions: number[]; nodeIds: number[]; faces: Face[] };
export type Geometry = Surface & {
  bounds: number[];
  dimensions: number[];
  volume: number;
  recommendedSize: number;
  hash: string;
  units: string;
};
export type Material = {
  name: string;
  young: number;
  poisson: number;
  density: number;
  yield: number | null;
};
export type Support = {
  id: string;
  name: string;
  faces: number[];
  axes: boolean[];
};
/**
 * Loads. `vector` is a force (N), acceleration (m/s²) or moment (N·mm);
 * `magnitude` a pressure (MPa) or rotational speed (rpm). A remote force acts
 * at `point`; a rotation turns about `axis` through `point`. Gravity and
 * rotation act on the whole part and select no faces.
 */
export type LoadKind =
  | "force"
  | "pressure"
  | "gravity"
  | "remote"
  | "moment"
  | "bearing"
  | "rotation";
export type Load = {
  id: string;
  name: string;
  kind: LoadKind;
  faces: number[];
  vector: number[];
  magnitude: number;
  point?: number[];
  axis?: number[];
};
/**
 * A rigid point mass (kg) at `point` (mm), such as a motor or a bolted-on
 * component, carried by the selected faces. Its own rotational inertia is
 * not modeled.
 */
export type PointMass = {
  id: string;
  name: string;
  faces: number[];
  mass: number;
  point: number[];
};
/** Conditions applied to faces, edited through drafts. */
export type ConditionKind = "support" | "load" | "mass";
export type Condition = Support | Load | PointMass;
/** CalculiX equation solver: direct SPOOLES or preconditioned conjugate gradients. */
export type Solver = "spooles" | "iterative-scaling" | "iterative-cholesky";
/**
 * Threads for meshing and solving, a per-machine preference outside the
 * study: Auto uses performance cores, All every logical core.
 */
export type Threads = "auto" | "single" | "all";
export type Cpus = { logical: number; performance: number };
/** Analysis types; projects saved before the choice are linear static. */
export type Analysis = "static" | "frequency" | "buckling";
export type Study = {
  analysis: Analysis;
  material: Material | null;
  supports: Support[];
  loads: Load[];
  masses: PointMass[];
  /** Modes to find in vibration studies. */
  modes?: number;
  meshSize: number;
  detail: "coarse" | "medium" | "fine" | "custom";
  solver: Solver;
};
export type MeshInfo = {
  size: number;
  nodeCount: number;
  elementCount: number;
  minQuality: number;
};
/** Mesh arrays for display come from the engine's binary view file. */
export type Mesh = MeshInfo & { view: ViewData };
/** Summary numbers. Static results fill the force fields. */
export type Summary = {
  seconds: number;
  maxStress?: number;
  maxMovement?: number;
  minSafety?: number | null;
  reactions?: number[];
  stressNode?: number;
  movementNode?: number;
  appliedForce?: number[];
  forceBalanceError?: number;
  [key: string]: unknown;
};
/** One result frame: a load step, mode, increment or frequency. */
export type FrameInfo = { label: string; value: number | null; unit: string };
/** A row of the console's Checks tab. */
export type Check = {
  label: string;
  values: number[];
  unit: string;
  digits?: number;
};
export type Chart = {
  id: string;
  title: string;
  x: { label: string; unit: string; values: number[] };
  series: { label: string; unit: string; values: number[] }[];
};
/** A mesh convergence study: one row per mesh, one verdict per quantity. */
export type Convergence = {
  /** Largest relative change on the last refinement counted as converged. */
  tolerance: number;
  /** Element size ratio between successive meshes. */
  ratio: number;
  meshes: {
    size: number;
    elementCount: number;
    nodeCount: number;
    seconds: number;
    values: number[];
  }[];
  quantities: {
    id: string;
    label: string;
    unit: string;
    /** A local peak, which may not converge at a singularity. */
    peak?: boolean;
    converged: boolean;
    change: number | null;
    /** Richardson extrapolation from the last three meshes. */
    estimate: { value: number; order: number } | null;
    singular?: boolean;
  }[];
};
export type ConvergenceOptions = { runs: number; tolerance: number };
/** A number that characterizes a result, followed by mesh convergence. */
export type KeyResult = {
  id: string;
  label: string;
  unit: string;
  value: number;
  peak?: boolean;
};
export type ResultInfo = {
  keys: KeyResult[];
  convergence?: Convergence;
  /** Result schema version; results saved before 2 are linear static. */
  version: number;
  analysis: Analysis;
  frames: FrameInfo[];
  checks: Check[];
  charts: Chart[];
  summary: Summary;
  warnings: string[];
  solver: string;
  /** Conjugate-gradient iterations, or null for the direct solver. */
  iterations: number | null;
  threads: number;
  meshSize: number;
  nodeCount: number;
  elementCount: number;
};
/** A box (center and size, mm) re-solved on a finer mesh: a submodel. */
export type Region = { center: number[]; size: number[]; meshSize: number };
/** Faces of a solved region: cut faces carry the whole-part solution. */
export type RegionFace = {
  id: number;
  type: string;
  area: number;
  original: number | null;
  cut: boolean;
};
/** Nodal displacement and stress live in `view`, with the mesh they belong to. */
export type Result = ResultInfo & { view: ViewData };
export type RegionResult = Result & {
  region: Region;
  bounds: number[];
  faces: RegionFace[];
};
export type Part = {
  id: string;
  name: string;
  geometry: Geometry;
  sample?: "beam" | "bracket";
};
export type Axis = 0 | 1 | 2;
/**
 * Result filters, applied in the viewer. The section cuts away the part
 * beyond `position` (mm) along the axis; `flip` cuts away the near side
 * instead. Iso-surface and threshold levels are fractions of the active
 * plot's color scale, so they stay meaningful when the plot changes.
 * The threshold keeps stress or displacement above its level, and yield
 * margin below it: the critical region either way.
 */
export type Filters = {
  section: { on: boolean; axis: Axis; position: number; flip: boolean };
  iso: { on: boolean; level: number };
  threshold: { on: boolean; level: number };
};
export const MATERIALS: Material[] = [
  {
    name: "Aluminum 6061-T6",
    young: 68900,
    poisson: 0.33,
    density: 2700,
    yield: 276,
  },
  {
    name: "Structural steel",
    young: 200000,
    poisson: 0.3,
    density: 7850,
    yield: 250,
  },
  {
    name: "Stainless steel 304",
    young: 193000,
    poisson: 0.29,
    density: 8000,
    yield: 215,
  },
  {
    name: "Titanium Ti-6Al-4V",
    young: 113800,
    poisson: 0.342,
    density: 4430,
    yield: 880,
  },
];
export const emptyStudy = (): Study => ({
  analysis: "static",
  material: null,
  supports: [],
  loads: [],
  masses: [],
  meshSize: 0,
  detail: "medium",
  solver: "spooles",
});
export { fmt } from "./logic";
declare global {
  interface Window {
    desktop?: {
      platform: string;
      onMenu: (handler: (command: string) => void) => () => void;
      saveFile: (args: {
        name: string;
        content: string;
        type?: string;
      }) => Promise<boolean>;
    };
  }
}
