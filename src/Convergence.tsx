import { Check, TriangleAlert } from "lucide-react";
import { LineChart } from "./Chart";
import { fmt, sig } from "./logic";
import { useUnits } from "./ui";
import type { Convergence, ConvergenceOptions } from "./types";

const percent = (v: number | null) =>
  v === null ? "—" : fmt(v * 100, 2) + "%";

/** Plain-language verdict for one key result. */
function verdict(q: Convergence["quantities"][number], tolerance: number) {
  if (q.converged)
    return `Converged: changed ${percent(q.change)} on the last refinement, within ${percent(tolerance)}.`;
  if (q.singular)
    return `Still rising (${percent(q.change)} on the last refinement). This peak is likely at a sharp inside corner or a support edge, where the ideal model has no finite value. Judge strength away from it, or model the real fillet.`;
  return `Not converged: changed ${percent(q.change)} on the last refinement. Run more meshes or start from a finer one.`;
}

export function ConvergenceReport({ report }: { report: Convergence }) {
  const u = useUnits();
  const meshes = report.meshes;
  const done = report.quantities.every((q) => q.converged);
  return (
    <div className="convergence">
      <p className={"verdict " + (done ? "ok" : "warn")}>
        {done ? <Check size={13} /> : <TriangleAlert size={13} />}
        {done
          ? `Converged with ${meshes.length} meshes`
          : `Not fully converged after ${meshes.length} meshes`}
      </p>
      <table className="mesh-table">
        <thead>
          <tr>
            <th>Size, {u.label("mm")}</th>
            <th>Elements</th>
            {report.quantities.map((q) => (
              <th key={q.id}>
                {q.label}, {u.label(q.unit)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {meshes.map((m) => (
            <tr key={m.size}>
              <td>{u.show(m.size, "mm", 3)}</td>
              <td>{fmt(m.elementCount)}</td>
              {m.values.map((v, i) => (
                <td key={i}>{sig(u.value(v, report.quantities[i].unit))}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {report.quantities.map((q, i) => (
        <div key={q.id} className="quantity">
          <h5>
            {q.converged ? (
              <Check size={12} className="ok" />
            ) : (
              <TriangleAlert size={12} className="warn" />
            )}
            {q.label}
          </h5>
          <p className="note">{verdict(q, report.tolerance)}</p>
          {q.estimate && (
            <p className="note">
              Estimated limit {sig(u.value(q.estimate.value, q.unit))}{" "}
              {u.label(q.unit)} (Richardson extrapolation, observed order{" "}
              {fmt(q.estimate.order, 1)}).
            </p>
          )}
          {meshes.length > 1 && (
            <LineChart
              label={`${q.label} against element count`}
              x={meshes.map((m) => m.elementCount)}
              series={[
                {
                  label: q.label,
                  values: meshes.map((m) => u.value(m.values[i], q.unit)),
                },
              ]}
              xLabel="Elements"
              yLabel={u.label(q.unit)}
              logX
              height={110}
              minSpan={
                4 *
                report.tolerance *
                Math.abs(u.value(meshes.at(-1)!.values[i], q.unit))
              }
            />
          )}
        </div>
      ))}
    </div>
  );
}

/** Mesh count and tolerance for the next convergence study. */
export function ConvergenceControls({
  options,
  onChange,
}: {
  options: ConvergenceOptions;
  onChange: (o: ConvergenceOptions) => void;
}) {
  return (
    <>
      <div className="field">
        <span>Meshes, at most</span>
        <div className="seg" role="group" aria-label="Meshes">
          {[3, 4, 5].map((n) => (
            <button
              key={n}
              className={options.runs === n ? "on" : ""}
              aria-pressed={options.runs === n}
              onClick={() => onChange({ ...options, runs: n })}
            >
              {n}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span>Settled when results change less than</span>
        <div className="seg" role="group" aria-label="Tolerance">
          {[0.01, 0.02, 0.05].map((t) => (
            <button
              key={t}
              className={options.tolerance === t ? "on" : ""}
              aria-pressed={options.tolerance === t}
              onClick={() => onChange({ ...options, tolerance: t })}
            >
              {t * 100}%
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
