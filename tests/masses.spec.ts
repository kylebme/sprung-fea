import { test, expect } from "@playwright/test";
import {
  check,
  expectClose,
  fillVector,
  inspector,
  numbers,
  openBeam,
  solve,
  watchErrors,
} from "./helpers";

test("point mass: place it off the part, solve with gravity, check its weight", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await openBeam(page);
  await page
    .getByRole("button", { name: "Add load", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "Gravity", exact: true }).click();
  await page.getByRole("button", { name: "Save load" }).click();
  // A 10 kg component bolted to the free end, its center 50 mm beyond it.
  await page
    .getByRole("button", { name: "Add mass", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: /^Face 2\b/ }).click();
  await inspector(page).getByRole("button", { name: "Face center" }).click();
  await expect(page.getByLabel("X center of mass")).toHaveValue("100");
  await inspector(page).getByLabel(/^Mass/).fill("10");
  await fillVector(page, "center of mass", [150, 10, 5]);
  await page.getByRole("button", { name: "Save mass" }).click();
  await expect(
    page.getByRole("button", { name: /^Point mass\s*10 kg$/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Face 2, Plane.*Force/ }),
  ).toBeVisible();
  await page.screenshot({ path: "output/playwright/point-mass-setup.png" });
  await solve(page);
  expect(
    numbers(await check(page, "Mass, part + point masses"))[0],
  ).toBeCloseTo(10.054, 3);
  // 100 N force + 98.1 N component weight + 0.53 N beam weight.
  expectClose(numbers(await check(page, "Reaction")), [0, 0, 198.63]);
  // Undo removes the mass again, and the study no longer lists it.
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("ControlOrMeta+z");
  await expect(
    page.getByRole("button", { name: /^Point mass\s*10 kg$/ }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});
