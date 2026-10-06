import { test, expect } from "@playwright/test";
import {
  fillVector,
  inspector,
  openBeam,
  solve,
  viewCenter,
  watchErrors,
} from "./helpers";

test("editing a condition after solving shows the part, and cancel brings the result back", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await openBeam(page);
  await solve(page);
  const label = page.locator(".vlabel");
  await expect(label).toContainText("von Mises stress");
  // Editing the load hides the result so faces can be picked.
  await page.getByRole("button", { name: /^Force\s*100 N$/ }).click();
  await expect(label).toContainText("Select faces for Force");
  await expect(page.locator(".legend")).toHaveCount(0);
  const face3 = page.getByRole("button", { name: /^Face 3\b/ });
  await expect(face3).toBeEnabled();
  await face3.click();
  await expect(
    inspector(page).getByRole("button", { name: "Remove face 3" }),
  ).toBeVisible();
  // A click in the view picks a face too.
  await page.getByRole("button", { name: "Top", exact: true }).click();
  const middle = await viewCenter(page);
  await page.mouse.click(middle.x, middle.y);
  await expect(
    inspector(page).getByRole("button", { name: "Remove face 6" }),
  ).toBeVisible();
  // Cancel leaves the study unchanged: the result returns.
  await inspector(page).getByRole("button", { name: "Cancel" }).click();
  await expect(label).toContainText("von Mises stress");
  await expect(
    page.getByRole("heading", { name: "von Mises stress" }),
  ).toBeVisible();
  // Escape cancels too; adding a support likewise shows the part.
  await page.getByRole("button", { name: "Add support" }).first().click();
  await expect(label).toContainText("Select faces for Fixed");
  await page.keyboard.press("Escape");
  await expect(label).toContainText("von Mises stress");
  // Saving a changed selection invalidates the result.
  await page.getByRole("button", { name: /^Force\s*100 N$/ }).click();
  await page.getByRole("button", { name: /^Face 3\b/ }).click();
  await page.getByRole("button", { name: "Save load" }).click();
  await expect(
    page.getByRole("button", { name: /^Results\s*not solved/ }),
  ).toBeDisabled();
  expect(errors).toEqual([]);
});

test("the origin appears only while a position is entered, and XYZ inputs use the axis colors", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await openBeam(page);
  const host = page.locator(".view-host");
  await expect(host).toHaveAttribute("data-origin", "hidden");
  await page.getByRole("button", { name: "Add load" }).first().click();
  // A pressure has no position: no origin.
  await page.getByRole("button", { name: "Pressure", exact: true }).click();
  await expect(host).toHaveAttribute("data-origin", "hidden");
  await page.getByRole("button", { name: "Rotation", exact: true }).click();
  await expect(host).toHaveAttribute("data-origin", "shown");
  await page.screenshot({ path: "output/playwright/origin-rotation.png" });
  await page.getByRole("button", { name: "Remote force", exact: true }).click();
  await expect(host).toHaveAttribute("data-origin", "shown");
  await fillVector(page, "position", [150, 10, 5]);
  // Inputs are tinted like the X (red), Y (green) and Z (blue) arrows.
  const tint = (axis: string) =>
    page
      .getByLabel(`${axis} position`, { exact: true })
      .evaluate(
        (input) => getComputedStyle(input.previousElementSibling!).color,
      );
  expect(await tint("X")).toBe("rgb(229, 72, 77)");
  expect(await tint("Y")).toBe("rgb(61, 174, 107)");
  expect(await tint("Z")).toBe("rgb(63, 116, 224)");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(host).toHaveAttribute("data-origin", "hidden");
  await page.getByRole("button", { name: "Add mass" }).first().click();
  await expect(host).toHaveAttribute("data-origin", "shown");
  await page.keyboard.press("Escape");
  await expect(host).toHaveAttribute("data-origin", "hidden");
  expect(errors).toEqual([]);
});
