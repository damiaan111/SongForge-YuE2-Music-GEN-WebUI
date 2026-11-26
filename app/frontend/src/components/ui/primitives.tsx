/**
 * The building blocks every screen is made from.
 *
 * They take the project's CSS variables (globals.css) and add layout, state
 * styling and accessible defaults - nothing else. A page should be able to
 * look right by composing these without writing a colour or a font size.
 */
"use client";

import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  OctagonAlert,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";

// ------------------------------------------------------------------- Button

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "subtle";
type ButtonSize = "sm" | "md" | "lg" | "icon";

const BUTTON_BASE =
  "inline-flex items-center justify-center rounded-control font-medium " +
  "transition-[background-color,border-color,color,box-shadow,transform,filter] duration-150 " +
  "select-none whitespace-nowrap active:translate-y-px " +
  "disabled:opacity-45 disabled:cursor-not-allowed disabled:active:translate-y-0";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  // The one hot control on a screen: it starts work or makes sound.
  primary:
    "sf-ember shadow-[0_1px_0_oklch(1_0_0/0.25)_inset,0_6px_18px_-8px_var(--sf-accent-deep)] " +
    "hover:brightness-110 disabled:hover:brightness-100",
  secondary:
    "bg-overlay text-ink border border-edge-strong shadow-[var(--sf-highlight)] " +
    "hover:bg-elevated hover:border-ink-faint disabled:hover:bg-overlay",
  ghost:
    "text-ink-muted hover:text-ink hover:bg-overlay disabled:hover:bg-transparent",
  danger:
    "bg-danger text-white shadow-[0_1px_0_oklch(1_0_0/0.2)_inset] hover:brightness-110",
  subtle:
    "bg-transparent text-ink-muted border border-edge " +
    "hover:bg-overlay hover:text-ink hover:border-edge-strong",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
  lg: "h-12 px-6 text-[15px] gap-2.5",
  icon: "h-9 w-9 p-0",
};

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { className, variant = "secondary", size = "md", loading, disabled, children, type, ...props },
    ref,
  ) {
    return (
      <button
        ref={ref}
        // A bare <button> inside a <form> submits it; nothing here should.
        type={type ?? "button"}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        className={cn(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className)}
        {...props}
      >
        {loading && <Spinner className="h-3.5 w-3.5" />}
        {children}
      </button>
    );
  },
);

/** Button styling applied to any element - use for Next.js <Link>. */
export function buttonClasses(
  variant: ButtonVariant = "secondary",
  size: ButtonSize = "md",
  className?: string,
) {
  return cn(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className);
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn("animate-spin", className)}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path
        d="M22 12a10 10 0 0 1-10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

// --------------------------------------------------------------------- Card

export function Card({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("sf-card", className)} {...props} />;
}

