// Pure study logic. Only type imports, so Node can run the unit tests directly.
import type {
  Bolt,
  Condition,
  ConditionKind,
  Face,
  Load,
  Material,
  MeshInfo,
  PointMass,
  ResultInfo,
  ThermalCondition,
  Study,
  Support,
} from "./types";

/** The study list holding each kind of condition. */
export const LISTS = {
  support: "supports",
  load: "loads",
  mass: "masses",
  thermal: "thermal",
  bolt: "bolts",
} as const satisfies Record<ConditionKind, keyof Study>;
export const conditionsOf = (study: Study, kind: ConditionKind) =>
  (study[LISTS[kind]] ?? []) as Condition[];

/** Fills settings that older projects lack with the values they implied. */
export function normalizeStudy(study: Study): Study {
  return {
    ...study,
    analysis: study.analysis ?? "static",
    solver: study.solver ?? "spooles",
    masses: study.masses ?? [],
    thermal: study.thermal ?? [],
  };
}

/**
 * Results in the current schema. Results saved before schema 2 are linear
 * static: one frame, with checks rebuilt from the summary.
 */
export function normalizeResult(info: ResultInfo): ResultInfo {
  if (info.version >= 2) return info;
  const s = info.summary;
  return {
    ...info,
    version: 2,
    analysis: "static",
    keys: [
      {
        id: "maxMovement",
        label: "Maximum displacement",
        unit: "mm",
        value: s.maxMovement ?? 0,
      },
      {
        id: "maxStress",
        label: "Peak stress",
        unit: "MPa",
        value: s.maxStress ?? 0,
        peak: true,
      },
    ],
    frames: [{ label: "Static load", value: null, unit: "" }],
    charts: [],
    checks: s.appliedForce
      ? [
          { label: "Applied force X, Y, Z", values: s.appliedForce, unit: "N" },
          { label: "Reaction X, Y, Z", values: s.reactions || [], unit: "N" },
          {
            label: "Force balance error",
            values: [(s.forceBalanceError || 0) * 100],
            unit: "%",
          },
        ]
      : [],
  };
}

export function fmt(n: number, digits = 3) {
  return !Number.isFinite(n)
    ? "—"
    : Math.abs(n) > 0 && (Math.abs(n) < 0.001 || Math.abs(n) >= 1e6)
      ? n.toExponential(2)
      : new Intl.NumberFormat("en-US", {
          maximumFractionDigits: digits,
        }).format(n);
}

/** A number to `digits` significant digits, for values of any scale. */
export function sig(n: number, digits = 4) {
  return !Number.isFinite(n)
    ? "—"
    : Math.abs(n) > 0 && (Math.abs(n) < 0.001 || Math.abs(n) >= 1e6)
      ? n.toExponential(digits - 1)
      : new Intl.NumberFormat("en-US", {
          maximumSignificantDigits: digits,
        }).format(n);
}

export type History = { study: Study; past: Study[]; future: Study[] };
export type HistoryAction =
  | { type: "edit"; study: Study }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "reset"; study: Study };
export const HISTORY_LIMIT = 30;

/** Every study change goes through here, so undo and redo stay consistent. */
export function history(state: History, action: HistoryAction): History {
  switch (action.type) {
    case "edit":
      return {
        study: action.study,
        past: [...state.past.slice(-(HISTORY_LIMIT - 1)), state.study],
        future: [],
      };
    case "undo":
      if (!state.past.length) return state;
      return {
        study: state.past.at(-1)!,
        past: state.past.slice(0, -1),
        future: [state.study, ...state.future],
      };
    case "redo":
      if (!state.future.length) return state;
      return {
        study: state.future[0],
        past: [...state.past, state.study],
        future: state.future.slice(1),
      };
    case "reset":
      return { study: action.study, past: [], future: [] };
  }
}

/** A mesh depends only on the geometry and the element size. */
export const meshStillValid = (before: Study, after: Study) =>
  before.meshSize === after.meshSize;

/**
 * Upper end of the yield-margin color scale. Parts that yield keep the 0–5
 * range; safer parts get a range that still shows variation across them.
 */
export function marginScale(minSafety: number | null) {
  const target = Math.max(5, 2 * (minSafety || 0));
  for (let power = 1; ; power *= 10)
    for (const m of [1, 2, 5]) if (m * power >= target) return m * power;
}

/** Edits a property. A preset becomes "Custom material"; a typed name stays. */
export function editMaterial(
  material: Material,
  changes: Partial<Material>,
  presets: string[],
): Material {
  return {
    ...material,
    ...changes,
    name: presets.includes(material.name) ? "Custom material" : material.name,
  };
}

/** Planes facing a global axis are easiest to find by their position on it. */
export function faceHint(
  face: Face,
  length: (mm: number) => string = (mm) => fmt(mm, 1),
) {
  const axis = face.normal.findIndex((n) => Math.abs(n) > 0.999);
  return face.type === "Plane" && axis >= 0
    ? `Plane · ${"xyz"[axis]} ${length(face.center[axis])}`
    : face.type;
}

export type Draft =
  | { kind: "support"; value: Support }
  | { kind: "load"; value: Load }
  | { kind: "mass"; value: PointMass }
  | { kind: "thermal"; value: ThermalCondition }
  | { kind: "bolt"; value: Bolt };

/** The study as it would be if the draft condition were saved now. */
export function previewStudy(
  study: Study,
  draft: Draft | null,
  selected: number[],
): Study {
  if (!draft) return study;
  return {
    ...study,
    [LISTS[draft.kind]]: [
      ...conditionsOf(study, draft.kind).filter((c) => c.id !== draft.value.id),
      { ...draft.value, faces: selected },
    ],
  };
}

export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as any)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as any)[k] !== undefined);
  return (
    ka.length === kb.length &&
    ka.every((k) => sameValue((a as any)[k], (b as any)[k]))
  );
}

/** Results embedded in a project: the engine's view file in base64. */
export type SavedResults = {
  hash: string;
  study: Study;
  mesh: MeshInfo;
  result: ResultInfo;
  view: string;
};

/**
 * Results saved in a project are shown again only for the same geometry and
 * study. The caller still decodes `view`, which checks the arrays.
 */
export function restoreResults(
  saved: unknown,
  hash: string,
  study: Study,
): Omit<SavedResults, "hash" | "study"> | null {
  if (!saved || typeof saved !== "object") return null;
  const s = saved as Partial<SavedResults>;
  if (
    s.hash !== hash ||
    !s.study ||
    !sameValue(normalizeStudy(s.study), normalizeStudy(study))
  )
    return null;
  if (
    typeof s.view !== "string" ||
    !s.mesh?.elementCount ||
    !s.result?.summary ||
    !Array.isArray(s.result.warnings)
  )
    return null;
  return { mesh: s.mesh, result: normalizeResult(s.result), view: s.view };
}

/** Next focus position for arrow-key navigation in a vertical list. */
export function moveFocus(key: string, index: number, count: number) {
  if (!count) return null;
  if (key === "ArrowDown") return Math.min(count - 1, index + 1);
  if (key === "ArrowUp") return Math.max(0, index - 1);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}
