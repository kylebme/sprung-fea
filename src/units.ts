// Unit systems. Studies, the engine and the view file always use the SI
// working units (mm, N, MPa, °C, …); the interface converts what it shows
// and what is typed. Only type imports, so Node can test it directly.
export type UnitSystem = "si" | "us";

/** A US unit for an SI working unit: shown = SI × scale + offset. */
type Conversion = { unit: string; scale: number; offset?: number };

const IN = 1 / 25.4;
const LBF = 1 / 4.4482216152605;
const PSI = 145.03773773;
/**
 * US equivalents of the SI working units, keyed by the SI unit string the
 * code and engine use. Units missing here (%, Hz, rpm, relative, W, × …)
 * are the same in both systems.
 */
const US: Record<string, Conversion> = {
  mm: { unit: "in", scale: IN },
  "mm²": { unit: "in²", scale: IN ** 2 },
  "mm³": { unit: "in³", scale: IN ** 3 },
  N: { unit: "lbf", scale: LBF },
  "N·mm": { unit: "lbf·in", scale: LBF * IN },
  MPa: { unit: "psi", scale: PSI },
  "MPa per mm": { unit: "psi per in", scale: PSI / IN },
  "kg/m³": { unit: "lb/in³", scale: 1 / 27679.9047 },
  kg: { unit: "lb", scale: 1 / 0.45359237 },
  "°C": { unit: "°F", scale: 1.8, offset: 32 },
  "m/s²": { unit: "in/s²", scale: 1000 * IN },
  "W/(m·K)": { unit: "Btu/(hr·ft·°F)", scale: 1 / 1.730735 },
  "µm/(m·°C)": { unit: "µin/(in·°F)", scale: 1 / 1.8 },
  "W/(m²·K)": { unit: "Btu/(hr·ft²·°F)", scale: 1 / 5.678263 },
  "J/(kg·K)": { unit: "Btu/(lb·°F)", scale: 1 / 4186.8 },
  "W/m²": { unit: "Btu/(hr·ft²)", scale: 1 / 3.154591 },
  "µm/m": { unit: "µin/in", scale: 1 },
  "mm/mm": { unit: "in/in", scale: 1 },
};

/** The unit shown for an SI working unit. */
export const unitLabel = (unit: string, system: UnitSystem) =>
  system === "us" ? (US[unit]?.unit ?? unit) : unit;

/** A value in SI working units, as shown. */
export function toShown(value: number, unit: string, system: UnitSystem) {
  const c = system === "us" ? US[unit] : undefined;
  return c ? value * c.scale + (c.offset ?? 0) : value;
}

/** A value as typed or shown, back in SI working units. */
export function fromShown(value: number, unit: string, system: UnitSystem) {
  const c = system === "us" ? US[unit] : undefined;
  return c ? (value - (c.offset ?? 0)) / c.scale : value;
}

/** Whether the unit converts in this system (otherwise it is shared). */
export const converts = (unit: string, system: UnitSystem) =>
  system === "us" && unit in US;

/** The status-bar summary of the working units. */
export const SYSTEM_LABEL: Record<UnitSystem, string> = {
  si: "mm · N · MPa",
  us: "in · lbf · psi",
};
