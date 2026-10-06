import { test, expect, type Page } from "@playwright/test";
import { inspector, viewCenter, watchErrors } from "./helpers";

async function openJoint(page: Page) {
  await page.goto("http://127.0.0.1:5173");
  await page.getByRole("button", { name: /^Bolted joint.*Open$/ }).click();
  await page.getByRole("button", { name: "Use example setup" }).click();
  await expect(page.locator(".condition-label")).toHaveCount(3);
}

const labels = (page: Page) =>
  page.locator(".condition-label").allTextContents();

test("hide, isolate and show bodies; labels follow what is visible", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await openJoint(page);
  expect((await labels(page)).sort()).toEqual(["Bolt", "Fixed", "Force"]);
  // The pulled plate is Body 2: hiding it hides its load's label.
  await page.getByRole("button", { name: "Hide Body 2" }).click();
  await expect(page.locator(".condition-label")).toHaveCount(2);
  expect((await labels(page)).sort()).toEqual(["Bolt", "Fixed"]);
  await expect(page.getByRole("button", { name: "Show Body 2" })).toBeVisible();
  // Only the bolt.
  await page.getByRole("button", { name: "Isolate Body 3" }).click();
  await expect(page.locator(".condition-label")).toHaveText(["Bolt"]);
  await page.getByRole("button", { name: "Show all", exact: true }).click();
  await expect(page.locator(".condition-label")).toHaveCount(3);
  // A right-click on a face offers its body's menu.
  const middle = await viewCenter(page);
  await page.mouse.click(middle.x, middle.y, { button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const hide = menu.getByRole("menuitem", { name: /^Hide Body \d$/ });
  const name = (await hide.innerText()).replace("Hide ", "");
  await hide.click();
  await expect(menu).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Show " + name }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Show all", exact: true }).click();
  expect(errors).toEqual([]);
});

test("a hidden bolt shank: found automatically, or picked with a body's faces", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await openJoint(page);
  // Without the example's bolt, a new bolt finds its shank inside the plates.
  await page.getByRole("button", { name: /^Bolt\s*20,000 N$/ }).click();
  await inspector(page).getByRole("button", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Add bolt" }).first().click();
  const found = inspector(page).getByRole("group", { name: "Bolts found" });
  await expect(found).toContainText("Body 3");
  await found.getByRole("button").click();
  await expect(inspector(page).locator(".chip")).toHaveText(["Face 21"]);
  await expect(found.getByRole("button")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "Save bolt" }).click();
  await expect(
    page.getByRole("button", { name: /^Bolt\s*10,000 N$/ }),
  ).toBeVisible();
  // A condition can take every face of a body at once, and give them back.
  await page.getByRole("button", { name: "Add support" }).first().click();
  const all = page.getByRole("button", { name: "Select all faces of Body 3" });
  await all.click();
  await expect(inspector(page).locator(".chip")).toHaveCount(7);
  await all.click();
  await expect(inspector(page).locator(".chip")).toHaveCount(0);
  expect(errors).toEqual([]);
});
