/**
 * A collected diagnostics report, shown to the person who is about to paste
 * it somewhere public.
 *
 * The preview is the point of this component. A report exists to be pasted
 * into an issue, and the one safeguard that actually works is letting someone
 * read the exact text the copy button will put on their clipboard — so the
 * body below is `renderDiagnostics(report, format)` verbatim, in the format
 * that will be copied, rather than a prettier summary of it.
 *
 * The "not included" list is {@link DiagnosticsReport.withheld}, which the
 * builder generates from its own redaction policy. It is rendered rather than
 * restated: a list written here would be a second claim about what the payload
 * contains, and the two would drift the first time the policy changed.
 */
import { useMemo } from "react";

import { useI18n } from "@/hooks/use-i18n";
import {
  diagnosticsSummaryLine,
  renderDiagnostics,
  type DiagnosticsCopyFormat,
  type DiagnosticsReport,
} from "@/lib/diagnostics";

export interface DiagnosticsReportViewProps {
  report: DiagnosticsReport;
  /** The format the preview shows, and that the copy button will copy. */
  format: DiagnosticsCopyFormat;
}

export function DiagnosticsReportView({
  report,
  format,
}: DiagnosticsReportViewProps) {
  const { t } = useI18n();
  const text = useMemo(
    () => renderDiagnostics(report, format),
    [report, format],
  );

  return (
    <div className="space-y-3" data-testid="diagnostics-report">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-foreground">
          {diagnosticsSummaryLine(report)}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("Collected {{when}}", {
            when: report.capturedAt,
            defaultValue: `Collected ${report.capturedAt}`,
          })}
        </p>
      </div>

      <div className="min-w-0 rounded-lg border border-border/60 bg-card/50 p-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {report.includesUserData
            ? t(
                "This report includes your zone names",
                "This report includes your zone names",
              )
            : t("Not included in this report", "Not included in this report")}
        </h4>
        <ul
          role="list"
          data-testid="diagnostics-withheld"
          className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground"
        >
          {report.withheld.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </div>

      <div className="min-w-0">
        <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("Exactly what will be copied", "Exactly what will be copied")}
        </h4>
        <pre
          data-testid="diagnostics-preview"
          className="scrollbar-themed max-h-80 overflow-auto rounded-lg border border-border/60 bg-card/50 p-3 text-[11px] leading-relaxed text-foreground"
        >
          {text}
        </pre>
      </div>
    </div>
  );
}
