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
};
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
  } | null>(null);
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
    renderer.setClearColor("#f3f5f7", 0);
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
    };
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
      for (const mesh of runtime.current?.faces || []) {
        const mat = mesh.material as THREE.MeshStandardMaterial;
        mat.emissive.set(mesh.userData.face === next ? "#1c443e" : "#000000");
        mat.emissiveIntensity = 0.18;
      }
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
      renderer.render(scene, camera);
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
    const colors = new Float32Array(positions.length);
    if (values.length)
      values.forEach((v, i) => {
        const c = contour(p.plot === "safety" ? 1 - v / max : v / max);
        colors[i * 3] = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
      });
    for (const face of surface.faces) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      g.setIndex(face.indices);
      g.computeVertexNormals();
      if (values.length)
        g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      const selected = p.selected.includes(face.id);
      const supported = p.study.supports.some((s) => s.faces.includes(face.id));
      const loaded = p.study.loads.some((l) => l.faces.includes(face.id));
      const mat = new THREE.MeshStandardMaterial({
        color: values.length
          ? "#ffffff"
          : selected
            ? "#5bbaa7"
            : supported
              ? "#8dbeb5"
              : loaded
                ? "#e6b88d"
                : "#becbd4",
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
          color: values.length ? "#203349" : "#516775",
          transparent: true,
          opacity: p.wireframe ? 0.22 : 0.4,
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
            new THREE.MeshStandardMaterial({ color: "#158477" }),
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
                  0x158477,
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
                0xc9793e,
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
              0xc9793e,
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
  ]);
  useEffect(() => {
    for (const mesh of runtime.current?.faces || []) {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.emissive.set(
        mesh.userData.face === p.hovered ? "#1c443e" : "#000000",
      );
      mat.emissiveIntensity = 0.18;
    }
  }, [p.hovered]);
  return (
    <div
      className="three-host"
      ref={host}
      aria-label="Interactive 3D part. Drag to rotate, scroll to zoom, click a face to select."
    >
      {failure && <div className="viewer-error">{failure}</div>}
    </div>
  );
});
