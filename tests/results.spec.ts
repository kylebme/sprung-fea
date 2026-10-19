import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { inspector, numbers, solve, viewCenter, watchErrors } from "./helpers";

test("assembly results: yield margin per body, color scale, saved probes, save and reopen", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto("http://127.0.0.1:5173");
  await page.getByRole("button", { name: /^Post on plate.*Open$/ }).click();
  await page.getByRole("button", { name: "Use example setup" }).click();
  // Aluminum plate (yield 276 MPa), structural steel post (250 MPa).
  await page.getByRole("button", { name: /^Material/ }).click();
  await inspector(page)
    .getByLabel("Body 2 material")
    .selectOption("Structural steel");
  await solve(page);
  const panel = inspector(page);

  // Each body is judged against its own yield strength.
  const table = panel.getByRole("table", { name: "Yield margin by body" });
  const row = async (body: string) =>
    numbers(await table.getByRole("row").filter({ hasText: body }).innerText());
  const [, plateYield, plateStress, plateMargin] = await row("Body 1");
  const [, postYield, postStress, postMargin] = await row("Body 2");
  expect([plateYield, postYield]).toEqual([276, 250]);
  // Peak stress shows to 0.1 MPa: margins agree to that rounding.
  expect(Math.abs((plateMargin * plateStress) / 276 - 1)).toBeLessThan(0.03);
  expect(Math.abs((postMargin * postStress) / 250 - 1)).toBeLessThan(0.03);
  // The plotted minimum is the lower body margin: the post's, against
  // steel, not the part material's 276 MPa.
  const lowest = Math.min(plateMargin, postMargin);
  await page.getByRole("radio", { name: "Yield margin", exact: true }).click();
  const shown = Number(await panel.locator(".big strong").innerText());
  expect(shown).toBeCloseTo(lowest, 1);
  expect(shown).toBeLessThan(276 / Math.max(plateStress, postStress) - 0.5);

  // A fixed top for the margin, in flat bands; values above it continue.
  await panel.getByLabel("Highest color value").fill("50");
  await expect(page.locator(".legend span").first()).toHaveText(/^50\+/);
  await panel.getByRole("button", { name: "6 bands" }).click();
  await expect(
    panel.getByRole("button", { name: "6 bands" }),
  ).toHaveAttribute("aria-pressed", "true");
  await panel.getByRole("button", { name: "Colorblind-safe" }).click();
  // Limits belong to their plot: stress keeps its automatic range.
  await page.getByRole("radio", { name: "von Mises stress" }).click();
  await expect(panel.getByLabel("Highest color value")).toHaveValue("");
  const top = numbers(await page.locator(".legend span").first().innerText());
  expect(top[0]).toBeCloseTo(Math.max(plateStress, postStress), 0);

  // Probe a point, save it, and read it from the table and the view.
  const middle = await viewCenter(page);
  await page.mouse.click(middle.x, middle.y);
  const card = page.locator(".probe-card");
  await expect(card).toContainText("Interpolated");
  const probed = numbers(
    await card.locator(".kv").filter({ hasText: "von Mises" }).innerText(),
  )[0];
  await card.getByRole("button", { name: "Save probe" }).click();
  await expect(
    card.getByRole("button", { name: "Probe saved" }),
  ).toBeDisabled();
  const saved = panel.getByRole("table", { name: "Saved probes" });
  await expect(saved.getByLabel("Probe name")).toHaveValue("P1");
  expect(numbers(await saved.getByRole("row").innerText())[0]).toBeCloseTo(
    probed,
    2,
  );
  await expect(page.locator(".condition-label.probe")).toHaveText("P1");
  await saved.getByLabel("Probe name").fill("Fillet");
  await expect(page.locator(".condition-label.probe")).toHaveText("Fillet");

  // Every quantity at the saved probe, as CSV.
  const csvDownload = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Export CSV" }).click();
  const csv = await fs.readFile(await (await csvDownload).path(), "utf8");
  const [header, line] = csv.split("\n");
  expect(header).toMatch(
    /^probe,x_mm,y_mm,z_mm,frame,displacement_mm,von_mises_MPa,.*yield_margin/,
  );
  const cells = line.split(",");
  expect(cells[0]).toBe("Fillet");
  expect(Number(cells[header.split(",").indexOf("von_mises_MPa")])).toBeCloseTo(
    probed,
    2,
  );

  // The color scale and saved probes come back with the project.
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await (await download).saveAs("output/playwright/results-display.sfea");
  await page.reload();
  await page
    .locator('input[type=file][accept=".sfea"]')
    .setInputFiles(path.resolve("output/playwright/results-display.sfea"));
  await expect(page.getByText("Results loaded from project")).toBeVisible();
  await expect(
    panel.getByRole("table", { name: "Saved probes" }).getByLabel("Probe name"),
  ).toHaveValue("Fillet");
  await page.getByRole("radio", { name: "Yield margin", exact: true }).click();
  await expect(panel.getByLabel("Highest color value")).toHaveValue("50");
  await expect(
    panel.getByRole("button", { name: "6 bands" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    panel.getByRole("button", { name: "Colorblind-safe" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: "output/playwright/results-display.png" });
  expect(errors).toEqual([]);
});
