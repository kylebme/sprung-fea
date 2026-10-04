import express from "express";
import { validateRegion, validateStudy, RequestError } from "./validation.mjs";
import multer from "multer";
import { execFileSync, spawn } from "node:child_process";
import os from "node:os";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/**
 * Logical cores, and performance cores where the platform reports them
 * (Apple Silicon). Automatic thread counts use performance cores, since
 * efficiency cores slow down a parallel factorization that waits for them.
 */
function cores() {
  const logical = os.availableParallelism();
  let performance = logical;
  if (process.platform === "darwin")
    try {
      performance =
        Number(execFileSync("sysctl", ["-n", "hw.perflevel0.physicalcpu"])) ||
        logical;
    } catch {}
  return { logical, performance: Math.min(performance, logical) };
}
/**
 * Stops an engine and the CalculiX process it started: the engine's process
 * group on POSIX, its process tree on Windows.
 */
function terminate(child) {
  try {
    if (process.platform === "win32")
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
      });
    else process.kill(-child.pid, "SIGTERM");
  } catch {}
}
export async function createServer({
  port = 4318,
  dataDir = path.join(root, ".sprung-fea"),
  resourceDir = root,
  workerExecutable = null,
  keepDocuments = 40,
  maxDocumentAge = 7 * 24 * 3600000,
  python = process.env.SPRUNG_FEA_PYTHON ||
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
    // VTK.wasm needs WebAssembly compilation, and its Emscripten embind glue
    // generates invokers with new Function, hence 'unsafe-eval'.
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'self'",
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
        .json({ error: "Requests must originate from Sprung FEA." });
    if (req.headers["sec-fetch-site"] === "cross-site")
      return res
        .status(403)
        .json({ error: "Cross-site requests are disabled." });
    next();
  });
  // Projects embed STEP files of up to 50 MB as base64 (4/3 larger).
  app.use(express.json({ limit: "70mb" }));
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 },
  });
  const folder = (id) => {
    if (!/^[a-f0-9-]{36}$/.test(id))
      throw new RequestError("Invalid document identifier.");
    return path.join(dataDir, id);
  };
  // Marks a document as recently used so pruning keeps it.
  const touch = (id) => {
    const now = new Date();
    return fs.utimes(folder(id), now, now).catch(() => {});
  };
  const prune = async () => {
    const busy = new Set(
      [...jobs.values()]
        .filter((j) => j.status === "running")
        .map((j) => j.document),
    );
    const documents = [];
    for (const entry of await fs.readdir(dataDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
      const { mtimeMs } = await fs.stat(path.join(dataDir, entry.name));
      documents.push({ id: entry.name, used: mtimeMs });
    }
    documents.sort((a, b) => b.used - a.used);
    const now = Date.now();
    for (const [i, d] of documents.entries()) {
      if (busy.has(d.id) || now - d.used < 3600000) continue;
      if (i >= keepDocuments || now - d.used > maxDocumentAge)
        await fs.rm(path.join(dataDir, d.id), { recursive: true, force: true });
    }
  };
  const recoveryDir = path.join(dataDir, "recovery");
  const cpus = cores();
  const run = (cmd, dir, study = {}, threads = cpus.performance) => {
    const id = randomUUID();
    const job = {
      id,
      status: "running",
      stage: cmd,
      message: "Starting",
      started: Date.now(),
      document: path.basename(dir),
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
          SPRUNG_FEA_THREADS: String(threads),
          ...(workerExecutable
            ? {
                SPRUNG_FEA_CCX: path.join(
                  resourceDir,
                  "runtime",
                  "solver",
                  process.platform === "win32" ? "ccx.exe" : "ccx",
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
    terminate(job.child);
  };
  app.get("/api/health", (_, res) =>
    res.json({
      ok: true,
      engine: existsSync(workerExecutable || python),
      cpus,
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
    const samples = {
      beam: "Cantilever beam.step",
      bracket: "Mounting bracket.step",
      "post-plate": "Post on plate.step",
    };
    if (!samples[req.params.name]) return res.sendStatus(404);
    const id = randomUUID();
    const dir = folder(id);
    await fs.mkdir(dir);
    await fs.copyFile(
      path.join(resourceDir, "samples", req.params.name + ".step"),
      path.join(dir, "part.step"),
    );
    res.json({
      id,
      name: samples[req.params.name],
      sample: req.params.name,
      job: run("import", dir),
    });
  });
  const readRecovery = async () => {
    try {
      return JSON.parse(
        await fs.readFile(path.join(recoveryDir, "state.json"), "utf8"),
      );
    } catch {
      return null;
    }
  };
  // Autosave keeps one recovery copy on disk, outside pruned documents.
  app.get("/api/recovery", async (_, res) => {
    const state = await readRecovery();
    res.json(state && { name: state.name, at: state.at });
  });
  app.post("/api/recovery", async (req, res) => {
    const { id, name, study, sample } = req.body;
    validateStudy(study);
    if (typeof name !== "string" || !name.trim() || name.length > 200)
      throw new RequestError("A part name is required.");
    const source = path.join(folder(id), "part.step");
    await fs.access(source);
    await fs.mkdir(recoveryDir, { recursive: true });
    const previous = await readRecovery();
    if (previous?.document !== id) {
      await fs.copyFile(source, path.join(recoveryDir, "part.step.tmp"));
      await fs.rename(
        path.join(recoveryDir, "part.step.tmp"),
        path.join(recoveryDir, "part.step"),
      );
    }
    const state = {
      document: id,
      name,
      study,
      sample: ["beam", "bracket", "post-plate"].includes(sample)
        ? sample
        : undefined,
      at: Date.now(),
    };
    await fs.writeFile(
      path.join(recoveryDir, "state.json.tmp"),
      JSON.stringify(state),
    );
    await fs.rename(
      path.join(recoveryDir, "state.json.tmp"),
      path.join(recoveryDir, "state.json"),
    );
    await touch(id);
    res.json({ at: state.at });
  });
  app.post("/api/recovery/open", async (_, res) => {
    const state = await readRecovery();
    if (!state)
      return res.status(404).json({ error: "There is no autosaved study." });
    validateStudy(state.study);
    const id = randomUUID();
    const dir = folder(id);
    await fs.mkdir(dir);
    await fs.copyFile(
      path.join(recoveryDir, "part.step"),
      path.join(dir, "part.step"),
    );
    res.json({
      id,
      name: state.name,
      study: state.study,
      sample: state.sample,
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
    if (!["mesh", "solve", "converge", "submodel"].includes(action))
      return res.sendStatus(404);
    await fs.access(path.join(dir, "geometry.json"));
    await touch(id);
    if (
      [...jobs.values()].some(
        (j) => j.status === "running" && j.document === id,
      )
    )
      return res
        .status(409)
        .json({ error: "A job is already running for this part." });
    validateStudy(action === "submodel" ? req.body?.study : req.body);
    if (action === "submodel") validateRegion(req.body.region);
    // Threads are a machine preference, not part of the study: CalculiX
    // gives identical results with any count.
    let threads = cpus.performance;
    if (req.query.threads !== undefined) {
      threads = Number(req.query.threads);
      if (!Number.isInteger(threads) || threads < 1 || threads > cpus.logical)
        throw new RequestError(
          `Threads must be a whole number from 1 to ${cpus.logical}.`,
        );
    }
    let payload = req.body;
    if (action === "converge") {
      // A convergence study solves on 2–6 successively finer meshes until
      // the key results change by less than the tolerance (a fraction).
      const runs = Number(req.query.runs ?? 3);
      const tolerance = Number(req.query.tolerance ?? 0.02);
      if (!Number.isInteger(runs) || runs < 2 || runs > 6)
        throw new RequestError("A convergence study uses 2 to 6 meshes.");
      if (!(tolerance >= 0.001 && tolerance <= 0.2))
        throw new RequestError(
          "The convergence tolerance must lie between 0.1% and 20%.",
        );
      payload = { study: req.body, options: { runs, tolerance } };
    }
    const job = run(action, dir, payload, threads);
    jobs.get(job).document = id;
    res.json({ job });
  });
  app.post("/api/documents/:id/save", async (req, res) => {
    validateStudy(req.body.study);
    const step = await fs.readFile(
      path.join(folder(req.params.id), "part.step"),
    );
    await touch(req.params.id);
    res.json({
      format: "sprung-fea",
      version: 1,
      name: req.body.name,
      step: step.toString("base64"),
      study: req.body.study,
    });
  });
  app.post("/api/open", async (req, res) => {
    const project = req.body;
    if (
      project.format !== "sprung-fea" ||
      project.version !== 1 ||
      typeof project.step !== "string" ||
      !project.study
    )
      return res
        .status(400)
        .json({ error: "This is not a supported Sprung FEA project." });
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
  // Mesh and nodal results for the viewer, in the engine's binary layout.
  // ?region=1 serves the refined region of a submodel solve.
  app.get("/api/documents/:id/view", async (req, res) => {
    const target = path.join(
      folder(req.params.id),
      req.query.region ? "region" : "",
      "view.bin",
    );
    try {
      await fs.access(target);
    } catch {
      return res.status(404).json({ error: "Mesh the part first." });
    }
    await touch(req.params.id);
    res.sendFile(target, {
      dotfiles: "allow",
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store",
      },
    });
  });
  app.get("/api/documents/:id/export/:file", async (req, res) => {
    const allowed = {
      deck: "analysis.inp",
      log: "solver.log",
      mesh: "part.msh",
      frd: "analysis.frd",
      "region-deck": "region/analysis.inp",
      "region-log": "region/solver.log",
      "region-frd": "region/analysis.frd",
    };
    const file = allowed[req.params.file];
    if (!file) return res.sendStatus(404);
    const target = path.join(folder(req.params.id), file);
    try {
      await fs.access(target);
    } catch {
      return res.status(404).json({
        error: "Solver files are not available. Solve the study first.",
      });
    }
    await touch(req.params.id);
    // Development data lives in .sprung-fea/, which send() ignores by default.
    res.download(target, path.basename(file), { dotfiles: "allow" });
  });
  app.use(express.static(path.join(root, "dist")));
  app.get("/", (_, res) => res.sendFile(path.join(root, "dist", "index.html")));
  app.use((error, req, res, next) => {
    let status = error.status || error.statusCode || 500;
    let message = error.message || "The request failed.";
    if (error.code === "ENOENT") {
      status = 404;
      message =
        "This part's working files are no longer available. Open the project or STEP file again.";
    } else if (error.code === "LIMIT_FILE_SIZE") {
      status = 413;
      message = "STEP files are limited to 50 MB.";
    } else if (error.type === "entity.too.large") {
      status = 413;
      message = "This project is larger than the supported 50 MB of STEP data.";
    } else if (error.type === "entity.parse.failed") {
      status = 400;
      message = "The request is not valid JSON.";
    } else if (status >= 500) {
      console.error(error);
      message = "The local service failed unexpectedly.";
    }
    res.status(status).json({ error: message });
  });
  await prune().catch(console.error);
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
  const pruning = setInterval(() => prune().catch(console.error), 3600000);
  pruning.unref();
  return {
    server,
    port: server.address().port,
    close: async () => {
      clearInterval(cleanup);
      clearInterval(pruning);
      for (const child of children) terminate(child);
      await new Promise((r) => server.close(r));
    },
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  createServer().then((s) =>
    console.log(`Sprung FEA engine: http://127.0.0.1:${s.port}`),
  );
