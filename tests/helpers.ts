// Shared steps for the browser specs. Every step drives the real interface.
import { expect, type Page } from "@playwright/test";

export const inspector = (page: Page) =>
  page.getByRole("complementary", { name: "Inspector" });

/** Fails the test on any uncaught page error. */
export function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

/** Opens the cantilever beam example with the example setup applied. */
export async function openBeam(page: Page, setup = true) {
  await page.goto("http://127.0.0.1:5173");
  await page.getByRole("button", { name: /^Cantilever beam.*Open$/ }).click();
  await expect(
    page.getByRole("heading", { name: "Cantilever beam" }),
  ).toBeVisible();
  if (setup)
    await page.getByRole("button", { name: "Use example setup" }).click();
}

export async function solve(page: Page, heading = "von Mises stress") {
  // The title bar's Solve button works from any inspector section.
  await page.locator("header button.solve").click();
  await expect(page.getByRole("heading", { name: heading })).toBeVisible({
    timeout: 90000,
  });
}

/**
 * The middle of the 3D view's uncovered part: the inspector card covers its
 * left edge, and the view centres the part in the rest.
 */
export async function viewCenter(page: Page) {
  const box = (await page.locator(".view-host canvas").boundingBox())!;
  const card = await page.locator(".inspector").boundingBox();
  const covered = card ? card.x + card.width + 12 - box.x : 0;
  return {
    x: box.x + (covered + box.width) / 2,
    y: box.y + box.height / 2,
  };
}

/** Opens the title bar's Export menu and returns one of its items. */
export async function exportItem(page: Page, name: string) {
  await page.getByRole("button", { name: "Export", exact: true }).click();
  return page.getByRole("menuitem", { name, exact: true });
}

/** Opens the console's Checks tab and returns a row's value text. */
export async function check(page: Page, label: string) {
  const tab = page.getByRole("button", { name: "Checks", exact: true });
  if (!(await page.locator(".console.open").count())) await tab.click();
  else if (!(await tab.evaluate((b) => b.classList.contains("on"))))
    await tab.click();
  return page
    .locator(".check-row")
    .filter({ hasText: label })
    .locator("b")
    .innerText();
}

/** Numbers in a formatted value such as "-1,000, 0.5, 2 N". */
export const numbers = (text: string) =>
  text
    .replace(/[^\d.,eE+\- ]/g, " ")
    .split(/,\s+|\s+/)
    .map((v) => v.replace(/,/g, ""))
    .filter((v) => v && !Number.isNaN(Number(v)))
    .map(Number);

/** Fills the X, Y, Z inputs labelled "<axis> <name>". */
export async function fillVector(page: Page, name: string, values: number[]) {
  for (const [i, axis] of ["X", "Y", "Z"].entries())
    await page
      .getByLabel(`${axis} ${name}`, { exact: true })
      .fill(String(values[i]));
}

/** Element-wise closeness, for formatted solver numbers. */
export function expectClose(actual: number[], expected: number[], tol = 0.01) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((v, i) => expect(Math.abs(v - expected[i])).toBeLessThan(tol));
}
