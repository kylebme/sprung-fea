import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "../server/index.mjs";
import { decodeView, range } from "../src/viewData.ts";
const request = async (base, url, body) => {
  const response = await fetch(
    base + url,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {},
  );
  const data = await response.json();
  if (!response.ok) throw Error(data.error);
  return data;
};
const wait = async (base, id) => {
  for (let i = 0; i < 200; i++) {
    const j = await request(base, "/api/jobs/" + id);
    if (j.status === "done") return j.data;
    if (j.status === "error") throw Error(j.error);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Job timed out");
};
test("STEP → portable project → reopen → real solve → export", async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "sprung-fea-server-test-"),
  );
  // Development keeps documents under .sprung-fea/: downloads must still work
  // from a hidden folder.
  const service = await createServer({
    port: 0,
    dataDir: path.join(dir, ".sprung-fea"),
  });
  const base = `http://127.0.0.1:${service.port}`;
  try {
    const imported = await request(base, "/api/sample/beam", {});
    const geo = await wait(base, imported.job);
    assert.equal(geo.faces.length, 6);
    const study = {
      analysis: "static",
      material: {
        name: "Aluminum",
        young: 68900,
        poisson: 0.33,
        density: 2700,
        yield: 276,
      },
      supports: [
        {
          id: "held",
          name: "Held in place",
          faces: [1],
          axes: [true, true, true],
        },
      ],
      loads: [
        {
          id: "force",
          name: "Applied force",
          kind: "force",
          faces: [2],
          vector: [0, 0, -100],
          magnitude: 1,
        },
      ],
      masses: [],
      thermal: [],
      meshSize: 4,
      detail: "medium",
      solver: "iterative-cholesky",
    };
    const project = await request(
      base,
      "/api/documents/" + imported.id + "/save",
      { name: "beam.step", study },
    );
    assert.equal(project.format, "sprung-fea");
    assert.ok(
      Buffer.from(project.step, "base64").toString().includes("ISO-10303-21"),
    );
    const opened = await request(base, "/api/open", project);
    const reopened = await wait(base, opened.job);
    assert.equal(reopened.hash, geo.hash);
    assert.deepEqual(opened.study, study);
    const { solver, analysis, masses, thermal, ...older } = study;
    const legacy = await request(base, "/api/open", {
      ...project,
      study: { ...older, detail: "balanced" },
    });
    assert.equal(legacy.study.detail, "medium");
    // Studies from before solver choice used the direct solver, and studies
    // from before analysis types were linear static.
    assert.equal(legacy.study.solver, "spooles");
    assert.equal(legacy.study.analysis, "static");
    assert.deepEqual(legacy.study.masses, []);
    assert.deepEqual(legacy.study.thermal, []);
    const unknown = await fetch(base + "/api/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...project,
        study: { ...study, analysis: "cfd" },
      }),
    });
    assert.equal(unknown.status, 400);
    await wait(base, legacy.job);
    const { cpus } = await request(base, "/api/health");
    assert.ok(cpus.logical >= cpus.performance && cpus.performance >= 1);
    const tooMany = await fetch(
      `${base}/api/documents/${opened.id}/solve?threads=${cpus.logical + 1}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(study),
      },
    );
    assert.equal(tooMany.status, 400);
    const solving = await request(
      base,
      "/api/documents/" + opened.id + "/solve?threads=" + cpus.logical,
      study,
    );
    const data = await wait(base, solving.job);
    assert.equal(data.result.threads, cpus.logical);
    assert.ok(
      data.result.summary.maxMovement > 0.28 &&
        data.result.summary.maxMovement < 0.3,
    );
    // The viewer's binary contract: the client decoder reads what the
    // engine wrote, and its fields agree with the solver summary.
    assert.equal(data.result.stress, undefined);
    // Result schema 2: one frame, its fields, and generic check rows.
    assert.equal(data.result.version, 2);
    assert.equal(data.result.analysis, "static");
    assert.deepEqual(data.result.fields, [
      "displacement",
      "vonMises",
      "principalMax",
      "principalMin",
      "shear",
      "strain",
      "strainMax",
      "strainMin",
    ]);
    assert.equal(data.result.frames.length, 1);
    assert.ok(
      data.result.checks.some(
        (c) => c.label === "Force balance error" && c.values[0] < 1,
      ),
    );
    assert.match(data.result.solver, /incomplete Cholesky/);
    assert.ok(data.result.iterations > 0);
    const response = await fetch(
      base + "/api/documents/" + opened.id + "/view",
    );
    assert.equal(
      response.headers.get("content-type"),
      "application/octet-stream",
    );
    const view = decodeView(await response.arrayBuffer());
    assert.equal(view.nodeIds.length, data.mesh.nodeCount);
    assert.equal(view.tets.length / 10, data.mesh.elementCount);
    assert.deepEqual(
      [...new Set(view.triangleFaces)].sort(),
      [1, 2, 3, 4, 5, 6],
    );
    assert.equal(view.frames.length, 1);
    assert.equal(
      range(view.fields.vonMises).max,
      data.result.summary.maxStress,
    );
    assert.equal(view.displacement.length, data.mesh.nodeCount * 3);
    const csp = response.headers.get("content-security-policy");
    assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
    const deck = await (
      await fetch(base + "/api/documents/" + opened.id + "/export/deck")
    ).text();
    assert.ok(deck.includes("TYPE=C3D10"));
    assert.ok(deck.includes("*CLOAD"));
    assert.ok(deck.includes("*STATIC, SOLVER=ITERATIVE CHOLESKY"));
    // A convergence study: options travel as query parameters.
    const badRuns = await fetch(
      `${base}/api/documents/${opened.id}/converge?runs=9`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(study),
      },
    );
    assert.equal(badRuns.status, 400);
    const converging = await request(
      base,
      `/api/documents/${opened.id}/converge?runs=2&tolerance=0.05`,
      { ...study, solver: "spooles" },
    );
    const converged = await wait(base, converging.job);
    const history = converged.result.convergence;
    assert.equal(history.meshes.length, 2);
    assert.equal(history.tolerance, 0.05);
    assert.equal(converged.mesh.elementCount, history.meshes[1].elementCount);
    assert.deepEqual(
      converged.result.keys.map((k) => k.id),
      ["maxMovement", "maxStress"],
    );
    // A vibration study: no loads needed, modes come back as frames.
    const modal = { ...study, analysis: "frequency", modes: 3, loads: [] };
    const manyModes = await fetch(`${base}/api/documents/${opened.id}/solve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...modal, modes: 80 }),
    });
    assert.equal(manyModes.status, 400);
    const vibrating = await wait(
      base,
      (await request(base, `/api/documents/${opened.id}/solve`, modal)).job,
    );
    assert.equal(vibrating.result.analysis, "frequency");
    assert.deepEqual(
      vibrating.result.frames.map((f) => f.label),
      ["Mode 1", "Mode 2", "Mode 3"],
    );
    assert.ok(Math.abs(vibrating.result.frames[0].value / 816 - 1) < 0.02);
    const modeView = decodeView(
      await (
        await fetch(`${base}/api/documents/${opened.id}/view`)
      ).arrayBuffer(),
    );
    assert.equal(modeView.frames.length, 3);
    assert.ok(modeView.frames[2].displacement.length > 0);
    const foreign = await fetch(base + "/api/sample/beam", {
      method: "POST",
      headers: { Origin: "https://unrelated.example" },
    });
    assert.equal(foreign.status, 403);
    const invalid = await fetch(base + "/api/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        format: "sprung-fea",
        version: 1,
        step: "broken",
        study: {},
      }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("recovery on disk, error statuses, and document pruning", async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "sprung-fea-server-test-"),
  );
  const stale = path.join(dir, "00000000-0000-4000-8000-000000000000");
  await fs.mkdir(stale);
  const old = new Date(Date.now() - 30 * 24 * 3600000);
  await fs.utimes(stale, old, old);
  const service = await createServer({ port: 0, dataDir: dir });
  const base = `http://127.0.0.1:${service.port}`;
  try {
    const imported = await request(base, "/api/sample/beam", {});
    assert.equal(imported.sample, "beam");
    const geo = await wait(base, imported.job);
    assert.equal(await request(base, "/api/recovery"), null);
    const study = {
      material: null,
      supports: [],
      loads: [],
      meshSize: geo.recommendedSize,
      detail: "medium",
    };
    const saved = await request(base, "/api/recovery", {
      id: imported.id,
      name: "Cantilever beam.step",
      study,
      sample: "beam",
    });
    assert.ok(saved.at > 0);
    const meta = await request(base, "/api/recovery");
    assert.equal(meta.name, "Cantilever beam.step");
    const restored = await request(base, "/api/recovery/open", {});
    assert.equal(restored.sample, "beam");
    assert.deepEqual(restored.study, {
      ...study,
      solver: "spooles",
      analysis: "static",
      masses: [],
      thermal: [],
    });
    assert.equal((await wait(base, restored.job)).hash, geo.hash);

    const post = (url, body) =>
      fetch(base + url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const invalid = await post(`/api/documents/${imported.id}/solve`, {});
    assert.equal(invalid.status, 400);
    // Remote forces need their point, rotations their axis and speed.
    for (const load of [
      { kind: "remote", faces: [2], vector: [0, 0, -1] },
      { kind: "rotation", faces: [], vector: [0, 0, 0], magnitude: 100 },
      { kind: "moment", faces: [], vector: [0, 0, 1] },
      { kind: "spring", faces: [2], vector: [0, 0, 1] },
    ]) {
      const response = await post(`/api/documents/${imported.id}/solve`, {
        ...study,
        loads: [{ id: "l", name: "Load", magnitude: 0, ...load }],
      });
      assert.equal(response.status, 400, load.kind);
    }
    // Assemblies: the bonded example has two bodies, and body materials
    // must name bodies by number.
    const assembly = await request(base, "/api/sample/post-plate", {});
    const assemblyGeometry = await wait(base, assembly.job);
    assert.equal(assembly.name, "Post on plate.step");
    assert.deepEqual(
      assemblyGeometry.bodies.map((b) => b.name),
      ["Body 1", "Body 2"],
    );
    assert.deepEqual(assemblyGeometry.components, [[1, 2]]);
    const badBody = await post(`/api/documents/${imported.id}/solve`, {
      ...study,
      bodyMaterials: { first: study.material },
    });
    assert.equal(badBody.status, 400);
    // Harmonic settings: an ordered range, damping below critical, and a
    // known excitation.
    for (const harmonic of [
      { min: 500, max: 100, damping: 0.02, excitation: "loads" },
      { min: 10, max: 100, damping: 1.5, excitation: "loads" },
      { min: 10, max: 100, damping: 0.02, excitation: "wind" },
    ]) {
      const response = await post(`/api/documents/${imported.id}/solve`, {
        ...study,
        analysis: "harmonic",
        harmonic,
      });
      assert.equal(response.status, 400, JSON.stringify(harmonic));
    }
    const notBoolean = await post(`/api/documents/${imported.id}/solve`, {
      ...study,
      largeDeformation: "yes",
    });
    assert.equal(notBoolean.status, 400);
    // Thermal conditions need a known kind, faces, and a positive film
    // coefficient for convection.
    for (const condition of [
      { kind: "conduction", faces: [2], value: 1 },
      { kind: "radiation", faces: [2], value: 1.5, ambient: 20 },
      { kind: "temperature", faces: [], value: 20 },
      { kind: "convection", faces: [2], value: -5, ambient: 20 },
    ]) {
      const response = await post(`/api/documents/${imported.id}/solve`, {
        ...study,
        analysis: "thermal",
        thermal: [{ id: "t", name: "Heat", ...condition }],
      });
      assert.equal(response.status, 400, condition.kind);
    }
    // Support types, time settings and material tables are checked too.
    const aluminum = {
      name: "Aluminum",
      young: 68900,
      poisson: 0.33,
      density: 2700,
      yield: 276,
    };
    const held = {
      id: "s",
      name: "Held",
      faces: [1],
      axes: [true, true, true],
    };
    const valid = { ...study, material: aluminum, supports: [held] };
    for (const changes of [
      { supports: [{ ...held, frame: "sideways" }] },
      { transient: { on: true, duration: -5, start: 20 } },
      { preload: "yes" },
      { material: { ...aluminum, hardening: [[5]] } },
      { material: { ...aluminum, byTemperature: [{ young: 1 }] } },
      { contact: "on" },
      { contacts: [{ id: "1-2", kind: "glued" }] },
      { contacts: [{ id: "1-2", kind: "frictional", friction: 3 }] },
      { bolts: [{ id: "b", name: "Bolt", faces: [2], preload: 0 }] },
    ]) {
      const response = await post(`/api/documents/${imported.id}/solve`, {
        ...valid,
        ...changes,
      });
      assert.equal(response.status, 400, JSON.stringify(changes));
    }
    // Point masses need a positive mass, a center and faces.
    for (const mass of [
      { faces: [2], mass: 0, point: [0, 0, 0] },
      { faces: [], mass: 1, point: [0, 0, 0] },
      { faces: [2], mass: 1, point: [0, 0] },
    ]) {
      const response = await post(`/api/documents/${imported.id}/solve`, {
        ...study,
        masses: [{ id: "m", name: "Mass", ...mass }],
      });
      assert.equal(response.status, 400, JSON.stringify(mass));
    }
    const missing = await post(
      "/api/documents/11111111-1111-4111-8111-111111111111/solve",
      study,
    );
    assert.equal(missing.status, 404);
    assert.doesNotMatch((await missing.json()).error, /\//);
    const noView = await fetch(`${base}/api/documents/${imported.id}/view`);
    assert.equal(noView.status, 404);
    const noDeck = await fetch(
      `${base}/api/documents/${imported.id}/export/deck`,
    );
    assert.equal(noDeck.status, 404);
    const malformed = await fetch(base + "/api/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    assert.equal(malformed.status, 400);
    const step = Buffer.alloc(48 * 1024 * 1024, 32);
    step.write("ISO-10303-21;");
    const large = await post("/api/open", {
      format: "sprung-fea",
      version: 1,
      name: "large.step",
      step: step.toString("base64"),
      study,
    });
    assert.equal(large.status, 200);
    await fetch(`${base}/api/jobs/${(await large.json()).job}`, {
      method: "DELETE",
    });
    await assert.rejects(fs.access(stale));
    await fs.access(path.join(dir, imported.id));
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
