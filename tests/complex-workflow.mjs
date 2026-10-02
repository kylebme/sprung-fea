import { expect } from "@playwright/test";
import path from "node:path";

export async function configureComplexPart(page, name) {
  const imported = page.waitForResponse(async (response) => {
    if (!response.url().includes("/api/jobs/") || !response.ok()) return false;
    const body = await response.json();
    return body.status === "done" && Array.isArray(body.data?.faces);
  });
  await page
    .locator('input[type=file][accept=".step,.stp"]')
    .setInputFiles(path.resolve(`samples/${name}.step`));
  const geometry = (await (await imported).json()).data;
  await expect(
    page.getByRole("heading", { name: "Your part, ready." }),
  ).toBeVisible({ timeout: 60000 });
  const planeAt = (axis, value) => {
    const planes = geometry.faces.filter(
      (f) => f.type === "Plane" && Math.abs(f.center[axis] - value) < 1e-4,
    );
    return planes.sort((a, b) => b.area - a.area)[0].id;
  };
  const cases = {
    "bearing-block": {
      support: () => planeAt(2, 0),
      load: () =>
        geometry.faces
          .filter((f) => f.type === "Cylinder")
          .sort((a, b) => b.area - a.area)[0].id,
      vector: [500, 0, 0],
      size: 5,
    },
    "ribbed-bracket": {
      support: () => planeAt(2, 0),
      load: () => planeAt(0, 8),
      vector: [300, 0, 0],
      size: 5,
    },
    "pocketed-housing": {
      support: () => planeAt(2, 0),
      load: () => planeAt(2, 32),
      vector: [0, 0, -500],
      size: 4,
    },
    "tube-elbow": {
      support: () => planeAt(1, -5),
      load: () => planeAt(0, -5),
      vector: [0, 0, -100],
      size: 4,
    },
  };
  const c = cases[name];
  await page
    .getByRole("button", { name: "Choose a material", exact: true })
    .click();
  await page.getByRole("button", { name: /Aluminum 6061-T6/ }).click();
  await page.getByRole("button", { name: "Use this material" }).click();
  await page.getByRole("button", { name: "Add support", exact: true }).click();
  await page
    .getByRole("button", { name: new RegExp(`^Face ${c.support()}\\b`) })
    .click();
  await page.getByRole("button", { name: "Save support" }).click();
  await page.getByRole("button", { name: /Loads Apply a load/ }).click();
  await page.getByRole("button", { name: "Add load", exact: true }).click();
  await page
    .getByRole("button", { name: new RegExp(`^Face ${c.load()}\\b`) })
    .click();
  for (const [i, axis] of ["X", "Y", "Z"].entries()) {
    await page
      .getByLabel(`${axis} force`, { exact: true })
      .fill(String(c.vector[i]));
  }
  await page.getByRole("button", { name: "Save load" }).click();
  await page.getByRole("button", { name: /Mesh Balanced/ }).click();
  await page.getByText("Advanced mesh settings", { exact: true }).click();
  await page.getByLabel(/^Target element size/).fill(String(c.size));
  return geometry;
}
