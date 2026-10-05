import { test, expect, type Page } from "@playwright/test";
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

const face = (page: Page, id: number) =>
  page.getByRole("button", { name: new RegExp(`^Face ${id}\\b`) });

/** A row of the section filter, as a number. */
const sectionRow = async (page: Page, label: string) =>
  numbers(
    await inspector(page)
      .locator(".filters .kv")
      .filter({ hasText: label })
      .locator("b")
      .innerText(),
  )[0];

test("frictionless supports let the bar contract; the section carries the load", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await openBeam(page);
  // Frictionless on the three faces through the corner at the origin:
  // the bar can contract sideways, and 1,000 N along it is pure tension.
  await page.getByRole("button", { name: /^Fixed\s*Face 1$/ }).click();
  await inspector(page)
    .getByRole("group", { name: "Support type" })
    .getByRole("button", { name: "Frictionless" })
    .click();
  await face(page, 3).click();
  await face(page, 5).click();
  await page.getByRole("button", { name: "Save support" }).click();
  await expect(
    page.getByRole("button", { name: /^Frictionless\s*3 faces$/ }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Force\s*100 N$/ }).click();
  await fillVector(page, "force", [1000, 0, 0]);
  await page.getByRole("button", { name: "Save load" }).click();
  await solve(page);
  // σ = F/A = 1,000 N / 200 mm² everywhere.
  const peak = numbers(
    await inspector(page).locator(".big strong").innerText(),
  );
  expect(peak[0]).toBeCloseTo(5, 2);
  expectClose(numbers(await check(page, "Reaction X, Y, Z")), [-1000, 0, 0]);

  // The section at mid-length carries the whole load as tension.
  await page.getByRole("switch", { name: "Section" }).click();
  await expect(inspector(page).locator(".filters")).toContainText(
    "Normal force",
  );
  expect(await sectionRow(page, "Normal force")).toBeCloseTo(1000, 1);
  expect(await sectionRow(page, "Shear force")).toBeCloseTo(0, 3);
  expect(await sectionRow(page, "Bending moment")).toBeCloseTo(0, 1);
  await page.screenshot({ path: "output/playwright/frictionless.png" });
  expect(errors).toEqual([]);
});

test("section forces of the cantilever: shear and the bending moment", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await openBeam(page);
  await solve(page);
  await page.getByRole("switch", { name: "Section" }).click();
  // 100 N at the tip, cut at x = 50 and 25: M = F × distance to the tip.
  await expect(inspector(page).locator(".filters")).toContainText(
    "Bending moment",
  );
  expect(await sectionRow(page, "Shear force")).toBeCloseTo(100, 2);
  expect(await sectionRow(page, "Bending moment")).toBeCloseTo(5000, 0);
  expect(await sectionRow(page, "Torque")).toBeCloseTo(0, 2);
  // From mid-length, 100 steps of 0.25 mm toward the support.
  await page.getByLabel("Section position").focus();
  for (let i = 0; i < 100; i++) await page.keyboard.press("ArrowLeft");
  await expect
    .poll(() => sectionRow(page, "Bending moment"))
    .toBeCloseTo(7500, 0);
  // Keeping the other side reports the same loads from the other side.
  await inspector(page).getByRole("button", { name: "Flip" }).click();
  await expect
    .poll(() => sectionRow(page, "Bending moment"))
    .toBeCloseTo(7500, 0);
  expect(await sectionRow(page, "Shear force")).toBeCloseTo(100, 2);
  expect(errors).toEqual([]);
});

test("cylindrical supports hold the bracket by its bolt holes", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto("http://127.0.0.1:5173");
  await page.getByRole("button", { name: /^Mounting bracket.*Open$/ }).click();
  await page.getByRole("button", { name: "Use example setup" }).click();
  await page.getByRole("button", { name: /^Fixed\s*Face 1$/ }).click();
  await inspector(page)
    .getByRole("group", { name: "Support type" })
    .getByRole("button", { name: "Cylindrical" })
    .click();
  // A pin in each hole: radial and along blocked, free to turn.
  await expect(
    inspector(page).getByRole("button", { name: "Around: free" }),
  ).toBeVisible();
  await inspector(page).getByRole("button", { name: "Remove face 1" }).click();
  await face(page, 6).click();
  await face(page, 7).click();
  await page.getByRole("button", { name: "Save support" }).click();
  await expect(
    page.getByRole("button", { name: /^Cylindrical\s*2 faces$/ }).first(),
  ).toBeVisible();
  await solve(page);
  expectClose(numbers(await check(page, "Reaction X, Y, Z")), [0, 0, 100]);
  // Holes on a flat face are not cylinders.
  await page
    .getByRole("button", { name: /^Cylindrical\s*2 faces$/ })
    .first()
    .click();
  await face(page, 6).click();
  await face(page, 7).click();
  await face(page, 1).click();
  await page.getByRole("button", { name: "Save support" }).click();
  await page.locator("header button.solve").click();
  await expect(page.getByRole("alert")).toContainText("cylindrical faces");
  expect(errors).toEqual([]);
});
