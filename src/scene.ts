// The VTK.wasm scene behind the viewer. React owns the state; this class
// turns each state snapshot into VTK pipeline changes, renders on demand, and
// converts pointer input into camera moves and picks.
import { loadAsync, type StandaloneSession } from "@kitware/vtk-wasm";
import type { ViewData, Probe } from "./viewData";
import {
  hasResults,
  lowIsCritical,
  margin,
  movement,
  plotRange,
} from "./viewData";
import type { Face, Filters, Plot, Study } from "./types";

export type Theme = "light" | "dark";
export type Projection = "perspective" | "orthographic";
export type ViewName = "iso" | "front" | "top" | "right";

export type SceneState = {
  view: ViewData;
  faces: Face[];
  bounds: number[];
  study: Study;
  selected: number[];
  hovered: number | null;
  draftKind: "support" | "load" | "mass" | "thermal" | null;
  /** The plotted result, or null before solving. */
  plot: Plot | null;
  deformation: number;
  wireframe: boolean;
  theme: Theme;
  projection: Projection;
  marginMax: number;
  yieldStrength: number | null;
  filters: Filters;
  probe: Probe | null;
  /** Shows the part's origin and axes, for entering positions. */
  origin: boolean;
  /** Oscillates the deformation, for mode shapes. */
  animate: boolean;
  /** A box outline: the region being refined, by its corners. */
  region: { lo: number[]; hi: number[] } | null;
};

export type SceneEvents = {
  onSelect: (face: number) => void;
  onHover: (face: number | null) => void;
  onProbe: (probe: Probe) => void;
  /** Screen position (CSS px) of the probe marker after each render. */
  onOverlay: (position: { x: number; y: number } | null) => void;
};

export const palette = [
  "#2352a1",
  "#279abe",
  "#42bf9b",
  "#d9d96d",
  "#f1a04c",
  "#d65349",
];
const COLORS = {
  dark: {
    base: "#8b959e",
    edge: "#07090b",
    resultEdge: "#000000",
    hover: "#4d9bff",
    support: "#33b596",
    supportFace: "#4d9a87",
    load: "#f0a03c",
    loadFace: "#b08050",
    mass: "#b08cf0",
    massFace: "#8f7ab8",
    thermal: "#e8606a",
    thermalFace: "#b5646b",
    select: "#4d9bff",
    ghost: "#aab3bb",
    viewA: "#1d2227",
    viewB: "#121518",
  },
  light: {
    base: "#c3ccd3",
    edge: "#4a5a66",
    resultEdge: "#203349",
    hover: "#2f6fd8",
    support: "#12866b",
    supportFace: "#8fc4b6",
    load: "#c9700c",
    loadFace: "#e8bf93",
    mass: "#7a4fc9",
    massFace: "#c9b6ea",
    thermal: "#d23f4b",
    thermalFace: "#efb4b8",
    select: "#2f6fd8",
    ghost: "#7f8b95",
    viewA: "#ffffff",
    viewB: "#e8ebee",
  },
};
// Axis colors, shared with the X, Y and Z inputs (--x, --y, --z in CSS).
const AXES = ["#e5484d", "#3dae6b", "#3f74e0"];
/** Tints that tell the bodies of an assembly apart. */
const BODY_TINTS = [
  "#7a8a99",
  "#5b8ccf",
  "#c9a35b",
  "#7fb07a",
  "#b07ab0",
  "#6fb3b3",
];
const VIEW_ANGLE = 35;
const VTK_QUADRATIC_TETRA = 24;
/**
 * Point arrays shared by the surface and volume, named after the engine
 * field. Derived plots get their own arrays; filters color by these names.
 */
const FIELD: Record<Plot, string> = {
  stress: "vonMises",
  movement: "Movement",
  safety: "Margin",
  temperature: "temperature",
  plastic: "peeq",
  heatflux: "heatFlux",
  principalMax: "principalMax",
  principalMin: "principalMin",
  shear: "shear",
  strain: "strain",
  strainMax: "strainMax",
  strainMin: "strainMin",
  amplitude: "amplitude",
};
/** Arrays that are geometry or derived, not engine fields, when probing. */
const NOT_PROBED = new Set([
  "vtkValidPointMask",
  "Position",
  "Vector",
  "Movement",
  "Margin",
]);

const rgb = (hex: string) =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const mix = (a: number[], b: number[], t: number) =>
  a.map((v, i) => v + (b[i] - v) * t);
const add = (a: number[], b: number[], s = 1) => a.map((v, i) => v + b[i] * s);
const cross = (a: number[], b: number[]) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (a: number[]) => {
  const l = Math.hypot(...a) || 1;
  return a.map((v) => v / l);
};

/**
 * The VTK.wasm runtime is served by the local service and cached for the
 * page. Each scene gets its own session, so disposing it frees its objects.
 */
const runtime = () => loadAsync({ url: "/vtk-wasm", urlIsGzip: false });

// Generated declarations collapse C++ overloads to one signature (for
// example, selectColorArray(name) is missing), so the proxies are used
// untyped. Unknown method names still throw at call time.
type Obj = Record<string, any>;

export class Scene {
  private session: StandaloneSession;
  private vtk: Record<string, (args?: object) => Obj>;
  private ta: StandaloneSession["typedArrayInterface"];
  private canvas: HTMLCanvasElement;
  private events: SceneEvents;
  private state: SceneState | null = null;
  private last: Partial<SceneState> = {};
  private disposed = false;
  private frame = 0;
  private cleanup: (() => void)[] = [];
  private center = [0, 0, 0];
  private radius = 1;
  /** Radius of the region the camera was last fitted to. */
  private framed = 1;
  /** Animation frame request and the current deformation phase (±1). */
  private wave = 0;
  private phase = 1;
  private size = { width: 1, height: 1, scale: 1 };

