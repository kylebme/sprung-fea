import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import * as THREE from "three";
import { TrackballControls } from "three/addons/controls/TrackballControls.js";
import type { Geometry, Mesh, Result, Study, Plot } from "./types";
export type Theme = "light" | "dark";
export type Projection = "perspective" | "orthographic";
type Camera = THREE.PerspectiveCamera | THREE.OrthographicCamera;
const FOV = 35;
const halfFov = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
export type ViewerHandle = {
  fit: () => void;
  view: (v: string) => void;
  screenshot: () => string;
};
type Props = {
  geometry: Geometry;
  mesh: Mesh | null;
  result: Result | null;
  study: Study;
  selected: number[];
  hovered: number | null;
  onSelect: (id: number) => void;
  onHover: (id: number | null) => void;
  onProbe: (node: number) => void;
  plot: Plot;
  deformation: number;
  wireframe: boolean;
  probe: number | null;
  probeLabel: string | null;
  theme: Theme;
  projection: Projection;
  draftKind: "support" | "load" | null;
  marginMax: number;
  yieldStrength: number | null;
};
const COLORS = {
  dark: {
    base: "#8b959e",
    edge: "#07090b",
    edgeOpacity: 0.55,
    resultEdge: "#000000",
    hover: "#4d9bff",
    support: "#33b596",
    supportFace: "#4d9a87",
    load: "#f0a03c",
    loadFace: "#b08050",
    select: "#4d9bff",
  },
  light: {
    base: "#c3ccd3",
    edge: "#4a5a66",
    edgeOpacity: 0.4,
    resultEdge: "#203349",
    hover: "#2f6fd8",
    support: "#12866b",
    supportFace: "#8fc4b6",
    load: "#c9700c",
    loadFace: "#e8bf93",
    select: "#2f6fd8",
  },
};
const AXES: [string, number[], string][] = [
  ["X", [1, 0, 0], "#e5484d"],
  ["Y", [0, 1, 0], "#3dae6b"],
  ["Z", [0, 0, 1], "#3f74e0"],
];
function axisTriad() {
  const scene = new THREE.Scene();
  for (const [name, dir, color] of AXES) {
    const v = new THREE.Vector3(...(dir as [number, number, number]));
    scene.add(
      new THREE.ArrowHelper(v, new THREE.Vector3(), 1, color, 0.22, 0.1),
    );
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = color;
    ctx.font = "600 44px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(name, 32, 34);
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(canvas),
        depthTest: false,
      }),
    );
    sprite.position.copy(v.multiplyScalar(1.38));
    sprite.scale.setScalar(0.55);
    scene.add(sprite);
  }
  const camera = new THREE.OrthographicCamera(
    -1.35,
    1.35,
    1.35,
    -1.35,
    0.1,
    10,
  );
  return { scene, camera };
}
export const palette = [
  "#2352a1",
  "#279abe",
  "#42bf9b",
  "#d9d96d",
  "#f1a04c",
  "#d65349",
];
function contour(t: number) {
  t = Math.max(0, Math.min(1, t));
  const i = Math.min(4, Math.floor(t * 5));
  return new THREE.Color(palette[i]).lerp(
    new THREE.Color(palette[i + 1]),
    t * 5 - i,
  );
}
export const Viewer = forwardRef<ViewerHandle, Props>(function Viewer(p, ref) {
  const host = useRef<HTMLDivElement>(null);
  const runtime = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: Camera;
    perspective: THREE.PerspectiveCamera;
    orthographic: THREE.OrthographicCamera;
    /** Half the visible height of the orthographic view at zoom 1. */
    orthoHalf: number;
    aspect: number;
    controls: TrackballControls;
    group: THREE.Group;
    annotations: THREE.Group;
    markers: THREE.Group;
    positions: Float32Array | null;
    faces: THREE.Mesh[];
    radius: number;
    center: THREE.Vector3;
    probe: THREE.Vector3 | null;
  } | null>(null);
  const label = useRef<HTMLDivElement>(null);
  const props = useRef(p);
  props.current = p;
  const [failure, setFailure] = useState("");
  const frameOrtho = (
    cam: THREE.OrthographicCamera,
    half: number,
    aspect: number,
  ) => {
    cam.left = -half * aspect;
    cam.right = half * aspect;
    cam.top = half;
    cam.bottom = -half;
  };
  const fit = (v = "iso") => {
    const r = runtime.current;
    if (!r) return;
    const directions: Record<string, number[]> = {
      iso: [1, -1, 0.8],
      front: [0, -1, 0],
      top: [0, 0, 1],
      right: [1, 0, 0],
    };
    const dir = new THREE.Vector3(
      ...((directions[v] || directions.iso) as [number, number, number]),
    ).normalize();
    const cam = r.camera;
    if (v === "top") cam.up.set(0, 1, 0);
    else cam.up.set(0, 0, 1);
    // Half the visible height needed to show the bounding sphere.
    const half = (r.radius * 1.16) / Math.min(1, r.aspect);
    if (cam instanceof THREE.PerspectiveCamera) {
      cam.position.copy(r.center).addScaledVector(dir, half / halfFov);
      cam.near = r.radius / 1000;
      cam.far = r.radius * 1000;
    } else {
      r.orthoHalf = half;
      frameOrtho(cam, half, r.aspect);
      cam.zoom = 1;
      cam.position.copy(r.center).addScaledVector(dir, r.radius * 4);
      cam.near = r.radius / 1000;
      cam.far = r.radius * 1000;
    }
    r.controls.target.copy(r.center);
    cam.lookAt(r.center);
    cam.updateProjectionMatrix();
    r.controls.update();
  };
  const makeControls = (cam: Camera, dom: HTMLElement) => {
    // Trackball rotation has no fixed up axis, unlike a turntable.
    const controls = new TrackballControls(cam, dom);
    controls.rotateSpeed = 3.5;
    controls.zoomSpeed = 1.2;
    controls.panSpeed = 0.8;
    controls.staticMoving = false;
    controls.dynamicDampingFactor = 0.2;
    controls.keys = ["", "", ""];
    return controls;
  };
  /** Swaps cameras while keeping the view direction and visible size. */
  const project = (mode: Projection) => {
    const r = runtime.current;
    if (!r) return;
    const from = r.camera;
    const to = mode === "orthographic" ? r.orthographic : r.perspective;
    if (from === to) return;
    const target = r.controls.target.clone();
    const offset = from.position.clone().sub(target);
    const distance = offset.length();
    const dir = offset.normalize();
    to.up.copy(from.up);
    if (to instanceof THREE.OrthographicCamera) {
      r.orthoHalf = distance * halfFov;
      frameOrtho(to, r.orthoHalf, r.aspect);
      to.zoom = 1;
      to.position
        .copy(target)
        .addScaledVector(dir, Math.max(distance, r.radius * 4));
    } else {
      const half = r.orthoHalf / (from as THREE.OrthographicCamera).zoom;
      to.position.copy(target).addScaledVector(dir, half / halfFov);
    }
    to.near = r.radius / 1000;
    to.far = r.radius * 1000;
    to.lookAt(target);
    to.updateProjectionMatrix();
    r.controls.dispose();
    r.camera = to;
    r.controls = makeControls(to, r.renderer.domElement);
    r.controls.target.copy(target);
    r.controls.update();
  };
  const highlight = (face: number | null) => {
    for (const mesh of runtime.current?.faces || []) {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.emissive.set(
        mesh.userData.face === face
          ? COLORS[props.current.theme].hover
          : "#000000",
      );
      mat.emissiveIntensity = 0.16;
    }
  };
  useImperativeHandle(ref, () => ({
    fit: () => fit(),
    view: fit,
    screenshot: () =>
      runtime.current?.renderer.domElement
        .toDataURL("image/png")
        .split(",")[1] || "",
  }));
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        preserveDrawingBuffer: true,
      });
    } catch {
      setFailure(
        "The 3D view needs WebGL. Enable hardware acceleration and reopen BetterSim.",
      );
      return;
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setClearColor("#000000", 0);
    renderer.autoClear = false;
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const perspective = new THREE.PerspectiveCamera(FOV, 1, 0.01, 10000);
    const orthographic = new THREE.OrthographicCamera(
      -1,
      1,
      1,
      -1,
      0.01,
      10000,
    );
    const controls = makeControls(perspective, renderer.domElement);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x637080, 2.5));
    // A headlight follows the camera, so free rotation never shows an unlit side.
    const light = new THREE.DirectionalLight(0xffffff, 3);
    scene.add(light, light.target);
    const right = new THREE.Vector3(),
      up = new THREE.Vector3();
    const group = new THREE.Group();
    const annotations = new THREE.Group();
    const markers = new THREE.Group();
    scene.add(group, annotations, markers);
    runtime.current = {
      renderer,
      scene,
      camera: perspective,
      perspective,
      orthographic,
      orthoHalf: 1,
      aspect: 1,
      controls,
      group,
      annotations,
      markers,
      positions: null,
      faces: [],
      radius: 100,
      center: new THREE.Vector3(),
      probe: null,
    };
    const triad = axisTriad();
    let sized = false;
    const resize = new ResizeObserver(() => {
      const r = runtime.current!;
      const { width, height } = el.getBoundingClientRect();
      if (!width || !height) return;
      renderer.setSize(width, height);
      r.aspect = width / height;
      perspective.aspect = r.aspect;
      perspective.updateProjectionMatrix();
      frameOrtho(orthographic, r.orthoHalf, r.aspect);
      orthographic.updateProjectionMatrix();
      r.controls.handleResize();
      // Frame the part once; later resizes (console, window) keep the view.
      if (!sized) {
        sized = true;
        fit();
      }
    });
    resize.observe(el);
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let down = { x: 0, y: 0 };
    let hover: number | null = null;
    const hit = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        (-(event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, runtime.current!.camera);
      return raycaster.intersectObjects(runtime.current?.faces || [])[0];
    };
    const pointerDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
    };
    const pointerMove = (e: PointerEvent) => {
      if (e.buttons) return;
      const h = hit(e);
      const next = h?.object.userData.face ?? null;
      if (next !== hover) {
        hover = next;
        props.current.onHover(next);
        renderer.domElement.style.cursor = next ? "pointer" : "grab";
      }
      highlight(next);
    };
    const pointerUp = (e: PointerEvent) => {
      if (
        e.button !== 0 ||
        Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5
      )
        return;
      const h = hit(e);
      if (!h) return;
      const latest = props.current;
      if (latest.result && latest.mesh) {
        const surface = latest.mesh.surface;
        const pos = (h.object as THREE.Mesh).geometry.getAttribute("position");
        const index = (h.object as THREE.Mesh).geometry.index!;
        const candidates = [0, 1, 2].map((i) =>
          index.getX(h.faceIndex! * 3 + i),
        );
        let best = candidates[0];
        let distance = Infinity;
        for (const i of candidates) {
          const d = new THREE.Vector3()
            .fromBufferAttribute(pos, i)
            .distanceToSquared(h.point);
          if (d < distance) {
            best = i;
            distance = d;
          }
        }
        latest.onProbe(surface.nodeIds[best]);
      } else latest.onSelect(h.object.userData.face);
    };
    const leave = () => {
      hover = null;
      props.current.onHover(null);
    };
    renderer.domElement.addEventListener("pointerdown", pointerDown);
    renderer.domElement.addEventListener("pointermove", pointerMove);
    renderer.domElement.addEventListener("pointerup", pointerUp);
    renderer.domElement.addEventListener("pointerleave", leave);
    let frame = 0;
    const render = () => {
      frame = requestAnimationFrame(render);
      const r = runtime.current!;
      const camera = r.camera;
      r.controls.update();
      right.setFromMatrixColumn(camera.matrixWorld, 0);
      up.setFromMatrixColumn(camera.matrixWorld, 1);
      light.position
        .copy(camera.position)
        .addScaledVector(right, r.radius)
        .addScaledVector(up, r.radius * 1.5);
      light.target.position.copy(r.controls.target);
      const { width, height } = el.getBoundingClientRect();
      renderer.setViewport(0, 0, width, height);
      renderer.clear();
      renderer.render(scene, camera);
      const size = 84;
      renderer.clearDepth();
      renderer.setScissorTest(true);
      renderer.setScissor(6, 6, size, size);
      renderer.setViewport(6, 6, size, size);
      triad.camera.position.set(0, 0, 4).applyQuaternion(camera.quaternion);
      triad.camera.quaternion.copy(camera.quaternion);
      renderer.render(triad.scene, triad.camera);
      renderer.setScissorTest(false);
      const tag = label.current;
      const point = r.probe;
      if (tag) {
        const v = point?.clone().project(camera);
        tag.hidden = !v || v.z > 1 || !props.current.probeLabel;
        if (v) {
          tag.style.left = ((v.x + 1) / 2) * width + "px";
          tag.style.top = ((1 - v.y) / 2) * height + "px";
        }
      }
    };
    render();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      runtime.current?.controls.dispose();
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
          obj.geometry.dispose();
          const mats = Array.isArray(obj.material)
            ? obj.material
            : [obj.material];
          mats.forEach((m) => m.dispose());
        }
      });
      renderer.dispose();
      el.removeChild(renderer.domElement);
      runtime.current = null;
    };
  }, []);
  useEffect(() => project(p.projection), [p.projection]);
  useEffect(() => {
    const r = runtime.current;
    if (!r) return;
    const b = p.geometry.bounds;
    r.center.set((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2);
    r.radius = Math.hypot(...p.geometry.dimensions) / 2;
    fit();
  }, [p.geometry]);
  const clear = (group: THREE.Group) => {
    while (group.children.length) {
      const child = group.children[0];
      child.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
          obj.geometry.dispose();
          const mats = Array.isArray(obj.material)
            ? obj.material
            : [obj.material];
          mats.forEach((m) => m.dispose());
        }
      });
      group.remove(child);
    }
  };
  // Selection and condition colours change often, so they are applied to the
  // existing face materials rather than rebuilding the scene.
  const paint = () => {
    const r = runtime.current;
    if (!r) return;
    const q = props.current;
    const colors = COLORS[q.theme];
    const selectColor =
      q.draftKind === "support"
        ? colors.support
        : q.draftKind === "load"
          ? colors.load
          : colors.select;
    const supported = new Set(q.study.supports.flatMap((s) => s.faces));
    const loaded = new Set(q.study.loads.flatMap((l) => l.faces));
    for (const mesh of r.faces) {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (mat.vertexColors) continue;
      const id = mesh.userData.face;
      mat.color.set(
        q.selected.includes(id)
          ? selectColor
          : supported.has(id)
            ? colors.supportFace
            : loaded.has(id)
              ? colors.loadFace
              : colors.base,
      );
    }
  };
  useEffect(() => {
    const r = runtime.current;
    if (!r) return;
    clear(r.group);
    r.faces = [];
    const colors = COLORS[p.theme];
    const surface = p.mesh?.surface || p.geometry;
    const positions = new Float32Array(surface.positions);
    let values: number[] = [];
    let max = 1;
    if (p.result) {
      for (let i = 0; i < positions.length / 3; i++)
        for (let a = 0; a < 3; a++)
          positions[i * 3 + a] += p.result.displacements[i][a] * p.deformation;
      values =
        p.plot === "stress"
          ? p.result.stress
          : p.plot === "movement"
            ? p.result.movement
            : p.result.stress.map((s) =>
                s > 0
                  ? Math.min(p.marginMax, (p.yieldStrength || 1) / s)
                  : p.marginMax,
              );
      max =
        p.plot === "safety"
          ? p.marginMax
          : values.reduce((a, b) => Math.max(a, b), 0);
    }
    r.positions = positions;
    const vertexColors = new Float32Array(positions.length);
    if (values.length)
      values.forEach((v, i) => {
        const c = contour(p.plot === "safety" ? 1 - v / max : v / max);
        vertexColors[i * 3] = c.r;
        vertexColors[i * 3 + 1] = c.g;
        vertexColors[i * 3 + 2] = c.b;
      });
    for (const face of surface.faces) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      g.setIndex(face.indices);
      g.computeVertexNormals();
      if (values.length)
        g.setAttribute("color", new THREE.BufferAttribute(vertexColors, 3));
      const mat = new THREE.MeshStandardMaterial({
        color: values.length ? "#ffffff" : colors.base,
        roughness: 0.55,
        metalness: 0.12,
        vertexColors: !!values.length,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
      const mesh = new THREE.Mesh(g, mat);
      mesh.userData.face = face.id;
      r.faces.push(mesh);
      r.group.add(mesh);
      const edges = p.wireframe
        ? new THREE.WireframeGeometry(g)
        : new THREE.EdgesGeometry(g, 25);
      r.group.add(
        new THREE.LineSegments(
          edges,
          new THREE.LineBasicMaterial({
            color: values.length ? colors.resultEdge : colors.edge,
            transparent: true,
            opacity: p.wireframe ? 0.3 : colors.edgeOpacity,
          }),
        ),
      );
    }
    paint();
    highlight(props.current.hovered);
  }, [
    p.geometry,
    p.mesh,
    p.result,
    p.plot,
    p.deformation,
    p.wireframe,
    p.theme,
    p.marginMax,
    p.yieldStrength,
  ]);
  useEffect(paint, [p.selected, p.study, p.draftKind, p.theme]);
  useEffect(() => {
    const r = runtime.current;
    if (!r) return;
    clear(r.annotations);
    const colors = COLORS[p.theme];
    if (!p.result) {
      const centers = p.geometry.faces;
      for (const s of p.study.supports)
        for (const id of s.faces) {
          const f = centers.find((f) => f.id === id);
          if (!f) continue;
          const c = new THREE.Vector3(
            ...(f.anchor as [number, number, number]),
          );
          const ball = new THREE.Mesh(
            new THREE.OctahedronGeometry(r.radius * 0.025),
            new THREE.MeshStandardMaterial({ color: colors.support }),
          );
          ball.position.copy(c);
          r.annotations.add(ball);
          for (let a = 0; a < 3; a++)
            if (s.axes[a]) {
              const dir = new THREE.Vector3();
              dir.setComponent(a, 1);
              r.annotations.add(
                new THREE.ArrowHelper(
                  dir,
                  c,
                  r.radius * 0.13,
                  colors.support,
                  r.radius * 0.035,
                  r.radius * 0.02,
                ),
              );
            }
        }
      for (const l of p.study.loads) {
        if (l.kind === "gravity") {
          const dir = new THREE.Vector3(
            ...(l.vector as [number, number, number]),
          );
          if (dir.lengthSq()) {
            dir.normalize();
            const c = r.center
              .clone()
              .add(new THREE.Vector3(0, 0, r.radius * 0.55));
            r.annotations.add(
              new THREE.ArrowHelper(
                dir,
                c,
                r.radius * 0.3,
                colors.load,
                r.radius * 0.06,
                r.radius * 0.03,
              ),
            );
          }
          continue;
        }
        for (const id of l.faces) {
          const f = centers.find((f) => f.id === id);
          if (!f) continue;
          let dir = new THREE.Vector3(
            ...(l.vector as [number, number, number]),
          );
          if (l.kind === "pressure") {
            dir
              .set(...(f.normal as [number, number, number]))
              .multiplyScalar(l.magnitude >= 0 ? -1 : 1);
          }
          if (dir.lengthSq() === 0) continue;
          dir.normalize();
          const c = new THREE.Vector3(
            ...(f.anchor as [number, number, number]),
          );
          const start = c.clone().addScaledVector(dir, -r.radius * 0.25);
          r.annotations.add(
            new THREE.ArrowHelper(
              dir,
              start,
              r.radius * 0.25,
              colors.load,
              r.radius * 0.06,
              r.radius * 0.03,
            ),
          );
        }
      }
    }
  }, [p.geometry, p.study, p.result, p.theme]);
  useEffect(() => {
    const r = runtime.current;
    if (!r) return;
    clear(r.markers);
    r.probe = null;
    const surface = p.mesh?.surface || p.geometry;
    if (p.probe && p.result && r.positions) {
      const index = surface.nodeIds.indexOf(p.probe);
      if (index >= 0) {
        const ball = new THREE.Mesh(
          new THREE.SphereGeometry(r.radius * 0.014, 16, 12),
          new THREE.MeshBasicMaterial({ color: "#ffffff", depthTest: false }),
        );
        ball.position.fromArray(r.positions, index * 3);
        ball.renderOrder = 5;
        r.markers.add(ball);
        r.probe = ball.position.clone();
      }
    }
  }, [p.probe, p.result, p.mesh, p.geometry, p.deformation]);
  useEffect(() => highlight(p.hovered), [p.hovered, p.theme]);
  return (
    <div
      className="three-host"
      ref={host}
      aria-label="Interactive 3D part. Drag to rotate, scroll to zoom, click a face to select."
    >
      {failure && <div className="viewer-error">{failure}</div>}
      <div className="probe-label" ref={label} hidden>
        {p.probeLabel}
      </div>
    </div>
  );
});
