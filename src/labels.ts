import { fmt } from "./logic";
import type {
  Analysis,
  Condition,
  ConditionKind,
  Load,
  LoadKind,
  PointMass,
  Plot,
  Solver,
  Study,
  Support,
  ThermalCondition,
  ThermalKind,
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
  heatflux: { name: "Heat flux", unit: "W/m²", digits: 1 },
};
/** Thermal condition kinds, in the editor's order, with their help text. */
export const THERMAL_KINDS: {
  id: ThermalKind;
  name: string;
  unit: string;
  label: string;
  note: string;
}[] = [
  {
    id: "temperature",
    name: "Temperature",
    unit: "°C",
    label: "Temperature",
    note: "Holds the faces at a fixed temperature, such as a surface clamped to a cold plate.",
  },
  {
    id: "heat",
    name: "Heat flow",
    unit: "W",
    label: "Total heat flow into the faces",
    note: "Heat entering through the faces, such as from a heater or a chip. Negative values remove heat.",
  },
  {
    id: "convection",
    name: "Convection",
    unit: "W/(m²·K)",
    label: "Film coefficient",
    note: "Heat exchanged with surrounding air or liquid. Typical: still air 5–10, moving air 20–100, water 500–10,000 W/(m²·K).",
  },
  {
    id: "generation",
    name: "Generation",
    unit: "W",
    label: "Heat generated in the part",
    note: "Heat produced evenly through the whole part, such as from electrical losses.",
  },
];
export const thermalValue = (c: ThermalCondition) =>
  c.kind === "temperature"
    ? fmt(c.value) + " °C"
    : c.kind === "convection"
      ? fmt(c.value) + " W/m²K"
      : fmt(c.value) + " W";
export const blankThermal = (): ThermalCondition => ({
  id: crypto.randomUUID(),
  name: "Temperature",
  kind: "temperature",
  faces: [],
  value: 100,
  ambient: 20,
});
/**
 * Analysis types and what each uses. `loads`: loads apply and are shown.
 * `supports`: at least one support is required. `mechanical`: supports and
 * point masses take part and are shown. `thermal`: thermal conditions take
 * part, and a temperature or convection is required. `eigen`: results are
 * shapes scaled to a 1 mm peak, solved with the direct solver.
 */
export const ANALYSES: Record<
  Analysis,
  {
    name: string;
    note: string;
    loads: boolean;
    supports: boolean;
    mechanical: boolean;
    thermal: boolean;
    eigen: boolean;
  }
> = {
  static: {
    name: "Linear static",
    note: "Stress and deflection under steady loads.",
    loads: true,
    supports: true,
    mechanical: true,
    thermal: false,
    eigen: false,
  },
  frequency: {
    name: "Natural frequencies",
    note: "The frequencies a part vibrates at on its own, and the shape of each vibration. Keep them away from the frequencies of motors, rotors or road input.",
    loads: false,
    supports: false,
    mechanical: true,
    thermal: false,
    eigen: true,
  },
  buckling: {
    name: "Buckling",
    note: "How many times the loads can grow before a slender or thin-walled part suddenly buckles sideways, and the shape it buckles into.",
    loads: true,
    supports: true,
    mechanical: true,
    thermal: false,
    eigen: true,
  },
  thermal: {
    name: "Heat transfer",
    note: "The temperatures a part settles at with heat flowing in and out: heaters, cooled faces, air.",
    loads: false,
    supports: false,
    mechanical: false,
    thermal: true,
    eigen: false,
  },
  thermalStress: {
    name: "Thermal stress",
    note: "Temperatures, and the stress and deflection from thermal expansion that the supports resist, together with any loads.",
    loads: true,
    supports: true,
    mechanical: true,
    thermal: true,
    eigen: false,
  },
};
/** Modes requested by default in each eigenvalue analysis. */
export const DEFAULT_MODES: Partial<Record<Analysis, number>> = {
  frequency: 6,
  buckling: 3,
};

/** A plot's name and unit, which depend on the analysis. */
export function plotInfo(plot: Plot, analysis: Analysis) {
  if (analysis === "buckling" && plot === "movement")
    return { name: "Buckled shape", unit: "relative", digits: 3 };
  if (ANALYSES[analysis].eigen && plot === "movement")
    return { name: "Mode shape", unit: "relative", digits: 3 };
  if (ANALYSES[analysis].eigen && plot === "stress")
    return { name: "Modal stress", unit: "MPa per mm", digits: 3 };
  return PLOTS[plot];
}
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
export const massValue = (m: PointMass) => fmt(m.mass) + " kg";
export const CONDITIONS: Record<
  ConditionKind,
  { group: string; add: string; empty: string }
> = {
  support: {
    group: "Supports",
    add: "Add support",
    empty: "Supports hold faces in place. A study needs at least one.",
  },
  load: {
    group: "Loads",
    add: "Add load",
    empty:
      "Loads are forces, pressures, moments, gravity or rotation acting on the part.",
  },
  thermal: {
    group: "Thermal",
    add: "Add thermal condition",
    empty:
      "Fixed temperatures, heat flows, convection to air, or heat generated in the part.",
  },
  mass: {
    group: "Masses",
    add: "Add mass",
    empty:
      "Point masses stand in for parts that are not modeled, such as a motor bolted to a face.",
  },
};
export const conditionValue = (kind: ConditionKind, c: Condition) =>
  kind === "load"
    ? loadValue(c as Load)
    : kind === "mass"
      ? massValue(c as PointMass)
      : kind === "thermal"
        ? thermalValue(c as ThermalCondition)
        : "";
export const blankMass = (point: number[]): PointMass => ({
  id: crypto.randomUUID(),
  name: "Point mass",
  faces: [],
  mass: 1,
  point,
});
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
