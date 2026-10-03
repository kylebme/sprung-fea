import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Scene,
  type Projection,
  type SceneState,
  type Theme,
  type ViewName,
} from "./scene";
import { geometryView, type Probe, type ViewData } from "./viewData";
import type { Filters, Geometry, Plot, Study } from "./types";
export { palette, type Projection, type Theme } from "./scene";

export type ViewerHandle = {
  fit: () => void;
  view: (v: ViewName) => void;
  screenshot: () => string;
};
type Props = {
  geometry: Geometry;
  /** Mesh or result arrays; the setup triangulation is shown without one. */
  view: ViewData | null;
  plot: Plot | null;
  study: Study;
  selected: number[];
  hovered: number | null;
  onSelect: (id: number) => void;
  onHover: (id: number | null) => void;
  onProbe: (probe: Probe) => void;
  /** Cross-section area in mm², or null without an active section. */
  onSectionArea: (area: number | null) => void;
  deformation: number;
  wireframe: boolean;
  probe: Probe | null;
  probeLabel: string | null;
  theme: Theme;
  projection: Projection;
  draftKind: "support" | "load" | "mass" | null;
  marginMax: number;
  yieldStrength: number | null;
  filters: Filters;
};

export const Viewer = forwardRef<ViewerHandle, Props>(function Viewer(p, ref) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const label = useRef<HTMLDivElement>(null);
  const props = useRef(p);
  props.current = p;
  const [scene, setScene] = useState<Scene | null>(null);
  const [failure, setFailure] = useState("");
  const setupView = useMemo(() => geometryView(p.geometry), [p.geometry]);

  useImperativeHandle(
    ref,
    () => ({
      fit: () => scene?.fit(),
      view: (v) => scene?.fit(v),
      screenshot: () => scene?.screenshot() || "",
    }),
    [scene],
  );

  useEffect(() => {
    let live = true;
    let created: Scene | null = null;
    const observer = new ResizeObserver(() => {
      const r = host.current!.getBoundingClientRect();
      created?.resize(r.width, r.height);
    });
    Scene.create(canvas.current!, {
      onSelect: (id) => props.current.onSelect(id),
      onHover: (id) => props.current.onHover(id),
      onProbe: (probe) => props.current.onProbe(probe),
      onOverlay: (at) => {
        const tag = label.current;
        if (!tag) return;
        tag.hidden = !at || !props.current.probeLabel;
        if (at) tag.style.translate = `${at.x}px ${at.y}px`;
      },
    })
      .then((s) => {
        if (!live) return s.dispose();
        created = s;
        observer.observe(host.current!);
        setScene(s);
      })
      .catch((e) => {
        console.error(e);
        if (live)
          setFailure(
            "The 3D view could not start. It needs WebGL 2 and WebAssembly; enable hardware acceleration and reopen BetterSim.",
          );
      });
    return () => {
      live = false;
      observer.disconnect();
      created?.dispose();
    };
  }, []);

  const view = p.view || setupView;
  const lastArea = useRef<number | null>(null);
  useEffect(() => {
    if (!scene) return;
    const state: SceneState = {
      view,
      faces: p.geometry.faces,
      bounds: p.geometry.bounds,
      study: p.study,
      selected: p.selected,
      hovered: p.hovered,
      draftKind: p.draftKind,
      plot: p.plot,
      deformation: p.deformation,
      wireframe: p.wireframe,
      theme: p.theme,
      projection: p.projection,
      marginMax: p.marginMax,
      yieldStrength: p.yieldStrength,
      filters: p.filters,
      probe: p.probe,
    };
    scene.update(state);
    const area = scene.sectionArea();
    if (area !== lastArea.current) {
      lastArea.current = area;
      p.onSectionArea(area);
    }
  });

  return (
    <div
      className="view-host"
      ref={host}
      aria-label="Interactive 3D part. Drag to rotate, right-drag to pan, scroll to zoom, click a face to select."
    >
      <canvas ref={canvas} tabIndex={-1} />
      {!scene && !failure && (
        <div className="viewer-note">Starting 3D view…</div>
      )}
      {failure && <div className="viewer-note">{failure}</div>}
      <div className="probe-label" ref={label} hidden>
        {p.probeLabel}
      </div>
    </div>
  );
});
