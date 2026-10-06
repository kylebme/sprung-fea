import { test, expect } from "@playwright/test";
import { check, inspector, numbers, solve, watchErrors } from "./helpers";

test("bonded assembly: open the post on plate, give the post its own material, solve", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto("http://127.0.0.1:5173");
  await page.getByRole("button", { name: /^Post on plate.*Open$/ }).click();
  await expect(
    page.getByRole("heading", { name: "Post on plate" }),
  ).toBeVisible();
  await expect(inspector(page)).toContainText("bonded where they touch");
  // Faces are listed under the body they belong to.
  await expect(page.locator(".body-row")).toHaveCount(2);
  await expect(page.locator(".body-row").first()).toContainText("Body 1");
  await page.getByRole("button", { name: "Use example setup" }).click();
  await page.getByRole("button", { name: /^Material/ }).click();
  await inspector(page)
    .getByLabel("Body 2 material")
    .selectOption("Structural steel");
  await expect(inspector(page).getByLabel("Body 2 material")).toHaveValue(
    "Structural steel",
  );
  await page.screenshot({ path: "output/playwright/assembly-setup.png" });
  await solve(page);
  // Aluminum plate 28.8 cm³ and steel post 16 cm³.
  const [mass] = numbers(await check(page, "Mass"));
  expect(mass).toBeCloseTo(28800 * 2.7e-6 + 16000 * 7.85e-6, 3);
  const reaction = numbers(await check(page, "Reaction X, Y, Z"));
  expect(reaction[0]).toBeCloseTo(-100, 1);
  await page.screenshot({ path: "output/playwright/assembly-result.png" });
  expect(errors).toEqual([]);
});
