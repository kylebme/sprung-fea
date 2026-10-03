// Pure study logic. Only type imports, so Node can run the unit tests directly.
import type {
  Face,
  Load,
  Material,
  Mesh,
  Result,
  Study,
  Support,
} from "./types";

export function fmt(n: number, digits = 3) {
  return !Number.isFinite(n)
    ? "—"
    : Math.abs(n) > 0 && (Math.abs(n) < 0.001 || Math.abs(n) >= 1e6)
      ? n.toExponential(2)
      : new Intl.NumberFormat("en-US", {
          maximumFractionDigits: digits,
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
export function faceHint(face: Face) {
  const axis = face.normal.findIndex((n) => Math.abs(n) > 0.999);
  return face.type === "Plane" && axis >= 0
    ? `Plane · ${"xyz"[axis]} ${fmt(face.center[axis], 1)}`
    : face.type;
}

export type Draft =
  { kind: "support"; value: Support } | { kind: "load"; value: Load };

/** The study as it would be if the draft condition were saved now. */
export function previewStudy(
  study: Study,
  draft: Draft | null,
  selected: number[],
): Study {
  if (!draft) return study;
  const key = draft.kind === "support" ? "supports" : "loads";
  return {
    ...study,
    [key]: [
      ...(study[key] as (Support | Load)[]).filter(
        (c) => c.id !== draft.value.id,
      ),
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

export type SavedResults = {
  hash: string;
  study: Study;
  mesh: Mesh;
  result: Result;
};

/**
 * Results saved in a project are shown again only for the same geometry and
 * study, and only if their arrays are consistent.
 */
export function restoreResults(
  saved: unknown,
  hash: string,
  study: Study,
): { mesh: Mesh; result: Result } | null {
  if (!saved || typeof saved !== "object") return null;
  const s = saved as Partial<SavedResults>;
  if (s.hash !== hash || !sameValue(s.study, study)) return null;
  const n = s.mesh?.surface?.nodeIds?.length;
  const r = s.result;
  if (
    !n ||
    !r ||
    s.mesh!.surface.positions?.length !== n * 3 ||
    r.stress?.length !== n ||
    r.movement?.length !== n ||
    r.displacements?.length !== n ||
    !r.summary
  )
    return null;
  return { mesh: s.mesh!, result: r };
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
