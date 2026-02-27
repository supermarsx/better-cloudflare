/**
 * UI component rendering a single DNS record row and optional inline
 * editor allowing update and deletion of the record.
 */
import { useState, useEffect, useCallback } from "react";
import type { ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tag } from "@/components/ui/tag";
import { Tooltip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { RecordType, DNSRecord, TTLValue } from "@/types/dns";
import { parseSPF, composeSPF, validateSPF } from "@/lib/spf";
import { storageManager } from "@/lib/storage";
import { useI18n } from "@/hooks/use-i18n";
import {
  parseSRV,
  composeSRV,
  parseTLSA,
  composeTLSA,
  parseSSHFP,
  composeSSHFP,
  parseNAPTR,
  composeNAPTR,
} from "@/lib/dns-parsers";
import { RECORD_TYPES, getTTLPresets, getRecordTypeLabel } from "@/types/dns";
import {
  Copy,
  Edit2,
  Trash2,
  Save,
  X,
  MoreHorizontal,
  MessageSquare,
} from "lucide-react";

/**
 * Properties for the `RecordRow` UI component which renders and optionally
 * edits a DNS record.
 */
export interface RecordRowProps {
  /** Zone ID this record belongs to (used for local record tags). */
  zoneId: string;
  /** The DNS record to display or edit */
  record: DNSRecord;
  /** Visible table columns in order (controls rendering of row cells). */
  columns?: Array<
    | "select"
    | "type"
    | "name"
    | "content"
    | "comment"
    | "tags"
    | "ttl"
    | "proxied"
    | "actions"
  >;
  /** Optional grid template columns string (keeps header/rows aligned). */
  gridTemplateColumns?: string;
  /** Whether the row is currently in edit mode */
  isEditing: boolean;
  /** Whether the record is selected for bulk actions */
  isSelected?: boolean;
  /** Callback invoked to transition into edit mode */
  onEdit: () => void;
  /** Save callback after editing; receives the updated record. May return a promise. */
  onSave: (record: DNSRecord) => void | Promise<void>;
  /** Cancel editing and revert changes */
  onCancel: () => void;
  /** Remove the record. May return a promise. */
  onDelete: () => void | Promise<void>;
  /** Toggle selection for bulk actions */
  onSelectChange?: (selected: boolean) => void | Promise<void>;
  /** Copy the record to the clipboard buffer */
  onCopy?: () => void | Promise<void>;
  /** Toggle Cloudflare proxy status for supported types. */
  onToggleProxy?: (next: boolean) => void | Promise<void>;
}

/**
 * Render a single DNS record row. When `isEditing` is true the row
 * renders in edit mode with inputs for each editable field; otherwise it
 * displays the record details.
 */
export function RecordRow({
  zoneId,
  record,
  columns,
  gridTemplateColumns,
  isEditing,
  isSelected = false,
  onEdit,
  onSave,
  onCancel,
  onDelete,
  onSelectChange,
  onCopy,
  onToggleProxy,
}: RecordRowProps) {
  const { t } = useI18n();
  const [editedRecord, setEditedRecord] = useState(record);
  const [expandedName, setExpandedName] = useState(false);
  const [expandedContent, setExpandedContent] = useState(false);
  const [dotMenuOpen, setDotMenuOpen] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [tags, setTags] = useState<string[]>(() =>
    storageManager.getRecordTags(zoneId, record.id),
  );
  const [zoneTags, setZoneTags] = useState<string[]>(() =>
    storageManager.getZoneTags(zoneId),
  );
  const [tagDraft, setTagDraft] = useState("");
  
  const [srvPriority, setSrvPriority] = useState<number | undefined>(
    parseSRV(record.content).priority,
  );
  const [srvWeight, setSrvWeight] = useState<number | undefined>(
    parseSRV(record.content).weight,
  );
  const [srvPort, setSrvPort] = useState<number | undefined>(
    parseSRV(record.content).port,
  );
  const [srvTarget, setSrvTarget] = useState<string>(
    parseSRV(record.content).target ?? "",
  );
  
  const [tlsaUsage, setTlsaUsage] = useState<number | undefined>(
    parseTLSA(record.content).usage,
  );
  const [tlsaSelector, setTlsaSelector] = useState<number | undefined>(
    parseTLSA(record.content).selector,
  );
  const [tlsaMatchingType, setTlsaMatchingType] = useState<number | undefined>(
    parseTLSA(record.content).matchingType,
  );
  const [tlsaData, setTlsaData] = useState<string>(
    parseTLSA(record.content).data ?? "",
  );
  
  const [sshfpAlgorithm, setSshfpAlgorithm] = useState<number | undefined>(
    parseSSHFP(record.content).algorithm,
  );
  const [sshfpFptype, setSshfpFptype] = useState<number | undefined>(
    parseSSHFP(record.content).fptype,
  );
  const [sshfpFingerprint, setSshfpFingerprint] = useState<string>(
    parseSSHFP(record.content).fingerprint ?? "",
  );
  
  const [naptrOrder, setNaptrOrder] = useState<number | undefined>(
    parseNAPTR(record.content).order,
  );
  const [naptrPref, setNaptrPref] = useState<number | undefined>(
    parseNAPTR(record.content).preference,
  );
  const [naptrFlags, setNaptrFlags] = useState<string>(
    parseNAPTR(record.content).flags ?? "",
  );
  const [naptrService, setNaptrService] = useState<string>(
    parseNAPTR(record.content).service ?? "",
  );
  const [naptrRegexp, setNaptrRegexp] = useState<string>(
    parseNAPTR(record.content).regexp ?? "",
  );
  const [naptrReplacement, setNaptrReplacement] = useState<string>(
    parseNAPTR(record.content).replacement ?? "",
  );
  const [spfQualifier, setSpfQualifier] = useState<string>("+");
  const [spfMechanism, setSpfMechanism] = useState<string>("include");
  const [spfValue, setSpfValue] = useState<string>("");
  const [spfBuilderError, setSpfBuilderError] = useState<string>("");

  const addSpfMechanism = useCallback(() => {
    const needsValue = ["ip4", "ip6", "include", "exists", "ptr"].includes(
      spfMechanism,
    );
    if (needsValue && !spfValue.trim()) {
      setSpfBuilderError(
        t("Value required for this mechanism", "Value required for this mechanism"),
      );
      return;
    }
    const parsed = parseSPF(editedRecord.content) ?? {
      version: "v=spf1",
      mechanisms: [],
    };
    const qualifier = spfQualifier === "+" ? undefined : spfQualifier;
    const mechanisms = [
      ...parsed.mechanisms,
      {
        qualifier,
        mechanism: spfMechanism,
        value: spfValue.trim() || undefined,
      },
    ];
    setEditedRecord({
      ...editedRecord,
      content: composeSPF({ ...parsed, mechanisms }),
    });
    setSpfBuilderError("");
    if (spfMechanism === "all") setSpfValue("");
  }, [editedRecord, spfMechanism, spfQualifier, spfValue, t]);

  useEffect(() => {
    setEditedRecord(record);
    setExpandedName(false);
    setExpandedContent(false);
    if (record.type === "SRV") {
      const parsed = parseSRV(record.content);
      if (parsed.priority !== srvPriority) setSrvPriority(parsed.priority);
      if (parsed.weight !== srvWeight) setSrvWeight(parsed.weight);
      if (parsed.port !== srvPort) setSrvPort(parsed.port);
      if (parsed.target !== srvTarget) setSrvTarget(parsed.target ?? "");
    }
    if (record.type === "TLSA") {
      const parsed = parseTLSA(record.content);
      if (parsed.usage !== tlsaUsage) setTlsaUsage(parsed.usage);
      if (parsed.selector !== tlsaSelector) setTlsaSelector(parsed.selector);
      if (parsed.matchingType !== tlsaMatchingType)
        setTlsaMatchingType(parsed.matchingType);
      if (parsed.data !== tlsaData) setTlsaData(parsed.data ?? "");
    }
    if (record.type === "SSHFP") {
      const parsed = parseSSHFP(record.content);
      if (parsed.algorithm !== sshfpAlgorithm)
        setSshfpAlgorithm(parsed.algorithm);
      if (parsed.fptype !== sshfpFptype) setSshfpFptype(parsed.fptype);
      if (parsed.fingerprint !== sshfpFingerprint)
        setSshfpFingerprint(parsed.fingerprint ?? "");
    }
    if (record.type === "NAPTR") {
      const parsed = parseNAPTR(record.content);
      if (parsed.order !== naptrOrder) setNaptrOrder(parsed.order);
      if (parsed.preference !== naptrPref) setNaptrPref(parsed.preference);
      if (parsed.flags !== naptrFlags) setNaptrFlags(parsed.flags ?? "");
      if (parsed.service !== naptrService)
        setNaptrService(parsed.service ?? "");
      if (parsed.regexp !== naptrRegexp) setNaptrRegexp(parsed.regexp ?? "");
      if (parsed.replacement !== naptrReplacement)
        setNaptrReplacement(parsed.replacement ?? "");
    }
  }, [
    record,
    srvPriority,
    srvWeight,
    srvPort,
    srvTarget,
    tlsaUsage,
    tlsaSelector,
    tlsaMatchingType,
    tlsaData,
    sshfpAlgorithm,
    sshfpFptype,
    sshfpFingerprint,
    naptrOrder,
    naptrPref,
    naptrFlags,
    naptrService,
    naptrRegexp,
    naptrReplacement,
  ]);

  useEffect(() => {
    setTags(storageManager.getRecordTags(zoneId, record.id));
    setZoneTags(storageManager.getZoneTags(zoneId));
    setTagDraft("");
  }, [record.id, zoneId]);

  useEffect(() => {
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | { zoneId?: string; recordId?: string }
        | undefined;
      if (!detail?.zoneId) return;
      if (detail.zoneId !== zoneId) return;
      setZoneTags(storageManager.getZoneTags(zoneId));
      if (detail.recordId && detail.recordId !== record.id) return;
      setTags(storageManager.getRecordTags(zoneId, record.id));
    };
    window.addEventListener("record-tags-changed", onChanged);
    return () => window.removeEventListener("record-tags-changed", onChanged);
  }, [record.id, zoneId]);

  const addTag = useCallback(() => {
    const next = tagDraft.trim();
    if (!next) return;
    const nextTags = Array.from(new Set([...tags, next])).slice(0, 32);
    setTags(nextTags);
    storageManager.setRecordTags(zoneId, record.id, nextTags);
    setTagDraft("");
  }, [record.id, tagDraft, tags, zoneId]);

  const removeTag = useCallback(
    (tag: string) => {
      const next = tags.filter((t) => t !== tag);
      setTags(next);
      storageManager.setRecordTags(zoneId, record.id, next);
    },
    [record.id, tags, zoneId],
  );

  const ttlValue = editedRecord.ttl === 1 ? "auto" : editedRecord.ttl;
  const isCustomTTL = !getTTLPresets().includes(ttlValue as TTLValue);
  const MAX_PREVIEW_CHARS = 30;
  const tagSuggestionListId = `record-tag-suggestions-${record.id}`;
  const truncate = (value: string) =>
    value.length > MAX_PREVIEW_CHARS
      ? `${value.slice(0, MAX_PREVIEW_CHARS)}...`
      : value;

  const renderActionsMenuItems = useCallback(() => {
    return (
      <>
        <DropdownMenuItem
          onSelect={() => {
            onEdit();
          }}
        >
          <Edit2 className="mr-2 h-3.5 w-3.5" />
          {t("Edit", "Edit")}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!onCopy}
          onSelect={() => {
            onCopy?.();
          }}
        >
          <Copy className="mr-2 h-3.5 w-3.5" />
          {t("Copy", "Copy")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={() => {
            onDelete();
          }}
        >
          <Trash2 className="mr-2 h-3.5 w-3.5" />
          {t("Delete", "Delete")}
        </DropdownMenuItem>
      </>
    );
  }, [onCopy, onDelete, onEdit, t]);

  const renderContextMenuItems = useCallback(() => {
    return (
      <>
        <ContextMenuItem
          onSelect={() => {
            onEdit();
          }}
        >
          <Edit2 className="mr-2 h-3.5 w-3.5" />
          {t("Edit", "Edit")}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!onCopy}
          onSelect={() => {
            onCopy?.();
          }}
        >
          <Copy className="mr-2 h-3.5 w-3.5" />
          {t("Copy", "Copy")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={() => {
            onDelete();
          }}
        >
          <Trash2 className="mr-2 h-3.5 w-3.5" />
          {t("Delete", "Delete")}
        </ContextMenuItem>
      </>
    );
  }, [onCopy, onDelete, onEdit, t]);

  if (isEditing) {
    return (
      <div className="rounded-xl border border-border/60 bg-card/80 p-4 shadow-[0_12px_30px_rgba(0,0,0,0.18)]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
              {t("Editing", "Editing")}
            </div>
            <div className="text-sm text-foreground/90">
              {record.name || t("Unnamed record", "Unnamed record")}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => onSave(editedRecord)}>
              <Save className="h-3.5 w-3.5 mr-1" />
              {t("Save", "Save")}
            </Button>
            <Button size="sm" variant="outline" onClick={onCancel}>
              <X className="h-3.5 w-3.5 mr-1" />
              {t("Cancel", "Cancel")}
            </Button>
          </div>
        </div>

        <div className="mt-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 glass-fade">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
              {t("Tags", "Tags")}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                list={tagSuggestionListId}
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addTag();
                  }
                }}
                placeholder={t("Add tag", "Add tag")}
                className="ui-focus h-7 w-44 rounded-md border border-input bg-background px-2 text-[11px] text-foreground placeholder:text-muted-foreground"
              />
              <datalist id={tagSuggestionListId}>
                {zoneTags.map((tag) => (
                  <option key={tag} value={tag} />
                ))}
              </datalist>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2"
                onClick={addTag}
              >
                {t("Add", "Add")}
              </Button>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {tags.length ? (
              tags.map((tag) => (
                <span key={tag} className="inline-flex items-center gap-1">
                  <Tag className="text-[9px] px-2 py-0.5">{tag}</Tag>
                  <button
                    type="button"
                    className="ui-icon-button h-5 w-5"
                    aria-label={t("Remove tag {{tag}}", {
                      tag,
                      defaultValue: `Remove tag ${tag}`,
                    })}
                    onClick={() => removeTag(tag)}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))
            ) : (
              <span className="text-[10px] text-muted-foreground/70">
                {t("No tags", "No tags")}
              </span>
            )}
          </div>
        </div>
        <div className="mt-4 grid grid-cols-12 gap-4 items-start">
          <div className="col-span-2 space-y-1">
            <Label className="text-[10px] uppercase tracking-widest text-muted-foreground">
              {t("Type", "Type")}
            </Label>
            <Select
              value={editedRecord.type}
              onValueChange={(value: RecordType) =>
                setEditedRecord({
                  ...editedRecord,
                  type: value,
                })
              }
            >
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RECORD_TYPES.map((type) => (
                  <SelectItem
                    key={type}
                    value={type}
                  >
                    <Tooltip tip={getRecordTypeLabel(type)} side="right">
                      <span>{getRecordTypeLabel(type)}</span>
                    </Tooltip>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-3 space-y-1">
            <Label className="text-[10px] uppercase tracking-widest text-muted-foreground">
              {t("Name", "Name")}
            </Label>
            <Input
              value={editedRecord.name}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setEditedRecord({
                  ...editedRecord,
                  name: e.target.value,
                })
              }
              placeholder={t("e.g. www", "e.g. www")}
              className="h-8"
            />
          </div>
          <div className="col-span-4 space-y-1">
            <Label className="text-[10px] uppercase tracking-widest text-muted-foreground">
              {t("Content", "Content")}
            </Label>
            {editedRecord.type === "SRV" ? (
              <div className="grid grid-cols-4 gap-2">
                <Input
                  type="number"
                  placeholder={t("SRV priority", "priority")}
                  value={srvPriority ?? ""}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const n = Number.parseInt(e.target.value, 10);
                    const val = Number.isNaN(n) ? undefined : n;
                    setSrvPriority(val);
                    setEditedRecord({
                      ...editedRecord,
                      content: composeSRV(val, srvWeight, srvPort, srvTarget),
                    });
                  }}
                  className="h-8"
                />
                <Input
                  type="number"
                  placeholder={t("SRV weight", "weight")}
                  value={srvWeight ?? ""}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const n = Number.parseInt(e.target.value, 10);
                    const val = Number.isNaN(n) ? undefined : n;
                    setSrvWeight(val);
                    setEditedRecord({
                      ...editedRecord,
                      content: composeSRV(srvPriority, val, srvPort, srvTarget),
                    });
                  }}
                  className="h-8"
                />
                <Input
                  type="number"
                  placeholder={t("SRV port", "port")}
                  value={srvPort ?? ""}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const n = Number.parseInt(e.target.value, 10);
                    const val = Number.isNaN(n) ? undefined : n;
                    setSrvPort(val);
                    setEditedRecord({
                      ...editedRecord,
                      content: composeSRV(
                        srvPriority,
                        srvWeight,
                        val,
                        srvTarget,
                      ),
                    });
                  }}
                  className="h-8"
                />
                <Input
                  placeholder={t("SRV target", "target")}
                  value={srvTarget}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    setSrvTarget(e.target.value);
                    setEditedRecord({
                      ...editedRecord,
                      content: composeSRV(
                        srvPriority,
                        srvWeight,
                        srvPort,
                        e.target.value,
                      ),
                    });
                  }}
                  className="h-8"
                />
              </div>
            ) : editedRecord.type === "TLSA" ? (
              <div className="grid grid-cols-4 gap-2">
                <Input
                  type="number"
                  placeholder={t("TLSA usage", "usage")}
                  value={tlsaUsage ?? ""}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const n = Number.parseInt(e.target.value, 10);
                    const val = Number.isNaN(n) ? undefined : n;
                    setTlsaUsage(val);
                    setEditedRecord({
                      ...editedRecord,
                      content: composeTLSA(
                        val,
                        tlsaSelector,
                        tlsaMatchingType,
                        tlsaData,
                      ),
                    });
                  }}
                  className="h-8"
                />
                <Input
                  type="number"
                  placeholder={t("TLSA selector", "selector")}
                  value={tlsaSelector ?? ""}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const n = Number.parseInt(e.target.value, 10);
                    const val = Number.isNaN(n) ? undefined : n;
                    setTlsaSelector(val);
                    setEditedRecord({
                      ...editedRecord,
                      content: composeTLSA(
                        tlsaUsage,
                        val,
                        tlsaMatchingType,
                        tlsaData,
                      ),
                    });
                  }}
                  className="h-8"
                />
                <Input
                  type="number"
                  placeholder={t("TLSA matching type", "matching type")}
                  value={tlsaMatchingType ?? ""}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const n = Number.parseInt(e.target.value, 10);
                    const val = Number.isNaN(n) ? undefined : n;
                    setTlsaMatchingType(val);
                    setEditedRecord({
                      ...editedRecord,
                      content: composeTLSA(
                        tlsaUsage,
                        tlsaSelector,
                        val,
                        tlsaData,
                      ),
                    });
                  }}
                  className="h-8"
                />
                <Input
                  placeholder={t("TLSA data", "data")}
                  value={tlsaData}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    setTlsaData(e.target.value);
                    setEditedRecord({
                      ...editedRecord,
                      content: composeTLSA(
                        tlsaUsage,
                        tlsaSelector,
                        tlsaMatchingType,
                        e.target.value,
                      ),
                    });
                  }}
                  className="h-8"
                />
              </div>
            ) : editedRecord.type === "SSHFP" ? (
              <div className="grid grid-cols-3 gap-2">
                <Input
                  type="number"
                  placeholder={t("SSHFP algorithm", "algorithm")}
                  value={sshfpAlgorithm ?? ""}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const n = Number.parseInt(e.target.value, 10);
                    const val = Number.isNaN(n) ? undefined : n;
                    setSshfpAlgorithm(val);
                    setEditedRecord({
                      ...editedRecord,
                      content: composeSSHFP(val, sshfpFptype, sshfpFingerprint),
                    });
                  }}
                  className="h-8"
                />
                <Input
                  type="number"
                  placeholder={t("SSHFP fptype", "fptype")}
                  value={sshfpFptype ?? ""}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const n = Number.parseInt(e.target.value, 10);
                    const val = Number.isNaN(n) ? undefined : n;
                    setSshfpFptype(val);
                    setEditedRecord({
                      ...editedRecord,
                      content: composeSSHFP(
                        sshfpAlgorithm,
                        val,
                        sshfpFingerprint,
                      ),
                    });
                  }}
                  className="h-8"
                />
                <Input
                  placeholder={t("SSHFP fingerprint", "fingerprint")}
                  value={sshfpFingerprint}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    setSshfpFingerprint(e.target.value);
                    setEditedRecord({
                      ...editedRecord,
                      content: composeSSHFP(
                        sshfpAlgorithm,
                        sshfpFptype,
                        e.target.value,
                      ),
                    });
                  }}
                  className="h-8"
                />
              </div>
            ) : editedRecord.type === "NAPTR" ? (
              <div className="grid grid-cols-6 gap-2">
                <Input
                  type="number"
                  placeholder={t("NAPTR order", "order")}
                  value={naptrOrder ?? ""}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const n = Number.parseInt(e.target.value, 10);
                    const val = Number.isNaN(n) ? undefined : n;
                    setNaptrOrder(val);
                    setEditedRecord({
                      ...editedRecord,
                      content: composeNAPTR(
                        val,
                        naptrPref,
                        naptrFlags,
                        naptrService,
                        naptrRegexp,
                        naptrReplacement,
                      ),
                    });
                  }}
                  className="h-8"
                />
                <Input
                  type="number"
                  placeholder={t("NAPTR preference", "preference")}
                  value={naptrPref ?? ""}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const n = Number.parseInt(e.target.value, 10);
                    const val = Number.isNaN(n) ? undefined : n;
                    setNaptrPref(val);
                    setEditedRecord({
                      ...editedRecord,
                      content: composeNAPTR(
                        naptrOrder,
                        val,
                        naptrFlags,
                        naptrService,
                        naptrRegexp,
                        naptrReplacement,
                      ),
                    });
                  }}
                  className="h-8"
                />
                <Input
                  placeholder={t("NAPTR flags", "flags")}
                  value={naptrFlags}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    setNaptrFlags(e.target.value);
                    setEditedRecord({
                      ...editedRecord,
                      content: composeNAPTR(
                        naptrOrder,
                        naptrPref,
                        e.target.value,
                        naptrService,
                        naptrRegexp,
                        naptrReplacement,
                      ),
                    });
                  }}
                  className="h-8"
                />
                <Input
                  placeholder={t("NAPTR service", "service")}
                  value={naptrService}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    setNaptrService(e.target.value);
                    setEditedRecord({
                      ...editedRecord,
                      content: composeNAPTR(
                        naptrOrder,
                        naptrPref,
                        naptrFlags,
                        e.target.value,
                        naptrRegexp,
                        naptrReplacement,
                      ),
                    });
                  }}
                  className="h-8"
                />
                <Input
                  placeholder={t("NAPTR regexp", "regexp")}
                  value={naptrRegexp}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    setNaptrRegexp(e.target.value);
                    setEditedRecord({
                      ...editedRecord,
                      content: composeNAPTR(
                        naptrOrder,
                        naptrPref,
                        naptrFlags,
                        naptrService,
                        e.target.value,
                        naptrReplacement,
                      ),
                    });
                  }}
                  className="h-8"
                />
                <Input
                  placeholder={t("NAPTR replacement", "replacement")}
                  value={naptrReplacement}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    setNaptrReplacement(e.target.value);
                    setEditedRecord({
                      ...editedRecord,
                      content: composeNAPTR(
                        naptrOrder,
                        naptrPref,
                        naptrFlags,
                        naptrService,
                        naptrRegexp,
                        e.target.value,
                      ),
                    });
                  }}
                  className="h-8"
                />
              </div>
            ) : editedRecord.type === "SPF" ? (
              <div className="space-y-2">
                {editedRecord.content.length > 120 ||
                editedRecord.content.includes("\n") ? (
                  <Textarea
                    value={editedRecord.content}
                    onChange={(e) =>
                      setEditedRecord({
                        ...editedRecord,
                        content: e.target.value,
                      })
                    }
                    rows={4}
                    className="min-h-24 resize-y"
                  />
                ) : (
                  <Input
                    value={editedRecord.content}
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      setEditedRecord({
                        ...editedRecord,
                        content: e.target.value,
                      })
                    }
                    className="h-8"
                  />
                )}
                <div className="flex flex-wrap gap-2">
                  <select
                    className="ui-focus glass-surface glass-surface-hover h-8 rounded-md border border-border bg-background/10 px-2 text-sm focus-visible:outline-none"
                    value={spfQualifier}
                    onChange={(e) => setSpfQualifier(e.target.value)}
                  >
                    <option value="+">+</option>
                    <option value="-">-</option>
                    <option value="~">~</option>
                    <option value="?">?</option>
                  </select>
                  <select
                    className="ui-focus glass-surface glass-surface-hover h-8 rounded-md border border-border bg-background/10 px-2 text-sm focus-visible:outline-none"
                    value={spfMechanism}
                    onChange={(e) => setSpfMechanism(e.target.value)}
                  >
                    <option value="include">include</option>
                    <option value="ip4">ip4</option>
                    <option value="ip6">ip6</option>
                    <option value="a">a</option>
                    <option value="mx">mx</option>
                    <option value="exists">exists</option>
                    <option value="ptr">ptr</option>
                    <option value="all">all</option>
                  </select>
                  <Input
                    placeholder={t("value (optional)", "value (optional)")}
                    value={spfValue}
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      setSpfValue(e.target.value)
                    }
                    className="h-8"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={addSpfMechanism}
                    className="h-8"
                  >
                    {t("Add", "Add")}
                  </Button>
                </div>
                {spfBuilderError && (
                  <div className="text-sm text-red-600">{spfBuilderError}</div>
                )}
                {!validateSPF(editedRecord.content).ok && (
                  <div className="text-red-600">
                    {t("SPF validation issues:", "SPF validation issues:")}{" "}
                    {validateSPF(editedRecord.content).problems.join(", ")}
                  </div>
                )}
              </div>
            ) : (
              <>
                {editedRecord.type === "TXT" ||
                editedRecord.content.length > 120 ||
                editedRecord.content.includes("\n") ? (
                  <Textarea
                    value={editedRecord.content}
                    onChange={(e) =>
                      setEditedRecord({
                        ...editedRecord,
                        content: e.target.value,
                      })
                    }
                    rows={4}
                    className="min-h-24 resize-y"
                  />
                ) : (
                  <Input
                    value={editedRecord.content}
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      setEditedRecord({
                        ...editedRecord,
                        content: e.target.value,
                      })
                    }
                    className="h-8"
                  />
                )}
              </>
            )}
          </div>
          <div className="col-span-1 space-y-1">
            <Label className="text-[10px] uppercase tracking-widest text-muted-foreground">
              {t("TTL", "TTL")}
            </Label>
            <Select
              value={isCustomTTL ? "custom" : String(ttlValue)}
              onValueChange={(value: string) => {
                if (value === "custom") {
                  setEditedRecord({ ...editedRecord, ttl: 300 });
                } else {
                  setEditedRecord({
                    ...editedRecord,
                    ttl: value === "auto" ? "auto" : Number(value),
                  });
                }
              }}
            >
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {getTTLPresets().map((ttl) => (
                  <SelectItem key={ttl} value={String(ttl)}>
                    {ttl === "auto" ? t("Auto", "Auto") : ttl}
                  </SelectItem>
                ))}
                <SelectItem value="custom">{t("Custom", "Custom")}</SelectItem>
              </SelectContent>
            </Select>
            {isCustomTTL && (
              <Input
                type="number"
                value={
                  typeof editedRecord.ttl === "number" ? editedRecord.ttl : ""
                }
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const n = Number.parseInt(e.target.value, 10);
                  setEditedRecord({
                    ...editedRecord,
                    ttl: Number.isNaN(n) ? 300 : n,
                  });
                }}
                className="h-8"
              />
            )}
            {editedRecord.type === "MX" && (
              <Input
                type="number"
                value={editedRecord.priority ?? ""}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const n = Number.parseInt(e.target.value, 10);
                  setEditedRecord({
                    ...editedRecord,
                    priority: Number.isNaN(n) ? undefined : n,
                  });
                }}
                className="h-8"
              />
            )}
          </div>
          <div className="col-span-1 space-y-1">
            <Label className="text-[10px] uppercase tracking-widest text-muted-foreground">
              {t("Proxy", "Proxy")}
            </Label>
            {(editedRecord.type === "A" ||
              editedRecord.type === "AAAA" ||
              editedRecord.type === "CNAME") && (
              <Switch
                checked={editedRecord.proxied || false}
                onCheckedChange={(checked: boolean) =>
                  setEditedRecord({
                    ...editedRecord,
                    proxied: checked,
                  })
                }
              />
            )}
          </div>
        </div>
        <div className="mt-4 space-y-1">
            <Label className="text-[10px] uppercase tracking-widest text-muted-foreground">
              {t("Comment", "Comment")}
            </Label>
          <Textarea
            value={editedRecord.comment ?? ""}
            onChange={(e) =>
              setEditedRecord({
                ...editedRecord,
                comment: e.target.value,
              })
            }
            placeholder={t("Optional: add a note for this record", "Optional: add a note for this record")}
            className="min-h-20 resize-y"
          />
          <div className="text-[11px] text-muted-foreground">
            {t(
              "Stored with the record in Cloudflare.",
              "Stored with the record in Cloudflare.",
            )}
          </div>
        </div>
      </div>
    );
  }

  const visibleColumns = (columns ??
    ([
      "select",
      "type",
      "name",
      "content",
      "ttl",
      "proxied",
      "actions",
    ] as const)) as NonNullable<RecordRowProps["columns"]>;

  return (
    <ContextMenu onOpenChange={setContextMenuOpen}>
      <ContextMenuTrigger asChild>
        <div
          className="ui-focus ui-table-row group focus-visible:outline-none"
          style={gridTemplateColumns ? { gridTemplateColumns } : undefined}
          role="button"
          tabIndex={0}
          data-selected={isSelected}
          data-context-open={contextMenuOpen ? "true" : "false"}
          onDoubleClick={() => onEdit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onEdit();
            }
          }}
        >
          {visibleColumns.map((col) => {
            switch (col) {
              case "select":
                return (
                  <div
                    key={col}
                    className="flex items-center justify-center"
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={(event) => onSelectChange?.(event.target.checked)}
                      onClick={(event) => event.stopPropagation()}
                      className="checkbox-themed"
                      aria-label={t("Select record", "Select record")}
                    />
                  </div>
                );
              case "type":
                return (
                  <div key={col} className="min-w-0">
                    <Tooltip
                      tip={getRecordTypeLabel(record.type as RecordType)}
                      side="top"
                    >
                      <Tag data-record-type={record.type}>{record.type}</Tag>
                    </Tooltip>
                  </div>
                );
              case "name":
                return (
                  <Tooltip key={col} tip={record.name} side="top">
                    <div
                      className="min-w-0 truncate font-mono text-[11px]"
                      onClick={(event) => {
                        event.stopPropagation();
                        if (record.name.length > MAX_PREVIEW_CHARS) {
                          setExpandedName((prev) => !prev);
                        }
                      }}
                      role={
                        record.name.length > MAX_PREVIEW_CHARS ? "button" : undefined
                      }
                      tabIndex={record.name.length > MAX_PREVIEW_CHARS ? 0 : -1}
                    >
                      {truncate(record.name)}
                    </div>
                  </Tooltip>
                );
              case "content":
                return (
                  <Tooltip key={col} tip={record.content} side="top">
                    <div
                      className="min-w-0 truncate text-[10px] text-muted-foreground"
                      onClick={(event) => {
                        event.stopPropagation();
                        if (record.content.length > MAX_PREVIEW_CHARS) {
                          setExpandedContent((prev) => !prev);
                        }
                      }}
                      role={
                        record.content.length > MAX_PREVIEW_CHARS ? "button" : undefined
                      }
                      tabIndex={record.content.length > MAX_PREVIEW_CHARS ? 0 : -1}
                    >
                      {truncate(record.content)}
                    </div>
                  </Tooltip>
                );
              case "comment": {
                const c = (record.comment ?? "").trim();
                if (!c) {
                  return (
                    <div key={col} className="text-[10px] text-muted-foreground/80">
                      —
                    </div>
                  );
                }
                return (
                  <Tooltip key={col} tip={c} side="top">
                    <div className="min-w-0 truncate text-[10px] text-muted-foreground">
                      {truncate(c)}
                    </div>
                  </Tooltip>
                );
              }
              case "tags": {
                const preview = tags.slice(0, 2);
                const remaining = Math.max(0, tags.length - preview.length);
                return (
                  <div
                    key={col}
                    className="flex min-w-0 flex-wrap items-center gap-1"
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    {preview.length ? (
                      <>
                        {preview.map((t) => (
                          <Tag key={t} className="text-[8px] px-1.5 py-0.5">
                            {t}
                          </Tag>
                        ))}
                        {remaining > 0 && (
                          <span className="text-[10px] text-muted-foreground">
                            +{remaining}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-[10px] text-muted-foreground/70">—</span>
                    )}
                  </div>
                );
              }
              case "ttl":
                return (
                  <div
                    key={col}
                    className="text-[10px] text-muted-foreground whitespace-nowrap"
                  >
                    {t("TTL", "TTL")} {record.ttl === 1 ? t("Auto", "Auto") : record.ttl}
                    {typeof record.priority === "number" ? ` • P${record.priority}` : ""}
                  </div>
                );
              case "proxied":
                return (
                  <div
                    key={col}
                    className="flex items-center gap-0.5"
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    {record.proxied ? (
                      <Tag variant="primary" className="ui-tag-proxied">
                        {t("Proxied", "Proxied")}
                      </Tag>
                    ) : (
                      <span className="text-xs text-muted-foreground/80">—</span>
                    )}
                    {(record.type === "A" ||
                      record.type === "AAAA" ||
                      record.type === "CNAME") && (
                      <Switch
                        size="xs"
                        checked={record.proxied || false}
                        onCheckedChange={(checked: boolean) => {
                          onToggleProxy?.(checked);
                        }}
                        onClick={(event) => event.stopPropagation()}
                        onDoubleClick={(event) => event.stopPropagation()}
                      />
                    )}
                  </div>
                );
              case "actions":
                return (
                  <div
                    key={col}
                    className="flex justify-end opacity-0 transition-opacity group-hover:opacity-100"
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    <DropdownMenu open={dotMenuOpen} onOpenChange={setDotMenuOpen}>
                      <Tooltip tip={t("Actions", "Actions")} side="top">
                        <DropdownMenuTrigger asChild>
                          <Button
                              size="sm"
                              variant="ghost"
                              className="ui-icon-button h-7 w-7 p-0"
                              aria-label={t("Record Actions", "Record Actions")}
                              onClick={(event) => event.stopPropagation()}
                            >
                            <MoreHorizontal className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                      </Tooltip>
                      <DropdownMenuContent
                        align="end"
                        sideOffset={6}
                        onClick={(event) => event.stopPropagation()}
                      >
                        {renderActionsMenuItems()}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                );
              default:
                return null;
            }
          })}
      {(expandedName || expandedContent) && (
        <div className="glass-surface glass-sheen glass-fade col-span-full relative mt-2 space-y-2 rounded-lg px-3 py-2 text-xs text-foreground/80">
          <div
            className="absolute right-2 top-2 flex gap-1"
            onClick={(event) => event.stopPropagation()}
          >
            {expandedName && (
              <Tooltip tip={t("Copy name", "Copy name")} side="left">
                <Button
                  size="sm"
                  variant="ghost"
                  className="ui-icon-button h-7 w-7 p-0"
                  aria-label={t("Copy name", "Copy name")}
                  onClick={() =>
                    void navigator.clipboard?.writeText(record.name)
                  }
                >
                  <Copy className="h-3 w-3" />
                </Button>
              </Tooltip>
            )}
            {expandedContent && (
              <Tooltip tip={t("Copy content", "Copy content")} side="left">
                <Button
                  size="sm"
                  variant="ghost"
                  className="ui-icon-button h-7 w-7 p-0"
                  aria-label={t("Copy content", "Copy content")}
                  onClick={() =>
                    void navigator.clipboard?.writeText(record.content)
                  }
                >
                  <Copy className="h-3 w-3" />
                </Button>
              </Tooltip>
            )}
          </div>
          {expandedName && (
            <div className="break-all pr-16">
                <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
                {t("Name", "Name")}
                </span>
              <div className="mt-1 font-mono text-sm text-foreground">
                {record.name}
              </div>
            </div>
          )}
          {expandedContent && (
            <div className="break-all pr-16">
                <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
                {t("Content", "Content")}
                </span>
              <div className="mt-1 text-foreground">{record.content}</div>
            </div>
          )}
          {!!(record.comment ?? "").trim() && (
            <div className="break-all pr-16">
                <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
                {t("Comment", "Comment")}
                </span>
              <div className="mt-1 text-foreground">{record.comment}</div>
            </div>
          )}
          <div className="pr-16">
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
              {t("Tags", "Tags")}
            </span>
            <div className="mt-2 flex flex-wrap items-center gap-1">
              {tags.length ? (
                tags.map((tag) => (
                  <span key={tag} className="inline-flex items-center gap-1">
                    <Tag className="text-[9px] px-2 py-0.5">{tag}</Tag>
                    <button
                      type="button"
                      className="ui-icon-button h-5 w-5"
                      aria-label={t("Remove tag {{tag}}", {
                        tag,
                        defaultValue: `Remove tag ${tag}`,
                      })}
                      onClick={(event) => {
                        event.stopPropagation();
                        removeTag(tag);
                      }}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))
              ) : (
                <span className="text-[10px] text-muted-foreground/70">
                  {t("No tags", "No tags")}
                </span>
              )}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                list={tagSuggestionListId}
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addTag();
                  }
                }}
                placeholder={t("Add tag", "Add tag")}
                className="ui-focus h-7 w-44 rounded-md border border-input bg-background px-2 text-[11px] text-foreground placeholder:text-muted-foreground"
              />
              <datalist id={tagSuggestionListId}>
                {zoneTags.map((tag) => (
                  <option key={tag} value={tag} />
                ))}
              </datalist>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2"
                onClick={(event) => {
                  event.stopPropagation();
                  addTag();
                }}
              >
                {t("Add", "Add")}
              </Button>
            </div>
          </div>
        </div>
      )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent onClick={(event) => event.stopPropagation()}>
        {renderContextMenuItems()}
      </ContextMenuContent>
    </ContextMenu>
  );
}
