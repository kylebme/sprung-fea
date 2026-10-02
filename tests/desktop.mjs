import { _electron as electron, expect } from "@playwright/test";
import path from "node:path";
import { configureComplexPart } from "./complex-workflow.mjs";
const executable = path.resolve(
  "release/mac-arm64/BetterSim.app/Contents/MacOS/BetterSim",
);
const app = await electron.launch({
  executablePath: executable,
  timeout: 60000,
  env: { ...process.env, PATH: "/usr/bin:/bin" },
});
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(
    page.getByRole("heading", {
      name: "Understand your part. Build with confidence.",
    }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Cantilever beam A simple, verifiable first study",
    })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your part, ready." }),
  ).toBeVisible({ timeout: 30000 });
  await page.getByRole("button", { name: "Use example setup" }).click();
  await page.getByRole("button", { name: "Run analysis", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "A clearer picture." }),
  ).toBeVisible({ timeout: 60000 });
  await expect(
    page.getByRole("button", { name: /Largest movement/ }),
  ).toContainText("0.288");
  await page.getByRole("button", { name: "Show peak" }).click();
  await expect(page.locator(".probe-card")).toContainText("Node ");
  await page.screenshot({ path: "output/playwright/desktop.png" });
  for (const name of [
    "bearing-block",
    "ribbed-bracket",
    "pocketed-housing",
    "tube-elbow",
  ]) {
    await configureComplexPart(page, name);
    await page
      .getByRole("button", { name: "Run analysis", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "A clearer picture." }),
    ).toBeVisible({ timeout: 90000 });
    await page.getByRole("button", { name: "Show peak" }).click();
    await expect(page.locator(".probe-card")).toContainText("Node ");
    await page.screenshot({ path: `output/playwright/desktop-${name}.png` });
  }
  const health = await page.evaluate(
    async () => await (await fetch("/api/health")).json(),
  );
  if (!health.engine) throw Error("Bundled engine not available");
  if (errors.length) throw Error(errors.join("\n"));
  console.log(
    "Packaged desktop acceptance passed: beam plus four complex STEP solids, bundled CalculiX solves, contours and peak probes, no Python/Homebrew on PATH.",
  );
} finally {
  await app.close();
}
