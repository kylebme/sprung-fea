import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { Plus, type LucideIcon } from "lucide-react";
import { moveFocus } from "./logic";

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
  value: number;
  unit?: string;
  step?: string;
  onChange: (n: number) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <span className="number-field">
        <input
          type="number"
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        {unit && <span>{unit}</span>}
      </span>
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
  swatch?: "support" | "load";
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
