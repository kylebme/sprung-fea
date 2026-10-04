// Records the README demo against `npm run dev`. Drives the real app in
// headless Chrome and keeps every repaint from the CDP screencast, with a
// drawn cursor and click rings. scripts/demo-media.py then cuts the frames
// into docs/media/. CAD faces are clicked by face number: before recording,
// a hover sweep over the model reads which face the app reports at each point.
import { chromium } from "@playwright/test";
import fs from "node:fs";

const OUT = "output/demo";
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT + "/frames", { recursive: true });

const W = 1280,
  H = 800,
  DSF = 1.5;
const browser = await chromium.launch({
  executablePath:
    process.env.SPRUNG_FEA_CHROMIUM ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  // Headless screencasts are only full density when the scale is a flag.
  args: [
    "--enable-webgl",
    "--use-gl=angle",
    "--hide-scrollbars",
    `--force-device-scale-factor=${DSF}`,
    `--window-size=${W},${H + 87}`,
  ],
});
const ctx = await browser.newContext({
  viewport: null,
  colorScheme: "dark",
  bypassCSP: true,
});

// A visible cursor and a brief ring on each click.
await ctx.addInitScript(() => {
  const install = () => {
    if (document.getElementById("__cursor")) return;
    const c = document.createElement("div");
    c.id = "__cursor";
    c.innerHTML =
      '<svg width="22" height="24" viewBox="0 0 22 24"><path d="M3 2 L3 19.5 L7.6 15.4 L10.7 22 L13.6 20.7 L10.6 14.2 L16.8 14.2 Z" fill="#ffffff" stroke="#0b0d10" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, {
      position: "fixed",
      left: "0",
      top: "0",
      zIndex: "2147483647",
      pointerEvents: "none",
      transform: "translate(-100px,-100px)",
      filter: "drop-shadow(0 1px 2px rgba(0,0,0,.5))",
    });
    document.documentElement.appendChild(c);
    let x = -100,
      y = -100;
    const place = (s = 1) =>
      (c.style.transform = `translate(${x - 3}px, ${y - 2}px) scale(${s})`);
    addEventListener(
      "mousemove",
      (e) => {
        x = e.clientX;
        y = e.clientY;
        place();
      },
      true,
    );
    addEventListener(
      "mousedown",
      (e) => {
        place(0.85);
        const r = document.createElement("div");
        Object.assign(r.style, {
          position: "fixed",
          left: e.clientX - 18 + "px",
          top: e.clientY - 18 + "px",
          width: "36px",
          height: "36px",
          borderRadius: "50%",
          border: "2px solid #4d9bff",
          background: "rgba(77,155,255,.18)",
          pointerEvents: "none",
          zIndex: "2147483646",
        });
        document.documentElement.appendChild(r);
        r.animate(
          [
            { transform: "scale(.35)", opacity: 1 },
            { transform: "scale(1.25)", opacity: 0 },
          ],
          { duration: 520, easing: "cubic-bezier(.2,.7,.3,1)" },
        ).onfinish = () => r.remove();
      },
      true,
    );
    addEventListener("mouseup", () => place(), true);
  };
  if (document.readyState === "loading")
    addEventListener("DOMContentLoaded", install);
  else install();
});

// Start without a previous autosave, and leave the real one alone.
await ctx.route("**/api/recovery", (r) =>
  r.request().method() === "GET"
    ? r.fulfill({ json: null })
    : r.fulfill({ json: { at: Date.now() } }),
);
const APP = "http://127.0.0.1:5173";
const nextFrame = (page) =>
  page.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );

/**
 * Finds a screen point well inside each requested face of the mounting
 * bracket in its opening view. The status bar names the face under the
 * cursor, so a coarse sweep finds each face and a fine one finds its middle.
 */
async function locateFaces(ids) {
  const page = await ctx.newPage();
  await page.goto(APP);
  await page.getByRole("button", { name: /^Mounting bracket.*Open$/ }).click();
  const status = page.locator("footer.status");
  const box = await page.locator("canvas").boundingBox();
  const faceAt = async (x, y) => {
    await page.mouse.move(x, y);
    await nextFrame(page);
    return /Face (\d+) ·/.exec(await status.innerText())?.[1] ?? null;
  };
  for (
    let i = 0;
    !(await faceAt(box.x + box.width / 2, box.y + box.height / 2));
    i++
  ) {
    if (i > 100) throw new Error("the 3D view did not start");
    await page.mouse.move(box.x + 5, box.y + 5);
    await page.waitForTimeout(100);
  }
  const samples = [];
  const sweep = async (x0, y0, x1, y1, step) => {
    for (let y = y0; y <= y1; y += step)
      for (let x = x0; x <= x1; x += step)
        samples.push({ x, y, face: await faceAt(x, y) });
  };
  await sweep(
    box.x + 12,
    box.y + 12,
    box.x + box.width - 12,
    box.y + box.height - 12,
    26,
  );
  const found = {};
  for (const id of ids) {
    const hits = samples.filter((p) => p.face === String(id));
    if (!hits.length) throw new Error(`Face ${id} is not visible`);
    const xs = hits.map((p) => p.x),
      ys = hits.map((p) => p.y);
    await sweep(
      Math.min(...xs) - 26,
      Math.min(...ys) - 26,
      Math.max(...xs) + 26,
      Math.max(...ys) + 26,
      6,
    );
    // The face sample farthest from any other face or the background.
    const others = samples.filter((p) => p.face !== String(id));
    let best = null,
      clearance = -1;
    for (const p of samples.filter((q) => q.face === String(id))) {
      const d = Math.min(
        ...others.map((o) => Math.hypot(o.x - p.x, o.y - p.y)),
      );
      if (d > clearance) [best, clearance] = [p, d];
    }
    found[id] = [best.x, best.y];
  }
  await page.close();
  return found;
}
// Faces 6 and 7 are the wall-plate bolt holes, face 9 the top of the base.
const face = await locateFaces([6, 7, 9]);
console.log("faces at", face);

