import React from "react";
import { LocateFixed } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/hooks/use-i18n";
import type { SpecialIpFinding } from "@/lib/audit/domain-audit";
import type { DNSRecord } from "@/types/dns";

export interface SpecialIpAuditFindingsProps {
  /** Records whose address is private, reserved or otherwise special-use. */
  findings: SpecialIpFinding[];
  /** Navigate the records list to the given record and highlight it. */
  onGoToRecord: (record: DNSRecord) => void;
}

/**
 * The per-record body of the "special/private/bogon IP" audit items: one line
 * per offending A/AAAA record with a "Go to record" control, in place of the
 * audit's plain-text summary.
 */
export function SpecialIpAuditFindings({
  findings,
  onGoToRecord,
}: SpecialIpAuditFindingsProps) {
  const { t } = useI18n();
  return (
    <ul className="mt-2 space-y-1" data-testid="special-ip-findings">
      {findings.map(({ record, ip, issue }) => {
        const label = t("Go to record {{name}}", {
          name: `${record.type} ${record.name}`,
          defaultValue: `Go to record ${record.type} ${record.name}`,
        });
        return (
          <li
            key={record.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/50 bg-background/40 px-2.5 py-1.5 text-xs"
          >
            <div className="min-w-0 flex-1 break-words text-muted-foreground">
              <span className="font-medium text-foreground/90">
                {record.name}
              </span>
              <span className="mx-1.5 text-foreground/50">&rarr;</span>
              <span className="font-mono">{ip}</span>
              <span className="ml-1.5">({issue})</span>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 px-2.5 text-xs"
              aria-label={label}
              title={label}
              data-record-id={record.id}
              onClick={() => onGoToRecord(record)}
            >
              <LocateFixed className="h-3.5 w-3.5" aria-hidden="true" />
              {t("Go to record", "Go to record")}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
