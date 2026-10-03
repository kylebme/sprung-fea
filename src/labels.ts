import { fmt } from "./logic";
import type {
  Analysis,
  Load,
  LoadKind,
  Plot,
  Solver,
  Study,
  Support,
} from "./types";

export const DETAILS = [
  { id: "coarse", name: "Coarse", factor: 1.5 },
  { id: "medium", name: "Medium", factor: 1 },
  { id: "fine", name: "Fine", factor: 0.65 },
] as const;
export const DETAIL_NAMES: Record<Study["detail"], string> = {
  coarse: "Coarse",
  medium: "Medium",
  fine: "Fine",
  custom: "Custom",
};
export const SOLVERS: { id: Solver; name: string; note: string }[] = [
  {
    id: "spooles",
    name: "Direct (SPOOLES)",
    note: "Exact factorization. Most robust; memory grows quickly with mesh size.",
  },
  {
    id: "iterative-cholesky",
    name: "Iterative, incomplete Cholesky",
    note: "Conjugate gradients with a strong preconditioner. Much less memory for large meshes.",
  },
  {
    id: "iterative-scaling",
    name: "Iterative, diagonal scaling",
    note: "Conjugate gradients with the least memory. Needs more iterations.",
  },
];
export const PLOTS: Record<
  Plot,
  { name: string; unit: string; digits: number }
> = {
  stress: { name: "von Mises stress", unit: "MPa", digits: 3 },
  movement: { name: "Displacement", unit: "mm", digits: 4 },
  safety: { name: "Yield margin", unit: "× yield", digits: 2 },
  temperature: { name: "Temperature", unit: "°C", digits: 2 },
  plastic: { name: "Plastic strain", unit: "mm/mm", digits: 5 },
};
export const ANALYSES: Record<Analysis, { name: string; note: string }> = {
  static: {
    name: "Linear static",
    note: "Stress and deflection under steady loads.",
  },
};
/** Short console labels for worker stages. */
export const STAGES: Record<string, string> = {
  importing: "import",
  meshing: "mesh",
  solve: "solve",
  checking: "check",
  solving: "solve",
  reading: "read",
};
export const stripExt = (name: string) => name.replace(/\.(step|stp)$/i, "");
export const facesLabel = (faces: number[]) =>
  faces.length === 1 ? "Face " + faces[0] : faces.length + " faces";
/** Load kinds in the order the editor offers them, with their help text. */
export const LOAD_KINDS: { id: LoadKind; name: string; note: string }[] = [
  {
    id: "force",
    name: "Force",
    note: "One total force, split across the selected faces by area.",
  },
  {
    id: "pressure",
    name: "Pressure",
    note: "Positive pressure pushes into the surface.",
  },
  {
    id: "gravity",
    name: "Gravity",
    note: "Acts on the whole part using the material density.",
  },
  {
    id: "remote",
    name: "Remote force",
    note: "A force acting at a point off the faces, such as the end of a lever. The selected faces carry it; its offset adds a moment.",
  },
  {
    id: "moment",
    name: "Moment",
    note: "A twisting load about the X, Y and Z directions, carried by the selected faces.",
  },
  {
    id: "bearing",
    name: "Bearing",
    note: "A shaft or pin pressing on a cylindrical face. It pushes on the half that faces the load, so act across the axis.",
  },
  {
    id: "rotation",
    name: "Rotation",
    note: "The whole part spins about an axis, using the material density.",
  },
];
export const BODY_LOADS: LoadKind[] = ["gravity", "rotation"];
export const isBodyLoad = (l: Load) => BODY_LOADS.includes(l.kind);
export const loadValue = (l: Load) =>
  l.kind === "pressure"
    ? fmt(l.magnitude) + " MPa"
    : l.kind === "rotation"
      ? fmt(l.magnitude) + " rpm"
      : fmt(Math.hypot(...l.vector)) +
        (l.kind === "gravity" ? " m/s²" : l.kind === "moment" ? " N·mm" : " N");
export const blankSupport = (): Support => ({
  id: crypto.randomUUID(),
  name: "Fixed",
  faces: [],
  axes: [true, true, true],
});
export const blankLoad = (): Load => ({
  id: crypto.randomUUID(),
  name: "Force",
  kind: "force",
  faces: [],
  vector: [0, 0, -100],
  magnitude: 1,
});