const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
const frames = [];
cdp.on("Page.screencastFrame", (f) => {
  const name = `f${String(frames.length).padStart(5, "0")}.jpg`;
  fs.writeFileSync(`${OUT}/frames/${name}`, Buffer.from(f.data, "base64"));
  frames.push({ name, t: f.metadata.timestamp });
  cdp
    .send("Page.screencastFrameAck", { sessionId: f.sessionId })
    .catch(() => {});
});
// Each clip runs from its start mark to its end mark; steps between clips
// appear only in the full video.
const marks = [];
const mark = (name) => marks.push({ name, t: Date.now() / 1000 });

const insp = page.getByRole("complementary", { name: "Inspector" });
const wait = (ms) => page.waitForTimeout(ms);
let pos = { x: W * 0.55, y: H * 0.6 };
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

async function glide(x, y) {
  const d = Math.hypot(x - pos.x, y - pos.y);
  const n = Math.round(Math.min(950, Math.max(380, 300 + d * 0.7)) / 16);
  const from = { ...pos };
  for (let i = 1; i <= n; i++) {
    const k = ease(i / n);
    await page.mouse.move(from.x + (x - from.x) * k, from.y + (y - from.y) * k);
    await wait(12);
  }
  pos = { x, y };
}
async function clickAt(x, y, after = 450) {
  await glide(x, y);
  await wait(140);
  await page.mouse.down();
  await wait(90);
  await page.mouse.up();
  await wait(after);
}
/**
 * Scrolls an element into view with the wheel, over the panel that holds
 * it, as a person would. Elements outside a scrolling panel are left alone.
 */
async function reveal(loc) {
  await loc.waitFor();
  let last = null;
  for (let i = 0; i < 40; i++) {
    const { r, c } = await loc.evaluate((e) => {
      let p = e.parentElement;
      while (
        p &&
        !(
          /auto|scroll/.test(getComputedStyle(p).overflowY) &&
          p.scrollHeight > p.clientHeight
        )
      )
        p = p.parentElement;
      const b = e.getBoundingClientRect();
      return {
        r: { x: b.x, y: b.y, width: b.width, height: b.height },
        c: p && p.getBoundingClientRect().toJSON(),
      };
    });
    if (
      !c ||
      (r.y >= c.top + 6 && r.y + r.height <= c.bottom - 6) ||
      r.y === last
    )
      return r;
    last = r.y;
    const x = Math.min(Math.max(r.x + r.width / 2, c.left + 30), c.right - 30);
    const y = (c.top + c.bottom) / 2;
    if (Math.hypot(pos.x - x, pos.y - y) > 30) await glide(x, y);
    const need =
      r.y < c.top ? r.y - c.top - 24 : r.y + r.height - c.bottom + 24;
    await page.mouse.wheel(0, Math.max(-100, Math.min(100, need)));
    await wait(60);
  }
  throw new Error("could not reveal element");
}
async function click(loc, after = 450) {
  const b = await reveal(loc);
  await clickAt(b.x + Math.min(b.width / 2, 60), b.y + b.height / 2, after);
}
async function type(loc, text) {
  await click(loc, 150);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(text, { delay: 110 });
  await wait(350);
}
async function drag(x0, y0, dx, dy, n) {
  await glide(x0, y0);
  await wait(150);
  await page.mouse.down();
  for (let i = 1; i <= n; i++) {
    await page.mouse.move(x0 + dx * ease(i / n), y0 + dy * ease(i / n));
    await wait(14);
  }
  await page.mouse.up();
  pos = { x: x0 + dx, y: y0 + dy };
}
/** Drags a range slider's thumb through fractions of its travel. */
async function slide(loc, stops) {
  const s = await reveal(loc);
  const at = (f) => s.x + s.width * f;
  const y = s.y + s.height / 2;
  const v = await loc.evaluate((e) => (e.value - e.min) / (e.max - e.min));
  await glide(at(v), y);
  await wait(150);
  await page.mouse.down();
  for (const f of stops) {
    const x0 = pos.x;
    const n = Math.max(12, Math.round(Math.abs(at(f) - x0) / 4));
    for (let i = 1; i <= n; i++) {
      await page.mouse.move(x0 + (at(f) - x0) * ease(i / n), y);
      await wait(16);
    }
    pos = { x: at(f), y };
    await wait(250);
  }
  await page.mouse.up();
}
const btn = (name, o = {}) => page.getByRole("button", { name, ...o });
async function solve(heading) {
  await click(page.locator("header button.solve"), 100);
  await page
    .getByRole("heading", { name: heading })
    .waitFor({ timeout: 90000 });
}

