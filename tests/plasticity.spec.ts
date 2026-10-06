import { test, expect } from "@playwright/test";
import {
  check,
  fillVector,
  inspector,
  numbers,
  openBeam,
  solve,
  watchErrors,
} from "./helpers";

test("plasticity: overload the cantilever, see plastic strain and the permanent bend", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await openBeam(page);
  // 1,100 N bends the root past aluminum’s 276 MPa yield (about 920 N),
  // below the fully plastic collapse load.
  await page.getByRole("button", { name: /^Force\s*100 N$/ }).click();
  await fillVector(page, "force", [0, 0, -1100]);
  await page.getByRole("button", { name: "Save load" }).click();
  await solve(page);
  await expect(inspector(page)).toContainText("turn on Plasticity");
  await page.getByRole("button", { name: /^Analysis/ }).click();
  await page.getByRole("switch", { name: "Plasticity" }).click();
  await page.getByRole("switch", { name: "Then remove the loads" }).click();
  await expect(page.locator("header")).toContainText("Static, plastic");
  await solve(page);
  await page
    .getByRole("radio", { name: "Plastic strain", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Plastic strain" }),
  ).toBeVisible();
  // It opens at full load; the last frame is after unloading.
  await expect(inspector(page)).toContainText("Load 100%");
  const [plastic] = numbers(await check(page, "Largest plastic strain"));
  expect(plastic).toBeGreaterThan(0);
  const [set] = numbers(
    await check(page, "Permanent displacement after unloading"),
  );
  expect(set).toBeGreaterThan(0);
  await page.getByLabel("Result frame").focus();
  await page.keyboard.press("End");
  await expect(page.locator(".vlabel")).toContainText("Unloaded");
  await page.screenshot({ path: "output/playwright/plasticity.png" });
  // One stress–strain point at the ultimate strength and elongation is the
  // same straight line. Solving remeshes, so the peak agrees only to the
  // mesh's variation.
  await page.getByRole("button", { name: /^Material/ }).click();
  await inspector(page).getByRole("button", { name: "Add point" }).click();
  await expect(inspector(page).getByLabel("Stress 1")).toHaveValue("310");
  await expect(inspector(page).getByLabel("Strain 1")).toHaveValue("12");
  await page.getByRole("button", { name: "Apply material" }).click();
  await solve(page);
  await expect(inspector(page)).toContainText(
    "follows the stress–strain points",
  );
  const [curve] = numbers(await check(page, "Largest plastic strain"));
  expect(Math.abs(curve / plastic - 1)).toBeLessThan(0.1);
  expect(errors).toEqual([]);
});
