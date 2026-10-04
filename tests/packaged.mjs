// Solves the example beam with only the packaged engine and solver, as an
// installed build would: no development Python and no system CalculiX. Run
// after npm run package:mac, package:win or package:linux.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "../server/index.mjs";
const resources = path.resolve(
  {
    darwin: "release/mac-arm64/Sprung FEA.app/Contents/Resources",
    win32: "release/win-unpacked/resources",
    linux: "release/linux-unpacked/resources",
  }[process.platform],
);
const exe = process.platform === "win32" ? ".exe" : "";
const engine = path.join(resources, "runtime", "sprung-fea-engine" + exe);
await fs.access(engine);
await fs.access(path.join(resources, "runtime", "solver", "ccx" + exe));
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
// A one-file engine unpacks itself on every start, slowly on a cold runner.
const wait = async (base, id) => {
  for (let i = 0; i < 1200; i++) {
    const j = await request(base, "/api/jobs/" + id);
    if (j.status === "done") return j.data;
    if (j.status === "error") throw Error(j.error);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw Error("Job timed out");
};
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sprung-fea-packaged-"));
const service = await createServer({
  port: 0,
  dataDir: dir,
  resourceDir: resources,
  workerExecutable: engine,
});
const base = `http://127.0.0.1:${service.port}`;
try {
  assert.equal((await request(base, "/api/health")).engine, true);
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
    solver: "spooles",
  };
  const solve = async (s) =>
    (
      await wait(
        base,
        (await request(base, `/api/documents/${imported.id}/solve`, s)).job,
      )
    ).result;
  const static_ = await solve(study);
  const movement = static_.summary.maxMovement;
  assert.ok(movement > 0.28 && movement < 0.3, `Movement ${movement} mm`);
  console.log(`Static solve: ${movement.toFixed(4)} mm tip movement`);
  const modal = await solve({
    ...study,
    analysis: "frequency",
    modes: 3,
    loads: [],
  });
  assert.equal(modal.analysis, "frequency");
  console.log("Frequency solve: ok");
} finally {
  await service.close();
  await fs.rm(dir, { recursive: true, force: true });
}