export function CardHeader({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-3 p-5 pb-4 sm:p-6 sm:pb-4", className)}>
      <div className="flex min-w-0 flex-1 basis-[14rem] items-start gap-3">
        {icon && (
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-overlay text-accent">
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-ink">{title}</h2>
          {description && (
            <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
              {description}
            </p>
          )}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** A titled block inside a card or page: the heading every section shares. */
export function SectionTitle({
  children,
  description,
  action,
  className,
}: {
  children: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-ink">{children}</h2>
        {description && (
          <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">{description}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** The header every page opens with: one title, one line, the page's actions. */
export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  eyebrow?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3 sm:mb-8", className)}>
      <div className="min-w-0">
        {eyebrow && (
          <div className="mb-1.5 text-xs font-medium uppercase tracking-[0.14em] text-accent">
            {eyebrow}
          </div>
        )}
        <h1 className="text-2xl font-semibold leading-tight text-ink sm:text-[1.75rem]">
          {title}
        </h1>
        {description && (
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-ink-muted">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

// -------------------------------------------------------------------- Input

const CONTROL =
  "w-full rounded-control border border-edge bg-field px-3 text-sm text-ink " +
  "placeholder:text-ink-faint transition-[border-color,box-shadow] duration-150 " +
  "hover:border-edge-strong " +
  "focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-accent/15 " +
  "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:border-edge " +
  "aria-[invalid=true]:border-danger aria-[invalid=true]:focus:ring-danger/15";

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(CONTROL, "h-10", className)} {...props} />;
});

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(CONTROL, "resize-y py-2.5 leading-relaxed", className)}
      {...props}
    />
  );
});

/**
 * A numeric field that does not fight the person typing into it.
 *
 * `<input type="number">` reports an empty string for an intermediate value
 * like "1." or "-", so the usual `Number(e.target.value)` handler snaps a
 * controlled field to 0 mid-keystroke. This keeps the raw text locally, parses
 * on every change, and only re-reads the prop while the field is not focused.
 * A decimal comma is accepted, because a European keyboard produces one.
 */
export function NumberInput({
  value,
  onValueChange,
  allowEmpty = false,
  className,
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> & {
  value: number | null | undefined;
  onValueChange: (next: number | null) => void;
  allowEmpty?: boolean;
}) {
  const asText = (input: number | null | undefined) =>
    input === null || input === undefined ? "" : String(input);
  const [text, setText] = React.useState(() => asText(value));
  const [focused, setFocused] = React.useState(false);

  // While the field has focus the local text is the source of truth; outside
  // that, the prop wins (a version restore, a reset, a discard). Adjusting
  // during render rather than in an effect avoids a flash of the stale value.
  const external = asText(value);
  const [lastExternal, setLastExternal] = React.useState(external);
  if (!focused && external !== lastExternal) {
    setLastExternal(external);
    setText(external);
  }

  return (
    <Input
      {...props}
      type="text"
      inputMode="decimal"
      className={cn("tabular-nums", className)}
      value={text}
      onFocus={(event) => {
        setFocused(true);
        props.onFocus?.(event);
      }}
      onBlur={(event) => {
        setFocused(false);
        setText(asText(value));
        props.onBlur?.(event);
      }}
      onChange={(event) => {
        const raw = event.target.value;
        setText(raw);
        const trimmed = raw.trim().replace(",", ".");
        if (trimmed === "") {
          if (allowEmpty) onValueChange(null);
          return;
        }
        const parsed = Number(trimmed);
        if (Number.isFinite(parsed)) onValueChange(parsed);
      }}
    />
  );
}

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className, children, ...props }, ref) {
  return (
    <select ref={ref} className={cn(CONTROL, "sf-select h-10 cursor-pointer", className)} {...props}>
      {children}
    </select>
  );
});

/** A range input whose filled part tracks its value in every browser. */
export const Slider = React.forwardRef<
  HTMLInputElement,
  Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">
>(function Slider({ className, style, min = 0, max = 100, value, ...props }, ref) {
  const low = Number(min);
  const high = Number(max);
  const fill =
    typeof value === "number" || typeof value === "string"
      ? ((Number(value) - low) / (high - low || 1)) * 100
      : 50;
  return (
    <input
      ref={ref}
      type="range"
      min={min}
      max={max}
      value={value}
      className={cn("sf-range w-full", className)}
      style={{ ...style, ["--sf-range-fill" as string]: `${Math.min(100, Math.max(0, fill))}%` }}
      {...props}
    />
  );
});

/** A labelled checkbox drawn in the app's own style. */
export function Checkbox({
  checked,
  onChange,
  children,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  children: React.ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label
      className={cn(
        "inline-flex items-center gap-2 text-[13px] text-ink-muted",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:text-ink",
        className,
      )}
    >
      <input
        type="checkbox"
        className="sf-check"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      {children}
    </label>
  );
}

// -------------------------------------------------------------------- Field

export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
  className,
}: {
  label: React.ReactNode;
  htmlFor?: string;
  hint?: React.ReactNode;
  error?: string | null;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const generated = React.useId();
  const base = htmlFor ?? generated;
  const hintId = `${base}-hint`;
  const errorId = `${base}-error`;

  // Hints and errors are only announced if the control points at them, and a
  // field that reports an error should be marked invalid whether or not the
  // caller remembered. Both are wired here so no call site can forget.
  const describedBy = [error ? errorId : null, hint && !error ? hintId : null]
    .filter(Boolean)
    .join(" ");
  const child = React.isValidElement<Record<string, unknown>>(children)
    ? React.cloneElement(children, {
        "aria-describedby":
          [describedBy, children.props["aria-describedby"] as string | undefined]
            .filter(Boolean)
            .join(" ") || undefined,
        "aria-invalid": error ? true : children.props["aria-invalid"],
      })
    : children;

  return (
    <div className={cn("space-y-1.5", className)}>
      <label
        htmlFor={htmlFor}
        className="flex items-center gap-1 text-[13px] font-medium text-ink"
      >
        {label}
        {required && (
          <span className="text-accent" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {child}
      {hint && !error && (
        <p id={hintId} className="text-xs leading-relaxed text-ink-faint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="flex items-start gap-1.5 text-xs text-danger">
          <OctagonAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- Toggle

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
  id,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
  id?: string;
}) {
  // <label htmlFor> cannot name a <button>, so the switch is named by id
  // reference instead. Without this every toggle in the app is announced as an
  // anonymous "switch".
  const generated = React.useId();
  const base = id ?? generated;
  const labelId = `${base}-label`;
  const descriptionId = `${base}-description`;

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <span
          id={labelId}
          onClick={() => !disabled && onChange(!checked)}
          className={cn(
            "block text-sm font-medium text-ink",
            disabled ? "opacity-50" : "cursor-pointer",
          )}
        >
          {label}
        </span>
        {description && (
          <p id={descriptionId} className="mt-0.5 text-xs leading-relaxed text-ink-faint">
            {description}
          </p>
        )}
      </div>
      <button
        id={base}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={description ? descriptionId : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 h-6 w-11 shrink-0 rounded-full border transition-colors duration-200",
          "disabled:cursor-not-allowed disabled:opacity-50",
          checked
            ? "border-transparent bg-accent"
            : "border-edge-strong bg-sunken hover:border-ink-faint",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "absolute left-0.5 top-1/2 h-[1.125rem] w-[1.125rem] -translate-y-1/2 rounded-full shadow-sm",
            "transition-[transform,background-color] duration-200",
            checked ? "translate-x-[1.25rem] bg-accent-ink" : "translate-x-0 bg-ink-muted",
          )}
        />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- Segmented

/**
 * A segmented control: two to five mutually exclusive choices, all visible.
 *
 * Announced as a radio group with roving focus, so arrow keys move the choice
 * and Tab leaves the group in one step.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  size = "md",
  className,
  idPrefix,
}: {
  value: T;
  onChange: (next: T) => void;
  options: readonly { value: T; label: React.ReactNode; icon?: React.ReactNode; title?: string }[];
  /** Accessible name for the group. */
  label: string;
  size?: "sm" | "md";
  className?: string;
  idPrefix?: string;
}) {
  const generated = React.useId();
  const prefix = idPrefix ?? generated;
  const move = (step: number) => {
    const index = options.findIndex((option) => option.value === value);
    const next = options[(index + step + options.length) % options.length];
    onChange(next.value);
    requestAnimationFrame(() => document.getElementById(`${prefix}-${next.value}`)?.focus());
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        "inline-flex max-w-full gap-0.5 rounded-[0.8rem] border border-edge bg-sunken p-1",
        className,
      )}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          event.preventDefault();
          move(1);
        } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          event.preventDefault();
          move(-1);
        }
      }}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            id={`${prefix}-${option.value}`}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.title}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={cn(
              "sf-focus-inset inline-flex min-w-0 items-center justify-center gap-1.5 rounded-[0.55rem] font-medium",
              "transition-[background-color,color,box-shadow] duration-150",
              size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3.5 text-[13px]",
              active
                ? "bg-elevated text-ink shadow-[var(--sf-highlight),var(--sf-shadow-sm)]"
                : "text-ink-muted hover:text-ink",
            )}
          >
            {option.icon}
            <span className="truncate">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// -------------------------------------------------------------------- Badge

