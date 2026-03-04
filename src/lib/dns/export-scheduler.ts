/**
 * Export scheduling utility — allows users to set up recurring DNS record
 * exports with configurable format and destination. Works in both web
 * (download) and desktop (file save) modes.
 */

export type ExportFormat = "json" | "csv" | "bind";

export interface ExportSchedule {
  id: string;
  zoneId: string;
  zoneName: string;
  format: ExportFormat;
  intervalMs: number;
  lastExportAt?: number;
  enabled: boolean;
}

const STORAGE_KEY = "bc_export_schedules";

/**
 * Load saved export schedules from localStorage.
 */
export function loadExportSchedules(): ExportSchedule[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as ExportSchedule[];
  } catch {
    return [];
  }
}

/**
 * Save export schedules to localStorage.
 */
export function saveExportSchedules(schedules: ExportSchedule[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(schedules));
}

/**
 * Add or update a schedule.
 */
export function upsertSchedule(schedule: ExportSchedule): ExportSchedule[] {
  const schedules = loadExportSchedules();
  const idx = schedules.findIndex((s) => s.id === schedule.id);
  if (idx >= 0) {
    schedules[idx] = schedule;
  } else {
    schedules.push(schedule);
  }
  saveExportSchedules(schedules);
  return schedules;
}

/**
 * Remove a schedule by id.
 */
export function removeSchedule(id: string): ExportSchedule[] {
  const schedules = loadExportSchedules().filter((s) => s.id !== id);
  saveExportSchedules(schedules);
  return schedules;
}

/**
 * Get schedules that are due for export (enabled and past their interval).
 */
export function getDueSchedules(): ExportSchedule[] {
  const now = Date.now();
  return loadExportSchedules().filter((s) => {
    if (!s.enabled) return false;
    if (!s.lastExportAt) return true;
    return now - s.lastExportAt >= s.intervalMs;
  });
}

/**
 * Mark a schedule as just exported.
 */
export function markExported(id: string): void {
  const schedules = loadExportSchedules();
  const schedule = schedules.find((s) => s.id === id);
  if (schedule) {
    schedule.lastExportAt = Date.now();
    saveExportSchedules(schedules);
  }
}

/**
 * Common interval presets (in milliseconds).
 */
export const EXPORT_INTERVAL_PRESETS = [
  { label: "Every hour", ms: 60 * 60 * 1000 },
  { label: "Every 6 hours", ms: 6 * 60 * 60 * 1000 },
  { label: "Daily", ms: 24 * 60 * 60 * 1000 },
  { label: "Weekly", ms: 7 * 24 * 60 * 60 * 1000 },
] as const;
