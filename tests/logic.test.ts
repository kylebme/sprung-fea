// Invariants that the browser tests can't isolate: undo history and the
// guard that keeps stale results from being shown for a changed study.
import { test } from "node:test";
import assert from "node:assert/strict";
import { history, restoreResults, HISTORY_LIMIT } from "../src/logic.ts";

const study = (meshSize: number) => ({
  material: null,
  supports: [],
  loads: [],
  meshSize,
  detail: "custom" as const,
});

test("undo and redo retrace edits exactly, and a new edit clears redo", () => {
  let h = history(
    { study: study(0), past: [], future: [] },
    { type: "reset", study: study(1) },
  );
  for (let i = 2; i <= 4; i++)
    h = history(h, { type: "edit", study: study(i) });
  h = history(h, { type: "undo" });
  h = history(h, { type: "undo" });
  assert.equal(h.study.meshSize, 2);
  h = history(h, { type: "redo" });
  assert.equal(h.study.meshSize, 3);
  h = history(h, { type: "edit", study: study(9) });
  assert.equal(h.future.length, 0);
  assert.equal(history(h, { type: "redo" }), h);
  for (let i = 0; i < HISTORY_LIMIT + 10; i++)
    h = history(h, { type: "edit", study: study(100 + i) });
  assert.equal(h.past.length, HISTORY_LIMIT);
});

test("saved results are restored only for the same geometry and study", () => {
  const s = study(2);
  const saved = {
    hash: "abc",
    study: s,
    mesh: {
      surface: { positions: [0, 0, 0, 1, 1, 1], nodeIds: [1, 2], faces: [] },
      size: 2,
      nodeCount: 2,
      elementCount: 1,
      minQuality: 0.5,
    },
    result: {
      displacements: [
        [0, 0, 0],
        [0, 0, 1],
      ],
      stress: [1, 2],
      movement: [0, 1],
      summary: {},
    },
  };
  assert.ok(restoreResults(saved, "abc", { ...s }));
  assert.equal(restoreResults(saved, "other", s), null);
  assert.equal(restoreResults(saved, "abc", study(3)), null);
  assert.equal(
    restoreResults(
      { ...saved, result: { ...saved.result, stress: [1] } },
      "abc",
      s,
    ),
    null,
  );
  assert.equal(restoreResults(undefined, "abc", s), null);
});
