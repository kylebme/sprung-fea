import { _electron as electron, expect } from "@playwright/test";
import path from "node:path";
import { configureComplexPart } from "./complex-workflow.mjs";
const executable = path.resolve(
  "release/mac-arm64/Sprung FEA.app/Contents/MacOS/Sprung FEA",
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
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(page.getByRole("heading", { name: "Sprung FEA" })).toBeVisible();
  await page.getByRole("button", { name: /^Cantilever beam.*Open$/ }).click();
  await expect(
    page.getByRole("heading", { name: "Cantilever beam" }),
  ).toBeVisible({ timeout: 30000 });
  await page.getByRole("button", { name: "Use example setup" }).click();
  await inspector.getByRole("button", { name: "Solve", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "von Mises stress" }),
  ).toBeVisible({ timeout: 60000 });
  await page.getByRole("button", { name: "Displacement", exact: true }).click();
  await expect(inspector.locator(".big")).toContainText("0.288");
  await page.getByRole("button", { name: "Show in view" }).click();
  await expect(page.locator(".probe-card")).toContainText("Node");
  // VTK.wasm runs inside the packaged app under the service's CSP.
  await page.getByRole("switch", { name: "Section" }).click();
  await expect(page.locator(".filters")).toContainText(
    /Section area\s*200\s*mm²/,
  );
  await page.screenshot({ path: "output/playwright/desktop.png" });
  await page.getByRole("switch", { name: "Section" }).click();
  // Edit > Undo reaches the study history, and text fields keep text undo.
  const menu = (id) =>
    app.evaluate(({ Menu }, id) => {
      Menu.getApplicationMenu().getMenuItemById(id).click();
    }, id);
  await page.getByRole("button", { name: /^Material\s*Aluminum/ }).click();
  await page.getByRole("button", { name: /Structural steel/ }).click();
  await page.getByRole("button", { name: "Apply material" }).click();
  await expect(
    page.getByRole("button", { name: /^Material\s*Structural steel/ }),
  ).toBeVisible();
  await menu("undo");
  await expect(
    page.getByRole("button", { name: /^Material\s*Aluminum/ }),
  ).toBeVisible();
  await menu("redo");
  await expect(
    page.getByRole("button", { name: /^Material\s*Structural steel/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Material\s*Structural/ }).click();
  const name = page.getByLabel("Name", { exact: true });
  await name.click();
  await page.keyboard.type("X");
  await expect(name).toHaveValue("Structural steelX");
  await menu("undo");
  await expect(name).toHaveValue("Structural steel");
  await expect(
    page.getByRole("button", { name: /^Material\s*Structural steel/ }),
  ).toBeVisible();
  for (const name of [
    "bearing-block",
    "ribbed-bracket",
    "pocketed-housing",
    "tube-elbow",
  ]) {
    await configureComplexPart(page, name);
    await inspector.getByRole("button", { name: "Solve", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "von Mises stress" }),
    ).toBeVisible({ timeout: 90000 });
    await page.getByRole("button", { name: "Show in view" }).click();
    await expect(page.locator(".probe-card")).toContainText("Node");
    await page.screenshot({ path: `output/playwright/desktop-${name}.png` });
  }
  const health = await page.evaluate(
    async () => await (await fetch("/api/health")).json(),
  );
  if (!health.engine) throw Error("Bundled engine not available");
  if (errors.length) throw Error(errors.join("\n"));
  console.log(
    "Packaged desktop acceptance passed: beam plus four complex STEP solids, bundled CalculiX solves, VTK.wasm contours and section, peak probes, no Python/Homebrew on PATH.",
  );
} finally {
  await app.close();
}
