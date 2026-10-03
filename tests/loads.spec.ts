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

test("remote force, moment and rotation loads: set up, solve, and balance", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await openBeam(page);
  // The example's 100 N tip force becomes a remote force 50 mm past the end.
  await page.getByRole("button", { name: /^Force\s*100 N$/ }).click();
  await page.getByRole("button", { name: "Remote force", exact: true }).click();
  await fillVector(page, "position", [150, 10, 5]);
  await page.getByRole("button", { name: "Save load" }).click();
  await expect(
    page.getByRole("button", { name: /^Remote force\s*100 N$/ }),
  ).toBeVisible();
  await solve(page);
  expectClose(numbers(await check(page, "Applied force")), [0, 0, -100]);
  expectClose(numbers(await check(page, "Reaction")), [0, 0, 100]);
  await page.getByRole("button", { name: "Displacement", exact: true }).click();
  // Beam theory: F L³/3EI + (F × 50 mm) L²/2EI = 0.508 mm, plus shear.
  const tip = Number(await inspector(page).locator(".big strong").innerText());
  expect(tip).toBeGreaterThan(0.5);
  expect(tip).toBeLessThan(0.53);
  await page.screenshot({ path: "output/playwright/remote-force.png" });

  // A pure moment on the free end: no net force reaches the support.
  await page.getByRole("button", { name: /^Remote force\s*100 N$/ }).click();
  await page.getByRole("button", { name: "Moment", exact: true }).click();
  await fillVector(page, "moment", [0, 5000, 0]);
  await page.getByRole("button", { name: "Save load" }).click();
  await expect(
    page.getByRole("button", { name: /^Moment\s*5,000 N·mm$/ }),
  ).toBeVisible();
  await solve(page);
  expectClose(numbers(await check(page, "Reaction")), [0, 0, 0]);

  // Rotation is a body load: no faces, an axis and a speed.
  await page.getByRole("button", { name: /^Moment\s*5,000 N·mm$/ }).click();
  await page.getByRole("button", { name: "Rotation", exact: true }).click();
  await expect(
    inspector(page).getByText("Click faces in the view"),
  ).toHaveCount(0);
  await page.getByLabel("Speed").fill("3000");
  await page
    .getByRole("group", { name: "Rotation axis" })
    .getByRole("button", { name: "Z", exact: true })
    .click();
  await fillVector(page, "axis position", [0, 10, 5]);
  await page.getByRole("button", { name: "Save load" }).click();
  await expect(
    page.getByRole("button", { name: /^Rotation\s*3,000 rpm$/ }),
  ).toBeVisible();
  await solve(page);
  // Mass × centripetal acceleration of the centroid: 0.054 kg × ω² × 50 mm.
  const [rx] = numbers(await check(page, "Reaction"));
  expect(rx).toBeCloseTo(-266.48, 1);
  await page.screenshot({ path: "output/playwright/rotation.png" });
  expect(errors).toEqual([]);
});

test("bearing load on a bore: pushes the loaded half, rejects an axial force", async ({
  page,
}) => {
  test.setTimeout(180000);
  const errors = watchErrors(page);
  const { configureComplexPart } = await import("./complex-workflow.mjs");
  await page.goto("http://127.0.0.1:5173");
  const geometry = await configureComplexPart(page, "bearing-block");
  const bore = geometry.faces
    .filter((f: { type: string }) => f.type === "Cylinder")
    .sort((a: { area: number }, b: { area: number }) => b.area - a.area)[0];
  await page.getByRole("button", { name: /^Service force|^Force/ }).click();
  await page.getByRole("button", { name: "Bearing", exact: true }).click();
  // Along the bore's axis is not a bearing load.
  await fillVector(page, "force", [0, 0, -800]);
  await page.getByRole("button", { name: "Save load" }).click();
  await page.locator("header button.solve").click();
  await expect(page.getByRole("alert")).toContainText("along its axis");
  await page.getByRole("button", { name: "Dismiss" }).click();
  await page.getByRole("button", { name: /^Bearing\s*800 N$/ }).click();
  await fillVector(page, "force", [0, -800, 0]);
  await expect(
    page.getByRole("button", { name: new RegExp(`^Remove face ${bore.id}$`) }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save load" }).click();
  await solve(page);
  const applied = numbers(await check(page, "Applied force"));
  expect(applied[1]).toBeCloseTo(-800, 0);
  expect(Math.abs(applied[0])).toBeLessThan(0.5);
  const reaction = numbers(await check(page, "Reaction"));
  expect(reaction[1]).toBeCloseTo(800, 0);
  await page.screenshot({ path: "output/playwright/bearing.png" });
  expect(errors).toEqual([]);
});
