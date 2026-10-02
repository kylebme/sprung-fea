import { test, expect } from "@playwright/test";
import path from "node:path";
import fs from "node:fs/promises";
test("complete study, real contours, probe, refine, save, reopen, and invalidate", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:5173");
  await page.screenshot({ path: "output/playwright/welcome.png" });
  await page
    .getByRole("button", {
      name: "Cantilever beam A simple, verifiable first study",
    })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your part, ready." }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Choose a material", exact: true })
    .click();
  await page.getByRole("button", { name: /Aluminum 6061-T6/ }).click();
  await page.getByRole("button", { name: "Use this material" }).click();
  await page.getByRole("button", { name: "Add support", exact: true }).click();
  await page.getByRole("button", { name: /^Face 1\b/ }).click();
  await page.getByRole("button", { name: "Save support" }).click();
  await page.getByRole("button", { name: /Loads Apply a load/ }).click();
  await page.getByRole("button", { name: "Add load", exact: true }).click();
  await page.getByRole("button", { name: /^Face 2\b/ }).click();
  await page.getByLabel("Z force", { exact: true }).fill("-100");
  await page.getByRole("button", { name: "Save load" }).click();
  await page.getByRole("button", { name: /Mesh Balanced/ }).click();
  await page.getByRole("button", { name: "Preview mesh" }).click();
  await expect(
    page.getByText("Minimum quality", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Run analysis", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "A clearer picture." }),
  ).toBeVisible({ timeout: 60000 });
  await expect(
    page.getByRole("button", { name: /Largest movement/ }),
  ).toContainText("0.288");
  await page.screenshot({ path: "output/playwright/stress.png" });
  await page.getByLabel("Shape display").selectOption("auto");
  await expect(page.getByText(/Movement shown at/)).toBeVisible();
  const canvas = page.locator("canvas");
  const box = await canvas.boundingBox();
  await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);
  await expect(page.locator(".probe-card")).toContainText("Node ");
  await page.getByRole("button", { name: "Compare with a finer mesh" }).click();
  await expect(
    page.getByText("Refinement comparison", { exact: true }),
  ).toBeVisible({ timeout: 60000 });
  await page.screenshot({ path: "output/playwright/refined.png" });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const download = await downloadPromise;
  await download.saveAs("output/playwright/beam.bsim");
  await page.reload();
  await page
    .locator('input[type=file][accept=".bsim"]')
    .setInputFiles(path.resolve("output/playwright/beam.bsim"));
  await expect(
    page.getByRole("heading", { name: "Your part, ready." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Supports 1 defined/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Loads 1 defined/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Mesh Custom/ }).click();
  await page.getByRole("button", { name: "Run analysis", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "A clearer picture." }),
  ).toBeVisible({ timeout: 60000 });
  await page.getByRole("button", { name: /Material Aluminum/ }).click();
  await page.getByRole("button", { name: /Structural steel/ }).click();
  await page.getByRole("button", { name: "Use this material" }).click();
  await expect(
    page.getByRole("button", { name: /Results Run to see results/ }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Undo study edit" }).click();
  await expect(
    page.getByRole("button", { name: /Material Aluminum/ }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test("invalid STEP reports an actionable import error", async ({ page }) => {
  await page.goto("http://127.0.0.1:5173");
  await page.locator('input[type=file][accept=".step,.stp"]').setInputFiles({
    name: "broken.step",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("not a STEP solid"),
  });
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Understand your part. Build with confidence.",
    }),
  ).toBeVisible();
});

for (const name of [
  "bearing-block",
  "ribbed-bracket",
  "pocketed-housing",
  "tube-elbow",
]) {
  test(`complex STEP: ${name}, semantic surfaces, solve, probe and refine`, async ({
    page,
  }) => {
    test.setTimeout(180000);
    const { configureComplexPart } = await import("./complex-workflow.mjs");
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("http://127.0.0.1:5173");
    const geometry = await configureComplexPart(page, name);
    expect(geometry.faces.length).toBeGreaterThanOrEqual(10);
    await page
      .getByRole("button", { name: "Preview mesh", exact: true })
      .click();
    await expect(
      page.getByText("Minimum quality", { exact: true }),
    ).toBeVisible({ timeout: 60000 });
    await page
      .getByRole("button", { name: "Run analysis", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "A clearer picture." }),
    ).toBeVisible({ timeout: 90000 });
    await page.getByRole("button", { name: "Show peak" }).click();
    await expect(page.locator(".probe-card")).toContainText("Node ");
    await page.getByLabel("Shape display").selectOption("auto");
    await page.screenshot({ path: `output/playwright/${name}.png` });
    await page
      .getByRole("button", { name: "Compare with a finer mesh" })
      .click();
    await expect(
      page.getByText("Refinement comparison", { exact: true }),
    ).toBeVisible({ timeout: 90000 });
    await page.screenshot({ path: `output/playwright/${name}-refined.png` });
    expect(errors).toEqual([]);
  });
}

test("curved pressure: select inner torus and verify projected-area reactions in UI", async ({
  page,
}) => {
  const { configureComplexPart } = await import("./complex-workflow.mjs");
  await page.goto("http://127.0.0.1:5173");
  const geo = await configureComplexPart(page, "tube-elbow");
  const torus = geo.faces
    .filter((f) => f.type === "Torus")
    .sort((a, b) => a.area - b.area)[0].id;
  await page.getByRole("button", { name: /Loads 1 defined/ }).click();
  await page.getByRole("button", { name: /Applied force Face/ }).click();
  await page.getByRole("button", { name: "Pressure", exact: true }).click();
  await page
    .getByRole("button", { name: "Clear selection", exact: true })
    .click();
  await page
    .getByRole("button", { name: new RegExp(`^Face ${torus}\\b`) })
    .click();
  await page.getByLabel(/^Pressure/).fill("1");
  await page.getByRole("button", { name: "Save load" }).click();
  await page.getByRole("button", { name: /Mesh Custom/ }).click();
  await page.getByRole("button", { name: "Run analysis", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "A clearer picture." }),
  ).toBeVisible({ timeout: 60000 });
  await page.getByText("How to interpret this result", { exact: true }).click();
  const rx = page
    .locator(".property-row")
    .filter({ hasText: "Support reaction X" });
  const ry = page
    .locator(".property-row")
    .filter({ hasText: "Support reaction Y" });
  expect(
    Number((await rx.locator("b").innerText()).replace(" N", "")),
  ).toBeCloseTo(-Math.PI * 49, 0);
  expect(
    Number((await ry.locator("b").innerText()).replace(" N", "")),
  ).toBeCloseTo(-Math.PI * 49, 0);
  await page.screenshot({ path: "output/playwright/toroidal-pressure.png" });
});
