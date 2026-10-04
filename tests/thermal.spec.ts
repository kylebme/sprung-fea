import { test, expect } from "@playwright/test";
import {
  check,
  inspector,
  numbers,
  openBeam,
  solve,
  watchErrors,
} from "./helpers";

async function thermal(
  page: import("@playwright/test").Page,
  kind: string,
  faces: number[],
  fill: Record<string, number>,
) {
  await page
    .getByRole("button", { name: "Add thermal condition" })
    .first()
    .click();
  await page
    .getByRole("group", { name: "Thermal type" })
    .getByRole("button", { name: kind, exact: true })
    .click();
  for (const f of faces)
    await page
      .getByRole("button", { name: new RegExp(`^Face ${f}\\b`) })
      .click();
  for (const [label, value] of Object.entries(fill))
    await inspector(page)
      .getByLabel(new RegExp("^" + label))
      .fill(String(value));
  await page.getByRole("button", { name: "Save condition" }).click();
}

test("heat transfer: fixed temperature, heater and air; then thermal stress", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await openBeam(page);
  await page.getByRole("button", { name: /^Analysis/ }).click();
  await inspector(page)
    .getByRole("button", { name: /^Heat transfer/ })
    .click();
  // Supports and loads play no part in heat transfer.
  await expect(
    page.getByRole("button", { name: "Supports", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Loads", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: /^Mesh \+ Solver\s/ }).click();
  await expect(inspector(page).locator(".missing")).toContainText(
    "Temperature or convection",
  );
  await thermal(page, "Temperature", [1], { Temperature: 20 });
  await thermal(page, "Generation", [], { "Heat generated": 5 });
  await expect(
    page.getByRole("button", { name: /^Generation\s*5 W$/ }),
  ).toBeVisible();
  await solve(page, "Temperature");
  // q''' = 5 W in 20 cm³, one end at 20 °C: T(L) = 20 + q'''L²/(2k).
  const peak = Number(await inspector(page).locator(".big strong").innerText());
  expect(peak).toBeCloseTo(20 + ((5 / 2e-5) * 0.01) / (2 * 167), 2);
  const [into, out] = numbers(await check(page, "Heat flowing in, out"));
  expect(into).toBeCloseTo(5, 3);
  expect(out).toBeCloseTo(5, 3);
  await page.getByRole("button", { name: "Heat flux", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Heat flux" })).toBeVisible();
  await page.screenshot({ path: "output/playwright/heat-transfer.png" });

  // Thermal stress: the same heat, with the end held in place.
  await page.getByRole("button", { name: /^Analysis/ }).click();
  await inspector(page)
    .getByRole("button", { name: /^Thermal stress/ })
    .click();
  await expect(page.getByLabel("Stress-free temperature")).toHaveValue("20");
  await expect(
    page.getByRole("button", { name: /^Fixed\s*Face 1$/ }),
  ).toBeVisible();
  await solve(page);
  await page.getByRole("button", { name: "Temperature", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Temperature" }),
  ).toBeVisible();
  const reaction = numbers(await check(page, "Reaction X, Y, Z"));
  // The 100 N example load still acts; heat adds no net force.
  expect(reaction[2]).toBeCloseTo(100, 1);
  await page.screenshot({ path: "output/playwright/thermal-stress.png" });
  expect(errors).toEqual([]);
});
