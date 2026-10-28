/**
 * Small, unopinionated building blocks used across the app.
 *
 * These are deliberately plain: they take the project's CSS variables and add
 * nothing beyond layout, state styling and accessible defaults.
 */
"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

// ------------------------------------------------------------------- Button

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "subtle";
type ButtonSize = "sm" | "md" | "lg" | "icon";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--sf-accent)] text-[var(--sf-accent-ink)] hover:bg-[var(--sf-accent-strong)] " +
    "disabled:hover:bg-[var(--sf-accent)] font-medium",
  secondary:
    "bg-[var(--sf-bg-overlay)] text-[var(--sf-text)] border border-[var(--sf-border-strong)] " +
    "hover:border-[var(--sf-accent)]",
  ghost:
    "text-[var(--sf-text-muted)] hover:text-[var(--sf-text)] hover:bg-[var(--sf-bg-overlay)]",
  danger:
    "bg-[var(--sf-danger)] text-white hover:opacity-90 font-medium",
  subtle:
    "bg-transparent text-[var(--sf-text-muted)] border border-[var(--sf-border)] " +
    "hover:bg-[var(--sf-bg-overlay)] hover:text-[var(--sf-text)]",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
  lg: "h-12 px-6 text-base gap-2",
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
    { className, variant = "secondary", size = "md", loading, disabled, children, ...props },
    ref,
  ) {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        className={cn(
          "inline-flex items-center justify-center rounded-lg transition-colors",
          "disabled:opacity-50 disabled:cursor-not-allowed select-none whitespace-nowrap",
          BUTTON_VARIANTS[variant],
          BUTTON_SIZES[size],
          className,
        )}
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
  return cn(
    "inline-flex items-center justify-center rounded-lg transition-colors",
    "disabled:opacity-50 disabled:cursor-not-allowed select-none whitespace-nowrap",
    BUTTON_VARIANTS[variant],
    BUTTON_SIZES[size],
    className,
  );
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
  return (
    <div
      className={cn(
        "rounded-xl border border-[var(--sf-border)] bg-[var(--sf-bg-raised)]",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({
  title,
  description,
  action,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-4 p-5 pb-3", className)}>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold tracking-wide text-[var(--sf-text)]">
          {title}
        </h2>
        {description && (
          <p className="mt-1 text-xs leading-relaxed text-[var(--sf-text-muted)]">
            {description}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}

// -------------------------------------------------------------------- Input

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        "w-full rounded-lg border border-[var(--sf-border)] bg-[var(--sf-bg)] px-3 py-2",
        "text-sm text-[var(--sf-text)] placeholder:text-[var(--sf-text-faint)]",
        "focus:border-[var(--sf-accent)] focus:outline-none",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        "aria-[invalid=true]:border-[var(--sf-danger)]",
        className,
      )}
      {...props}
    />
  );
});

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        "w-full rounded-lg border border-[var(--sf-border)] bg-[var(--sf-bg)] px-3 py-2",
        "text-sm leading-relaxed text-[var(--sf-text)] placeholder:text-[var(--sf-text-faint)]",
        "focus:border-[var(--sf-accent)] focus:outline-none resize-y",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        "aria-[invalid=true]:border-[var(--sf-danger)]",
        className,
      )}
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
      className={className}
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
    <select
      ref={ref}
      className={cn(
        "w-full rounded-lg border border-[var(--sf-border)] bg-[var(--sf-bg)] px-3 py-2",
        "text-sm text-[var(--sf-text)] focus:border-[var(--sf-accent)] focus:outline-none",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
});

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
        className="flex items-center gap-1 text-xs font-medium text-[var(--sf-text-muted)]"
      >
        {label}
        {required && (
          <span className="text-[var(--sf-accent)]" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {child}
      {hint && !error && (
        <p id={hintId} className="text-xs leading-relaxed text-[var(--sf-text-faint)]">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs text-[var(--sf-danger)]">
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
            "block text-sm text-[var(--sf-text)]",
            disabled ? "opacity-50" : "cursor-pointer",
          )}
        >
          {label}
        </span>
        {description && (
          <p id={descriptionId} className="mt-0.5 text-xs text-[var(--sf-text-faint)]">
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
          "relative h-6 w-11 shrink-0 rounded-full transition-colors",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          checked ? "bg-[var(--sf-accent)]" : "bg-[var(--sf-bg-overlay)]",
          "border border-[var(--sf-border-strong)]",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white transition-transform",
            checked ? "translate-x-5.5" : "translate-x-0.5",
          )}
          style={{ height: "1.125rem", width: "1.125rem" }}
        />
      </button>
    </div>
  );
}

