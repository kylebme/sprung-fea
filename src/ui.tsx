import {
  createContext,
  useContext,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ChevronRight, Plus, type LucideIcon } from "lucide-react";
import { fmt, moveFocus, sig } from "./logic";
import type { ConditionKind } from "./types";
import {
  converts,
  fromShown,
  toShown,
  unitLabel,
  type UnitSystem,
} from "./units";

/** The unit system the interface shows; data stays in SI working units. */
export const UnitsContext = createContext<UnitSystem>("si");

/** Formatting in the chosen unit system, from SI working units. */
export function useUnits() {
  const system = useContext(UnitsContext);
  return {
    system,
    label: (unit: string) => unitLabel(unit, system),
    value: (v: number, unit: string) => toShown(v, unit, system),
    /** A formatted value: SI keeps its digits, converted values keep five
     * significant digits. */
    show: (v: number, unit: string, digits = 3) =>
      converts(unit, system)
        ? sig(toShown(v, unit, system), Math.max(4, digits + 1))
        : fmt(v, digits),
  };
}

/** A value with its unit, for read-only rows. */
export function Qty({
  value,
  unit,
  digits = 3,
}: {
  value: number;
  unit: string;
  digits?: number;
}) {
  const u = useUnits();
  return (
    <>
      {u.show(value, unit, digits)}
      <em>{u.label(unit)}</em>
    </>
  );
}

/**
 * A number input in the chosen units. The typed text is kept while it is
 * edited, so unit round-off never rewrites it; an empty field reports NaN.
 */
function useNumberText(value: number, unit: string | undefined) {
  const system = useContext(UnitsContext);
  const [text, setText] = useState<string | null>(null);
  const shown = toShown(value, unit ?? "", system);
  return {
    value:
      text ??
      (Number.isFinite(shown)
        ? // Converted values: six significant digits hide round-off.
          String(
            Number(shown.toPrecision(converts(unit ?? "", system) ? 6 : 10)),
          )
        : ""),
    change: (raw: string, onChange: (n: number) => void) => {
      setText(raw);
      const n = raw.trim() === "" ? NaN : Number(raw);
      if (raw.trim() === "" || Number.isFinite(n))
        onChange(fromShown(n, unit ?? "", system));
    },
    blur: () => setText(null),
  };
}

export function Head({ small, title }: { small: string; title: string }) {
  return (
    <div className="ihead">
      <small>{small}</small>
      <h2>{title}</h2>
    </div>
  );
}

export function Row({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="kv">
      <span>{label}</span>
      <b>{children}</b>
    </div>
  );
}

export function NumberField({
  label,
  value,
  unit,
  step = "any",
  onChange,
}: {
  label: string;
  /** In SI working units; `unit` names them and converts for display. */
  value: number;
  unit?: string;
  step?: string;
  onChange: (n: number) => void;
}) {
  const system = useContext(UnitsContext);
  const text = useNumberText(value, unit);
  return (
    <label className="field">
      <span>{label}</span>
      <span className="number-field">
        <input
          type="number"
          step={step}
          value={text.value}
          onChange={(e) => text.change(e.target.value, onChange)}
          onBlur={text.blur}
        />
        {unit && <span>{unitLabel(unit, system)}</span>}
      </span>
    </label>
  );
}

/** A bare number input for table cells, in the chosen units; empty is NaN. */
export function NumberCell({
  label,
  value,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  unit?: string;
  onChange: (n: number) => void;
}) {
  const text = useNumberText(value, unit);
  return (
    <span className="number-field">
      <input
        type="number"
        aria-label={label}
        value={text.value}
        onChange={(e) => text.change(e.target.value, onChange)}
        onBlur={text.blur}
      />
    </span>
  );
}

/**
 * Less common settings, collapsed until opened. `open` sets the starting
 * state, for settings the current study needs.
 */
export function More({
  title,
  open = false,
  children,
}: {
  title: string;
  open?: boolean;
  children: ReactNode;
}) {
  const [shown, setShown] = useState(open);
  return (
    <details
      className="more"
      open={shown}
      onToggle={(e) => setShown(e.currentTarget.open)}
    >
      <summary>
        <ChevronRight size={12} />
        {title}
      </summary>
      {shown && <div className="more-body">{children}</div>}
    </details>
  );
}

/** One component of a vector input, in the chosen units. */
export function VectorInput({
  axis,
  name,
  value,
  unit,
  onChange,
}: {
  axis: string;
  name: string;
  value: number;
  unit?: string;
  onChange: (n: number) => void;
}) {
  const text = useNumberText(value, unit);
  return (
    <label className={"axis-" + axis.toLowerCase()}>
      <span>{axis}</span>
      <input
        aria-label={axis + " " + name}
        type="number"
        value={text.value}
        onChange={(e) => text.change(e.target.value, onChange)}
        onBlur={text.blur}
      />
    </label>
  );
}

/** Arrow keys, Home and End move focus between the matching buttons. */
export const listKeys =
  (selector: string) => (e: KeyboardEvent<HTMLElement>) => {
    const items = [
      ...e.currentTarget.querySelectorAll<HTMLButtonElement>(selector),
    ].filter((b) => !b.disabled);
    const next = moveFocus(
      e.key,
      items.indexOf(document.activeElement as HTMLButtonElement),
      items.length,
    );
    if (next === null) return;
    e.preventDefault();
    items[next].focus();
  };

export function Node({
  depth = 0,
  icon: Icon,
  swatch,
  label,
  value,
  active,
  dim,
  group,
  disabled,
  onClick,
}: {
  depth?: number;
  icon?: LucideIcon;
  swatch?: ConditionKind;
  label: string;
  value?: string;
  active?: boolean;
  dim?: boolean;
  group?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      className={
        "node" +
        (active ? " active" : "") +
        (dim ? " dim" : "") +
        (group ? " group" : "")
      }
      style={{ "--d": depth } as CSSProperties}
      aria-current={active || undefined}
      onClick={onClick}
      disabled={disabled}
    >
      {Icon && <Icon size={14} />}
      {swatch && <span className={"swatch " + swatch} />}
      <span className="label">{label}</span>
      {value && <span className="val">{value}</span>}
    </button>
  );
}

export function Group({
  icon,
  label,
  active,
  onClick,
  onAdd,
  addLabel,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onClick: () => void;
  onAdd: () => void;
  addLabel: string;
  disabled: boolean;
}) {
  return (
    <div className="group-row">
      <Node
        depth={1}
        icon={icon}
        label={label}
        group
        active={active}
        onClick={onClick}
        disabled={disabled}
      />
      <button
        className="add"
        aria-label={addLabel}
        title={addLabel}
        onClick={onAdd}
        disabled={disabled}
      >
        <Plus size={13} />
      </button>
    </div>
  );
}
