// Installs the pinned VTK.wasm runtime into public/vtk-wasm. The app runs
// offline, so the runtime is served by the local service, not a CDN.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Kitware's package registry keeps versioned nightlies. Loader 3.x needs the
// per-class method manifests (types/*.json), which the 9.7.1 release bundle
// lacks, so a nightly is pinned by version and content hash instead.
const VERSION = "9.7.20260927";
const SHA256 =
  "63252b799e8c44dfb149f329c94f9f6715c78b654292f18cce067c9d080a2e92";
const URL = `https://gitlab.kitware.com/api/v4/projects/13/packages/generic/vtk-wasm32-emscripten/${VERSION}/vtk-${VERSION}-wasm32-emscripten.tar.gz`;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "public", "vtk-wasm");
const stamp = path.join(target, "VERSION");

const current = await fs.readFile(stamp, "utf8").catch(() => "");
if (current.trim() === `${VERSION} ${SHA256}`) {
  console.log(`VTK.wasm ${VERSION} already installed.`);
  process.exit(0);
}

console.log(`Downloading VTK.wasm ${VERSION} (13 MB)…`);
const response = await fetch(URL);
if (!response.ok) throw Error(`Download failed: HTTP ${response.status}`);
const archive = Buffer.from(await response.arrayBuffer());
const digest = createHash("sha256").update(archive).digest("hex");
if (digest !== SHA256)
  throw Error(`VTK.wasm checksum mismatch: expected ${SHA256}, got ${digest}`);

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "sprung-fea-vtk-"));
try {
  await fs.writeFile(path.join(temp, "bundle.tar.gz"), archive);
  const tar = spawnSync("tar", ["-xzf", "bundle.tar.gz"], { cwd: temp });
  if (tar.status !== 0)
    throw Error("Could not extract VTK.wasm: " + tar.stderr);

  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(target, { recursive: true });
  for (const file of ["vtkWebAssembly.mjs", "vtkWebAssembly.wasm"])
    await fs.copyFile(path.join(temp, file), path.join(target, file));

  // Served loose (not as the .tar.gz), the loader reads one merged method
  // index instead of 846 per-class manifests.
  const types = path.join(temp, "types");
  const index = {};
  for (const file of await fs.readdir(types)) {
    if (!file.endsWith(".json")) continue;
    const manifest = JSON.parse(await fs.readFile(path.join(types, file)));
    const methods = {};
    for (const [name, info] of Object.entries(manifest.methods || {}))
      methods[name] = info?.maySuspend ? 1 : 0;
    index[manifest.title || file.slice(0, -5)] = {
      inherits: manifest.inherits || undefined,
      methods,
    };
  }
  await fs.writeFile(
    path.join(target, "vtk-methods.json"),
    JSON.stringify(index),
  );

  await fs.writeFile(stamp, `${VERSION} ${SHA256}\n`);
  console.log(`VTK.wasm ${VERSION} installed in public/vtk-wasm.`);
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
