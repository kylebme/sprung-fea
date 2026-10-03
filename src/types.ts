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
export type Study = {
  material: Material | null;
  supports: Support[];
  loads: Load[];
  meshSize: number;
  detail: "coarse" | "medium" | "fine" | "custom";
};
export type Mesh = {
  surface: Surface;
  size: number;
  nodeCount: number;
  elementCount: number;
  minQuality: number;
};
export type Result = {
  displacements: number[][];
  stress: number[];
  movement: number[];
  summary: {
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
  warnings: string[];
  solver: string;
  meshSize: number;
  nodeCount: number;
  elementCount: number;
};
export type Part = {
  id: string;
  name: string;
  geometry: Geometry;
  sample?: "beam" | "bracket";
};
export type Plot = "stress" | "movement" | "safety";
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
