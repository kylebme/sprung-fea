import { fmt } from "./logic";
import type { Load, Plot, Study, Support } from "./types";

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
export const PLOTS: Record<Plot, { name: string; unit: string }> = {
  stress: { name: "von Mises stress", unit: "MPa" },
  movement: { name: "Displacement", unit: "mm" },
  safety: { name: "Yield margin", unit: "× yield" },
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
export const loadValue = (l: Load) =>
  l.kind === "pressure"
    ? fmt(l.magnitude) + " MPa"
    : fmt(Math.hypot(...l.vector)) + (l.kind === "gravity" ? " m/s²" : " N");
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