  // Long-lived VTK objects; per-model data is swapped inside them.
  private window: Obj;
  private renderer: Obj;
  private overlay: Obj;
  private triad: Obj;
  private origin: Obj;
  private originReach: Obj;
  private triadRenderer: Obj;
  private camera: Obj;
  private points: Obj;
  private pointsArray: Obj | null = null;
  private colors: Obj | null = null;
  private surface: Obj;
  private grid: Obj;
  private surfaceMapper: Obj;
  private surfaceActor: Obj;
  private edges: Obj;
  private edgesActor: Obj;
  private lut: Obj;
  private plane: Obj;
  private cutter: Obj;
  private capClip: Obj;
  private capActor: Obj;
  private iso: Obj;
  private isoActor: Obj;
  private band: Obj;
  private bandSurface: Obj;
  private bandActors: Obj[];
  private empty: Obj;
  private picker: Obj;
  private probeFilter: Obj;
  private marker: Obj;
  private glyphs: { source: Obj; data: Obj; actor: Obj }[];
  /** Lines from remote load points and point masses to their faces. */
  private links: { data: Obj; actor: Obj }[];
  private fieldArrays: Record<string, Obj> = {};
  private pickPoint: Obj;
  private pickData: Obj;

  static async create(canvas: HTMLCanvasElement, events: SceneEvents) {
    return new Scene(
      (await runtime()).createStandaloneSession(),
      canvas,
      events,
    );
  }

  private constructor(
    s: StandaloneSession,
    canvas: HTMLCanvasElement,
    events: SceneEvents,
  ) {
    this.session = s;
    this.vtk = s.vtk as any;
    this.ta = s.typedArrayInterface;
    this.canvas = canvas;
    this.events = events;
    const make = (name: string, args?: object) => this.vtk[name](args);

    if (!canvas.id) canvas.id = "vtk-" + Math.random().toString(36).slice(2);
    const selector = "#" + canvas.id;
    this.window = make("vtkRenderWindow", { canvasSelector: selector });
    this.window.setNumberOfLayers(2);
    this.window.setMultiSamples(4);
    // WebGL 2 lacks dual depth peeling, so translucent ghosts blend unsorted.
    this.renderer = make("vtkRenderer");
    this.renderer.setGradientBackground(true);
    this.window.addRenderer(this.renderer);
    this.camera = this.renderer.getActiveCamera();
    this.camera.setViewAngle(VIEW_ANGLE);
    // Markers draw on top of the model with the same camera.
    this.overlay = make("vtkRenderer");
    this.overlay.setLayer(1);
    this.overlay.setInteractive(0);
    this.overlay.setActiveCamera(this.camera);
    this.window.addRenderer(this.overlay);
    this.triadRenderer = make("vtkRenderer");
    this.triadRenderer.setLayer(1);
    this.triadRenderer.setInteractive(0);
    this.triadRenderer.getActiveCamera().setParallelProjection(1);
    this.triad = this.axes();
    this.triadRenderer.addActor(this.triad);
    // The part's coordinate origin, drawn over the model while a position
    // is being entered. An invisible ball in the model renderer keeps it
    // inside the camera's clipping range.
    this.origin = this.axes();
    // Captions size to a share of their renderer: the triad's is small, the
    // model view's is the whole viewport.
    for (const axis of ["X", "Y", "Z"]) {
      const caption = this.origin[`get${axis}AxisCaptionActor2D`]();
      caption.setWidth(0.04);
      caption.setHeight(0.045);
    }
    this.origin.setVisibility(0);
    this.overlay.addActor(this.origin);
    const reach = make("vtkSphereSource");
    this.originReach = this.actor(this.mapper({ port: reach }));
    this.originReach.$userData.source = reach;
    this.originReach.getProperty().setOpacity(0);
    this.originReach.pickableOff();
    this.originReach.setVisibility(0);
    this.window.addRenderer(this.triadRenderer);

    // Model: one set of (deformed) points shared by surface and volume.
    this.points = make("vtkPoints");
    this.surface = make("vtkPolyData");
    this.grid = make("vtkUnstructuredGrid");
    this.surfaceMapper = make("vtkPolyDataMapper");
    this.surfaceMapper.setInputData(this.surface);
    this.surfaceMapper.setInterpolateScalarsBeforeMapping(1);
    this.surfaceMapper.resolveCoincidentTopology = 1;
    this.surfaceActor = this.actor(this.surfaceMapper);
    this.surfaceMapper.scalarVisibilityOn();
    this.shade(this.surfaceActor);
    this.edges = make("vtkPolyData");
    this.edgesActor = this.actor(this.mapper({ data: this.edges }));
    this.edgesActor.getMapper().scalarVisibilityOff();
    this.edgesActor.pickableOff();

    this.lut = make("vtkColorTransferFunction");
    this.lut.setColorSpaceToRGB();

    // Section: the surface is clipped by `plane`; the cut through the volume
    // caps it. Cap clipping by value keeps the threshold region honest.
    this.plane = make("vtkPlane");
    this.cutter = make("vtkCutter");
    this.cutter.setCutFunction(this.plane);
    this.cutter.setInputData(this.grid);
    this.capClip = make("vtkClipPolyData");
    this.capClip.setInputConnection(this.cutter.getOutputPort(0));
    this.capActor = this.fieldActor(this.cutter);
    // Iso-surface through the volume.
    this.iso = make("vtkContourFilter");
    this.iso.setInputData(this.grid);
    this.isoActor = this.fieldActor(this.iso);
    // Threshold region: its boundary is the surface clipped by value plus the
    // iso-surface at that value.
    this.band = make("vtkContourFilter");
    this.band.setInputData(this.grid);
    this.bandSurface = make("vtkClipPolyData");
    this.empty = make("vtkPolyData");
    this.bandSurface.setInputData(this.empty);
    this.bandActors = [
      this.fieldActor(this.band),
      this.fieldActor(this.bandSurface),
    ];

    this.picker = make("vtkCellPicker");
    this.picker.setTolerance(0.0005);
    this.probeFilter = make("vtkProbeFilter");
    this.probeFilter.setSourceData(this.grid);
    this.pickPoint = make("vtkPoints");
    this.pickData = make("vtkPolyData");
    this.pickData.setPoints(this.pickPoint);
    this.probeFilter.setInputData(this.pickData);

    const sphere = make("vtkSphereSource");
    sphere.setThetaResolution(16);
    sphere.setPhiResolution(12);
    this.marker = this.actor(this.mapper({ port: sphere }), this.overlay);
    this.marker.getProperty().setColor(1, 1, 1);
    this.marker.getProperty().setAmbient(0.6);
    this.marker.$userData.source = sphere;

    // Condition annotations: arrows for loads and blocked support directions,
    // small octahedra on supported faces.
    const arrow = make("vtkArrowSource");
    arrow.setTipLength(0.28);
    arrow.setTipRadius(0.11);
    arrow.setShaftRadius(0.035);
    const octahedron = make("vtkSphereSource");
    octahedron.setThetaResolution(4);
    octahedron.setPhiResolution(3);
    const ball = make("vtkSphereSource");
    ball.setThetaResolution(12);
    ball.setPhiResolution(8);
    this.glyphs = [arrow, arrow, octahedron, ball, ball].map((source) => {
      const data = make("vtkPolyData");
      const glyph = make("vtkGlyph3D");
      glyph.setInputData(data);
      glyph.setSourceConnection(source.getOutputPort(0));
      glyph.setVectorModeToUseVector();
      glyph.setScaleModeToDataScalingOff();
      const actor = this.actor(this.mapper({ port: glyph }));
      actor.pickableOff();
      actor.getMapper().scalarVisibilityOff();
      return { source: glyph, data, actor };
    });

    this.links = [0, 1, 2].map(() => {
      const data = make("vtkPolyData");
      const actor = this.actor(this.mapper({ data }));
      actor.getMapper().scalarVisibilityOff();
      actor.pickableOff();
      actor.getProperty().setLineWidth(1.5);
      return { data, actor };
    });

    this.listen();
  }

