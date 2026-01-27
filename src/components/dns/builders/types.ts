import type { DNSRecord } from "@/types/dns";

export type RecordDraft = Partial<DNSRecord>;

export type BuilderWarnings = {
  issues: string[];
  nameIssues: string[];
  canonical?: string;
};

export type BuilderWarningsChange = (warnings: BuilderWarnings) => void;

