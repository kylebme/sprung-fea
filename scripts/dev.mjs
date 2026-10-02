import { spawn } from "node:child_process";
const children = [
  spawn(process.execPath, ["--watch", "server/index.mjs"], {
    stdio: "inherit",
  }),
  spawn(process.execPath, ["node_modules/vite/bin/vite.js"], {
    stdio: "inherit",
  }),
];
if (process.argv.includes("--electron")) {
  setTimeout(
    () =>
      children.push(
        spawn("node_modules/.bin/electron", ["."], {
          stdio: "inherit",
          env: { ...process.env, BETTERSIM_DEV: "1" },
        }),
      ),
    2000,
  );
}
for (const sig of ["SIGINT", "SIGTERM"])
  process.on(sig, () => {
    for (const c of children) c.kill();
    process.exit();
  });