  /** X, Y and Z arrows in the axis colors, labelled at their tips. */
  private axes() {
    const axes = this.vtk.vtkAxesActor();
    axes.setShaftTypeToCylinder();
    axes.setCylinderRadius(0.04);
    axes.setConeRadius(0.5);
    axes.setNormalizedTipLength(0.22, 0.22, 0.22);
    ["X", "Y", "Z"].forEach((axis, i) => {
      axes[`get${axis}AxisShaftProperty`]().setColor(...rgb(AXES[i]));
      axes[`get${axis}AxisTipProperty`]().setColor(...rgb(AXES[i]));
      const label = axes[`get${axis}AxisCaptionActor2D`]();
      const text = label.getCaptionTextProperty();
      text.setColor(...rgb(AXES[i]));
      text.setBold(1);
      text.setShadow(0);
      text.setFontSize(13);
    });
    return axes;
  }

  private mapper(input: { port: Obj } | { data: Obj }) {
    const mapper = this.vtk.vtkPolyDataMapper();
    if ("port" in input) mapper.setInputConnection(input.port.getOutputPort(0));
    else mapper.setInputData(input.data);
    return mapper;
  }

  private actor(mapper: Obj, renderer = this.renderer) {
    const actor = this.vtk.vtkActor({ mapper });
    renderer.addActor(actor);
    return actor;
  }

  /** VTK lights with one headlight; ambient keeps oblique faces readable. */
  private shade(actor: Obj) {
    const p = actor.getProperty();
    p.setInterpolationToPhong();
    p.setAmbient(0.3);
    p.setDiffuse(0.75);
    p.setSpecular(0.12);
    p.setSpecularPower(20);
  }

  /** An actor colored by the active result field. */
  private fieldActor(source: Obj) {
    const mapper = this.mapper({ port: source });
    mapper.setLookupTable(this.lut);
    mapper.setUseLookupTableScalarRange(1);
    mapper.setInterpolateScalarsBeforeMapping(1);
    mapper.setScalarModeToUsePointFieldData();
    mapper.setArrayAccessMode(1);
    const actor = this.actor(mapper);
    this.shade(actor);
    actor.setVisibility(0);
    return actor;
  }

  private array(
    data: Float64Array | Int32Array | Uint8Array,
    components: number,
    name = "",
  ) {
    return this.ta.toVTKAoSArray(data, components, name) as Obj;
  }

  private cells(connectivity: Int32Array, size: number) {
    const offsets = new Int32Array(connectivity.length / size + 1);
    for (let i = 0; i < offsets.length; i++) offsets[i] = i * size;
    const cells = this.vtk.vtkCellArray();
    const o = this.array(offsets, 1);
    const c = this.array(connectivity, 1);
    cells.setData(o, c);
    o.$delete();
    c.$delete();
    return cells;
  }

  /** Applies a state snapshot, rebuilding only what changed. */
  update(next: SceneState) {
    if (this.disposed) return;
    const prev = this.last;
    const changed = (...keys: (keyof SceneState)[]) =>
      keys.some((k) => prev[k] !== next[k]);
    this.state = next;
    const prevView = prev.view;
    const geometry =
      !prevView ||
      prevView.points !== next.view.points ||
      prevView.triangles !== next.view.triangles ||
      prevView.tets !== next.view.tets;
    const model = changed("view");
    if (geometry) this.setModel(next);
    else if (model) this.setFields(next.view);
    if (model || changed("deformation")) this.deform();
    if (
      model ||
      changed("plot", "marginMax", "yieldStrength", "theme", "wireframe")
    )
      this.colorFields();
    if (
      model ||
      changed("selected", "hovered", "study", "draftKind", "theme", "plot")
    )
      this.paintFaces();
    if (model || changed("study", "theme", "plot")) this.annotate();
    if (
      model ||
      changed("filters", "plot", "marginMax", "theme", "deformation")
    )
      this.filter();
    if (model || changed("probe", "deformation")) this.placeMarker();
    if (model || changed("region", "theme")) this.drawRegion();
    if (changed("projection")) this.project(next.projection);
    if (changed("theme")) {
      // Matches the viewport's CSS gradient tokens (--view-a, --view-b).
      this.renderer.setBackground(...rgb(COLORS[next.theme].viewB));
      this.renderer.setBackground2(...rgb(COLORS[next.theme].viewA));
    }
    if (changed("origin", "bounds")) this.showOrigin();
    if (model || changed("animate", "deformation")) this.oscillate();
    if (changed("study", "origin") && !changed("bounds")) {
      // A point placed beyond the framed region: zoom out to include it,
      // keeping the view direction.
      const radius = this.extent().radius;
      if (radius > this.framed * 1.05) this.reframe();
    }
    if (changed("bounds")) {
      // Gmsh order: xmin, ymin, zmin, xmax, ymax, zmax.
      const b = next.bounds;
      this.center = [0, 1, 2].map((i) => (b[i] + b[i + 3]) / 2);
      this.radius = Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2 || 1;
      this.fit("iso");
    }
    this.last = { ...next };
    this.invalidate();
  }

