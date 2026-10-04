import { test, expect } from "@playwright/test";
import { fillVector, inspector, openBeam, solve, watchErrors } from "./helpers";

test("large deformation: a heavily loaded cantilever, load steps and the load path", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await openBeam(page);
  // PL²/EI = 1 for the beam: the tip drops 30 mm, not the linear 33 mm.
  await page.getByRole("button", { name: /^Force\s*100 N$/ }).click();
  await fillVector(page, "force", [0, 0, -11483]);
  await page.getByRole("button", { name: "Save load" }).click();
  await solve(page);
  // A linear solve warns and points to the setting.
  await expect(inspector(page)).toContainText("Large deformation");
  await page.getByRole("button", { name: /^Analysis/ }).click();
  await page.getByRole("switch", { name: "Large deformation" }).click();
  await expect(page.locator("header")).toContainText(
    "Static, large deformation",
  );
  await solve(page);
  await page.getByRole("button", { name: "Displacement", exact: true }).click();
  const tip = Number(await inspector(page).locator(".big strong").innerText());
  expect(tip).toBeGreaterThan(29.5);
  expect(tip).toBeLessThan(31.5);
  // Results at every load step, and the true-scale shape by default.
  await expect(page.getByLabel("Result frame")).toBeVisible();
  await expect(inspector(page)).toContainText("Load 100%");
  await expect(page.locator(".vchip")).toContainText("True scale");
  await expect(
    page.getByRole("img", { name: /Load and displacement/ }),
  ).toBeVisible();
  await page.screenshot({ path: "output/playwright/large-deformation.png" });
  await page.getByLabel("Result frame").fill("0");
  await expect(page.locator(".vlabel")).toContainText("Load 10%");
  expect(errors).toEqual([]);
});
