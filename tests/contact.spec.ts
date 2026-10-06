import { test, expect, type Page } from "@playwright/test";
import {
  check,
  inspector,
  numbers,
  openBeam,
  solve,
  watchErrors,
} from "./helpers";

async function openExample(page: Page, name: RegExp) {
  await page.goto("http://127.0.0.1:5173");
  await page.getByRole("button", { name }).click();
  await expect(
    page.getByRole("button", { name: "Use example setup" }),
  ).toBeVisible();
}

const tree = (page: Page) => page.getByRole("navigation", { name: "Study" });

test("contact stays hidden until an assembly turns it on", async ({ page }) => {
  const errors = watchErrors(page);
  // A single part has nothing to touch.
  await openBeam(page, false);
  await page.getByRole("button", { name: /^Analysis/ }).click();
  await expect(
    page.getByRole("switch", { name: "Contact and bolts" }),
  ).toHaveCount(0);
  // An assembly offers it, off: its bodies are bonded and the tree is as
  // before.
  await openExample(page, /^Post on plate.*Open$/);
  await page.getByRole("button", { name: /^Analysis/ }).click();
  const toggle = page.getByRole("switch", { name: "Contact and bolts" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(
    tree(page).getByRole("button", { name: /^Contacts/ }),
  ).toHaveCount(0);
  await expect(tree(page).getByText("Bolts", { exact: true })).toHaveCount(0);
  await toggle.click();
  await expect(page.locator("header")).toContainText("Static, contact");
  await tree(page)
    .getByRole("button", { name: /^Contacts\s*1 bonded$/ })
    .click();
  const pair = inspector(page).getByRole("group", {
    name: "Body 1 · Body 2 contact",
  });
  await expect(pair.getByRole("button", { name: "Bonded" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(inspector(page).getByLabel("Friction coefficient")).toHaveCount(
    0,
  );
  await pair.getByRole("button", { name: "Frictional" }).click();
  await expect(inspector(page).getByLabel("Friction coefficient")).toHaveValue(
    "0.2",
  );
  await expect(
    tree(page).getByRole("button", { name: /^Contacts\s*1 frictional$/ }),
  ).toBeVisible();
  // The stiffness setting stays folded away.
  await expect(inspector(page).getByLabel("Stiffness factor")).toHaveCount(0);
  // Other analyses leave contact out.
  await page.getByRole("button", { name: /^Analysis/ }).click();
  await inspector(page)
    .getByRole("button", { name: /^Natural frequencies/ })
    .click();
  await expect(
    tree(page).getByRole("button", { name: /^Contacts/ }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("bolted joint: tighten the bolt, pull the plates, read bolt and contact forces", async ({
  page,
}) => {
  test.setTimeout(240000);
  const errors = watchErrors(page);
  await openExample(page, /^Bolted joint.*Open$/);
  await page.getByRole("button", { name: "Use example setup" }).click();
  await expect(
    tree(page).getByRole("button", { name: /^Contacts\s*3 frictional$/ }),
  ).toBeVisible();
  // The preload from a tightening torque: T / (K d), with the 10 mm shank.
  await tree(page)
    .getByRole("button", { name: /^Bolt\s*20,000 N$/ })
    .click();
  await expect(inspector(page).getByText("Shank stress")).toBeVisible();
  await inspector(page).getByText("Preload from tightening torque").click();
  await inspector(page)
    .getByLabel(/^Tightening torque/)
    .fill("36");
  await inspector(page)
    .getByRole("button", { name: /^Use 18,000 N$/ })
    .click();
  await expect(inspector(page).getByLabel(/^Preload/)).toHaveValue("18000");
  await page.getByRole("button", { name: "Save bolt" }).click();
  await expect(
    tree(page).getByRole("button", { name: /^Bolt\s*18,000 N$/ }),
  ).toBeVisible();
  await page.locator("header button.solve").click();
  await expect(
    page.getByRole("heading", { name: "von Mises stress" }),
  ).toBeVisible({
    timeout: 200000,
  });
  // It opens with the loads on; the bolt was tightened to its preload.
  await expect(inspector(page).getByLabel("Result frame")).toBeVisible();
  await expect(inspector(page)).toContainText("Load 100%");
  const bolts = inspector(page).getByRole("table", { name: "Bolt forces" });
  const [tightened, loaded] = numbers(
    await bolts.locator("tbody tr").innerText(),
  );
  expect(tightened).toBe(18000);
  expect(Math.abs(loaded / tightened - 1)).toBeLessThan(0.05);
  // Friction carries the 3 kN pull below its 0.2 × 18 kN limit.
  const plates = inspector(page)
    .getByRole("table", { name: "Contact forces" })
    .locator("tbody tr")
    .first();
  await expect(plates).toContainText("Stuck");
  await expect(
    inspector(page).getByRole("heading", { name: "Bolt force" }),
  ).toBeVisible();
  expect(numbers(await check(page, "Force balance error"))[0]).toBeLessThan(
    0.01,
  );
  await tree(page)
    .getByRole("radio", { name: "Contact pressure", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Contact pressure" }),
  ).toBeVisible();
  // The first frames show the bolt being tightened.
  await page.getByLabel("Result frame").focus();
  await page.keyboard.press("Home");
  await expect(page.locator(".vlabel")).toContainText("Tightening");
  await page.screenshot({ path: "output/playwright/bolted-joint.png" });
  // Hidden bodies leave the view and its section: cut across the joint,
  // then hide the bolt.
  await page.getByRole("switch", { name: "Section" }).click();
  await inspector(page)
    .getByRole("group", { name: "Section normal" })
    .getByRole("button", { name: "Y" })
    .click();
  const area = async () =>
    numbers(
      await inspector(page)
        .locator(".filters .kv")
        .filter({ hasText: "Section area" })
        .locator("b")
        .innerText(),
    )[0];
  const whole = await area();
  await page.getByRole("button", { name: "Hide Body 3" }).click();
  await expect.poll(area).toBeLessThan(whole);
  expect(errors).toEqual([]);
});
