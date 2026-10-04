import { useEffect, useRef } from "react";
import { ChevronDown, ChevronUp, LoaderCircle } from "lucide-react";
import { fmt } from "./logic";
import { STAGES } from "./labels";
import { useUnits } from "./ui";
import type { Result } from "./types";

export type LogEntry = {
  time: number;
  kind: string;
  text: string;
  level?: "error" | "done";
};
export type Job = {
  id: string;
  stage: string;
  message: string;
  started: number;
};

const clock = (t: number) =>
  new Date(t).toLocaleTimeString("en-GB", { hour12: false });

export function Console({
  log,
  result,
  open,
  tab,
  onOpen,
  onTab,
}: {
  log: LogEntry[];
  result: Result | null;
  open: boolean;
  tab: "output" | "checks";
  onOpen: (open: boolean) => void;
  onTab: (tab: "output" | "checks") => void;
}) {
  const u = useUnits();
  const end = useRef<HTMLDivElement>(null);
  // Braces matter: scrollIntoView returns a Promise in current Chromium, and
  // React would treat a returned value as the effect's cleanup function.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [log, open, tab]);
  const last = log.at(-1);
  const s = result?.summary;
  return (
    <div className={"console" + (open ? " open" : "")}>
      <div className="console-tabs">
        {(["output", "checks"] as const).map((t) => (
          <button
            key={t}
            className={tab === t ? "on" : ""}
            onClick={() => {
              if (open && tab === t) onOpen(false);
              else {
                onTab(t);
                onOpen(true);
              }
            }}
          >
            {t === "output" ? "Output" : "Checks"}
          </button>
        ))}
        <span className="last">{!open && last ? last.text : ""}</span>
        <button
          className="toggle"
          aria-label={open ? "Hide console" : "Show console"}
          onClick={() => onOpen(!open)}
        >
          {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </div>
      {open && (
        <div className="console-body">
          {tab === "output" ? (
            log.length ? (
              log.map((l, i) => (
                <div className={"log-line " + (l.level || "")} key={i}>
                  <span className="t">{clock(l.time)}</span>
                  <span className="k">{l.kind}</span>
                  <span className="m">{l.text}</span>
                </div>
              ))
            ) : (
              <div className="console-empty">No output yet.</div>
            )
          ) : result && s ? (
            <>
              <CheckRow label="Solver" value={result.solver} />
              <CheckRow label="Threads" value={fmt(result.threads)} />
              {result.iterations !== null && (
                <CheckRow
                  label="Solver iterations"
                  value={fmt(result.iterations)}
                />
              )}
              <CheckRow
                label="Mesh"
                value={`${fmt(result.elementCount)} C3D10 · ${fmt(result.nodeCount)} nodes · ${u.show(result.meshSize, "mm", 3)} ${u.label("mm")}`}
              />
              {result.checks.map((c) => (
                <CheckRow
                  key={c.label}
                  label={c.label}
                  value={
                    c.values
                      .map((v) =>
                        u.show(v, c.unit, c.digits ?? (c.unit === "%" ? 4 : 2)),
                      )
                      .join(", ") +
                    (c.unit === "%" ? "%" : " " + u.label(c.unit))
                  }
                />
              ))}
              <CheckRow label="Solve time" value={fmt(s.seconds, 2) + " s"} />
              {result.warnings.map((w) => (
                <div key={w} className="check-row">
                  {w}
                </div>
              ))}
            </>
          ) : (
            <div className="console-empty">Checks appear after a solve.</div>
          )}
          <div ref={end} />
        </div>
      )}
    </div>
  );
}

function CheckRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="check-row">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

/** Progress for a running job. Not modal: the view stays usable. */
export function JobCard({ job, onCancel }: { job: Job; onCancel: () => void }) {
  return (
    <div className="job-card" role="status">
      <div className="stage">
        <LoaderCircle size={13} className="spin" />
        {STAGES[job.stage] || job.stage}
        <span>{Math.floor((Date.now() - job.started) / 1000)} s</span>
      </div>
      <b>{job.message}</b>
      <div className="progress">
        <div />
      </div>
      <button className="btn" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
