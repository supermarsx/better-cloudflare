import type { DNSRecord } from "@/types/dns";

export type RecordDraft = Partial<DNSRecord>;

export type BuilderWarnings = {
  issues: string[];
  nameIssues: string[];
  canonical?: string;
};

export type BuilderWarningsChange = (warnings: BuilderWarnings) => void;

/**
 * Plain-English explanation of the record a guided builder is assembling.
 *
 * Every builder derives one of these from its own field state so the dialog can
 * show, while the user types, what the record will actually do rather than only
 * how it is spelled. Keep the text factual: `unknowns` exists precisely so a
 * builder can say "this depends on something I cannot see" instead of guessing.
 */
export type BuilderSummary = {
  /**
   * One sentence describing the effect of the record. Always present, including
   * for an empty form, where it should explain what the user is about to build.
   */
  headline: string;
  /** Short supporting sentences that qualify the headline. */
  details?: string[];
  /**
   * Effects that cannot be determined from the form alone (for example a value
   * whose meaning is defined by the service consuming it). Rendered separately
   * so a guess is never presented as a fact.
   */
  unknowns?: string[];
};

/** Contract implemented by every builder's exported `describe*` function. */
export type BuilderDescribe<TValues> = (values: TValues) => BuilderSummary;