  private setModel(s: SceneState) {
    const v = s.view;
    this.pointsArray?.$delete();
    this.colors?.$delete();
    this.pointsArray = this.array(new Float64Array(v.points), 3, "Points");
    this.points.setData(this.pointsArray);
    this.surface.setPoints(this.points);
    const polys = this.cells(v.triangles, 3);
    this.surface.setPolys(polys);
    polys.$delete();
    this.surface.getCellData().removeArray("Colors");
    this.colors = this.array(
      new Uint8Array(v.triangleFaces.length * 3),
      3,
      "Colors",
    );
    this.surface.getCellData().addArray(this.colors);
    // The grid shares the new points, so its cells must be replaced too;
    // stale tetrahedra would index past the end of a smaller point set.
    this.grid.reset();
    this.grid.setPoints(this.points);
    if (v.tets) {
      const tets = this.cells(v.tets, 10);
      this.grid.setCells(VTK_QUADRATIC_TETRA, tets);
      tets.$delete();
    }
    this.setFields(v);
    this.buildEdges(v);
  }

  /** Replaces the nodal result arrays, e.g. when another frame is shown. */
  private setFields(v: ViewData) {
    for (const [name, a] of Object.entries(this.fieldArrays)) {
      for (const data of [this.surface, this.grid])
        data.getPointData().removeArray(name);
      a.$delete();
    }
    this.fieldArrays = {};
    if (hasResults(v)) {
      for (const [name, values] of Object.entries(v.fields))
        this.share(name, this.array(new Float64Array(values), 1, name));
      if (v.displacement) {
        this.share("Movement", this.array(movement(v), 1, "Movement"));
        this.share(
          "Vector",
          this.array(new Float64Array(v.displacement), 3, "Vector"),
        );
      }
      this.share(
        "Position",
        this.array(new Float64Array(v.points), 3, "Position"),
      );
    }
    this.surface.modified();
    this.grid.modified();
  }

  /** Point arrays are shared by the surface and the volume. */
  private share(name: string, array: Obj) {
    this.fieldArrays[name]?.$delete();
    for (const data of [this.surface, this.grid]) {
      data.getPointData().removeArray(name);
      data.getPointData().addArray(array);
    }
    this.fieldArrays[name] = array;
  }

  /** CAD face boundaries: triangle edges between different faces. */
  private buildEdges(v: ViewData) {
    const n = v.nodeIds.length;
    const owner = new Map<number, number>();
    const lines: number[] = [];
    const t = v.triangles;
    for (let i = 0; i < t.length; i += 3) {
      const face = v.triangleFaces[i / 3];
      for (let k = 0; k < 3; k++) {
        const a = t[i + k],
          b = t[i + ((k + 1) % 3)];
        const key = Math.min(a, b) * n + Math.max(a, b);
        const other = owner.get(key);
        if (other === undefined) owner.set(key, face);
        else {
          if (other !== face) lines.push(a, b);
          owner.set(key, -1);
        }
      }
    }
    for (const [key, face] of owner)
      if (face >= 0) lines.push(Math.floor(key / n), key % n);
    this.edges.setPoints(this.points);
    const cells = this.cells(Int32Array.from(lines), 2);
    this.edges.setLines(cells);
    cells.$delete();
    this.edges.modified();
  }

  private deform() {
    const s = this.state!;
    const v = s.view;
    const view = this.ta.toJSTypedArray(
      this.pointsArray as any,
    ) as Float64Array;
    const scale = v.displacement ? s.deformation * this.phase : 0;
    for (let i = 0; i < view.length; i++)
      view[i] = v.points[i] + (scale ? v.displacement![i] * scale : 0);
    this.pointsArray!.modified();
    this.points.modified();
    this.surface.modified();
    this.grid.modified();
    this.edges.modified();
  }

  /** Scalar range of the active plot, like the legend. */
  private scale() {
    const s = this.state!;
    if (!s.plot || !hasResults(s.view)) return { min: 0, max: 1 };
    return plotRange(s.view, s.plot, s.yieldStrength, s.marginMax);
  }

  private colorFields() {
    const s = this.state!;
    const colors = COLORS[s.theme];
    const p = this.surfaceActor.getProperty();
    p.setEdgeVisibility(s.wireframe ? 1 : 0);
    p.setEdgeColor(...rgb(s.plot ? colors.resultEdge : colors.edge));
    this.edgesActor
      .getProperty()
      .setColor(...rgb(s.plot ? colors.resultEdge : colors.edge));
    this.edgesActor.getProperty().setOpacity(s.plot ? 0.45 : 0.6);
    if (!s.plot || !hasResults(s.view)) return;
    if (s.yieldStrength && s.view.fields.vonMises)
      this.share(
        "Margin",
        this.array(margin(s.view, s.yieldStrength, s.marginMax), 1, "Margin"),
      );
    const { min, max } = this.scale();
    const stops = s.plot === "safety" ? [...palette].reverse() : palette;
    this.lut.removeAllPoints();
    stops.forEach((c, i) =>
      this.lut.addRGBPoint(min + (i / 5) * (max - min), ...rgb(c)),
    );
    const name = FIELD[s.plot];
    for (const data of [this.surface, this.grid])
      data.getPointData().setActiveScalars(name);
    for (const a of [this.capActor, this.isoActor, ...this.bandActors])
      a.getMapper().setArrayName(name);
  }

