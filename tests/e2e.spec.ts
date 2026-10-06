import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs/promises";
import { exportItem, viewCenter } from "./helpers";
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
  await page.getByRole("button", { name: /^Mesh \+ Solver\s*Medium/ }).click();
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
  await page.getByRole("radio", { name: "Displacement", exact: true }).click();
  await expect(inspector(page).locator(".big")).toContainText("0.288");
  await page.getByRole("button", { name: "Magnified" }).click();
  await expect(page.getByText(/Displacement ×/)).toBeVisible();
  const middle = await viewCenter(page);
  await page.mouse.click(middle.x, middle.y);
  await expect(page.locator(".probe-card")).toContainText("Interpolated");
  // Convergence has its own card, opened from its row under Results.
  await page
    .getByRole("button", { name: /^Convergence\s*not checked/ })
    .click();
  await page.getByRole("button", { name: /^Re-solve once with/ }).click();
  await expect(
    page.getByText("Peak stress change", { exact: true }),
  ).toBeVisible({ timeout: 60000 });
  await page.screenshot({ path: "output/playwright/refined.png" });
  await page.getByRole("radio", { name: "Yield margin", exact: true }).click();
  // Minimum margin is 9.3, so the scale widens beyond the 0–5 default.
  await expect(page.locator(".legend")).toContainText("20+");
  // Switching console tabs re-runs its scroll effect; it must not crash.
  await page.getByRole("button", { name: "Checks", exact: true }).click();
  await expect(page.getByText("Force balance error")).toBeVisible();
  await page.getByRole("button", { name: "Output", exact: true }).click();
  await expect(
    page
      .locator(".log-line")
      .filter({ hasText: "Gmsh" })
      .filter({
        hasText:
          process.platform === "win32" ? "Generating tetrahedra" : "Meshing 3D",
      })
      .first(),
  ).toBeVisible();
  await expect(
    page
      .locator(".log-line")
      .filter({ hasText: "CalculiX" })
      .filter({ hasText: "Factoring the system" })
      .first(),
  ).toBeVisible();
  await expect(
    page.locator(".log-line").filter({ hasText: "Reading results" }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Checks", exact: true }).click();
  await page.getByRole("button", { name: "Hide console" }).click();
  await expect(
    page.getByRole("heading", { name: "Yield margin" }),
  ).toBeVisible();
  const csvPromise = page.waitForEvent("download");
  await (await exportItem(page, "Surface CSV")).click();
  const csv = await csvPromise;
  expect(csv.suggestedFilename()).toBe("sprung-fea-surface-nodes.csv");
  expect(await fs.readFile(await csv.path(), "utf8")).toMatch(/^surface_node,/);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const download = await downloadPromise;
  await download.saveAs("output/playwright/beam.sfea");
  await page.reload();
  await page
    .locator('input[type=file][accept=".sfea"]')
    .setInputFiles(path.resolve("output/playwright/beam.sfea"));
  // Saved results come back without solving again.
  await expect(
    page.getByRole("heading", { name: "von Mises stress" }),
  ).toBeVisible();
  await expect(page.getByText("Results loaded from project")).toBeVisible();
  await expect(await exportItem(page, "Deck .inp")).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: /^Fixed\s*Face 1$/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Force\s*100 N$/ }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /^Mesh \+ Solver\s*[\d,]+ el$/ })
    .click();
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
    page.getByRole("button", { name: /^Mesh \+ Solver\s*[\d,]+ el$/ }),
  ).toBeVisible();
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("ControlOrMeta+z");
  await expect(
    page.getByRole("button", { name: /^Material\s*Aluminum/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Mesh \+ Solver\s*[\d,]+ el$/ }),
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
test("free rotation and orthographic projection keep picking working", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:5173");
  await page.evaluate(() => localStorage.removeItem("sprung-fea-projection"));
  await page.getByRole("button", { name: /^Cantilever beam.*Open$/ }).click();
  await page.getByRole("button", { name: "Use example setup" }).click();
  await inspector(page)
    .getByRole("button", { name: "Solve", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "von Mises stress" }),
  ).toBeVisible({ timeout: 60000 });
  await expect(
    page.getByRole("button", { name: "Perspective" }),
  ).toHaveAttribute("aria-pressed", "true");
  const { x: cx, y: cy } = await viewCenter(page);
  // Drag across and back so the trackball ends near the starting view.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 120, cy - 80, { steps: 8 });
  await page.mouse.move(cx, cy, { steps: 8 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Fit part to view" }).click();
  await page.getByRole("button", { name: "Orthographic" }).click();
  await expect(
    page.getByRole("button", { name: "Orthographic" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(500);
  await page.mouse.click(cx, cy);
  await expect(page.locator(".probe-card")).toContainText("Interpolated");
  await page.screenshot({ path: "output/playwright/orthographic.png" });
  expect(
    await page.evaluate(() => localStorage.getItem("sprung-fea-projection")),
  ).toBe("orthographic");
  await page.getByRole("button", { name: "Perspective" }).click();
  await page.getByRole("button", { name: "Clear" }).click();
  await page.mouse.click(cx, cy);
  await expect(page.locator(".probe-card")).toContainText("Interpolated");
  expect(errors).toEqual([]);
});
test("result filters: section area, section probing, iso-surface, threshold, and saved results", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:5173");
  await page.getByRole("button", { name: /^Cantilever beam.*Open$/ }).click();
  await page.getByRole("button", { name: "Use example setup" }).click();
  await inspector(page)
    .getByRole("button", { name: "Solve", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "von Mises stress" }),
  ).toBeVisible({ timeout: 60000 });
  const filters = page.locator(".filters");
  await page.getByRole("switch", { name: "Section" }).click();
  // The 100 × 20 × 10 mm beam, cut through the volume at mid-length.
  await expect(filters).toContainText("50 mm");
  await expect(filters).toContainText(/Section area\s*200\s*mm²/);
  await page
    .getByRole("group", { name: "Section normal" })
    .getByRole("button", { name: "Z" })
    .click();
  await expect(filters).toContainText(/Section area\s*2,000\s*mm²/);
  await page
    .getByRole("group", { name: "Section normal" })
    .getByRole("button", { name: "X" })
    .click();
  // Looking at the cut face: a click probes the section, inside the part.
  await page.getByRole("button", { name: "Right", exact: true }).click();
  const middle = await viewCenter(page);
  await page.mouse.click(middle.x, middle.y);
  const card = page.locator(".probe-card");
  await expect(card).toContainText("Interpolated");
  await expect(card).toContainText(/Position\s*50, 10, 5\s*mm/);
  await page.screenshot({ path: "output/playwright/section.png" });
  await page.getByRole("button", { name: "Iso", exact: true }).click();
  await page.getByRole("switch", { name: "Section" }).click();
  await page.getByRole("switch", { name: "Iso-surface" }).click();
  await expect(filters).toContainText(/Iso value\s*14\.\d+ MPa/);
  await page.screenshot({ path: "output/playwright/iso-surface.png" });
  await page.getByRole("switch", { name: "Iso-surface" }).click();
  await page.getByRole("radio", { name: "Yield margin", exact: true }).click();
  await page.getByRole("switch", { name: "Threshold" }).click();
  await expect(filters).toContainText("Show below");
  await page.getByRole("button", { name: "Magnified" }).click();
  await page.screenshot({ path: "output/playwright/threshold.png" });
  // Saved projects carry the volume results, so filters work after reopening.
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await (await download).saveAs("output/playwright/filters.sfea");
  await page.reload();
  await page
    .locator('input[type=file][accept=".sfea"]')
    .setInputFiles(path.resolve("output/playwright/filters.sfea"));
  await expect(page.getByText("Results loaded from project")).toBeVisible();
  await page.getByRole("switch", { name: "Section" }).click();
  await expect(page.locator(".filters")).toContainText(
    /Section area\s*200\s*mm²/,
  );
  expect(errors).toEqual([]);
});
test("iterative solver: choose, solve, report iterations, and keep the choice", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:5173");
  await page.getByRole("button", { name: /^Cantilever beam.*Open$/ }).click();
  await page.getByRole("button", { name: "Use example setup" }).click();
  const solvers = page.getByRole("group", { name: "Solver" });
  await expect(
    solvers.getByRole("button", { name: /^Direct\b/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await solvers
    .getByRole("button", { name: /^Iterative, incomplete Cholesky/ })
    .click();
  await page
    .getByRole("group", { name: "Threads" })
    .getByRole("button", { name: "1", exact: true })
    .click();
  // Autosave runs after the job finishes; wait for it before reloading.
  const autosaved = page.waitForResponse(
    (r) => r.url().includes("/api/recovery") && r.request().method() === "POST",
    { timeout: 60000 },
  );
  await inspector(page)
    .getByRole("button", { name: "Solve", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "von Mises stress" }),
  ).toBeVisible({ timeout: 60000 });
  await page.getByRole("radio", { name: "Displacement", exact: true }).click();
  // Same answer as the direct solver.
  await expect(inspector(page).locator(".big")).toContainText("0.288");
  await page.getByRole("button", { name: "Checks", exact: true }).click();
  await expect(page.locator(".console")).toContainText(
    "CalculiX, iterative, incomplete Cholesky",
  );
  await expect(
    page.locator(".check-row").filter({ hasText: "Solver iterations" }),
  ).toContainText(/\d/);
  await expect(
    page.locator(".check-row").filter({ hasText: "Threads" }),
  ).toContainText("1");
  // Autosave keeps the solver choice with the rest of the study.
  await autosaved;
  await page.reload();
  await page
    .getByRole("button", { name: /^Cantilever beam.*Restore$/ })
    .click();
  await page.getByRole("button", { name: /^Mesh \+ Solver\s/ }).click();
  await expect(
    page
      .getByRole("group", { name: "Solver" })
      .getByRole("button", { name: /^Iterative, incomplete Cholesky/ }),
  ).toHaveAttribute("aria-pressed", "true");
  // The thread count is a machine preference, kept across reloads.
  await expect(
    page
      .getByRole("group", { name: "Threads" })
      .getByRole("button", { name: "1", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page
    .getByRole("group", { name: "Threads" })
    .getByRole("button", { name: /^Auto/ })
    .click();
  expect(errors).toEqual([]);
});
test("invalid STEP reports an actionable import error", async ({ page }) => {
  await page.goto("http://127.0.0.1:5173");
  await page.locator('input[type=file][accept=".step,.stp"]').setInputFiles({
    name: "broken.step",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("not a STEP solid"),
  });
  await expect(page.getByRole("alert")).toContainText("Import failed");
  await expect(page.getByRole("heading", { name: "Sprung FEA" })).toBeVisible();
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
    await page.getByRole("button", { name: /^Convergence\s/ }).click();
    await page.getByRole("button", { name: /^Re-solve once with/ }).click();
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
  await page.getByRole("button", { name: /^Mesh \+ Solver\s*Custom/ }).click();
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

test("principal stress, Tresca shear and strain plots", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:5173");
  await page.getByRole("button", { name: /^Cantilever beam.*Open$/ }).click();
  await page.getByRole("button", { name: "Use example setup" }).click();
  await inspector(page)
    .getByRole("button", { name: "Solve", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "von Mises stress" }),
  ).toBeVisible({ timeout: 60000 });
  // Bending: tension above, an equal compression below.
  await page.getByRole("radio", { name: "Max principal stress" }).click();
  const tension = Number(
    await inspector(page).locator(".big strong").innerText(),
  );
  await page.getByRole("radio", { name: "Min principal stress" }).click();
  await expect(inspector(page)).toContainText("Minimum");
  const compression = Number(
    await inspector(page).locator(".big strong").innerText(),
  );
  expect(compression).toBeLessThan(0);
  expect(Math.abs(compression / tension + 1)).toBeLessThan(0.2);
  await page.getByRole("switch", { name: "Threshold" }).click();
  await expect(page.locator(".filters")).toContainText("Show below");
  await page.getByRole("switch", { name: "Threshold" }).click();
  await page.getByRole("radio", { name: "Max shear stress (Tresca)" }).click();
  const shear = Number(
    await inspector(page).locator(".big strong").innerText(),
  );
  expect(shear).toBeGreaterThan(0);
  const middle = await viewCenter(page);
  await page.mouse.click(middle.x, middle.y);
  await expect(page.locator(".probe-card")).toContainText("Max principal");
  await expect(page.locator(".probe-card")).toContainText("Equivalent strain");
  // Strain at the surface: σ/E, about 430 µm/m at the root.
  await page.getByRole("radio", { name: "Max principal strain" }).click();
  await expect(page.locator(".vlabel")).toContainText("µm/m");
  const strain = Number(
    (await inspector(page).locator(".big strong").innerText()).replace(
      /,/g,
      "",
    ),
  );
  expect(strain).toBeGreaterThan(200);
  expect(strain).toBeLessThan(800);
  await page.screenshot({ path: "output/playwright/principal.png" });
  expect(errors).toEqual([]);
});
