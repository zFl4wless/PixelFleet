import type React from "react";
import type { PropsWithChildren } from "react";
import { cn } from "../../lib/classNames";

type Tone = "default" | "success" | "warning" | "danger" | "info";

export function EightBitButton({
  className,
  variant = "primary",
  size = "md",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md" | "lg";
}) {
  return <button className={cn("eightbit-button", `button-${variant}`, `button-${size}`, className)} {...props} />;
}

export function EightBitInput({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn("eightbit-input", className)} {...props} />;
}

export function EightBitLoginForm({
  username,
  error,
  loading,
  onUsernameChange,
  onSubmit
}: {
  username: string;
  error?: string;
  loading: boolean;
  onUsernameChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <form
      className="login-form pixel-panel"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <img src="/pixel-fleet-mark.svg" alt="" className="login-logo" />
      <div>
        <p className="eyebrow">Guest Login</p>
        <h1>Pixel Fleet</h1>
      </div>
      <label className="field-label" htmlFor="username">
        Username
      </label>
      <EightBitInput
        id="username"
        value={username}
        maxLength={18}
        autoComplete="off"
        placeholder="Captain"
        onChange={(event) => onUsernameChange(event.target.value)}
      />
      {error ? <EightBitAlert tone="danger">{error}</EightBitAlert> : null}
      <EightBitButton disabled={loading} size="lg" type="submit">
        {loading ? "Creating account..." : "Start as guest"}
      </EightBitButton>
    </form>
  );
}

export function EightBitAvatar({ seed, label, size = "md" }: { seed: string; label: string; size?: "sm" | "md" | "lg" }) {
  const hash = Array.from(seed).reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const colors = ["#2de2c6", "#ffce3a", "#ef4f4f", "#f6fbff", "#65a7ff"];
  const color = colors[hash % colors.length];
  const accent = colors[(hash + 2) % colors.length];

  return (
    <div className={cn("eightbit-avatar", `avatar-${size}`)} aria-label={label} title={label}>
      <span style={{ backgroundColor: color }} />
      <span style={{ backgroundColor: accent }} />
      <span style={{ backgroundColor: color }} />
      <strong>{label.slice(0, 2).toUpperCase()}</strong>
    </div>
  );
}

export function EightBitBadge({ children, tone = "default" }: PropsWithChildren<{ tone?: Tone }>) {
  return <span className={cn("eightbit-badge", `tone-${tone}`)}>{children}</span>;
}

export function EightBitProgress({ value, label }: { value: number; label?: string }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className="progress-wrap" aria-label={label}>
      <div className="eightbit-progress">
        <span style={{ width: `${clamped}%` }} />
      </div>
      {label ? <small>{label}</small> : null}
    </div>
  );
}

export function EightBitTabs({
  tabs,
  active,
  onChange
}: {
  tabs: Array<{ id: string; label: string }>;
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="eightbit-tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          className={cn("tab-trigger", active === tab.id && "active")}
          key={tab.id}
          role="tab"
          aria-selected={active === tab.id}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function EightBitTable({
  rows
}: {
  rows: Array<{
    label: string;
    value: string | number;
  }>;
}) {
  return (
    <table className="eightbit-table">
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <th>{row.label}</th>
            <td>{row.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function EightBitAlert({ children, tone = "info" }: PropsWithChildren<{ tone?: Tone }>) {
  return <div className={cn("eightbit-alert", `tone-${tone}`)}>{children}</div>;
}

export function EightBitToastViewport({
  toasts,
  onDismiss
}: {
  toasts: Array<{ id: string; tone: Tone; message: string }>;
  onDismiss: (id: string) => void;
}) {
  return (
    <div className="toast-viewport" aria-live="polite">
      {toasts.map((toast) => (
        <button className={cn("eightbit-toast", `tone-${toast.tone}`)} key={toast.id} onClick={() => onDismiss(toast.id)}>
          {toast.message}
        </button>
      ))}
    </div>
  );
}

export function EightBitSpinner({ label = "Loading" }: { label?: string }) {
  return (
    <div className="spinner-wrap">
      <span className="eightbit-spinner" />
      <span>{label}</span>
    </div>
  );
}

export function EightBitSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="skeleton-stack">
      {Array.from({ length: lines }, (_, index) => (
        <span className="eightbit-skeleton" key={index} />
      ))}
    </div>
  );
}

export function EightBitTooltip({ label, children }: PropsWithChildren<{ label: string }>) {
  return (
    <span className="tooltip-wrap" data-tooltip={label}>
      {children}
    </span>
  );
}

export function EightBitSeparator() {
  return <div className="eightbit-separator" role="separator" />;
}
