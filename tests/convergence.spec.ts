import { test, expect } from "@playwright/test";
import { inspector, openBeam, solve, watchErrors } from "./helpers";

test("mesh convergence: refine until settled, adopt the finest mesh, undo", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await openBeam(page);
  await solve(page);
  await inspector(page)
    .getByRole("button", { name: "Check mesh convergence" })
    .click();
  const report = inspector(page).locator(".convergence");
  await expect(report).toContainText("Converged with 2 meshes", {
    timeout: 90000,
  });
  await expect(report.locator("tbody tr")).toHaveCount(2);
  await expect(report).toContainText(
    /Maximum displacement.*Converged: changed/s,
  );
  await expect(
    page.getByRole("img", { name: /against element count/ }).first(),
  ).toBeVisible();
  await page.screenshot({ path: "output/playwright/convergence.png" });
  // The study now uses the finest mesh: 0.75 × 4 mm.
  await page.getByRole("button", { name: /^Mesh\s/ }).click();
  await expect(page.getByLabel(/^Element size/)).toHaveValue("3");
  // Undo returns to the starting size and clears the result.
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByLabel(/^Element size/)).toHaveValue("4");
  await expect(
    page.getByRole("button", { name: /^Results\s*not solved/ }),
  ).toBeDisabled();
  expect(errors).toEqual([]);
});

test("mesh convergence flags a peak stress that keeps rising at a sharp corner", async ({
  page,
}) => {
  test.setTimeout(300000);
  const errors = watchErrors(page);
  const { configureComplexPart } = await import("./complex-workflow.mjs");
  await page.goto("http://127.0.0.1:5173");
  await configureComplexPart(page, "ribbed-bracket");
  await solve(page);
  await inspector(page)
    .getByRole("button", { name: "Check mesh convergence" })
    .click();
  const report = inspector(page).locator(".convergence");
  await expect(report).toContainText("Not fully converged after 3 meshes", {
    timeout: 240000,
  });
  await expect(report).toContainText("sharp inside corner");
  await page.screenshot({ path: "output/playwright/convergence-singular.png" });
  expect(errors).toEqual([]);
});
