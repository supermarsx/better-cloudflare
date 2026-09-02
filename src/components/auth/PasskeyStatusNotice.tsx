/**
 * The one place that turns a {@link PasskeyStatusState} into something a user
 * reads.
 *
 * `passkeyStatusState` distinguishes four reasons passkeys cannot be used
 * right now, and each has a different remedy — a different build, a different
 * platform, enrolling a fingerprint, or re-registering. Showing one generic
 * "passkeys unavailable" line for all four would throw that distinction away at
 * the last step, so each cause gets its own heading, icon and tone here. Only
 * the body text comes from the state (the backend supplies its own for
 * `"backend"`), so the two components that show this notice cannot drift apart.
 */
import type { PasskeyStatusState } from "@/lib/auth/passkey-status";
import { passkeyStatusReason } from "@/lib/auth/passkey-status";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  Fingerprint,
  KeyRound,
  MonitorOff,
  type LucideIcon,
} from "lucide-react";

/**
 * How loudly a notice is presented.
 *
 * - `critical` — something is wrong or shut off: the app's own gate, or a
 *   status call that failed.
 * - `warning` — nothing is broken, but the user must act before passkeys work.
 * - `info` — a standing platform limitation with no action available. Painting
 *   it red would imply a fault the user could fix.
 */
export type PasskeyNoticeTone = "critical" | "warning" | "info";

export interface PasskeyNotice {
  /** Headline naming the specific situation, never a generic one. */
  title: string;
  /** The explanation, from the state (backend text included). */
  reason: string;
  tone: PasskeyNoticeTone;
  icon: LucideIcon;
}

/**
 * The notice to show for `state`, or `null` when there is nothing to say —
 * either because passkeys are usable or because the status is not known yet.
 */
export function passkeyStatusNotice(
  state: PasskeyStatusState | null,
): PasskeyNotice | null {
  // `passkeyStatusReason` is the single place that knows which variants carry a
  // message; the `kind` check repeats its `available` case only so TypeScript
  // narrows the union for the `cause` switch below.
  const reason = passkeyStatusReason(state);
  if (!state || reason === null || state.kind === "available") return null;

  if (state.kind === "error") {
    return {
      title: "Passkey status could not be read",
      reason,
      tone: "critical",
      icon: AlertTriangle,
    };
  }

  switch (state.cause) {
    case "webview":
      return {
        title: "Passkeys are not supported on this platform",
        reason,
        tone: "info",
        icon: MonitorOff,
      };
    case "no-authenticator":
      return {
        title: "No passkey authenticator on this device",
        reason,
        tone: "warning",
        icon: Fingerprint,
      };
    case "legacy-credentials":
      return {
        title: "Your passkeys need re-registering",
        reason,
        tone: "warning",
        icon: KeyRound,
      };
    case "backend":
    default:
      return {
        title: "Passkeys temporarily unavailable",
        reason,
        tone: "critical",
        icon: AlertTriangle,
      };
  }
}

const TONE_SURFACE: Record<PasskeyNoticeTone, string> = {
  critical: "border-destructive/60 bg-destructive/10",
  warning: "border-amber-500/40 bg-amber-500/10",
  info: "border-border/60 bg-muted/40",
};

const TONE_HEADING: Record<PasskeyNoticeTone, string> = {
  critical: "text-destructive",
  warning: "text-amber-600 dark:text-amber-400",
  info: "text-foreground",
};

interface PasskeyStatusNoticeProps {
  state: PasskeyStatusState | null;
  className?: string;
}

/**
 * Renders {@link passkeyStatusNotice}, or nothing when passkeys are usable.
 *
 * `role="alert"` is kept for every tone: the notice always explains why a
 * security control the user is reaching for is not there, and a screen reader
 * user who cannot see the button's absence is exactly who needs to be told.
 */
export function PasskeyStatusNotice({
  state,
  className,
}: PasskeyStatusNoticeProps) {
  const notice = passkeyStatusNotice(state);
  if (!notice) return null;

  const Icon = notice.icon;

  return (
    <div
      className={cn(
        "rounded-md border p-3 text-sm text-foreground",
        TONE_SURFACE[notice.tone],
        className,
      )}
      role="alert"
    >
      <div
        className={cn(
          "flex items-center gap-2 font-semibold",
          TONE_HEADING[notice.tone],
        )}
      >
        <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
        {notice.title}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{notice.reason}</p>
    </div>
  );
}

export default PasskeyStatusNotice;
