import type { ViewData } from "./viewData";
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
export type Load = {
  id: string;
  name: string;
  kind: "force" | "pressure" | "gravity";
  faces: number[];
  vector: number[];
  magnitude: number;
};
/** CalculiX equation solver: direct SPOOLES or preconditioned conjugate gradients. */
export type Solver = "spooles" | "iterative-scaling" | "iterative-cholesky";
/**
 * Threads for meshing and solving, a per-machine preference outside the
 * study: Auto uses performance cores, All every logical core.
 */
export type Threads = "auto" | "single" | "all";
export type Cpus = { logical: number; performance: number };
export type Study = {
  material: Material | null;
  supports: Support[];
  loads: Load[];
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
export type Summary = {
  maxStress: number;
  maxMovement: number;
  minSafety: number | null;
  reactions: number[];
  stressNode: number;
  movementNode: number;
  seconds: number;
  appliedForce: number[];
  forceBalanceError: number;
};
export type ResultInfo = {
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
/** Nodal displacement and stress live in `view`, with the mesh they belong to. */
export type Result = ResultInfo & { view: ViewData };
export type Part = {
  id: string;
  name: string;
  geometry: Geometry;
  sample?: "beam" | "bracket";
};
export type Plot = "stress" | "movement" | "safety";
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
  material: null,
  supports: [],
  loads: [],
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
