import { spawnSync } from "node:child_process";
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status || 1);
};
run(process.platform === "win32" ? "python" : "python3", [
  "-m",
  "venv",
  ".venv",
]);
const python =
  process.platform === "win32"
    ? ".venv/Scripts/python.exe"
    : ".venv/bin/python";
run(python, ["-m", "pip", "install", "-r", "engine/requirements.txt"]);
run(process.execPath, ["scripts/fetch-vtk-wasm.mjs"]);
console.log(
  "STEP mesher and VTK.wasm viewer ready. Install CalculiX (ccx) or set SPRUNG_FEA_CCX. On Mac: brew install costerwi/calculix/calculix-ccx",
);
