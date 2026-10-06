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

test("US units: switch, enter loads in lbf, read results in inches and psi", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto("http://127.0.0.1:5173");
  await page.evaluate(() => localStorage.removeItem("sprung-fea-units"));
  await openBeam(page);
  await page.getByRole("button", { name: /Switch to US units/ }).click();
  await expect(page.locator("footer")).toContainText("in · lbf · psi");
  // The 100 × 20 × 10 mm beam in inches.
  await expect(page.locator("footer")).toContainText(
    "3.937 × 0.7874 × 0.3937 in",
  );
  // The example's 100 N load reads in pounds-force.
  await expect(
    page.getByRole("button", { name: /^Force\s*22.48 lbf$/ }),
  ).toBeVisible();
  // Typed in lbf, stored in N: 22.48089 lbf is 100 N, shown to six digits.
  await page.getByRole("button", { name: /^Force/ }).click();
  await expect(page.getByLabel("Z force")).toHaveValue("-22.4809");
  await fillVector(page, "force", [0, 0, -22.48089431]);
  await expect(inspector(page)).toContainText("Total force, lbf");
  await page.getByRole("button", { name: "Save load" }).click();
  await solve(page);
  // Peak stress about 29.4 MPa = 4,270 psi; deflection 0.288 mm = 0.01134 in.
  await expect(page.locator(".vlabel")).toContainText("psi");
  await page.getByRole("radio", { name: "Displacement", exact: true }).click();
  const tip = Number(await inspector(page).locator(".big strong").innerText());
  expect(tip).toBeCloseTo(0.288 / 25.4, 4);
  await expect(inspector(page).locator(".big")).toContainText("in");
  expect(numbers(await check(page, "Reaction X, Y, Z"))[2]).toBeCloseTo(
    22.48,
    1,
  );
  await expect(
    page.locator(".check-row").filter({ hasText: "Reaction" }),
  ).toContainText("lbf");
  // Material values in US units.
  await page.getByRole("button", { name: /^Material/ }).click();
  await expect(
    inspector(page).getByText("lb/in³", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "output/playwright/us-units.png" });
  // The choice is kept on this computer.
  await page.reload();
  await expect(page.locator("footer")).toContainText("in · lbf · psi");
  await page.getByRole("button", { name: /Switch to SI units/ }).click();
  await expect(page.locator("footer")).toContainText("mm · N · MPa");
  expect(errors).toEqual([]);
});
