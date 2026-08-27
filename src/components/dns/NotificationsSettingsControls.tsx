/**
 * Small building blocks shared by the notification settings sub-sections:
 * a labelled row, a debounced number field with clamp feedback, and a
 * confirmation dialog. Kept apart from the sections so each stays readable.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils";

/** Debounce applied to typed (text / number) inputs before they persist. */
export const SETTINGS_INPUT_DEBOUNCE_MS = 400;

interface SettingRowProps {
  /** Id of the control the row labels (`htmlFor`). Omit for a group label. */
  htmlFor?: string;
  label: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Label on the left, control on the right; stacks on narrow widths. */
export function SettingRow({
  htmlFor,
  label,
  description,
  children,
  className,
}: SettingRowProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 border-b border-border/40 py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        {htmlFor ? (
          <Label htmlFor={htmlFor} className="text-sm font-medium">
            {label}
          </Label>
        ) : (
          <span className="text-sm font-medium">{label}</span>
        )}
        {description ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {children}
      </div>
    </div>
  );
}

interface SwitchRowProps {
  id: string;
  label: string;
  description?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}

/** A labelled switch. Switches persist immediately (no debounce). */
export function SwitchRow({
  id,
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: SwitchRowProps) {
  return (
    <SettingRow htmlFor={id} label={label} description={description}>
      <Switch
        id={id}
        size="sm"
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </SettingRow>
  );
}

interface NumberFieldProps {
  id: string;
  label: string;
  description?: ReactNode;
  value: number | null;
  min: number;
  max: number;
  unit?: string;
  disabled?: boolean;
  /** Called with the clamped integer after the debounce / blur / Enter. */
  onCommit: (value: number) => void;
  /**
   * When present a "Never" checkbox is rendered; checking it commits `null`
   * and clears the number, unchecking restores `restoreValue`.
   */
  never?: {
    label: string;
    restoreValue: number;
    onChange: (never: boolean) => void;
  };
  debounceMs?: number;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Numeric input that persists 400 ms after the last keystroke (or on blur /
 * Enter), exposes `min`/`max` and an `aria-describedby` hint, and tells the
 * user when the typed value was adjusted to the allowed range.
 */
export function NumberField({
  id,
  label,
  description,
  value,
  min,
  max,
  unit,
  disabled,
  onCommit,
  never,
  debounceMs = SETTINGS_INPUT_DEBOUNCE_MS,
}: NumberFieldProps) {
  const { t } = useI18n();
  const hintId = useId();
  const noticeId = useId();
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  const [notice, setNotice] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  // Follow external changes (backend reply, restore defaults) unless typing.
  useEffect(() => {
    if (dirtyRef.current) return;
    setDraft(value === null ? "" : String(value));
  }, [value]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  const commit = useCallback(
    (raw: string) => {
      clearTimer();
      dirtyRef.current = false;
      const parsed = Number.parseInt(raw.trim(), 10);
      if (!Number.isFinite(parsed)) {
        // Nothing usable typed; fall back to the current value.
        setDraft(value === null ? "" : String(value));
        setNotice(null);
        return;
      }
      const clamped = clampInt(parsed, min, max);
      if (clamped !== parsed) {
        setNotice(
          t("Adjusted to {{value}} (allowed range {{min}}–{{max}})", {
            value: clamped,
            min,
            max,
            defaultValue: `Adjusted to ${clamped} (allowed range ${min}–${max})`,
          }),
        );
      } else {
        setNotice(null);
      }
      setDraft(String(clamped));
      if (clamped !== value) onCommitRef.current(clamped);
    },
    [clearTimer, max, min, t, value],
  );

  const isNever = never !== undefined && value === null;

  return (
    <SettingRow htmlFor={id} label={label} description={description}>
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-2">
          <Input
            id={id}
            type="number"
            inputMode="numeric"
            min={min}
            max={max}
            step={1}
            value={draft}
            disabled={disabled || isNever}
            aria-describedby={notice ? `${hintId} ${noticeId}` : hintId}
            aria-invalid={notice ? true : undefined}
            className="h-8 w-28 text-sm"
            onChange={(event) => {
              dirtyRef.current = true;
              const next = event.target.value;
              setDraft(next);
              clearTimer();
              timerRef.current = window.setTimeout(
                () => commit(next),
                debounceMs,
              );
            }}
            onBlur={(event) => {
              if (dirtyRef.current) commit(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit(event.currentTarget.value);
              }
            }}
          />
          {unit ? (
            <span className="text-xs text-muted-foreground">{unit}</span>
          ) : null}
          {never ? (
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-primary"
                checked={isNever}
                disabled={disabled}
                onChange={(event) => {
                  clearTimer();
                  dirtyRef.current = false;
                  setNotice(null);
                  never.onChange(event.target.checked);
                }}
              />
              {never.label}
            </label>
          ) : null}
        </div>
        <p id={hintId} className="text-[11px] text-muted-foreground">
          {t("Between {{min}} and {{max}}", {
            min,
            max,
            defaultValue: `Between ${min} and ${max}`,
          })}
        </p>
        {notice ? (
          <p
            id={noticeId}
            role="status"
            className="text-[11px] text-amber-600 dark:text-amber-400"
          >
            {notice}
          </p>
        ) : null}
      </div>
    </SettingRow>
  );
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Modal yes/no prompt for destructive settings actions. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive = true,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useI18n();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            {t("Cancel", "Cancel")}
          </Button>
          <Button
            type="button"
            variant={destructive ? "destructive" : "default"}
            size="sm"
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Section wrapper with a heading, used by every settings sub-section. */
export function SettingsSection({
  title,
  description,
  children,
  testId,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section
      aria-label={title}
      data-testid={testId}
      className="rounded-lg border border-border/50 bg-card/40 px-4 py-2"
    >
      <h3 className="pt-2 text-sm font-semibold">{title}</h3>
      {description ? (
        <p className="pb-1 text-xs text-muted-foreground">{description}</p>
      ) : null}
      {children}
    </section>
  );
}