  /** Setup colors by CAD face; results color by field. */
  private paintFaces() {
    const s = this.state!;
    const m = this.surfaceMapper;
    if (s.plot) {
      m.setLookupTable(this.lut);
      m.setUseLookupTableScalarRange(1);
      m.setColorModeToMapScalars();
      m.setScalarModeToUsePointFieldData();
      m.setArrayAccessMode(1);
      m.setArrayName(FIELD[s.plot]);
      return;
    }
    const colors = COLORS[s.theme];
    const pick =
      s.draftKind === "support"
        ? colors.support
        : s.draftKind === "load"
          ? colors.load
          : s.draftKind === "mass"
            ? colors.mass
            : s.draftKind === "thermal"
              ? colors.thermal
              : colors.select;
    const supported = new Set(s.study.supports.flatMap((c) => c.faces));
    const loaded = new Set(s.study.loads.flatMap((c) => c.faces));
    const massed = new Set(s.study.masses.flatMap((c) => c.faces));
    const heated = new Set((s.study.thermal || []).flatMap((c) => c.faces));
    const byFace = new Map<number, number[]>();
    const bodies = [...new Set(s.faces.map((f) => f.body))];
    for (const f of s.faces) {
      const plain = !(
        s.selected.includes(f.id) ||
        supported.has(f.id) ||
        loaded.has(f.id) ||
        massed.has(f.id) ||
        heated.has(f.id)
      );
      let c = rgb(
        s.selected.includes(f.id)
          ? pick
          : supported.has(f.id)
            ? colors.supportFace
            : loaded.has(f.id)
              ? colors.loadFace
              : massed.has(f.id)
                ? colors.massFace
                : heated.has(f.id)
                  ? colors.thermalFace
                  : colors.base,
      );
      // Assemblies: each body gets its own tint of the base color.
      if (plain && bodies.length > 1)
        c = mix(
          c,
          rgb(BODY_TINTS[bodies.indexOf(f.body) % BODY_TINTS.length]),
          0.22,
        );
      if (f.id === s.hovered) c = mix(c, rgb(colors.hover), 0.35);
      byFace.set(
        f.id,
        c.map((x) => Math.round(x * 255)),
      );
    }
    const out = this.ta.toJSTypedArray(this.colors as any) as Uint8Array;
    const faces = s.view.triangleFaces;
    const fallback = rgb(colors.base).map((x) => Math.round(x * 255));
    for (let i = 0; i < faces.length; i++) {
      const c = byFace.get(faces[i]) || fallback;
      out[i * 3] = c[0];
      out[i * 3 + 1] = c[1];
      out[i * 3 + 2] = c[2];
    }
    this.colors!.modified();
    m.setColorModeToDirectScalars();
    m.setScalarModeToUseCellFieldData();
    m.setArrayAccessMode(1);
    m.setArrayName("Colors");
    m.scalarVisibilityOn();
  }

  private annotate() {
    const s = this.state!;
    const colors = COLORS[s.theme];
    const r = this.radius;
    const loads: number[][] = [],
      supports: number[][] = [],
      markers: number[][] = [],
      points: number[][] = [],
      links: number[] = [],
      masses: number[][] = [],
      massLinks: number[] = [];
    if (!s.plot) {
      const faces = new Map(s.faces.map((f) => [f.id, f]));
      for (const c of s.study.supports)
        for (const id of c.faces) {
          const f = faces.get(id);
          if (!f) continue;
          markers.push([...f.anchor, 0, 0, 1]);
          c.axes.forEach((on, a) => {
            if (on)
              supports.push([...f.anchor, ...[0, 1, 2].map((i) => +(i === a))]);
          });
        }
      for (const l of s.study.loads) {
        if (l.kind === "gravity") {
          const dir = unit(l.vector);
          if (Math.hypot(...l.vector))
            loads.push([...add(this.center, [0, 0, r * 0.55]), ...dir]);
          continue;
        }
        if (l.kind === "rotation") {
          // The spin axis: an arrow along it through the chosen point.
          if (!l.axis || !l.point || !Math.hypot(...l.axis)) continue;
          const u = unit(l.axis);
          loads.push([...add(l.point, u, -r * 0.5), ...u]);
          loads.push([...add(l.point, u, r * 0.25), ...u]);
          points.push([...l.point, 0, 0, 1]);
          continue;
        }
        if (l.kind === "remote" && l.point) {
          // The force acts at its point, linked to the faces carrying it.
          if (Math.hypot(...l.vector)) {
            const u = unit(l.vector);
            loads.push([...add(l.point, u, -r * 0.25), ...u]);
          }
          points.push([...l.point, 0, 0, 1]);
          for (const id of l.faces) {
            const f = faces.get(id);
            if (f) links.push(...l.point, ...f.anchor);
          }
          continue;
        }
        if (l.kind === "moment") {
          // A double-headed arrow along the moment axis.
          if (!Math.hypot(...l.vector)) continue;
          const u = unit(l.vector);
          for (const id of l.faces) {
            const f = faces.get(id);
            if (!f) continue;
            loads.push([...add(f.anchor, u, -r * 0.25), ...u]);
            loads.push([...add(f.anchor, u, -r * 0.33), ...u]);
          }
          continue;
        }
        for (const id of l.faces) {
          const f = faces.get(id);
          if (!f) continue;
          const dir =
            l.kind === "pressure"
              ? f.normal.map((n) => n * (l.magnitude >= 0 ? -1 : 1))
              : l.vector;
          if (!Math.hypot(...dir)) continue;
          const u = unit(dir);
          // The arrow ends at the face.
          loads.push([...add(f.anchor, u, -r * 0.25), ...u]);
        }
      }
      for (const m of s.study.masses) {
        masses.push([...m.point, 0, 0, 1]);
        for (const id of m.faces) {
          const f = faces.get(id);
          if (f) massLinks.push(...m.point, ...f.anchor);
        }
      }
    }
    const sets = [
      { items: loads, color: colors.load, size: r * 0.25 },
      { items: supports, color: colors.support, size: r * 0.13 },
      { items: markers, color: colors.support, size: r * 0.05 },
      { items: points, color: colors.load, size: r * 0.06 },
      { items: masses, color: colors.mass, size: r * 0.1 },
    ];
    [
      { data: links, color: colors.load },
      { data: massLinks, color: colors.mass },
    ].forEach(({ data, color }, i) => {
      const link = this.links[i];
      const pts = this.vtk.vtkPoints();
      const coords = this.array(Float64Array.from(data), 3);
      pts.setData(coords);
      link.data.setPoints(pts);
      const lines = this.cells(
        Int32Array.from({ length: data.length / 3 }, (_, k) => k),
        2,
      );
      link.data.setLines(lines);
      link.data.modified();
      for (const o of [pts, coords, lines]) o.$delete();
      link.actor.getProperty().setColor(...rgb(color));
      link.actor.setVisibility(data.length ? 1 : 0);
    });
    sets.forEach(({ items, color, size }, i) => {
      const g = this.glyphs[i];
      const pts = this.vtk.vtkPoints();
      const coords = this.array(
        Float64Array.from(items.flatMap((x) => x.slice(0, 3))),
        3,
      );
      pts.setData(coords);
      g.data.setPoints(pts);
      const vectors = this.array(
        Float64Array.from(items.flatMap((x) => x.slice(3))),
        3,
        "Direction",
      );
      g.data.getPointData().setVectors(vectors);
      g.data.modified();
      for (const o of [pts, coords, vectors]) o.$delete();
      g.source.setScaleFactor(size);
      g.actor.getProperty().setColor(...rgb(color));
      g.actor.setVisibility(items.length ? 1 : 0);
    });
  }

