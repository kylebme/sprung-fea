import type { ReactNode } from "react";
import { Box, FolderOpen, Upload } from "lucide-react";
import type { Part } from "./types";

export type Recovery = { name: string; at: number; legacy?: boolean };

export function StartScreen({
  recovery,
  busy,
  onImport,
  onOpen,
  onRestore,
  onSample,
  children,
}: {
  recovery: Recovery | null;
  busy: boolean;
  onImport: () => void;
  onOpen: () => void;
  onRestore: () => void;
  onSample: (name: NonNullable<Part["sample"]>) => void;
  children?: ReactNode;
}) {
  return (
    <main className="start">
      <div className="start-card">
        <div className="start-left">
          <div className="start-name">
            <div className="mark">
              <Box size={16} />
            </div>
            <div>
              <h1>Sprung FEA</h1>
              <span>0.2.0</span>
            </div>
          </div>
          <button className="act" onClick={onImport} disabled={busy}>
            <Upload size={15} />
            Import STEP…
            <kbd>⌘I</kbd>
          </button>
          <button className="act" onClick={onOpen} disabled={busy}>
            <FolderOpen size={15} />
            Open project…
            <kbd>⌘O</kbd>
          </button>
          <p className="scope">
            Static, vibration, buckling, thermal and dynamic analysis of parts
            and bonded assemblies, in SI or US units (switch in the status bar).
            Solves locally with CalculiX.
          </p>
        </div>
        <div className="start-right">
          {recovery && (
            <>
              <h2>Recent</h2>
              <div className="start-list">
                <button onClick={onRestore} disabled={busy}>
                  <b>{recovery.name.replace(/\.(step|stp)$/i, "")}</b>
                  <small>
                    {recovery.at
                      ? "Autosaved " +
                        new Date(recovery.at).toLocaleString([], {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })
                      : "Autosave"}
                  </small>
                  <span className="r">Restore</span>
                </button>
              </div>
            </>
          )}
          <h2>Examples</h2>
          <div className="start-list">
            <button onClick={() => onSample("beam")} disabled={busy}>
              <b>Cantilever beam</b>
              <small>100 × 20 × 10 mm · 6 faces</small>
              <span className="r">Open</span>
            </button>
            <button onClick={() => onSample("bracket")} disabled={busy}>
              <b>Mounting bracket</b>
              <small>70 × 45 × 50 mm · 4 holes</small>
              <span className="r">Open</span>
            </button>
            <button onClick={() => onSample("post-plate")} disabled={busy}>
              <b>Post on plate</b>
              <small>Assembly · 2 bonded bodies</small>
              <span className="r">Open</span>
            </button>
            <button onClick={() => onSample("bolted-joint")} disabled={busy}>
              <b>Bolted joint</b>
              <small>Two plates and a bolt · contact</small>
              <span className="r">Open</span>
            </button>
          </div>
          <p className="dropnote">
            Drop a .step, .stp or .sfea file anywhere in this window.
          </p>
        </div>
      </div>
      {children}
    </main>
  );
}