// -------------------------------------------------------------------- Badge

type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "bg-[var(--sf-bg-overlay)] text-[var(--sf-text-muted)]",
  accent: "bg-[var(--sf-accent)]/15 text-[var(--sf-accent)]",
  success: "bg-[var(--sf-success)]/15 text-[var(--sf-success)]",
  warning: "bg-[var(--sf-warning)]/15 text-[var(--sf-warning)]",
  danger: "bg-[var(--sf-danger)]/15 text-[var(--sf-danger)]",
  info: "bg-[var(--sf-info)]/15 text-[var(--sf-info)]",
};

export function Badge({
  tone = "neutral",
  className,
  children,
}: {
  tone?: BadgeTone;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        BADGE_TONES[tone],
        className,
      )}
    >
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
}: {
  selected?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 text-xs transition-colors",
        selected
          ? "border-[var(--sf-accent)] bg-[var(--sf-accent)]/15 text-[var(--sf-accent)]"
          : "border-[var(--sf-border)] text-[var(--sf-text-muted)] hover:border-[var(--sf-border-strong)] hover:text-[var(--sf-text)]",
        className,
      )}
    >
      {children}
    </button>
  );
}

// ------------------------------------------------------------------- Banner

export function Banner({
  tone = "info",
  title,
  children,
  action,
}: {
  tone?: "info" | "warning" | "danger" | "success";
  title?: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  const colour = {
    info: "var(--sf-info)",
    warning: "var(--sf-warning)",
    danger: "var(--sf-danger)",
    success: "var(--sf-success)",
  }[tone];

  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className="flex items-start gap-3 rounded-lg border p-3 text-sm"
      style={{ borderColor: colour, backgroundColor: `color-mix(in oklab, ${colour} 10%, transparent)` }}
    >
      <span
        aria-hidden="true"
        className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: colour }}
      />
      <div className="min-w-0 flex-1">
        {title && <p className="font-medium text-[var(--sf-text)]">{title}</p>}
        {children && (
          <div className="text-xs leading-relaxed text-[var(--sf-text-muted)]">{children}</div>
        )}
      </div>
      {action}
    </div>
  );
}

// ------------------------------------------------------------------- Skeleton

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("sf-shimmer rounded-lg", className)} aria-hidden="true" />;
}

// ------------------------------------------------------------------- Dialog

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
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
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    // Move focus into the dialog so keyboard users are not left behind it.
    panelRef.current?.focus();
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        tabIndex={-1}
        className="relative w-full max-w-md rounded-xl border border-[var(--sf-border-strong)] bg-[var(--sf-bg-raised)] p-5 shadow-2xl focus:outline-none"
      >
        <h2 className="text-base font-semibold text-[var(--sf-text)]">{title}</h2>
        {description && (
          <p className="mt-1.5 text-sm leading-relaxed text-[var(--sf-text-muted)]">
            {description}
          </p>
        )}
        {children && <div className="mt-4">{children}</div>}
        <div className="mt-5 flex justify-end gap-2">{footer}</div>
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
}: {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-[var(--sf-border)] px-6 py-16 text-center">
      {icon && <div className="mb-4 text-[var(--sf-text-faint)]">{icon}</div>}
      <h3 className="text-base font-medium text-[var(--sf-text)]">{title}</h3>
      {description && (
        <p className="mt-2 max-w-sm text-sm leading-relaxed text-[var(--sf-text-muted)]">
          {description}
        </p>
      )}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
