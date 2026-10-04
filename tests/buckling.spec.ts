import { test, expect } from "@playwright/test";
import { fillVector, inspector, openBeam, solve, watchErrors } from "./helpers";

test("buckling: compress the beam, solve, read the Euler load factor", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await openBeam(page);
  await page.getByRole("button", { name: /^Force\s*100 N$/ }).click();
  await fillVector(page, "force", [-1000, 0, 0]);
  await page.getByRole("button", { name: "Save load" }).click();
  await page.getByRole("button", { name: /^Analysis/ }).click();
  await inspector(page)
    .getByRole("button", { name: /^Buckling/ })
    .click();
  await expect(page.getByLabel("Modes to find")).toHaveValue("3");
  await solve(page, "Buckled shape");
  const modes = page.getByRole("table", { name: "Modes" });
  await expect(modes).toContainText("Load factor");
  await expect(modes.locator("tbody tr")).toHaveCount(3);
  // Fixed–free Euler column: π²EI/(4L²) = 28,333 N, 28.3 × the 1,000 N load.
  const factor = Number(
    await inspector(page).locator(".big strong").innerText(),
  );
  expect(Math.abs(factor / 28.33 - 1)).toBeLessThan(0.02);
  await expect(inspector(page)).toContainText(
    "Design for a factor of at least 2 to 3",
  );
  // Buckled shapes are shown still, magnified.
  await expect(page.getByRole("switch", { name: "Animate" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(page.locator(".vchip")).toContainText("Shape ×");
  await page.screenshot({ path: "output/playwright/buckling.png" });
  expect(errors).toEqual([]);
});