  /** The outline of the region box. */
  private drawRegion() {
    const s = this.state!;
    const link = this.links[2];
    const lines: number[] = [];
    if (s.region) {
      const { lo, hi } = s.region;
      const corner = (i: number) =>
        [0, 1, 2].map((a) => ((i >> a) & 1 ? hi[a] : lo[a]));
      for (let i = 0; i < 8; i++)
        for (let a = 0; a < 3; a++)
          if (!((i >> a) & 1))
            lines.push(...corner(i), ...corner(i | (1 << a)));
    }
    const pts = this.vtk.vtkPoints();
    const coords = this.array(Float64Array.from(lines), 3);
    pts.setData(coords);
    link.data.setPoints(pts);
    const cells = this.cells(
      Int32Array.from({ length: lines.length / 3 }, (_, k) => k),
      2,
    );
    link.data.setLines(cells);
    link.data.modified();
    for (const o of [pts, coords, cells]) o.$delete();
    link.actor.getProperty().setColor(...rgb(COLORS[s.theme].select));
    link.actor.getProperty().setLineWidth(2);
    link.actor.setVisibility(lines.length ? 1 : 0);
  }

  private filter() {
    const s = this.state!;
    const f = s.filters;
    const results = !!(s.plot && s.view.tets && hasResults(s.view));
    const { min, max } = this.scale();
    const at = (fraction: number) => min + fraction * (max - min);
    const section = results && f.section.on;
    const iso = results && f.iso.on;
    const band = results && f.threshold.on;
    const ghost = iso || band;

    const normal = [0, 0, 0];
    normal[f.section.axis] = f.section.flip ? 1 : -1;
    const origin = [...this.center];
    origin[f.section.axis] = f.section.position;
    this.plane.setOrigin(...origin);
    this.plane.setNormal(...normal);
    const clipped = [
      this.surfaceActor,
      this.edgesActor,
      this.isoActor,
      ...this.bandActors,
    ];
    for (const a of clipped) {
      const m = a.getMapper();
      m.removeAllClippingPlanes();
      if (section) m.addClippingPlane(this.plane);
    }

    // The threshold keeps the critical side: high stress or displacement,
    // low yield margin.
    const level = at(f.threshold.level);
    const low = lowIsCritical(s.plot!);
    // Setup surfaces carry no scalars to clip by.
    this.bandSurface.setInputData(band ? this.surface : this.empty);
    this.bandSurface.setValue(level);
    this.bandSurface.setInsideOut(low ? 1 : 0);
    this.band.setValue(0, level);
    this.iso.setValue(0, at(f.iso.level));
    this.capClip.setValue(level);
    this.capClip.setInsideOut(low ? 1 : 0);
    this.capActor
      .getMapper()
      .setInputConnection((band ? this.capClip : this.cutter).getOutputPort(0));

    this.capActor.setVisibility(section && !iso ? 1 : 0);
    this.isoActor.setVisibility(iso ? 1 : 0);
    for (const a of this.bandActors) a.setVisibility(band ? 1 : 0);

    const p = this.surfaceActor.getProperty();
    p.setOpacity(ghost ? 0.14 : 1);
    if (ghost) p.setColor(...rgb(COLORS[s.theme].ghost));
    this.surfaceMapper.setScalarVisibility(ghost ? 0 : 1);
    this.surfaceActor.setPickable(ghost ? 0 : 1);
  }

  /** Cross-section area (mm²) of the active section, for display. */
  sectionArea() {
    const s = this.state;
    if (!s?.filters.section.on || !s.plot || !s.view.tets) return null;
    this.cutter.update(0);
    const out = this.cutter.getOutput();
    if (!out.getNumberOfCells()) return 0;
    const p = this.ta.toJSTypedArray(
      out.getPoints().getData(),
    ) as ArrayLike<number>;
    // Legacy layout: [n, id0 … idn-1, n, …]. Polygons are planar, so a fan
    // from the first vertex gives their area.
    const ids = this.vtk.vtkIdTypeArray();
    out.getPolys().exportLegacyFormat(ids);
    const cells = Array.from(
      this.ta.toJSTypedArray(ids as any) as ArrayLike<number>,
    );
    ids.$delete();
    const at = (i: number) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
    let area = 0;
    for (let c = 0; c < cells.length; c += cells[c] + 1) {
      const a = at(cells[c + 1]);
      for (let k = 2; k < cells[c]; k++) {
        const u = add(at(cells[c + k]), a, -1),
          w = add(at(cells[c + k + 1]), a, -1);
        area += Math.hypot(...cross(u, w)) / 2;
      }
    }
    return area;
  }

  private placeMarker() {
    const s = this.state!;
    const probe = s.probe;
    this.marker.setVisibility(probe ? 1 : 0);
    if (!probe) return;
    const scale = s.view.displacement && probe.displacement ? s.deformation : 0;
    this.marker.setPosition(
      ...add(probe.point, probe.displacement || [0, 0, 0], scale),
    );
    this.marker.$userData.source.setRadius(this.radius * 0.014);
  }

  // ---- Camera ----

