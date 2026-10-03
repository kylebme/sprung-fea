import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs/promises";
const inspector = (page: Page) =>
  page.getByRole("complementary", { name: "Inspector" });
test("complete study, real contours, probe, refine, save, reopen, and invalidate", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:5173");
  await page.screenshot({ path: "output/playwright/welcome.png" });
  await page.getByRole("button", { name: /^Cantilever beam.*Open$/ }).click();
  await expect(
    page.getByRole("heading", { name: "Cantilever beam" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Set material" }).click();
  await page.getByRole("button", { name: /Aluminum 6061-T6/ }).click();
  await page.getByRole("button", { name: "Apply material" }).click();
  await inspector(page)
    .getByRole("button", { name: "Add support", exact: true })
    .click();
  await page.getByRole("button", { name: /^Face 1\b/ }).click();
  await page.getByRole("button", { name: "Save support" }).click();
  await page.getByRole("button", { name: "Loads", exact: true }).click();
  await inspector(page)
    .getByRole("button", { name: "Add load", exact: true })
    .click();
  await page.getByRole("button", { name: /^Face 2\b/ }).click();
  await page.getByLabel("Z force", { exact: true }).fill("-100");
  await page.getByRole("button", { name: "Save load" }).click();
  await page.getByRole("button", { name: /^Mesh\s*Medium/ }).click();
  await page.getByRole("button", { name: "Preview mesh" }).click();
  await expect(
    page.getByText("Minimum quality", { exact: true }),
  ).toBeVisible();
  await inspector(page)
    .getByRole("button", { name: "Solve", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "von Mises stress" }),
  ).toBeVisible({ timeout: 60000 });
  await page.screenshot({ path: "output/playwright/stress.png" });
  await page.getByRole("button", { name: "Displacement", exact: true }).click();
  await expect(inspector(page).locator(".big")).toContainText("0.288");
  await page.getByRole("button", { name: "Magnified" }).click();
  await expect(page.getByText(/Displacement ×/)).toBeVisible();
  const canvas = page.locator("canvas");
  const box = await canvas.boundingBox();
  await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);
  await expect(page.locator(".probe-card")).toContainText("Node");
  await page.getByRole("button", { name: /^Re-solve with/ }).click();
  await expect(
    page.getByText("Peak stress change", { exact: true }),
  ).toBeVisible({ timeout: 60000 });
  await page.screenshot({ path: "output/playwright/refined.png" });
  await page.getByRole("button", { name: "Yield margin", exact: true }).click();
  // Minimum margin is 9.3, so the scale widens beyond the 0–5 default.
  await expect(page.locator(".legend")).toContainText("20+");
  const csvPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Surface CSV" }).click();
  const csv = await csvPromise;
  expect(csv.suggestedFilename()).toBe("bettersim-surface-nodes.csv");
  expect(await fs.readFile(await csv.path(), "utf8")).toMatch(/^surface_node,/);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const download = await downloadPromise;
  await download.saveAs("output/playwright/beam.bsim");
  await page.reload();
  await page
    .locator('input[type=file][accept=".bsim"]')
    .setInputFiles(path.resolve("output/playwright/beam.bsim"));
  // Saved results come back without solving again.
  await expect(
    page.getByRole("heading", { name: "von Mises stress" }),
  ).toBeVisible();
  await expect(page.getByText("Results loaded from project")).toBeVisible();
  await expect(page.getByRole("button", { name: "Deck .inp" })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: /^Fixed\s*Face 1$/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Force\s*100 N$/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Mesh\s*[\d,]+ el$/ }).click();
  await inspector(page)
    .getByRole("button", { name: "Solve", exact: true })
    .click();
  await expect(page.getByText(/^Solved ·/)).toBeVisible({ timeout: 60000 });
  await expect(
    page.getByRole("heading", { name: "von Mises stress" }),
  ).toBeVisible({ timeout: 60000 });
  await page.getByRole("button", { name: /^Material\s*Aluminum/ }).click();
  await page.getByRole("button", { name: /Structural steel/ }).click();
  await page.getByLabel("Name", { exact: true }).fill("Supplier steel");
  await page.getByLabel(/^Density/).fill("7800");
  // A typed name survives property edits.
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    "Supplier steel",
  );
  await page.getByRole("button", { name: "Apply material" }).click();
  await expect(
    page.getByRole("button", { name: /^Results\s*not solved/ }),
  ).toBeDisabled();
  // A material change keeps the mesh, and keyboard undo restores the study.
  await expect(
    page.getByRole("button", { name: /^Mesh\s*[\d,]+ el$/ }),
  ).toBeVisible();
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("ControlOrMeta+z");
  await expect(
    page.getByRole("button", { name: /^Material\s*Aluminum/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Mesh\s*[\d,]+ el$/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Material\s*Aluminum/ }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("button", { name: "Supports", exact: true }),
  ).toBeFocused();
  const html = page.locator("html");
  const initial = await html.getAttribute("data-theme");
  const other = initial === "dark" ? "light" : "dark";
  await page.getByRole("button", { name: `Use ${other} theme` }).click();
  await expect(html).toHaveAttribute("data-theme", other);
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", other);
  expect(errors).toEqual([]);
});
test("autosave restores the last study after a reload", async ({ page }) => {
  await page.goto("http://127.0.0.1:5173");
  await page.getByRole("button", { name: /^Cantilever beam.*Open$/ }).click();
  await page.getByRole("button", { name: "Use example setup" }).click();
  await expect(page.getByText("Saved locally")).toBeVisible({
    timeout: 10000,
  });
  await page.reload();
  await page
    .getByRole("button", { name: /^Cantilever beam.*Restore$/ })
    .click();
  await expect(
    page.getByRole("button", { name: /^Fixed\s*Face 1$/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Force\s*100 N$/ }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /^Cantilever beam/ })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "Use example setup" }),
  ).toBeVisible();
});
test("invalid STEP reports an actionable import error", async ({ page }) => {
  await page.goto("http://127.0.0.1:5173");
  await page.locator('input[type=file][accept=".step,.stp"]').setInputFiles({
    name: "broken.step",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("not a STEP solid"),
  });
  await expect(page.getByRole("alert")).toContainText("Import failed");
  await expect(page.getByRole("heading", { name: "BetterSim" })).toBeVisible();
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
    await inspector(page)
      .getByRole("button", { name: "Solve", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "von Mises stress" }),
    ).toBeVisible({ timeout: 90000 });
    await page.getByRole("button", { name: "Show in view" }).click();
    await expect(page.locator(".probe-card")).toContainText("Node");
    await page.getByRole("button", { name: "Magnified" }).click();
    await page.screenshot({ path: `output/playwright/${name}.png` });
    await page.getByRole("button", { name: /^Re-solve with/ }).click();
    // Jobs don't block the view: the camera stays usable while solving.
    await expect(page.locator(".job-card")).toBeVisible();
    await expect(inspector(page)).toHaveAttribute("inert", "");
    await page.getByRole("button", { name: "Fit part to view" }).click();
    await expect(
      page.getByText("Peak stress change", { exact: true }),
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
  await page.getByRole("button", { name: /^Force\s*100 N$/ }).click();
  await page.getByRole("button", { name: "Pressure", exact: true }).click();
  await page
    .getByRole("button", { name: "Clear selection", exact: true })
    .click();
  await page
    .getByRole("button", { name: new RegExp(`^Face ${torus}\\b`) })
    .click();
  await page.getByLabel(/^Pressure/).fill("1");
  await page.getByRole("button", { name: "Save load" }).click();
  await page.getByRole("button", { name: /^Mesh\s*Custom/ }).click();
  await inspector(page)
    .getByRole("button", { name: "Solve", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "von Mises stress" }),
  ).toBeVisible({ timeout: 60000 });
  await page.getByRole("button", { name: "Checks", exact: true }).click();
  const reactions = await page
    .locator(".check-row")
    .filter({ hasText: "Reaction X, Y, Z" })
    .locator("b")
    .innerText();
  const [rx, ry] = reactions
    .replace(" N", "")
    .split(", ")
    .map((v) => Number(v.replace(/,/g, "")));
  expect(rx).toBeCloseTo(-Math.PI * 49, 0);
  expect(ry).toBeCloseTo(-Math.PI * 49, 0);
  await page.screenshot({ path: "output/playwright/toroidal-pressure.png" });
});