type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "bg-overlay text-ink-muted border-edge",
  accent: "bg-accent/12 text-accent border-accent/25",
  success: "bg-success/12 text-success border-success/25",
  warning: "bg-warning/12 text-warning border-warning/25",
  danger: "bg-danger/12 text-danger border-danger/25",
  info: "bg-info/12 text-info border-info/25",
};

export function Badge({
  tone = "neutral",
  dot,
  className,
  children,
}: {
  tone?: BadgeTone;
  /** A leading status dot; pulses when "live". */
  dot?: boolean | "live";
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium",
        BADGE_TONES[tone],
        className,
      )}
    >
      {dot && (
        <span
          aria-hidden="true"
          className={cn("relative h-1.5 w-1.5 rounded-full bg-current", dot === "live" && "animate-pulse")}
        />
      )}
      {children}
    </span>
  );
}

// --------------------------------------------------------------------- Chip

export function Chip({
  selected,
  onClick,
  children,
  className,
  disabled,
}: {
  selected?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors duration-150",
        "disabled:cursor-not-allowed disabled:opacity-50",
        selected
          ? "border-accent/60 bg-accent/14 font-medium text-accent"
          : "border-edge bg-raised text-ink-muted hover:border-edge-strong hover:bg-overlay hover:text-ink",
        className,
      )}
    >
      {children}
    </button>
  );
}

