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
import { useI18n } from "@/hooks/use-i18n";
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

/**
 * The `t` from {@link useI18n}, narrowed to the two-argument form.
 *
 * Passed in rather than read from a hook because {@link passkeyStatusNotice}
 * is a plain function, called from two components and from neither a render
 * nor a hook body in one of them.
 *
 * It is a *required* parameter on purpose. Making it optional and falling back
 * to English would compile at every call site that forgot it, and the only
 * symptom would be a heading in English in eleven locales — which is the
 * defect this file is being changed to fix.
 */
export type TranslateNotice = (key: string, defaultValue: string) => string;

/**
 * Each title below is written out as a literal `t("…", "…")`, which is the
 * point of threading `t` this far.
 *
 * These six headings used to be plain string literals in the returned object
 * and were rendered through `notice.title` — a value, not a literal call. That
 * is the shape `ACTION_TABS` and the settings-search registry are in, and
 * `scripts/i18n-coverage.mjs` cannot see it: a scan for literal `t(` call
 * sites finds nothing, so all six were uncatalogued *and* absent from the
 * uncatalogued report, invisible to every gate in both directions. They name
 * the specific thing standing between the user and a working passkey, so they
 * are the last strings on this screen that should have shipped untranslated.
 *
 * The `|| key` floor is the same guard `LoginSettingsMenu` documents: `t`
 * returns an empty string until `src/i18n.ts` finishes its dynamic `import`,
 * and a notice with a blank heading says nothing at all.
 */
function advisoryNotice(
  advisory: PasskeyAdvisory,
  t: TranslateNotice,
): PasskeyNotice {
  return {
    title:
      t(
        "No built-in authenticator detected",
        "No built-in authenticator detected",
      ) || "No built-in authenticator detected",
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
  t: TranslateNotice,
): PasskeyNotice | null {
  // `passkeyStatusReason` is the single place that knows which variants carry a
  // message; the `kind` checks below repeat it only so TypeScript narrows.
  const reason = passkeyStatusReason(state);
  if (!state || reason === null) return null;

  if (state.kind === "available") {
    return state.advisory ? advisoryNotice(state.advisory, t) : null;
  }

  if (state.kind === "error") {
    return {
      title:
        t(
          "Passkey status could not be read",
          "Passkey status could not be read",
        ) || "Passkey status could not be read",
      reason,
      detail: null,
      tone: "critical",
      icon: AlertTriangle,
    };
  }

  switch (state.cause) {
    case "webview":
      return {
        title:
          t(
            "Passkeys are not supported on this platform",
            "Passkeys are not supported on this platform",
          ) || "Passkeys are not supported on this platform",
        reason,
        detail: null,
        tone: "info",
        icon: MonitorOff,
      };
    case "insecure-origin":
      return {
        title:
          t(
            "Passkeys need a secure context",
            "Passkeys need a secure context",
          ) || "Passkeys need a secure context",
        reason,
        detail: null,
        tone: "info",
        icon: ShieldOff,
      };
    case "legacy-credentials":
      return {
        title:
          t(
            "Your passkeys need re-registering",
            "Your passkeys need re-registering",
          ) || "Your passkeys need re-registering",
        reason,
        detail: null,
        tone: "warning",
        icon: KeyRound,
      };
    case "backend":
    default:
      return {
        title:
          t(
            "Passkeys temporarily unavailable",
            "Passkeys temporarily unavailable",
          ) || "Passkeys temporarily unavailable",
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
  const { t } = useI18n();
  const notice = passkeyStatusNotice(state, t);
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
