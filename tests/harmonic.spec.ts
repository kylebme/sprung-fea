import { test, expect } from "@playwright/test";
import {
  check,
  inspector,
  numbers,
  openBeam,
  solve,
  watchErrors,
} from "./helpers";

test("harmonic response: sweep the tip force, find resonance, then shake the base", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await openBeam(page);
  await page.getByRole("button", { name: /^Analysis/ }).click();
  await inspector(page)
    .getByRole("button", { name: /^Harmonic response/ })
    .click();
  await inspector(page).getByRole("spinbutton", { name: "To Hz" }).fill("3000");
  await solve(page, "Displacement amplitude");
  // It opens at the largest response: the first bending mode, 819 Hz,
  // about 25 × the 0.29 mm static deflection with 2% damping.
  await expect(page.locator(".vlabel")).toContainText("819");
  const peak = Number(await inspector(page).locator(".big strong").innerText());
  expect(peak).toBeGreaterThan(5.5);
  expect(peak).toBeLessThan(8);
  await expect(page.getByRole("switch", { name: "Animate" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  // Clicking the response curve far below resonance shows that frequency.
  const chart = page.getByRole("img", { name: "Displacement response" });
  const box = (await chart.boundingBox())!;
  await chart.click({ position: { x: box.width * 0.2, y: box.height / 2 } });
  await expect(page.locator(".vlabel")).not.toContainText("819");
  const [at] = numbers(await check(page, "Largest response at"));
  expect(at).toBeCloseTo(819.3, 0);
  await page.screenshot({ path: "output/playwright/harmonic.png" });

  // Base shaking: loads drop out, and 1 g at the base drives the beam.
  await page.getByRole("button", { name: /^Analysis/ }).click();
  await page
    .getByRole("group", { name: "Excitation" })
    .getByRole("button", { name: "Base shaking" })
    .click();
  await expect(
    page.getByRole("button", { name: "Loads", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Z base acceleration")).toHaveValue("1");
  await solve(page, "Displacement amplitude");
  await expect(inspector(page)).toContainText("relative to the shaking base");
  expect(errors).toEqual([]);
});