// ------------------------------------------------------------------- Banner

const BANNER_ICON = {
  info: Info,
  warning: AlertTriangle,
  danger: OctagonAlert,
  success: CheckCircle2,
} as const;

export function Banner({
  tone = "info",
  title,
  children,
  action,
  className,
}: {
  tone?: "info" | "warning" | "danger" | "success";
  title?: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  const colour = {
    info: "var(--sf-info)",
    warning: "var(--sf-warning)",
    danger: "var(--sf-danger)",
    success: "var(--sf-success)",
  }[tone];
  const Icon = BANNER_ICON[tone];

  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn("flex items-start gap-3 rounded-xl border p-3.5 text-sm", className)}
      style={{
        borderColor: `color-mix(in oklab, ${colour} 38%, transparent)`,
        backgroundColor: `color-mix(in oklab, ${colour} 9%, transparent)`,
      }}
    >
      <Icon
        aria-hidden="true"
        className="mt-0.5 h-4 w-4 shrink-0"
        style={{ color: colour }}
      />
      <div className="min-w-0 flex-1">
        {title && <p className="font-medium text-ink">{title}</p>}
        {children && (
          <div className={cn("text-[13px] leading-relaxed text-ink-muted", title && "mt-0.5")}>
            {children}
          </div>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

// ------------------------------------------------------------------- Skeleton

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("sf-shimmer rounded-xl", className)} aria-hidden="true" />;
}

// ------------------------------------------------------------------- Dialog

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), ' +
  'select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  size?: "md" | "lg" | "xl";
}) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  // Callers pass an inline arrow, so onClose changes identity on every render
  // of the parent. Through a ref, the effect below depends on `open` alone -
  // otherwise a live SSE frame re-runs it and drags focus back to the panel,
  // making the dialog's own buttons unreachable by keyboard.
  const closeRef = React.useRef(onClose);
  React.useEffect(() => {
    closeRef.current = onClose;
  });

  React.useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeRef.current();
        return;
      }
      // Keep Tab inside the dialog: the page behind it is inert to the eye,
      // so it must be inert to the keyboard too.
      if (event.key !== "Tab" || !panelRef.current) return;
      const items = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panelRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    // Move focus into the dialog so keyboard users are not left behind it.
    panelRef.current?.focus();
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      // Hand focus back to whatever opened the dialog.
      previous?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center p-0 sm:items-center sm:p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="absolute inset-0 bg-black/55 backdrop-blur-[3px]" aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        tabIndex={-1}
        className={cn(
          "sf-pop relative flex max-h-[min(92dvh,48rem)] w-full flex-col rounded-t-2xl border border-edge-strong bg-raised",
          "shadow-[var(--sf-shadow-lg)] focus:outline-none sm:rounded-2xl",
          size === "md" && "sm:max-w-md",
          size === "lg" && "sm:max-w-2xl",
          size === "xl" && "sm:max-w-4xl",
        )}
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-5 sm:px-6 sm:pt-6">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-ink">{title}</h2>
            {description && (
              <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{description}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1.5 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-overlay hover:text-ink"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        {children && <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 sm:px-6">{children}</div>}
        {footer && (
          <div className="flex flex-wrap justify-end gap-2 px-5 pb-5 pt-5 sm:px-6 sm:pb-6">{footer}</div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- EmptyState

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-2xl border border-dashed border-edge-strong/70 px-6 py-14 text-center",
        className,
      )}
    >
      {icon && (
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-overlay text-ink-muted">
          {icon}
        </div>
      )}
      <h3 className="text-lg font-semibold text-ink">{title}</h3>
      {description && (
        <p className="mt-2 max-w-md text-sm leading-relaxed text-ink-muted">
          {description}
        </p>
      )}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------- Menu

/**
 * A small drop-down menu anchored to its trigger.
 *
 * Closes on outside click and on Escape (returning focus to the trigger), and
 * flips above the trigger when there is no room below - the last card in a
 * grid must not open its menu underneath the player dock.
 */
export function Menu({
  trigger,
  children,
  align = "end",
  label,
  className,
}: {
  trigger: (props: {
    ref: React.Ref<HTMLButtonElement>;
    onClick: (event: React.MouseEvent) => void;
    "aria-expanded": boolean;
    "aria-haspopup": "menu";
  }) => React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  align?: "start" | "end";
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [above, setAbove] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      {trigger({
        ref: triggerRef,
        onClick: (event) => {
          event.preventDefault();
          event.stopPropagation();
          const rect = triggerRef.current?.getBoundingClientRect();
          // 260px is taller than any menu in the app; measured before opening
          // so the menu never paints in the wrong place first.
          if (rect) setAbove(window.innerHeight - rect.bottom < 260 && rect.top > 260);
          setOpen((value) => !value);
        },
        "aria-expanded": open,
        "aria-haspopup": "menu",
      })}
      {open && (
        <div
          role="menu"
          aria-label={label}
          className={cn(
            "sf-pop absolute z-40 min-w-48 overflow-hidden rounded-xl border border-edge-strong bg-elevated p-1 shadow-[var(--sf-shadow-lg)]",
            align === "end" ? "right-0" : "left-0",
            above ? "bottom-full mb-1.5" : "top-full mt-1.5",
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  icon,
  children,
  onClick,
  danger,
  href,
  description,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
  onClick?: () => void;
  danger?: boolean;
  href?: string;
  description?: React.ReactNode;
}) {
  const className = cn(
    // The menu clips its rounded corners, so the focus ring is drawn inside.
    "sf-focus-inset flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors",
    danger
      ? "text-danger hover:bg-danger/10"
      : "text-ink-muted hover:bg-overlay hover:text-ink",
  );
  const body = (
    <>
      {icon && <span className="flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block">{children}</span>
        {description && (
          <span className="mt-0.5 block text-xs text-ink-faint">{description}</span>
        )}
      </span>
    </>
  );
  if (href) {
    return (
      <a role="menuitem" href={href} onClick={onClick} className={className}>
        {body}
      </a>
    );
  }
  return (
    <button type="button" role="menuitem" onClick={onClick} className={className}>
      {body}
    </button>
  );
}

// ---------------------------------------------------------------------- Tabs

/**
 * An underlined tab strip that scrolls sideways when it runs out of room.
 *
 * Roving tabindex: one Tab stop for the whole strip, arrows move within it,
 * Home and End jump to the ends - the behaviour role="tab" promises.
 */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  idPrefix = "tab",
  panelId,
  className,
}: {
  tabs: readonly { value: T; label: React.ReactNode; count?: number | null }[];
  value: T;
  onChange: (next: T) => void;
  label: string;
  idPrefix?: string;
  panelId?: string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn("sf-scroll-x flex gap-1 border-b border-edge", className)}
      onKeyDown={(event) => {
        const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (!delta && event.key !== "Home" && event.key !== "End") return;
        event.preventDefault();
        const index = tabs.findIndex((tab) => tab.value === value);
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : (index + delta + tabs.length) % tabs.length;
        onChange(tabs[next].value);
        const target = document.getElementById(`${idPrefix}-${tabs[next].value}`);
        target?.focus();
        target?.scrollIntoView({ block: "nearest", inline: "nearest" });
      }}
    >
      {tabs.map((tab) => {
        const active = tab.value === value;
        return (
          <button
            key={tab.value}
            id={`${idPrefix}-${tab.value}`}
            role="tab"
            type="button"
            aria-selected={active}
            aria-controls={panelId}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(tab.value)}
            className={cn(
              // The strip scrolls sideways, so it clips the focus ring above
              // and below; sf-focus-inset draws it inside the tab instead.
              "sf-focus-inset relative inline-flex h-11 shrink-0 items-center gap-1.5 whitespace-nowrap px-3.5 text-sm font-medium transition-colors",
              active ? "text-ink" : "text-ink-muted hover:text-ink",
            )}
          >
            {tab.label}
            {tab.count != null && tab.count > 0 && (
              <span className="rounded-full bg-overlay px-1.5 text-xs tabular-nums text-ink-muted">
                {tab.count}
              </span>
            )}
            <span
              aria-hidden="true"
              className={cn(
                "absolute inset-x-2 -bottom-px h-0.5 rounded-full transition-opacity",
                active ? "bg-accent opacity-100" : "opacity-0",
              )}
            />
          </button>
        );
      })}
    </div>
  );
}

// ----------------------------------------------------------------- KeyValue

/** A label / value row for the detail lists (provenance, hardware, files). */
export function KeyValue({
  label,
  value,
  mono,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex items-baseline justify-between gap-4 py-2", className)}>
      <dt className="shrink-0 text-[13px] text-ink-faint">{label}</dt>
      <dd
        className={cn(
          "min-w-0 text-right text-[13px] text-ink",
          mono && "font-mono text-xs",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
