import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Geometry, Mesh, Result, Study, Plot } from "./types";
export type Theme = "light" | "dark";
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
  draftKind: "support" | "load" | null;
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
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    group: THREE.Group;
    faces: THREE.Mesh[];
    radius: number;
    center: THREE.Vector3;
    probe: THREE.Vector3 | null;
  } | null>(null);
  const label = useRef<HTMLDivElement>(null);
  const props = useRef(p);
  props.current = p;
  const [failure, setFailure] = useState("");
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
    r.camera.up.set(0, 0, v === "top" ? 0 : 1);
    if (v === "top") r.camera.up.set(0, 1, 0);
    r.camera.position
      .copy(r.center)
      .addScaledVector(
        dir,
        (r.radius /
          (Math.sin(THREE.MathUtils.degToRad(r.camera.fov / 2)) *
            Math.min(1, r.camera.aspect))) *
          1.16,
      );
    r.controls.target.copy(r.center);
    r.camera.near = r.radius / 1000;
    r.camera.far = r.radius * 1000;
    r.camera.updateProjectionMatrix();
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
    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 10000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x637080, 2.5));
    const light = new THREE.DirectionalLight(0xffffff, 3);
    light.position.set(100, -100, 200);
    scene.add(light);
    const group = new THREE.Group();
    scene.add(group);
    runtime.current = {
      renderer,
      scene,
      camera,
      controls,
      group,
      faces: [],
      radius: 100,
      center: new THREE.Vector3(),
      probe: null,
    };
    const triad = axisTriad();
    const resize = new ResizeObserver(() => {
      const { width, height } = el.getBoundingClientRect();
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      fit();
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
      raycaster.setFromCamera(pointer, camera);
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
      controls.update();
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
      const point = runtime.current?.probe;
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
      controls.dispose();
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
  useEffect(() => {
    const r = runtime.current;
    if (!r) return;
    const b = p.geometry.bounds;
    r.center.set((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2);
    r.radius = Math.hypot(...p.geometry.dimensions) / 2;
    fit();
  }, [p.geometry]);
  useEffect(() => {
    const r = runtime.current;
    if (!r) return;
    while (r.group.children.length) {
      const child = r.group.children[0];
      child.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
          obj.geometry.dispose();
          const mats = Array.isArray(obj.material)
            ? obj.material
            : [obj.material];
          mats.forEach((m) => m.dispose());
        }
      });
      r.group.remove(child);
    }
    r.faces = [];
    r.probe = null;
    const colors = COLORS[p.theme];
    const selectColor =
      p.draftKind === "support"
        ? colors.support
        : p.draftKind === "load"
          ? colors.load
          : colors.select;
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
                s > 0 ? Math.min(5, (p.study.material?.yield || 1) / s) : 5,
              );
      max =
        p.plot === "safety" ? 5 : values.reduce((a, b) => Math.max(a, b), 0);
    }
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
      const selected = p.selected.includes(face.id);
      const supported = p.study.supports.some((s) => s.faces.includes(face.id));
      const loaded = p.study.loads.some((l) => l.faces.includes(face.id));
      const mat = new THREE.MeshStandardMaterial({
        color: values.length
          ? "#ffffff"
          : selected
            ? selectColor
            : supported
              ? colors.supportFace
              : loaded
                ? colors.loadFace
                : colors.base,
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
      const lines = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({
          color: values.length ? colors.resultEdge : colors.edge,
          transparent: true,
          opacity: p.wireframe ? 0.3 : colors.edgeOpacity,
        }),
      );
      r.group.add(lines);
    }
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
          r.group.add(ball);
          for (let a = 0; a < 3; a++)
            if (s.axes[a]) {
              const dir = new THREE.Vector3();
              dir.setComponent(a, 1);
              r.group.add(
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
            r.group.add(
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
          r.group.add(
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
    if (p.probe && p.result) {
      const index = surface.nodeIds.indexOf(p.probe);
      if (index >= 0) {
        const ball = new THREE.Mesh(
          new THREE.SphereGeometry(r.radius * 0.014, 16, 12),
          new THREE.MeshBasicMaterial({ color: "#ffffff", depthTest: false }),
        );
        ball.position.fromArray(positions, index * 3);
        ball.renderOrder = 5;
        r.group.add(ball);
        r.probe = ball.position.clone();
      }
    }
  }, [
    p.geometry,
    p.mesh,
    p.result,
    p.study,
    p.selected,
    p.plot,
    p.deformation,
    p.wireframe,
    p.probe,
    p.theme,
    p.draftKind,
  ]);
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
