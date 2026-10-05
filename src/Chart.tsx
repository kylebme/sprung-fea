// A small SVG line chart for x–y result series: convergence histories,
// response curves and load paths. Colors come from the theme tokens. Every
// chart can open larger in a dialog that saves it as a PNG or CSV.
import { useEffect, useRef, useState, type Ref } from "react";
import { FileDown, ImageDown, Maximize2, X } from "lucide-react";
import { saveFile } from "./api";
import { fmt, sig } from "./logic";

export type Series = { label: string; values: number[] };

/** "Nice" tick values covering [min, max], and the step between them. */
export function ticks(min: number, max: number, count = 4) {
  if (!(max > min)) return { values: [min], step: Math.abs(min) || 1 };
  const raw = (max - min) / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) ||
    10 * power;
  const values: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step)
    values.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return { values, step };
}

/** A tick label with just enough decimals to tell neighbors apart. */
const tickText = (v: number, step: number) =>
  Math.abs(v) >= 1e6 || (Math.abs(v) > 0 && Math.abs(v) < 1e-3)
    ? v.toExponential(2)
    : fmt(v, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)));

type ChartProps = {
  x: number[];
  series: Series[];
  xLabel: string;
  yLabel: string;
  logX?: boolean;
  logY?: boolean;
  /** Index of the highlighted x value. */
  selected?: number;
  /** Clicking picks the nearest x value. */
  onSelect?: (index: number) => void;
  height?: number;
  /** Smallest y range shown, centered on the data, so tiny changes look flat. */
  minSpan?: number;
  label: string;
};

/** A chart with a button that opens it larger, with PNG and CSV export. */
export function LineChart(props: ChartProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="chart-frame">
      <Plot {...props} />
      <button
        className="icon-button chart-expand"
        title="Open larger"
        aria-label={`Open ${props.label} larger`}
        onClick={() => setOpen(true)}
      >
        <Maximize2 size={12} />
      </button>
      {open && <ChartDialog {...props} onClose={() => setOpen(false)} />}
    </div>
  );
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "chart";

const csvCell = (text: string) =>
  /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;

/** The plotted values as CSV: one row per x value, one column per series. */
export function chartCsv({ x, series, xLabel, yLabel }: ChartProps) {
  const head = [
    xLabel,
    ...series.map((s) => (yLabel ? `${s.label}, ${yLabel}` : s.label)),
  ];
  const rows = x.map((v, i) =>
    [v, ...series.map((s) => s.values[i])]
      .map((n) => (Number.isFinite(n) ? String(n) : ""))
      .join(","),
  );
  return [head.map(csvCell).join(","), ...rows].join("\n") + "\n";
}

/**
 * Renders the chart's SVG to a PNG, as base64, with the title above it. The
 * theme's colors are copied inline, since the stylesheet doesn't come along.
 */
async function chartPng(svg: SVGSVGElement, title: string) {
  const scale = 2;
  const margin = 16;
  const titleHeight = 28;
  const { width, height } = svg.viewBox.baseVal;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const targets = clone.querySelectorAll<SVGElement>("*");
  svg.querySelectorAll("*").forEach((el, i) => {
    const style = getComputedStyle(el);
    for (const p of [
      "fill",
      "stroke",
      "stroke-width",
      "stroke-dasharray",
      "font-family",
      "font-size",
      "font-weight",
    ])
      targets[i].style.setProperty(p, style.getPropertyValue(p));
  });
  // The hover and frame cursor are for reading values, not for the export.
  clone.querySelectorAll(".cursor").forEach((el) => el.remove());
  // Tick labels can hang past the plot's edges, so the margin is drawn too.
  const [w, h] = [width + 2 * margin, height + margin];
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("viewBox", `${-margin} 0 ${w} ${h}`);
  clone.setAttribute("width", String(w));
  clone.setAttribute("height", String(h));
  const image = new Image();
  image.src =
    "data:image/svg+xml;charset=utf-8," +
    encodeURIComponent(new XMLSerializer().serializeToString(clone));
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = w * scale;
  canvas.height = (h + titleHeight + margin) * scale;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  const root = getComputedStyle(document.documentElement);
  ctx.fillStyle = root.getPropertyValue("--panel");
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = root.getPropertyValue("--text");
  ctx.font = `600 13px ${root.fontFamily}`;
  ctx.textBaseline = "top";
  ctx.fillText(title, margin, margin);
  ctx.drawImage(image, 0, margin + titleHeight, w, h);
  return canvas.toDataURL("image/png").split(",")[1];
}

