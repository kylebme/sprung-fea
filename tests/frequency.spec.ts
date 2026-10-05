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
import path from "node:path";

test("natural frequencies: choose the analysis, solve, browse modes, animate, reopen", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await openBeam(page);
  await page.getByRole("button", { name: /^Analysis/ }).click();
  await inspector(page)
    .getByRole("button", { name: /^Natural frequencies/ })
    .click();
  await expect(page.locator("header")).toContainText("Natural frequencies");
  // Loads are optional: with any, Solve asks whether to include them.
  await expect(
    page.getByRole("button", { name: /^Force\s*100 N$/ }),
  ).toBeVisible();
  await page.getByLabel("Modes to find").fill("4");
  await page.locator("header button.solve").click();
  const ask = page.getByRole("dialog", { name: "Include the loads?" });
  await ask.getByRole("button", { name: "Ignore loads" }).click();
  await expect(page.getByRole("heading", { name: "Mode shape" })).toBeVisible({
    timeout: 90000,
  });
  await expect(inspector(page)).toContainText("the loads were not included");
  const modes = page.getByRole("table", { name: "Modes" });
  await expect(modes.locator("tbody tr")).toHaveCount(4);
  // Mode 1: first bending, 816 Hz by beam theory.
  const first = Number(
    (await inspector(page).locator(".big strong").innerText()).replace(
      /,/g,
      "",
    ),
  );
  expect(Math.abs(first / 816 - 1)).toBeLessThan(0.02);
  await expect(page.getByRole("switch", { name: "Animate" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.locator(".vchip")).toContainText("animated");
  await page.screenshot({ path: "output/playwright/frequency.png" });
  await modes.locator("tbody tr").nth(1).click();
  await expect(page.locator(".vlabel")).toContainText("Mode 2");
  const second = Number(
    (await inspector(page).locator(".big strong").innerText()).replace(
      /,/g,
      "",
    ),
  );
  expect(second).toBeGreaterThan(first * 1.8);
  await page.getByRole("switch", { name: "Animate" }).click();
  await expect(page.locator(".vchip")).not.toContainText("animated");
  expect(numbers(await check(page, "Natural frequencies found"))[0]).toBe(4);
  // Included, a 2 kN pull along the beam stiffens it; Escape cancels.
  await page.getByRole("button", { name: /^Force\s*100 N$/ }).click();
  await fillVector(page, "force", [2000, 0, 0]);
  await page.getByRole("button", { name: "Save load" }).click();
  await page.locator("header button.solve").click();
  await page.keyboard.press("Escape");
  await expect(ask).toBeHidden();
  await expect(page.getByRole("heading", { name: "Mode shape" })).toHaveCount(
    0,
  );
  await page.locator("header button.solve").click();
  await ask.getByRole("button", { name: "Include loads" }).click();
  await expect(page.getByRole("heading", { name: "Mode shape" })).toBeVisible({
    timeout: 90000,
  });
  await expect(inspector(page)).toContainText("The loads are included");
  const stiffened = Number(
    (await inspector(page).locator(".big strong").innerText()).replace(
      /,/g,
      "",
    ),
  );
  expect(stiffened).toBeGreaterThan(first);
  // Without supports the part is free: six rigid motions come first.
  await page.getByRole("button", { name: /^Force\s*2,000 N$/ }).click();
  await inspector(page).getByRole("button", { name: "Delete" }).click();
  await page.getByRole("button", { name: /^Fixed\s*Face 1$/ }).click();
  await inspector(page).getByRole("button", { name: "Delete" }).click();
  await solve(page, "Mode shape");
  await expect(modes.locator("tbody tr.dim")).toHaveCount(6);
  await expect(page.locator(".vlabel")).toContainText("Mode 1");
  // Saved projects keep every mode.
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await (await download).saveAs("output/playwright/frequency.sfea");
  await page.reload();
  await page
    .locator('input[type=file][accept=".sfea"]')
    .setInputFiles(path.resolve("output/playwright/frequency.sfea"));
  await expect(page.getByText("Results loaded from project")).toBeVisible();
  await expect(modes.locator("tbody tr")).toHaveCount(10);
  expect(errors).toEqual([]);
});
