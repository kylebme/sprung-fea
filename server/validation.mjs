/** Equation solvers: `direct` and `iterative` are the fastest of each kind
 * the engine has here; the others name one iterative solver. */
export const SOLVERS = [
  "direct",
  "iterative",
  "iterative-amg",
  "iterative-scaling",
  "iterative-cholesky",
];
/** Where the iterative solver runs, a machine preference. */
export const DEVICES = ["cpu", "gpu"];
/** Load kinds; body loads act on the whole part rather than faces. */
export const LOADS = [
  "force",
  "pressure",
  "gravity",
  "remote",
  "moment",
  "bearing",
  "rotation",
];
const BODY_LOADS = ["gravity", "rotation"];
const vector = (v, name) => {
  if (!Array.isArray(v) || v.length !== 3)
    throw new RequestError(`A ${name} must have three components.`);
  v.forEach((x) =>
    number(x, `${name[0].toUpperCase() + name.slice(1)} component`),
  );
  return v;
};
/** Analysis types the engine implements (engine/analyses.py). */
export const ANALYSES = [
  "static",
  "frequency",
  "buckling",
  "thermal",
  "thermalStress",
  "harmonic",
];
/** Thermal conditions; generation acts on the whole part. */
export const THERMAL = [
  "temperature",
  "heat",
  "convection",
  "radiation",
  "generation",
];
/** How touching bodies interact (engine/contact.py KINDS). */
export const CONTACTS = ["bonded", "frictional", "frictionless"];
/** What a support's blocked directions refer to (engine/model.py FRAMES). */
export const FRAMES = ["global", "normal", "cylinder"];
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
/** A submodel region: a box (center and size in mm) and its element size. */
export function validateRegion(r) {
  if (!r || typeof r !== "object")
    throw new RequestError("Define the region to refine.");
  vector(r.center, "region center");
  vector(r.size, "region size");
  if (r.size.some((v) => v <= 0))
    throw new RequestError("The region needs a positive size in X, Y and Z.");
  number(r.meshSize, "Region element size", { positive: true });
  return r;
}

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
  // Studies saved before solver choice used the direct solver, then named
  // after SPOOLES; studies saved before analysis types were linear static.
  s.solver ??= "direct";
  if (s.solver === "spooles") s.solver = "direct";
  s.analysis ??= "static";
  if (!ANALYSES.includes(s.analysis))
    throw new RequestError("This analysis type is not available.");
  // Mode count for vibration studies.
  if (
    s.modes !== undefined &&
    (!Number.isInteger(s.modes) || s.modes < 1 || s.modes > 50)
  )
    throw new RequestError("Ask for 1 to 50 modes.");
  if (!SOLVERS.includes(s.solver))
    throw new RequestError("The solver setting is invalid.");
  const material = (m) => {
    text(m.name, "Material name");
    number(m.young, "Elastic modulus", { positive: true });
    number(m.poisson, "Poisson ratio");
    if (m.poisson <= -1 || m.poisson >= 0.499)
      throw new RequestError("Poisson ratio must lie between -1 and 0.499.");
    number(m.density, "Density", { positive: true });
    if (m.yield !== null) number(m.yield, "Yield strength", { positive: true });
    // Thermal properties are optional; thermal studies require them.
    if (m.conductivity != null)
      number(m.conductivity, "Thermal conductivity", { positive: true });
    if (m.expansion != null) number(m.expansion, "Thermal expansion");
    // Plasticity: ultimate strength (MPa) and elongation at break (%).
    if (m.ultimate != null)
      number(m.ultimate, "Ultimate strength", { positive: true });
    if (m.elongation != null)
      number(m.elongation, "Elongation at break", { positive: true });
    if (m.specificHeat != null)
      number(m.specificHeat, "Specific heat", { positive: true });
    // Plasticity: stress–strain points beyond yield, [strain %, stress MPa].
    if (m.hardening != null) {
      if (!Array.isArray(m.hardening) || m.hardening.length > 50)
        throw new RequestError("The stress–strain points are invalid.");
      for (const p of m.hardening) {
        if (!Array.isArray(p) || p.length !== 2)
          throw new RequestError("The stress–strain points are invalid.");
        number(p[0], "Strain", { positive: true });
        number(p[1], "Stress", { positive: true });
      }
    }
    // Properties at temperatures, for thermal studies.
    if (m.byTemperature != null) {
      if (!Array.isArray(m.byTemperature) || m.byTemperature.length > 50)
        throw new RequestError("The temperature table is invalid.");
      for (const r of m.byTemperature) {
        if (!r || typeof r !== "object")
          throw new RequestError("The temperature table is invalid.");
        number(r.temperature, "Table temperature");
        if (r.young != null)
          number(r.young, "Elastic modulus", { positive: true });
        if (r.conductivity != null)
          number(r.conductivity, "Thermal conductivity", { positive: true });
        if (r.expansion != null) number(r.expansion, "Thermal expansion");
      }
    }
  };
  if (s.material) material(s.material);
  // Assemblies: bodies with their own material, by body id.
  if (s.bodyMaterials !== undefined) {
    if (
      !s.bodyMaterials ||
      typeof s.bodyMaterials !== "object" ||
      Array.isArray(s.bodyMaterials) ||
      Object.keys(s.bodyMaterials).length > 1000
    )
      throw new RequestError("This project contains an invalid study setup.");
    for (const [id, m] of Object.entries(s.bodyMaterials)) {
      if (!/^\d{1,9}$/.test(id))
        throw new RequestError("A body material refers to an invalid body.");
      material(m);
    }
  }
  // Studies saved before thermal analysis have no thermal conditions.
  s.thermal ??= [];
  if (!Array.isArray(s.thermal) || s.thermal.length > 100)
    throw new RequestError("This project contains an invalid study setup.");
  for (const c of s.thermal) {
    text(c.id, "Condition identifier");
    text(c.name, "Condition name");
    faces(c.faces);
    if (!THERMAL.includes(c.kind))
      throw new RequestError("Unsupported thermal condition.");
    if (c.kind !== "generation" && !c.faces.length)
      throw new RequestError(
        "A thermal condition must select at least one face.",
      );
    number(c.value, "Thermal value", {
      positive: c.kind === "convection" || c.kind === "radiation",
    });
    if (c.kind === "radiation" && c.value > 1)
      throw new RequestError("Emissivity must lie between 0 and 1.");
    if (c.kind === "convection" || c.kind === "radiation")
      number(c.ambient, "Ambient temperature");
  }
  // Heat transfer over time: a duration (s) from a uniform start (°C).
  if (s.transient !== undefined) {
    const t = s.transient;
    if (!t || typeof t !== "object" || typeof t.on !== "boolean")
      throw new RequestError("The time settings are invalid.");
    number(t.duration, "Duration", { positive: true });
    number(t.start, "Starting temperature");
  }
  // Vibration studies: whether the loads stiffen the part (asked on solve).
  for (const key of ["largeDeformation", "plasticity", "unload", "preload"])
    if (s[key] !== undefined && typeof s[key] !== "boolean")
      throw new RequestError("A study setting must be on or off.");
  // Harmonic response: frequency range (Hz), damping ratio, excitation.
  if (s.harmonic !== undefined) {
    const h = s.harmonic;
    if (!h || typeof h !== "object")
      throw new RequestError("The harmonic settings are invalid.");
    number(h.min, "Lowest frequency", { positive: true });
    number(h.max, "Highest frequency", { positive: true });
    if (h.max <= h.min)
      throw new RequestError("The highest frequency must be above the lowest.");
    number(h.damping, "Damping", { positive: true });
    if (h.damping >= 1)
      throw new RequestError("Damping must be below 100% of critical.");
    if (!["loads", "base"].includes(h.excitation))
      throw new RequestError("Choose loads or base shaking.");
    if (h.excitation === "base") vector(h.base, "base acceleration");
  }
  if (s.referenceTemperature !== undefined)
    number(s.referenceTemperature, "Stress-free temperature");
  // Contact and bolts, for static assemblies.
  if (s.contact !== undefined && typeof s.contact !== "boolean")
    throw new RequestError("A study setting must be on or off.");
  if (s.contacts !== undefined) {
    if (!Array.isArray(s.contacts) || s.contacts.length > 1000)
      throw new RequestError("This project contains an invalid study setup.");
    for (const c of s.contacts) {
      if (!c || typeof c.id !== "string" || !/^\d{1,9}-\d{1,9}$/.test(c.id))
        throw new RequestError(
          "A contact refers to an invalid pair of bodies.",
        );
      if (!CONTACTS.includes(c.kind))
        throw new RequestError(
          "Choose bonded, frictional or frictionless contact.",
        );
      if (c.friction !== undefined) {
        number(c.friction, "Friction coefficient", { positive: true });
        if (c.friction > 2)
          throw new RequestError(
            "The friction coefficient must lie between 0 and 2.",
          );
      }
    }
  }
  if (s.contactStiffness !== undefined)
    number(s.contactStiffness, "Contact stiffness factor", { positive: true });
  // Studies saved before bolts have none.
  const bolts = s.bolts ?? [];
  if (!Array.isArray(bolts) || bolts.length > 100)
    throw new RequestError("This project contains an invalid study setup.");
  for (const b of bolts) {
    if (!b?.faces?.length)
      throw new RequestError("A bolt must select its shank.");
    number(b.preload, "Bolt preload", { positive: true });
  }
  // Studies saved before point masses have none.
  s.masses ??= [];
  if (!Array.isArray(s.masses) || s.masses.length > 100)
    throw new RequestError("This project contains an invalid study setup.");
  const conditions = [
    ...s.supports,
    ...s.loads,
    ...s.masses,
    ...s.thermal,
    ...bolts,
  ];
  for (const c of conditions) {
    text(c.id, "Condition identifier");
    text(c.name, "Condition name");
    faces(c.faces);
  }
  if (new Set(conditions.map((c) => c.id)).size !== conditions.length)
    throw new RequestError("Condition identifiers must be unique.");
  for (const m of s.masses) {
    if (!m.faces.length)
      throw new RequestError("A point mass must select at least one face.");
    number(m.mass, "Point mass", { positive: true });
    vector(m.point, "center of mass");
  }
  for (const c of s.supports) {
    if (c.frame !== undefined && !FRAMES.includes(c.frame))
      throw new RequestError("Unsupported support type.");
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
    if (!LOADS.includes(c.kind))
      throw new RequestError("Unsupported load type.");
    if (!BODY_LOADS.includes(c.kind) && !c.faces.length)
      throw new RequestError("A surface load must select at least one face.");
    if (c.kind === "pressure") number(c.magnitude, "Pressure");
    else if (c.kind === "rotation") {
      number(c.magnitude, "Rotational speed");
      vector(c.axis, "rotation axis");
      vector(c.point, "axis position");
    } else {
      vector(c.vector, "load");
      if (c.kind === "remote") vector(c.point, "load position");
    }
  }
  return s;
}
