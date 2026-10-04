// A small SVG line chart for x–y result series: convergence histories,
// response curves and load paths. Colors come from the theme tokens.
import { useState } from "react";
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

export function LineChart({
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
}: {
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
}) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 280;
  const pad = { left: 46, right: 8, top: 8, bottom: 30 };
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
    const t = log ? ticks(10 ** lo, 10 ** hi, 3) : ticks(lo, hi, 3);
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
