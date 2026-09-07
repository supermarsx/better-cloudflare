/**
 * The one place that turns a {@link PasskeyStatusState} into something a user
 * reads.
 *
 * `passkeyStatusState` distinguishes several reasons passkeys are not working
 * the way the user expects, and each has a different remedy — a different
 * build, a different platform, enrolling a fingerprint, re-registering, or
 * nothing at all because the ceremony is still worth trying. Showing one
 * generic "passkeys unavailable" line for all of them would throw that
 * distinction away at the last step, so each cause gets its own heading, icon
 * and tone here. Only the body text comes from the state (the backend supplies
 * its own for `"backend"`), so the two components that show this notice cannot
 * drift apart.
 */
import type {
  PasskeyStatusState,
  PasskeyAdvisory,
} from "@/lib/auth/passkey-status";
import { passkeyStatusReason } from "@/lib/auth/passkey-status";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  Fingerprint,
  KeyRound,
  MonitorOff,
  ShieldOff,
  type LucideIcon,
} from "lucide-react";

/**
 * How loudly a notice is presented.
 *
 * - `critical` — something is wrong or shut off: the app's own gate, or a
 *   status call that failed.
 * - `warning` — nothing is broken, but the user must act before passkeys work.
 * - `info` — a standing platform limitation with no action available, or
 *   advice attached to a control that still works. Painting either red would
 *   imply a fault the user could fix.
 */
export type PasskeyNoticeTone = "critical" | "warning" | "info";

export interface PasskeyNotice {
  /** Headline naming the specific situation, never a generic one. */
  title: string;
  /** The explanation, from the state (backend text included). */
  reason: string;
  /** What the probe saw, shown small under the reason. Advisories only. */
  detail: string | null;
  tone: PasskeyNoticeTone;
  icon: LucideIcon;
}

function advisoryNotice(advisory: PasskeyAdvisory): PasskeyNotice {
  return {
    title: "No built-in authenticator detected",
    reason: advisory.reason,
    detail: advisory.detail,
    // Info, not warning: the buttons beside this notice work, and a security
    // key or phone passkey will complete the ceremony. An amber banner over a
    // control that works reads as a fault, and this is not one.
    tone: "info",
    icon: Fingerprint,
  };
}

/**
 * The notice to show for `state`, or `null` when there is nothing to say —
 * either because passkeys are usable with no caveat, or because the status is
 * not known yet.
 */
export function passkeyStatusNotice(
  state: PasskeyStatusState | null,
): PasskeyNotice | null {
  // `passkeyStatusReason` is the single place that knows which variants carry a
  // message; the `kind` checks below repeat it only so TypeScript narrows.
  const reason = passkeyStatusReason(state);
  if (!state || reason === null) return null;

  if (state.kind === "available") {
    return state.advisory ? advisoryNotice(state.advisory) : null;
  }

  if (state.kind === "error") {
    return {
      title: "Passkey status could not be read",
      reason,
      detail: null,
      tone: "critical",
      icon: AlertTriangle,
    };
  }

  switch (state.cause) {
    case "webview":
      return {
        title: "Passkeys are not supported on this platform",
        reason,
        detail: null,
        tone: "info",
        icon: MonitorOff,
      };
    case "insecure-origin":
      return {
        title: "Passkeys need a secure context",
        reason,
        detail: null,
        tone: "info",
        icon: ShieldOff,
      };
    case "legacy-credentials":
      return {
        title: "Your passkeys need re-registering",
        reason,
        detail: null,
        tone: "warning",
        icon: KeyRound,
      };
    case "backend":
    default:
      return {
        title: "Passkeys temporarily unavailable",
        reason,
        detail: null,
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
 * Renders {@link passkeyStatusNotice}, or nothing when passkeys are usable
 * with no caveat.
 *
 * `role="alert"` is used for the tones that report something standing in the
 * user's way. An advisory is `role="status"` instead: the control beside it
 * works, and interrupting a screen reader to say so would misrepresent it.
 */
export function PasskeyStatusNotice({
  state,
  className,
}: PasskeyStatusNoticeProps) {
  const notice = passkeyStatusNotice(state);
  if (!notice) return null;

  const Icon = notice.icon;
  const advisory = state?.kind === "available";

  return (
    <div
      className={cn(
        "rounded-md border p-3 text-sm text-foreground",
        TONE_SURFACE[notice.tone],
        className,
      )}
      role={advisory ? "status" : "alert"}
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
      {notice.detail && (
        <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-muted-foreground/70">
          {notice.detail}
        </p>
      )}
    </div>
  );
}

export default PasskeyStatusNotice;