function ChartDialog({
  onClose,
  ...props
}: ChartProps & { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const name = `sprung-fea-${slug(props.label)}`;
  const save = async (kind: "png" | "csv") => {
    setError("");
    try {
      if (kind === "csv") await saveFile(name + ".csv", chartCsv(props));
      else
        await saveFile(
          name + ".png",
          await chartPng(svg.current!, props.label),
          "base64",
        );
    } catch (e) {
      setError(
        `Couldn't save the ${kind.toUpperCase()}: ${(e as Error).message}`,
      );
    }
  };
  return (
    <dialog
      ref={dialog}
      className="chart-dialog"
      aria-label={props.label}
      onClose={onClose}
      // Escape closes the dialog only, not whatever edit is open behind it.
      onKeyDown={(e) => e.key === "Escape" && e.stopPropagation()}
      onClick={(e) => e.target === e.currentTarget && dialog.current?.close()}
    >
      <div className="chart-dialog-body">
        <header>
          <h3>{props.label}</h3>
          <button
            className="icon-button"
            aria-label="Close"
            onClick={() => dialog.current?.close()}
          >
            <X size={14} />
          </button>
        </header>
        <Plot
          {...props}
          width={640}
          height={360}
          tickCount={6}
          legend
          svgRef={svg}
        />
        <footer>
          {error && <span className="note warn">{error}</span>}
          <button className="btn" onClick={() => save("png")}>
            <ImageDown size={13} /> Save PNG
          </button>
          <button className="btn" onClick={() => save("csv")}>
            <FileDown size={13} /> Save CSV
          </button>
        </footer>
      </div>
    </dialog>
  );
}

function Plot({
  x,
  series,
  xLabel,
  yLabel,
  logX = false,
  logY = false,
  selected,
  onSelect,
  height = 150,
  minSpan = 0,
  label,
  width = 280,
  tickCount = 3,
  legend: showLegend = false,
  svgRef,
}: ChartProps & {
  width?: number;
  /** About how many ticks each axis gets. */
  tickCount?: number;
  /** Name the series inside the plot, so a saved image carries its key. */
  legend?: boolean;
  svgRef?: Ref<SVGSVGElement>;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const legend = showLegend && series.length > 1;
  const pad = { left: 46, right: 8, top: legend ? 20 : 8, bottom: 30 };
  const fx = (v: number) => (logX ? Math.log10(v) : v);
  const fy = (v: number) => (logY ? Math.log10(Math.max(v, 1e-30)) : v);
  const xs = x.map(fx);
  const ys = series.flatMap((s) => s.values.map(fy)).filter(Number.isFinite);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  let [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  if (!logY && y0 > 0 && y0 < 0.6 * y1) y0 = 0;
  if (!logY && y1 - y0 < minSpan) {
    const mid = (y0 + y1) / 2;
    [y0, y1] = [mid - minSpan / 2, mid + minSpan / 2];
  }
  if (y1 === y0)
    [y0, y1] = [y0 - (Math.abs(y0) || 1) * 0.1, y1 + (Math.abs(y1) || 1) * 0.1];
  const px = (v: number) =>
    pad.left + ((v - x0) / (x1 - x0 || 1)) * (width - pad.left - pad.right);
  const py = (v: number) =>
    height -
    pad.bottom -
    ((v - y0) / (y1 - y0)) * (height - pad.top - pad.bottom);
  // Log axes get nice ticks in linear space, placed at their logarithms.
  const axisTicks = (lo: number, hi: number, log: boolean) => {
    // Over a decade or more: powers of ten.
    if (log && hi - lo >= 1) {
      const out = [];
      for (let p = Math.ceil(lo); p <= Math.floor(hi); p++)
        out.push({ at: p, text: tickText(10 ** p, 10 ** p) });
      return out;
    }
    const t = log
      ? ticks(10 ** lo, 10 ** hi, tickCount)
      : ticks(lo, hi, tickCount);
    return t.values
      .filter((v) => !log || v > 0)
      .map((v) => ({ at: log ? Math.log10(v) : v, text: tickText(v, t.step) }));
  };
  const xTicks = axisTicks(x0, x1, logX);
  const yTicks = axisTicks(y0, y1, logY);
  const nearest = (clientX: number, rect: DOMRect) => {
    const v =
      x0 +
      ((((clientX - rect.left) / rect.width) * width - pad.left) /
        (width - pad.left - pad.right)) *
        (x1 - x0);
    let best = 0;
    xs.forEach((xv, i) => {
      if (Math.abs(xv - v) < Math.abs(xs[best] - v)) best = i;
    });
    return best;
  };
  const marked = hover ?? selected ?? null;
  return (
    <figure className="chart">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={label}
        onMouseMove={(e) =>
          setHover(nearest(e.clientX, e.currentTarget.getBoundingClientRect()))
        }
        onMouseLeave={() => setHover(null)}
        onClick={(e) =>
          onSelect?.(
            nearest(e.clientX, e.currentTarget.getBoundingClientRect()),
          )
        }
        style={{ cursor: onSelect ? "pointer" : "default" }}
      >
        {yTicks.map((t) => (
          <g key={"y" + t.at}>
            <line
              className="grid"
              x1={pad.left}
              x2={width - pad.right}
              y1={py(t.at)}
              y2={py(t.at)}
            />
            <text
              className="tick"
              x={pad.left - 4}
              y={py(t.at) + 3}
              textAnchor="end"
            >
              {t.text}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text
            key={"x" + t.at}
            className="tick"
            x={px(t.at)}
            y={height - pad.bottom + 12}
            textAnchor="middle"
          >
            {t.text}
          </text>
        ))}
        <text
          className="axis"
          x={(pad.left + width - pad.right) / 2}
          y={height - 3}
          textAnchor="middle"
        >
          {xLabel}
        </text>
        <text
          className="axis"
          x={9}
          y={(height - pad.bottom) / 2}
          textAnchor="middle"
          transform={`rotate(-90 9 ${(height - pad.bottom) / 2})`}
        >
          {yLabel}
        </text>
        {series.map((s, k) => (
          <g key={s.label} className={"series s" + k}>
            <polyline
              fill="none"
              points={s.values
                .map((v, i) => [px(xs[i]), py(fy(v))])
                .filter(([, y]) => Number.isFinite(y))
                .map((p) => p.join(","))
                .join(" ")}
            />
            {x.length <= 12 &&
              s.values.map((v, i) => (
                <circle key={i} cx={px(xs[i])} cy={py(fy(v))} r={2.5} />
              ))}
          </g>
        ))}
        {legend &&
          series.map((s, k) => {
            // Mono text, so each key's width follows from its label.
            const at =
              pad.left +
              series
                .slice(0, k)
                .reduce((sum, p) => sum + p.label.length * 5.5 + 26, 0);
            return (
              <g key={s.label} className={"series s" + k}>
                <polyline fill="none" points={`${at},7 ${at + 12},7`} />
                <text className="tick" x={at + 16} y={10}>
                  {s.label}
                </text>
              </g>
            );
          })}
        {marked !== null && (
          <line
            className="cursor"
            x1={px(xs[marked])}
            x2={px(xs[marked])}
            y1={pad.top}
            y2={height - pad.bottom}
          />
        )}
      </svg>
      {marked !== null && (
        <figcaption className="mono">
          {sig(x[marked])} ·{" "}
          {series.map((s) => sig(s.values[marked])).join(" · ")}
        </figcaption>
      )}
    </figure>
  );
}