  fit(view: ViewName = "iso") {
    const directions: Record<ViewName, number[]> = {
      iso: [1, -1, 0.8],
      front: [0, -1, 0],
      top: [0, 0, 1],
      right: [1, 0, 0],
    };
    const dir = unit(directions[view] || directions.iso);
    const aspect = this.size.width / this.size.height;
    const { center, radius } = this.extent();
    const half = (radius * 1.16) / Math.min(1, aspect);
    const distance = half / Math.tan(((VIEW_ANGLE / 2) * Math.PI) / 180);
    const c = this.camera;
    c.setFocalPoint(...center);
    c.setPosition(...add(center, dir, distance));
    c.setViewUp(...(view === "top" ? [0, 1, 0] : [0, 0, 1]));
    c.setParallelScale(half);
    this.framed = radius;
    this.invalidate();
  }

  /** Fits the extent while keeping the current view direction and up. */
  private reframe() {
    const c = this.camera;
    const aspect = this.size.width / this.size.height;
    const { center, radius } = this.extent();
    const half = (radius * 1.16) / Math.min(1, aspect);
    const distance = half / Math.tan(((VIEW_ANGLE / 2) * Math.PI) / 180);
    c.setFocalPoint(...center);
    c.setPosition(...add(center, c.getDirectionOfProjection(), -distance));
    c.setParallelScale(half);
    this.framed = radius;
    this.invalidate();
  }

  /**
   * The part's bounding sphere, grown to include points placed off the part
   * (remote load points, point masses, rotation axes) so Fit shows them.
   */
  private extent() {
    const study = this.state?.study;
    const points = study
      ? [
          ...study.loads.flatMap((l) =>
            (l.kind === "remote" || l.kind === "rotation") && l.point
              ? [l.point]
              : [],
          ),
          ...study.masses.map((m) => m.point),
        ]
      : [];
    if (this.state?.origin) {
      const l = this.originLength();
      points.push([0, 0, 0], [l, 0, 0], [0, l, 0], [0, 0, l]);
    }
    let center = this.center,
      radius = this.radius;
    for (const p of points) {
      const d = Math.hypot(...add(p, center, -1));
      if (!(d > radius)) continue;
      // Smallest sphere holding the current sphere and the point.
      const grown = (radius + d) / 2;
      center = add(center, add(p, center, -1), (grown - radius) / d);
      radius = grown;
    }
    return { center, radius };
  }

  /**
   * Swings the deformation between ±1 times its scale, 0.6 cycles a second,
   * while animation is on; otherwise holds it at +1.
   */
  private oscillate() {
    const on = !!this.state?.animate && !!this.state.view.displacement;
    if (on && !this.wave) {
      const start = performance.now();
      const tick = (time: number) => {
        if (this.disposed) return;
        this.phase = Math.cos(((time - start) / 1000) * 2 * Math.PI * 0.6);
        this.deform();
        this.render();
        this.wave = requestAnimationFrame(tick);
      };
      this.wave = requestAnimationFrame(tick);
    } else if (!on && this.wave) {
      cancelAnimationFrame(this.wave);
      this.wave = 0;
      this.phase = 1;
      this.deform();
      this.invalidate();
    }
  }

  private originLength() {
    return this.radius * 0.35;
  }

  private showOrigin() {
    const on = this.state!.origin ? 1 : 0;
    const l = this.originLength();
    this.origin.setTotalLength(l, l, l);
    this.origin.setVisibility(on);
    this.originReach.$userData.source.setRadius(l * 1.2);
    this.originReach.setVisibility(on);
  }

  /** Swaps projection while keeping the view direction and visible size. */
  private project(mode: Projection) {
    const c = this.camera;
    const tan = Math.tan(((VIEW_ANGLE / 2) * Math.PI) / 180);
    const focal = c.getFocalPoint();
    const dop = c.getDirectionOfProjection();
    if (mode === "orthographic") {
      c.setParallelScale(c.getDistance() * tan);
      c.setParallelProjection(1);
    } else if (c.getParallelProjection()) {
      c.setParallelProjection(0);
      c.setPosition(...add(focal, dop, -c.getParallelScale() / tan));
    }
    this.invalidate();
  }

  private rotate(dx: number, dy: number) {
    const c = this.camera;
    c.azimuth((-dx * 200) / this.size.width);
    c.elevation((dy * 200) / this.size.height);
    // No fixed up direction: a trackball rather than a turntable.
    c.orthogonalizeViewUp();
  }

  private pan(dx: number, dy: number) {
    const c = this.camera;
    const tan = Math.tan(((VIEW_ANGLE / 2) * Math.PI) / 180);
    const perPixel =
      (2 *
        (c.getParallelProjection()
          ? c.getParallelScale()
          : c.getDistance() * tan)) /
      this.size.height;
    const up = c.getViewUp();
    const right = unit(cross(c.getDirectionOfProjection(), up));
    const move = add(
      right.map((v) => v * -dx * perPixel),
      up,
      dy * perPixel,
    );
    c.setFocalPoint(...add(c.getFocalPoint(), move));
    c.setPosition(...add(c.getPosition(), move));
  }

  /**
   * Zooms toward the point under the cursor, as CAD tools do: the camera
   * scales about that point on the focal plane, so it stays under the
   * cursor while the view zooms.
   */
  private zoomAt(factor: number, display: number[]) {
    const c = this.camera;
    const r = this.renderer;
    const focal = c.getFocalPoint();
    r.setWorldPoint(focal[0], focal[1], focal[2], 1);
    r.worldToDisplay();
    const depth = r.getDisplayPoint()[2];
    r.setDisplayPoint(display[0], display[1], depth);
    r.displayToWorld();
    const w = r.getWorldPoint();
    const at = [w[0] / w[3], w[1] / w[3], w[2] / w[3]];
    const shift = add(add(focal, at, -1), [0, 0, 0], 1).map(
      (v) => v / factor - v,
    );
    c.setFocalPoint(...add(focal, shift));
    if (c.getParallelProjection()) {
      c.setPosition(...add(c.getPosition(), shift));
      c.setParallelScale(c.getParallelScale() / factor);
    } else {
      // Scale the camera position about the same point.
      const p = c.getPosition();
      c.setPosition(...add(at, add(p, at, -1), 1 / factor));
    }
  }

