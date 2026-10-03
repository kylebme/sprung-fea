import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "../server/index.mjs";
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