await page.goto(APP);
await page.evaluate(() => {
  localStorage.clear();
  localStorage.setItem("sprung-fea-theme", "dark");
});
await page.reload();
await page.getByRole("button", { name: /^Mounting bracket.*Open$/ }).waitFor();
const inner = await page.evaluate(() => [innerWidth, innerHeight]);
if (inner[0] !== W || inner[1] !== H) throw new Error("viewport " + inner);
await page.mouse.move(pos.x, pos.y);
await wait(500);
await cdp.send("Page.startScreencast", {
  format: "jpeg",
  quality: 90,
  maxWidth: W * DSF,
  maxHeight: H * DSF,
});
await wait(300);

// 1. Set up a static study: wall-mounted bracket, 500 N down on the base.
mark("setup:start");
await wait(1200);
await click(btn(/^Mounting bracket.*Open$/), 2600);
await click(btn("Set material"), 700);
await click(btn(/Aluminum 6061-T6/), 700);
await click(btn("Apply material"), 600);
await click(
  insp.getByRole("button", { name: "Add support", exact: true }),
  500,
);
await clickAt(...face[7], 400);
await clickAt(...face[6], 700);
await click(btn("Save support"), 600);
await click(btn("Loads", { exact: true }), 400);
await click(insp.getByRole("button", { name: "Add load", exact: true }), 500);
await clickAt(...face[9], 500);
await type(page.getByLabel("Z force", { exact: true }), "-500");
await click(btn("Save load"), 600);
await solve("von Mises stress");
await wait(2400);
mark("setup:end");

// 2. Static results: orbit, deflection, probe, a section square to the view.
mark("static-results:start");
await wait(600);
await drag(face[9][0] - 60, face[9][1] + 60, 90, -6, 60);
await wait(1300);
await click(btn("Iso", { exact: true }), 900);
await click(btn("Displacement", { exact: true }), 600);
await click(btn("Magnified"), 1600);
await clickAt(...face[9], 1600);
await click(btn("Max principal stress", { exact: true }), 1200);
await click(page.getByRole("switch", { name: "Section" }), 500);
const normal = page.getByRole("group", { name: "Section normal" });
await click(normal.getByRole("button", { name: "Y", exact: true }), 400);
// Keep the far half, so the cut faces the Front view.
await click(normal.getByRole("button", { name: "Flip" }), 400);
await click(btn("Front", { exact: true }), 1000);
await slide(page.getByLabel("Section position"), [0.2, 0.8, 0.27]);
await wait(1800);
mark("static-results:end");
await click(page.getByRole("switch", { name: "Section" }), 300);
await click(btn("Iso", { exact: true }), 600);

// 3. Natural frequencies: the same supports, animated mode shapes.
mark("natural-frequencies:start");
await wait(600);
await click(btn(/^Analysis/), 600);
await click(insp.getByRole("button", { name: /^Natural frequencies/ }), 700);
await solve("Mode shape");
await glide(1130, 300);
await wait(3600);
const modes = page.getByRole("table", { name: "Modes" }).locator("tbody tr");
await click(modes.nth(1), 3600);
await click(modes.last(), 3800);
mark("natural-frequencies:end");

// 4. Heat transfer: 15 W into the base, wall bolts held at 20 °C.
mark("heat-transfer:start");
await wait(600);
await click(btn(/^Analysis/), 600);
await click(insp.getByRole("button", { name: /^Heat transfer/ }), 700);
await click(btn("Add thermal condition").first(), 500);
await clickAt(...face[7], 400);
await clickAt(...face[6], 500);
await type(insp.getByLabel(/^Temperature/), "20");
await click(btn("Save condition"), 500);
await click(btn("Add thermal condition").first(), 500);
await click(
  page
    .getByRole("group", { name: "Thermal type" })
    .getByRole("button", { name: "Heat flow", exact: true }),
  400,
);
await clickAt(...face[9], 400);
await type(insp.getByLabel(/^Total heat flow/), "15");
await click(btn("Save condition"), 500);
await solve("Temperature");
await wait(2800);
mark("heat-transfer:end");
await wait(300);

await cdp.send("Page.stopScreencast");
await wait(300);
fs.writeFileSync(`${OUT}/timeline.json`, JSON.stringify({ frames, marks }));
console.log(`${frames.length} frames in ${OUT}`);
await browser.close();
