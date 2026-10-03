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
    path.join(os.tmpdir(), "bettersim-server-test-"),
  );
  const service = await createServer({ port: 0, dataDir: dir });
  const base = `http://127.0.0.1:${service.port}`;
  try {
    const imported = await request(base, "/api/sample/beam", {});
    const geo = await wait(base, imported.job);
    assert.equal(geo.faces.length, 6);
    const study = {
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
      meshSize: 4,
      detail: "medium",
    };
    const project = await request(
      base,
      "/api/documents/" + imported.id + "/save",
      { name: "beam.step", study },
    );
    assert.equal(project.format, "bettersim");
    assert.ok(
      Buffer.from(project.step, "base64").toString().includes("ISO-10303-21"),
    );
    const opened = await request(base, "/api/open", project);
    const reopened = await wait(base, opened.job);
    assert.equal(reopened.hash, geo.hash);
    assert.deepEqual(opened.study, study);
    const legacy = await request(base, "/api/open", {
      ...project,
      study: { ...study, detail: "balanced" },
    });
    assert.equal(legacy.study.detail, "medium");
    await wait(base, legacy.job);
    const solving = await request(
      base,
      "/api/documents/" + opened.id + "/solve",
      study,
    );
    const data = await wait(base, solving.job);
    assert.ok(
      data.result.summary.maxMovement > 0.28 &&
        data.result.summary.maxMovement < 0.3,
    );
    // The viewer's binary contract: the client decoder reads what the
    // engine wrote, and its fields agree with the solver summary.
    assert.equal(data.result.stress, undefined);
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
    assert.equal(range(view.vonMises).max, data.result.summary.maxStress);
    const csp = response.headers.get("content-security-policy");
    assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
    const deck = await (
      await fetch(base + "/api/documents/" + opened.id + "/export/deck")
    ).text();
    assert.ok(deck.includes("TYPE=C3D10"));
    assert.ok(deck.includes("*CLOAD"));
    const foreign = await fetch(base + "/api/sample/beam", {
      method: "POST",
      headers: { Origin: "https://unrelated.example" },
    });
    assert.equal(foreign.status, 403);
    const invalid = await fetch(base + "/api/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        format: "bettersim",
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
    path.join(os.tmpdir(), "bettersim-server-test-"),
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
    assert.deepEqual(restored.study, study);
    assert.equal((await wait(base, restored.job)).hash, geo.hash);

    const post = (url, body) =>
      fetch(base + url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const invalid = await post(`/api/documents/${imported.id}/solve`, {});
    assert.equal(invalid.status, 400);
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
      format: "bettersim",
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
