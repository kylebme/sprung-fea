import { spawnSync } from "node:child_process";
if (process.platform !== "darwin") throw Error("Mac signing requires macOS.");
const appPath = "release/mac-arm64/BetterSim.app";
for (const args of [
  ["--force", "--deep", "--sign", "-", appPath],
  ["--verify", "--deep", "--strict", appPath],
]) {
  const result = spawnSync("/usr/bin/codesign", args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}
