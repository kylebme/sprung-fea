import { test, expect } from "@playwright/test";
import {
  check,
  exportItem,
  fillVector,
  inspector,
  numbers,
  openBeam,
  solve,
  watchErrors,
} from "./helpers";

test("refine a region: box at the peak, solve, compare, switch views, export", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await openBeam(page);
  await solve(page);
  const panel = inspector(page);
  // Region refinement has its own card, opened from its row under Results.
  await page.getByRole("button", { name: /^Refined region\s*off/ }).click();
  await panel.getByRole("button", { name: "Refine a region" }).click();
  // The box starts around the peak stress, at the fixed end.
  const x = Number(await page.getByLabel("X region center").inputValue());
  expect(x).toBeLessThan(5);
  await page.screenshot({ path: "output/playwright/region-box.png" });
  await panel.getByRole("button", { name: "Solve region" }).click();
  await expect(panel.getByText("Peak stress, refined region")).toBeVisible({
    timeout: 90000,
  });
  const show = page.getByRole("group", { name: "Show result" });
  await expect(show.getByRole("button", { name: "Region" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // The refined mesh resolves the support's concentration above the
  // whole-part peak.
  const [whole, refined] = numbers(
    await check(page, "Peak stress, whole part in region"),
  );
  expect(refined).toBeGreaterThan(whole);
  await expect(page.locator(".vlabel")).toContainText("von Mises stress");
  await page.screenshot({ path: "output/playwright/region-result.png" });
  const deck = page.waitForEvent("download");
  await (await exportItem(page, "Deck .inp")).click();
  expect((await deck).suggestedFilename()).toBe("region-analysis.inp");

  // Back to the whole part; the region box stays outlined.
  await show.getByRole("button", { name: "Whole part" }).click();
  await page.getByRole("button", { name: /^Results\s/ }).click();
  await expect(panel.locator(".big strong")).toHaveText(
    String(Number(whole.toFixed(2))),
  );
  await page.getByRole("button", { name: /^Refined region\s*solved/ }).click();
  // Move the box to mid-span, where the cut faces agree with the whole part.
  await panel.getByRole("button", { name: "Edit region" }).click();
  await fillVector(page, "region center", [50, 10, 5]);
  await fillVector(page, "region size", [20, 30, 20]);
  await panel.getByRole("button", { name: "Solve region" }).click();
  await expect(
    panel.getByText(/cut faces agree with the whole part/),
  ).toBeVisible({
    timeout: 90000,
  });
  // A study edit invalidates both results.
  await page.getByRole("button", { name: /^Material\s*Aluminum/ }).click();
  await page.getByRole("button", { name: /Structural steel/ }).click();
  await page.getByRole("button", { name: "Apply material" }).click();
  await expect(
    page.getByRole("button", { name: /^Results\s*not solved/ }),
  ).toBeDisabled();
  expect(errors).toEqual([]);
});
