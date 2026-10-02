import express from "express";
import { validateStudy } from "./validation.mjs";
import multer from "multer";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export async function createServer({
  port = 4318,
  dataDir = path.join(root, ".bettersim"),
  resourceDir = root,
  workerExecutable = null,
  python = process.env.BETTERSIM_PYTHON ||
    path.join(
      root,
      ".venv",
      process.platform === "win32" ? "Scripts" : "bin",
      process.platform === "win32" ? "python.exe" : "python",
    ),
} = {}) {
  await fs.mkdir(dataDir, { recursive: true });
  const app = express();
  const ownOrigins = new Set([
    "http://127.0.0.1:5173",
    "http://localhost:5173",
  ]);
  const jobs = new Map();
  const children = new Set();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'self'",
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host || ""))
      return res.status(403).json({ error: "Invalid local host." });
    if (origin && !ownOrigins.has(origin))
      return res
        .status(403)
        .json({ error: "Requests must originate from BetterSim." });
    if (req.headers["sec-fetch-site"] === "cross-site")
      return res
        .status(403)
        .json({ error: "Cross-site requests are disabled." });
    next();
  });
  app.use(express.json({ limit: "64mb" }));
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 },
  });
  const folder = (id) => {
    if (!/^[a-f0-9-]{36}$/.test(id))
      throw new Error("Invalid document identifier.");
    return path.join(dataDir, id);
  };
  const run = (cmd, dir, study = {}) => {
    const id = randomUUID();
    const job = {
      id,
      status: "running",
      stage: cmd,
      message: "Starting…",
      started: Date.now(),
    };
    jobs.set(id, job);
    const child = spawn(
      workerExecutable || python,
      workerExecutable
        ? [cmd, dir]
        : [path.join(root, "engine", "worker.py"), cmd, dir],
      {
        env: {
          ...process.env,
          ...(workerExecutable
            ? {
                BETTERSIM_CCX: path.join(
                  resourceDir,
                  "runtime",
                  "solver",
                  "ccx",
                ),
              }
            : {}),
        },
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    );
    children.add(child);
    let out = "";
    let errors = "";
    let pending = "";
    child.stdin.end(JSON.stringify(study));
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.length > 100 * 1024 * 1024) {
        child.kill();
        job.error = "This job exceeded the supported model size.";
      }
    });
    child.stderr.on("data", (chunk) => {
      errors += chunk;
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        try {
          const p = JSON.parse(line);
          job.stage = p.stage;
          job.message = p.message;
        } catch {}
      }
    });
    child.on("error", (error) => {
      job.status = "error";
      job.error = `Could not start the analysis engine: ${error.message}. Run npm run setup.`;
      children.delete(child);
    });
    child.on("close", (code) => {
      children.delete(child);
      if (job.status === "cancelled") return;
      try {
        const response = JSON.parse(out.trim());
        if (!response.ok) throw new Error(response.error);
        job.status = "done";
        job.data = response.data;
        job.message = "Complete";
      } catch (error) {
        job.status = "error";
        job.error = error.message.includes("JSON")
          ? `Analysis engine failed (${code}). ${errors.slice(-3000)}`
          : error.message;
      }
      job.finished = Date.now();
    });
    job.child = child;
    return id;
  };
  const stop = (job) => {
    job.status = "cancelled";
    try {
      if (process.platform !== "win32") process.kill(-job.child.pid, "SIGTERM");
      else job.child.kill();
    } catch {}
  };
  app.get("/api/health", (_, res) =>
    res.json({
      ok: true,
      engine: existsSync(workerExecutable || python),
      platform: process.platform,
    }),
  );
  app.post("/api/import", upload.single("file"), async (req, res) => {
    if (!req.file || !/\.(step|stp)$/i.test(req.file.originalname))
      return res
        .status(400)
        .json({ error: "Choose a STEP file (.step or .stp)." });
    const id = randomUUID();
    const dir = folder(id);
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "part.step"), req.file.buffer);
    res.json({ id, name: req.file.originalname, job: run("import", dir) });
  });
  app.post("/api/sample/:name", async (req, res) => {
    if (!["beam", "bracket"].includes(req.params.name))
      return res.sendStatus(404);
    const id = randomUUID();
    const dir = folder(id);
    await fs.mkdir(dir);
    await fs.copyFile(
      path.join(resourceDir, "samples", req.params.name + ".step"),
      path.join(dir, "part.step"),
    );
    res.json({
      id,
      name:
        req.params.name === "beam"
          ? "Cantilever beam.step"
          : "Mounting bracket.step",
      job: run("import", dir),
    });
  });
  app.get("/api/jobs/:id", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.sendStatus(404);
    const { child, ...publicJob } = job;
    res.json(publicJob);
  });
  app.delete("/api/jobs/:id", (req, res) => {
    const job = jobs.get(req.params.id);
    if (job?.status === "running") stop(job);
    res.json({ ok: true });
  });
  app.post("/api/documents/:id/:action", async (req, res, next) => {
    const { id, action } = req.params;
    if (action === "save") return next();
    const dir = folder(id);
    await fs.access(path.join(dir, "geometry.json"));
    if (!["mesh", "solve"].includes(action)) return res.sendStatus(404);
    if (
      [...jobs.values()].some(
        (j) => j.status === "running" && j.document === id,
      )
    )
      return res
        .status(409)
        .json({ error: "A job is already running for this part." });
    validateStudy(req.body);
    const job = run(action, dir, req.body);
    jobs.get(job).document = id;
    res.json({ job });
  });
  app.post("/api/documents/:id/save", async (req, res) => {
    validateStudy(req.body.study);
    const step = await fs.readFile(
      path.join(folder(req.params.id), "part.step"),
    );
    res.json({
      format: "bettersim",
      version: 1,
      name: req.body.name,
      step: step.toString("base64"),
      study: req.body.study,
    });
  });
  app.post("/api/open", async (req, res) => {
    const project = req.body;
    if (
      project.format !== "bettersim" ||
      project.version !== 1 ||
      typeof project.step !== "string" ||
      !project.study
    )
      return res
        .status(400)
        .json({ error: "This is not a supported BetterSim project." });
    validateStudy(project.study);
    const bytes = Buffer.from(project.step, "base64");
    if (
      bytes.length > 50 * 1024 * 1024 ||
      !bytes.subarray(0, 1000).toString().includes("ISO-10303-21")
    )
      return res
        .status(400)
        .json({ error: "The project contains invalid STEP geometry." });
    const id = randomUUID();
    const dir = folder(id);
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "part.step"), bytes);
    res.json({
      id,
      name: String(project.name || "Untitled part"),
      study: project.study,
      job: run("import", dir),
    });
  });
  app.get("/api/documents/:id/export/:file", async (req, res) => {
    const allowed = {
      deck: "analysis.inp",
      log: "solver.log",
      mesh: "part.msh",
      frd: "analysis.frd",
    };
    const file = allowed[req.params.file];
    if (!file) return res.sendStatus(404);
    res.download(path.join(folder(req.params.id), file), file);
  });
  app.use(express.static(path.join(root, "dist")));
  app.get("/", (_, res) => res.sendFile(path.join(root, "dist", "index.html")));
  app.use((error, req, res, next) =>
    res.status(400).json({ error: error.message || "The request failed." }),
  );
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(port, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
  ownOrigins.add("http://127.0.0.1:" + server.address().port);
  ownOrigins.add("http://localhost:" + server.address().port);
  const cleanup = setInterval(() => {
    for (const [id, j] of jobs) {
      if (
        j.status !== "running" &&
        Date.now() - (j.finished || j.started) > 3600000
      )
        jobs.delete(id);
    }
  }, 60000);
  cleanup.unref();
  return {
    server,
    port: server.address().port,
    close: async () => {
      clearInterval(cleanup);
      for (const child of children) {
        try {
          if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
          else child.kill();
        } catch {}
      }
      await new Promise((r) => server.close(r));
    },
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  createServer().then((s) =>
    console.log(`BetterSim engine: http://127.0.0.1:${s.port}`),
  );
