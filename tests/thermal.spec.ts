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
    "Temperature, convection or radiation",
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
  await page.getByRole("radio", { name: "Heat flux", exact: true }).click();
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
  await page.getByRole("radio", { name: "Temperature", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Temperature" }),
  ).toBeVisible();
  const reaction = numbers(await check(page, "Reaction X, Y, Z"));
  // The 100 N example load still acts; heat adds no net force.
  expect(reaction[2]).toBeCloseTo(100, 1);
  await page.screenshot({ path: "output/playwright/thermal-stress.png" });
  expect(errors).toEqual([]);
});

test("heat over time warms an insulated part; radiation carries heat away", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await openBeam(page);
  await page.getByRole("button", { name: /^Analysis/ }).click();
  await inspector(page)
    .getByRole("button", { name: /^Heat transfer/ })
    .click();
  await inspector(page).getByRole("button", { name: "Over time" }).click();
  await inspector(page)
    .getByLabel(/^Duration/)
    .fill("100");
  await expect(page.locator("header")).toContainText(
    "Heat transfer, over time",
  );
  // With no way out, 5 W warms the 54 g bar at P/(mc) from 20 °C.
  await thermal(page, "Generation", [], { "Heat generated": 5 });
  await page.locator("header button.solve").click();
  await expect(
    page.getByRole("heading", { name: "Temperature over time" }),
  ).toBeVisible({ timeout: 90000 });
  await expect(inspector(page).getByLabel("Result frame")).toBeVisible();
  await expect(inspector(page)).toContainText("100 s");
  const end = Number(await inspector(page).locator(".big strong").innerText());
  expect(end).toBeCloseTo(20 + (5 * 100) / (2700 * 2e-5 * 896), 2);
  await page.screenshot({ path: "output/playwright/heat-over-time.png" });

  // Settled, with one end at 200 °C and the other radiating: the heat
  // conducted in leaves by radiation.
  await page.getByRole("button", { name: /^Analysis/ }).click();
  await inspector(page).getByRole("button", { name: "Settled" }).click();
  await page.getByRole("button", { name: /^Generation\s*5 W$/ }).click();
  await inspector(page).getByRole("button", { name: "Delete" }).click();
  await thermal(page, "Temperature", [1], { Temperature: 200 });
  await thermal(page, "Radiation", [2], { Emissivity: 0.9 });
  await expect(
    page.getByRole("button", { name: /^Radiation\s*ε 0\.9$/ }),
  ).toBeVisible();
  await solve(page, "Temperature");
  const [into, out] = numbers(await check(page, "Heat flowing in, out"));
  expect(into).toBeGreaterThan(0.1);
  expect(Math.abs(out / into - 1)).toBeLessThan(1e-3);
  expect(errors).toEqual([]);
});
