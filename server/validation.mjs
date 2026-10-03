export const SOLVERS = ["spooles", "iterative-scaling", "iterative-cholesky"];
/** Analysis types the engine implements (engine/analyses.py). */
export const ANALYSES = ["static"];
// Errors caused by the request itself; the service reports them as 400.
export class RequestError extends Error {
  status = 400;
}
const number = (v, name, { positive = false } = {}) => {
  if (typeof v !== "number" || !Number.isFinite(v) || (positive && v <= 0))
    throw new RequestError(
      `${name} must be a finite${positive ? " positive" : ""} number.`,
    );
  return v;
};
const text = (v, name) => {
  if (typeof v !== "string" || v.length > 200 || !v.trim())
    throw new RequestError(`${name} must be a short, nonempty name.`);
  return v;
};
const faces = (v) => {
  if (
    !Array.isArray(v) ||
    v.length > 10000 ||
    v.some((f) => !Number.isInteger(f) || f <= 0) ||
    new Set(v).size !== v.length
  )
    throw new RequestError("Select valid, unique faces.");
  return v;
};
export function validateStudy(s) {
  if (
    !s ||
    typeof s !== "object" ||
    !Array.isArray(s.supports) ||
    !Array.isArray(s.loads) ||
    s.supports.length > 100 ||
    s.loads.length > 100
  )
    throw new RequestError("This project contains an invalid study setup.");
  // Projects saved before 0.2 used Quick/Balanced for Coarse/Medium.
  s.detail = { quick: "coarse", balanced: "medium" }[s.detail] || s.detail;
  if (!["coarse", "medium", "fine", "custom"].includes(s.detail))
    throw new RequestError("The mesh detail setting is invalid.");
  number(s.meshSize, "Mesh size", { positive: true });
  // Studies saved before solver choice used the direct solver, and studies
  // saved before analysis types were linear static.
  s.solver ??= "spooles";
  s.analysis ??= "static";
  if (!ANALYSES.includes(s.analysis))
    throw new RequestError("This analysis type is not available.");
  if (!SOLVERS.includes(s.solver))
    throw new RequestError("The solver setting is invalid.");
  if (s.material) {
    const m = s.material;
    text(m.name, "Material name");
    number(m.young, "Elastic modulus", { positive: true });
    number(m.poisson, "Poisson ratio");
    if (m.poisson <= -1 || m.poisson >= 0.499)
      throw new RequestError("Poisson ratio must lie between -1 and 0.499.");
    number(m.density, "Density", { positive: true });
    if (m.yield !== null) number(m.yield, "Yield strength", { positive: true });
  }
  for (const c of [...s.supports, ...s.loads]) {
    text(c.id, "Condition identifier");
    text(c.name, "Condition name");
    faces(c.faces);
  }
  if (
    new Set([...s.supports, ...s.loads].map((c) => c.id)).size !==
    s.supports.length + s.loads.length
  )
    throw new RequestError("Condition identifiers must be unique.");
  for (const c of s.supports) {
    if (
      !Array.isArray(c.axes) ||
      c.axes.length !== 3 ||
      c.axes.some((a) => typeof a !== "boolean") ||
      !c.axes.some(Boolean) ||
      !c.faces.length
    )
      throw new RequestError(
        "A support must select faces and block at least one direction.",
      );
  }
  for (const c of s.loads) {
    if (!["force", "pressure", "gravity"].includes(c.kind))
      throw new RequestError("Unsupported load type.");
    if (c.kind !== "gravity" && !c.faces.length)
      throw new RequestError("A surface load must select at least one face.");
    if (c.kind === "pressure") number(c.magnitude, "Pressure");
    else {
      if (!Array.isArray(c.vector) || c.vector.length !== 3)
        throw new RequestError("A load must have three components.");
      c.vector.forEach((v) => number(v, "Load component"));
    }
  }
  return s;
}