  private zoom(factor: number) {
    const c = this.camera;
    if (c.getParallelProjection())
      c.setParallelScale(c.getParallelScale() / factor);
    else c.dolly(factor);
  }

  // ---- Rendering ----

  invalidate() {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private render() {
    if (this.disposed || !this.state) return;
    const { width, height, scale } = this.size;
    // Keep the triad a fixed 84 px square in the lower left.
    const t = 84 * scale,
      m = 6 * scale;
    this.triadRenderer.setViewport(
      m / (width * scale),
      m / (height * scale),
      (m + t) / (width * scale),
      (m + t) / (height * scale),
    );
    const tc = this.triadRenderer.getActiveCamera();
    tc.setFocalPoint(0, 0, 0);
    tc.setPosition(
      ...this.camera.getDirectionOfProjection().map((v: number) => -v * 5),
    );
    tc.setViewUp(...this.camera.getViewUp());
    tc.setParallelScale(1.35);
    this.triadRenderer.resetCameraClippingRange();
    this.renderer.resetCameraClippingRange();
    this.window.render();
    this.events.onOverlay(this.markerScreen());
  }

  private markerScreen() {
    if (!this.marker.getVisibility()) return null;
    const p = this.marker.getPosition();
    this.renderer.setWorldPoint(p[0], p[1], p[2], 1);
    this.renderer.worldToDisplay();
    const [x, y, z] = this.renderer.getDisplayPoint();
    if (z < 0 || z > 1) return null;
    const s = this.size.scale;
    return { x: x / s, y: this.size.height - y / s };
  }

  resize(width: number, height: number) {
    if (!width || !height) return;
    const first = this.size.width === 1 && this.size.height === 1;
    const scale = Math.min(devicePixelRatio || 1, 2);
    this.size = { width, height, scale };
    this.canvas.width = Math.round(width * scale);
    this.canvas.height = Math.round(height * scale);
    this.window.setSize(this.canvas.width, this.canvas.height);
    // Frame the part once; later resizes keep the view.
    if (first) this.fit("iso");
    // Resizing clears the canvas; draw now, before the browser paints the
    // empty frame (a dark flash in light mode).
    if (this.state) this.render();
    else this.invalidate();
  }

  /** PNG of the current view, base64 without the data-URL prefix. */
  screenshot() {
    this.render();
    return this.canvas.toDataURL("image/png").split(",")[1] || "";
  }

  // ---- Picking ----

  private display(e: { clientX: number; clientY: number }) {
    const r = this.canvas.getBoundingClientRect();
    const s = this.size.scale;
    return [(e.clientX - r.left) * s, (r.bottom - e.clientY) * s, 0];
  }

  private pickFace(e: PointerEvent) {
    if (!this.picker.pick(this.display(e), this.renderer)) return null;
    if (this.picker.getActor()?.$id !== this.surfaceActor.$id) return null;
    const cell = this.picker.getCellId();
    return cell >= 0 ? (this.state!.view.triangleFaces[cell] ?? null) : null;
  }

  /** Interpolated values at the picked point of the displayed result. */
  private pickProbe(e: PointerEvent): Probe | null {
    if (!this.picker.pick(this.display(e), this.renderer)) return null;
    const at = this.picker.getPickPosition();
    this.pickPoint.reset();
    this.pickPoint.insertNextPoint(at);
    this.pickPoint.modified();
    this.pickData.modified();
    this.probeFilter.update(0);
    const pd = this.probeFilter.getOutput().getPointData();
    const values: Record<string, number[]> = {};
    for (let i = 0; i < pd.getNumberOfArrays(); i++) {
      const a = pd.getArray(i);
      values[a.getName()] = Array.from(
        this.ta.toJSTypedArray(a) as ArrayLike<number>,
      ).slice(0, a.getNumberOfComponents());
    }
    if (!values.vtkValidPointMask?.[0] || !values.Position) return null;
    return {
      point: values.Position,
      node: null,
      values: Object.fromEntries(
        Object.entries(values)
          .filter(([k]) => !NOT_PROBED.has(k))
          .map(([k, v]) => [k, v[0]]),
      ),
      displacement: values.Vector || null,
    };
  }

  private listen() {
    const el = this.canvas;
    let drag: { x: number; y: number; button: number; moved: boolean } | null =
      null;
    let hover: number | null = null;
    let pending: PointerEvent | null = null;
    const down = (e: PointerEvent) => {
      drag = { x: e.clientX, y: e.clientY, button: e.button, moved: false };
      el.setPointerCapture(e.pointerId);
      el.focus();
    };
    const move = (e: PointerEvent) => {
      if (!drag) {
        // Hover is for face selection during setup; one pick per frame.
        if (this.state?.plot || pending) {
          pending = e;
          return;
        }
        pending = e;
        requestAnimationFrame(() => {
          const last = pending!;
          pending = null;
          if (this.disposed || this.state?.plot) return;
          const face = this.pickFace(last);
          if (face !== hover) {
            hover = face;
            el.style.cursor = face ? "pointer" : "grab";
            this.events.onHover(face);
          }
        });
        return;
      }
      const dx = e.clientX - drag.x,
        dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) <= 4) return;
      drag.moved = true;
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (drag.button === 2 || drag.button === 1 || e.shiftKey)
        this.pan(dx, dy);
      else this.rotate(dx, dy);
      this.invalidate();
    };
    const up = (e: PointerEvent) => {
      const click = drag && !drag.moved && drag.button === 0;
      drag = null;
      if (!click || !this.state) return;
      if (this.state.plot) {
        const probe = this.pickProbe(e);
        if (probe) this.events.onProbe(probe);
      } else {
        const face = this.pickFace(e);
        if (face) this.events.onSelect(face);
      }
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      this.zoomAt(Math.pow(1.0015, -e.deltaY), this.display(e));
      this.invalidate();
    };
    const leave = () => {
      if (hover !== null) this.events.onHover((hover = null));
    };
    const menu = (e: Event) => e.preventDefault();
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("contextmenu", menu);
    this.cleanup.push(() => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("contextmenu", menu);
    });
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.wave);
    for (const c of this.cleanup) c();
    this.window.finalize();
    this.session.dispose();
  }
}
