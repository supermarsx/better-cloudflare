import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type WheelEvent,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";
import {
  ChevronDown,
  Copy,
  Edit3,
  ExternalLink,
  FileDown,
  Hand,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  RefreshCw,
  Search,
  StickyNote,
  ZoomIn,
} from "lucide-react";
import type { DNSRecord } from "@/types/dns";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { TauriClient } from "@/lib/api/tauri-client";
import { isDesktop } from "@/lib/environment";
import { reportRuntimeError } from "@/lib/errors/runtime-reporting";
import { retainUtf8, utf8ByteLengthUpTo } from "./rendererSafety";

type Annotation = {
  id: string;
  x: number;
  y: number;
  text: string;
};

type TopologySummary = {
  cnameChains: Array<{ start: string; chain: string[] }>;
  sharedIps: Array<{ ip: string; names: string[] }>;
  detectedServices: Array<{ name: string; via: string }>;
  mxTrails: Array<{
    from: string;
    priority: number | null;
    target: string;
    chain: string[];
    terminal: string;
    ipv4: string[];
    ipv6: string[];
  }>;
  areas: {
    email: number;
    web: number;
    infra: number;
    misc: number;
  };
  nodeSummaries: Array<{
    name: string;
    records: DNSRecord[];
    resolvedTo: string[];
    areas: Array<"email" | "web" | "infra" | "misc">;
    terminal: string;
    ipv4: string[];
    ipv6: string[];
  }>;
};

type ZoneTopologyTabProps = {
  zoneName: string;
  records: DNSRecord[];
  isLoading?: boolean;
  maxResolutionHops?: number;
  resolverMode?: "dns" | "doh";
  dnsServer?: string;
  customDnsServer?: string;
  dohProvider?: "google" | "cloudflare" | "quad9" | "custom";
  dohCustomUrl?: string;
  exportConfirmPath?: boolean;
  exportFolderPreset?:
    | "system"
    | "documents"
    | "downloads"
    | "desktop"
    | "custom";
  exportCustomPath?: string;
  copyActions?: Array<"mermaid" | "svg" | "png">;
  exportActions?: Array<"mermaid" | "svg" | "png" | "pdf">;
  disableAnnotations?: boolean;
  disableFullWindow?: boolean;
  lookupTimeoutMs?: number;
  disablePtrLookups?: boolean;
  disableGeoLookups?: boolean;
  geoProvider?: "auto" | "ipwhois" | "ipapi_co" | "ip_api" | "internal";
  scanResolutionChain?: boolean;
  disableServiceDiscovery?: boolean;
  tcpServicePorts?: number[];
  onRefresh: () => Promise<void> | void;
  onEditRecord?: (record: DNSRecord) => void;
  modelYieldControl?: (signal?: AbortSignal) => Promise<void>;
};

type ServiceDiscoveryItem = {
  service: string;
  status: "up" | "down" | "inferred";
  details: string;
};

type ExternalDnsResolution = {
  requestedName?: string;
  chain: string[];
  terminal: string;
  ipv4: string[];
  ipv6: string[];
  reverseHostnamesByIp?: Record<string, string[]>;
  geoByIp?: Record<string, { country: string; countryCode?: string }>;
  source: "external";
  error?: string;
};

type TopologyResolutionProgress = {
  running: boolean;
  total: number;
  done: number;
};
type TopologyResolutionCacheEntry = {
  value: ExternalDnsResolution;
  ts: number;
};

function reportTopologyFailure(error: unknown, label: string) {
  return reportRuntimeError(error, { source: "runtime", label }).diagnostic;
}

function SanitizedTopologySvg({ svgMarkup }: { svgMarkup: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.replaceChildren();
    if (!svgMarkup.trim()) return;
    try {
      const safeMarkup = sanitizeTopologySvg(svgMarkup);
      const parsed = new DOMParser().parseFromString(
        safeMarkup,
        "image/svg+xml",
      ).documentElement;
      container.append(document.importNode(parsed, true));
    } catch (error) {
      reportTopologyFailure(error, "Insert sanitized DNS topology SVG");
      container.textContent = "Topology SVG could not be displayed safely.";
    }
  }, [svgMarkup]);
  return <div ref={containerRef} className="topology-svg-wrapper" />;
}

async function copyTopologyText(
  text: string,
  label = "Copy topology text",
): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) {
      throw new Error("Text clipboard access is unavailable");
    }
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    reportTopologyFailure(error, label);
    return false;
  }
}

async function runTopologyRefresh(
  refresh: () => Promise<void> | void,
): Promise<boolean> {
  try {
    await refresh();
    return true;
  } catch (error) {
    reportTopologyFailure(error, "Refresh DNS topology");
    return false;
  }
}
type TopologyProbeCacheEntry = {
  host: string;
  httpsUp: boolean;
  httpUp: boolean;
  ts: number;
};
type DiscoveryProgress = {
  label: string;
  done: number;
  total: number;
  requests: string[];
};
const TOPOLOGY_CACHE_TTL_MS = 5 * 60 * 1000;

function detectDarkThemeMode(): boolean {
  if (typeof document === "undefined") return true;
  const root = document.documentElement;
  const dataTheme = String(root.getAttribute("data-theme") ?? "").toLowerCase();
  if (dataTheme.includes("light") || dataTheme.includes("midday")) return false;
  if (
    dataTheme.includes("dark") ||
    dataTheme.includes("oled") ||
    dataTheme.includes("night") ||
    dataTheme.includes("sunset")
  )
    return true;
  const bgVar = getComputedStyle(root).getPropertyValue("--background").trim();
  const lightnessMatch = bgVar.match(/([0-9.]+)%\s*$/);
  if (lightnessMatch) {
    const lightness = Number(lightnessMatch[1]);
    if (Number.isFinite(lightness)) return lightness < 50;
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? true;
}

function applyEdgeLabelTheme(svgMarkup: string, isDarkTheme: boolean): string {
  if (!svgMarkup.trim() || typeof document === "undefined") return svgMarkup;
  try {
    const styles = getComputedStyle(document.documentElement);
    const hslVar = (name: string, fallback: string) => {
      const v = styles.getPropertyValue(name).trim();
      return v ? `hsl(${v})` : fallback;
    };
    const labelText = hslVar(
      "--foreground",
      isDarkTheme ? "#e6eeff" : "#1f2937",
    );
    const labelBg = hslVar("--card", isDarkTheme ? "#1a2132" : "#ffffff");
    const labelBorder = hslVar("--border", isDarkTheme ? "#445" : "#cbd5e1");
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgMarkup, "image/svg+xml");
    const svg = doc.querySelector("svg");
    if (!svg) return svgMarkup;
    const style = doc.createElementNS("http://www.w3.org/2000/svg", "style");
    style.textContent = `
      .edgeLabel, .edgeLabel span, .edgeLabel p { color: ${labelText} !important; fill: ${labelText} !important; }
      .edgeLabel rect { fill: ${labelBg} !important; stroke: ${labelBorder} !important; opacity: 0.95; rx: 6px; ry: 6px; }
      .flowchart-link, .edgePath path { stroke-linecap: round; stroke-linejoin: round; }
    `;
    svg.prepend(style);
    return new XMLSerializer().serializeToString(svg);
  } catch {
    return svgMarkup;
  }
}

const ALLOWED_TOPOLOGY_SVG_ELEMENTS = new Set([
  "circle",
  "clippath",
  "defs",
  "desc",
  "ellipse",
  "g",
  "line",
  "lineargradient",
  "marker",
  "mask",
  "path",
  "pattern",
  "polygon",
  "polyline",
  "radialgradient",
  "rect",
  "stop",
  "style",
  "svg",
  "text",
  "title",
  "tspan",
]);

function normalizeCssForInspection(css: string): string {
  return (
    css
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\\(?:\r\n|[\n\r\f])/g, "")
      // XML normalizes attribute newlines to spaces before CSS inspection.
      // Treat backslash-whitespace conservatively as a continued token.
      .replace(/\\[ \t]+/g, "")
      .replace(
        /\\([0-9a-f]{1,6})\s?|\\([^\r\n\f])/gi,
        (
          _match,
          hexadecimal: string | undefined,
          escaped: string | undefined,
        ) => {
          if (hexadecimal) {
            const codePoint = Number.parseInt(hexadecimal, 16);
            return codePoint > 0 && codePoint <= 0x10ffff
              ? String.fromCodePoint(codePoint)
              : "\uFFFD";
          }
          return escaped ?? "";
        },
      )
  );
}

function hasUnsafeCss(css: string): boolean {
  const normalized = normalizeCssForInspection(css);
  if (
    /@import|expression\s*\(|\b(?:javascript|vbscript|data)\s*:|behavior\s*:|-moz-binding/i.test(
      normalized,
    )
  ) {
    return true;
  }
  for (const match of normalized.matchAll(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    if (!/^#[A-Za-z_][A-Za-z0-9_.:-]*$/.test(match[2].trim())) return true;
  }
  return false;
}

/**
 * Sanitize Mermaid output before it is retained, inserted, copied, printed, or
 * exported. The allowlist intentionally excludes HTML, scripting, animation,
 * external resources, and interactive links.
 */
export function sanitizeTopologySvg(input: string): string {
  const doc = new DOMParser().parseFromString(input, "image/svg+xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("Mermaid returned malformed SVG");
  }
  const svg = doc.documentElement;
  if (
    svg.localName.toLowerCase() !== "svg" ||
    svg.namespaceURI !== "http://www.w3.org/2000/svg"
  ) {
    throw new Error("Mermaid returned a non-SVG document");
  }

  for (const element of Array.from(svg.querySelectorAll("*"))) {
    const localName = element.localName.toLowerCase();
    if (
      element.namespaceURI !== "http://www.w3.org/2000/svg" ||
      !ALLOWED_TOPOLOGY_SVG_ELEMENTS.has(localName)
    ) {
      element.remove();
      continue;
    }

    if (localName === "style") {
      const css = element.textContent ?? "";
      if (hasUnsafeCss(css)) element.remove();
      continue;
    }

    for (const attribute of Array.from(element.attributes)) {
      const attributeName = attribute.name.toLowerCase();
      const attributeValue = attribute.value.trim();
      if (
        attributeName.startsWith("on") ||
        attributeName === "href" ||
        attributeName === "xlink:href" ||
        attributeName === "src"
      ) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (hasUnsafeCss(attributeValue)) {
        element.removeAttribute(attribute.name);
        continue;
      }
    }
  }

  for (const attribute of Array.from(svg.attributes)) {
    const attributeName = attribute.name.toLowerCase();
    if (
      attributeName.startsWith("on") ||
      attributeName === "href" ||
      attributeName === "xlink:href" ||
      attributeName === "src" ||
      hasUnsafeCss(attribute.value)
    ) {
      svg.removeAttribute(attribute.name);
    }
  }
  if (!svg.getAttribute("xmlns")) {
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  }
  return new XMLSerializer().serializeToString(svg);
}

export type TopologyCanvasAllocation = {
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  downscaled: boolean;
};

function parsePositiveSvgNumber(value: string | null): number | null {
  if (!value) return null;
  const match = value
    .trim()
    .match(/^([+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(?:px)?$/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function readTopologySvgDimensions(svgMarkup: string): {
  width: number;
  height: number;
} {
  const parsed = new DOMParser().parseFromString(svgMarkup, "image/svg+xml");
  if (parsed.querySelector("parsererror")) {
    throw new Error("Cannot allocate a canvas for malformed SVG");
  }
  const svg = parsed.documentElement;
  if (svg.localName.toLowerCase() !== "svg") {
    throw new Error("Cannot allocate a canvas for a non-SVG document");
  }
  const viewBox = (svg.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const viewBoxWidth =
    viewBox.length === 4 && Number.isFinite(viewBox[2]) && viewBox[2] > 0
      ? viewBox[2]
      : null;
  const viewBoxHeight =
    viewBox.length === 4 && Number.isFinite(viewBox[3]) && viewBox[3] > 0
      ? viewBox[3]
      : null;
  return {
    width:
      parsePositiveSvgNumber(svg.getAttribute("width")) ?? viewBoxWidth ?? 1600,
    height:
      parsePositiveSvgNumber(svg.getAttribute("height")) ??
      viewBoxHeight ??
      900,
  };
}

export function computeTopologyCanvasAllocation(
  sourceWidth: number,
  sourceHeight: number,
  pixelRatio: number,
): TopologyCanvasAllocation {
  if (
    !Number.isFinite(sourceWidth) ||
    sourceWidth <= 0 ||
    !Number.isFinite(sourceHeight) ||
    sourceHeight <= 0
  ) {
    throw new RangeError("SVG dimensions must be finite positive numbers");
  }
  const boundedPixelRatio =
    Number.isFinite(pixelRatio) && pixelRatio > 0 ? Math.min(pixelRatio, 2) : 1;
  let scale = Math.min(
    boundedPixelRatio,
    TOPOLOGY_CANVAS_MAX_AXIS / sourceWidth,
    TOPOLOGY_CANVAS_MAX_AXIS / sourceHeight,
  );
  let scaledWidth = sourceWidth * scale;
  let scaledHeight = sourceHeight * scale;
  const areaScale = Math.min(
    1,
    Math.sqrt(TOPOLOGY_CANVAS_MAX_PIXELS / scaledWidth / scaledHeight),
  );
  scale *= areaScale;
  scaledWidth = sourceWidth * scale;
  scaledHeight = sourceHeight * scale;

  const width = Math.max(
    1,
    Math.min(TOPOLOGY_CANVAS_MAX_AXIS, Math.floor(scaledWidth)),
  );
  const height = Math.max(
    1,
    Math.min(TOPOLOGY_CANVAS_MAX_AXIS, Math.floor(scaledHeight)),
  );
  if (
    width > TOPOLOGY_CANVAS_MAX_AXIS ||
    height > TOPOLOGY_CANVAS_MAX_AXIS ||
    width * height > TOPOLOGY_CANVAS_MAX_PIXELS
  ) {
    throw new RangeError(
      "Topology canvas allocation exceeds its safety budget",
    );
  }
  return {
    width,
    height,
    sourceWidth,
    sourceHeight,
    downscaled:
      width < Math.ceil(sourceWidth * boundedPixelRatio) ||
      height < Math.ceil(sourceHeight * boundedPixelRatio),
  };
}

export function assignBoundedTopologyCanvas(
  canvas: HTMLCanvasElement,
  svgMarkup: string,
  pixelRatio: number,
): TopologyCanvasAllocation {
  const dimensions = readTopologySvgDimensions(svgMarkup);
  const allocation = computeTopologyCanvasAllocation(
    dimensions.width,
    dimensions.height,
    pixelRatio,
  );
  canvas.width = allocation.width;
  canvas.height = allocation.height;
  if (
    canvas.width > TOPOLOGY_CANVAS_MAX_AXIS ||
    canvas.height > TOPOLOGY_CANVAS_MAX_AXIS ||
    canvas.width * canvas.height > TOPOLOGY_CANVAS_MAX_PIXELS
  ) {
    canvas.width = 0;
    canvas.height = 0;
    throw new RangeError("Browser assigned an oversized topology canvas");
  }
  return allocation;
}

export async function withBoundedTopologyCanvas<T>(
  canvas: HTMLCanvasElement,
  svgMarkup: string,
  pixelRatio: number,
  operation: (
    canvas: HTMLCanvasElement,
    allocation: TopologyCanvasAllocation,
  ) => Promise<T> | T,
): Promise<T> {
  try {
    const allocation = assignBoundedTopologyCanvas(
      canvas,
      svgMarkup,
      pixelRatio,
    );
    return await operation(canvas, allocation);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

export async function withTopologyObjectUrl<T>(
  blob: Blob,
  operation: (url: string) => Promise<T> | T,
): Promise<T> {
  const url = URL.createObjectURL(blob);
  try {
    return await operation(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error("Failed to encode PNG data"));
    reader.onabort = () => reject(new Error("PNG encoding was aborted"));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("PNG encoder returned an invalid result"));
        return;
      }
      const separator = result.indexOf(",");
      if (separator < 0) {
        reject(new Error("PNG encoder returned a malformed data URL"));
        return;
      }
      resolve(result.slice(separator + 1));
    };
    reader.readAsDataURL(blob);
  });
}

export function appendBoundedTopologyAnnotation(
  annotations: readonly Annotation[],
  annotation: Annotation,
): { annotations: Annotation[]; diagnostic: string | null } {
  if (annotations.length >= TOPOLOGY_ANNOTATION_LIMIT) {
    return {
      annotations: [...annotations],
      diagnostic: `Annotation refused: remove an existing note before adding more than ${TOPOLOGY_ANNOTATION_LIMIT}.`,
    };
  }
  let retainedBytes = 0;
  for (const current of annotations) {
    retainedBytes += utf8ByteLengthUpTo(
      current.text,
      TOPOLOGY_ANNOTATION_TOTAL_MAX_BYTES,
    );
  }
  const remainingBytes = Math.max(
    0,
    TOPOLOGY_ANNOTATION_TOTAL_MAX_BYTES - retainedBytes,
  );
  const entryBudget = Math.min(
    TOPOLOGY_ANNOTATION_ENTRY_MAX_BYTES,
    remainingBytes,
  );
  if (entryBudget === 0) {
    return {
      annotations: [...annotations],
      diagnostic: `Annotation refused: the ${TOPOLOGY_ANNOTATION_TOTAL_MAX_BYTES.toLocaleString()}-byte annotation budget is full.`,
    };
  }
  const bounded = retainUtf8(annotation.text, entryBudget);
  const text = bounded.value.trim();
  if (!text) {
    return {
      annotations: [...annotations],
      diagnostic: "Annotation refused: enter non-empty text.",
    };
  }
  return {
    annotations: [...annotations, { ...annotation, text }],
    diagnostic: bounded.truncated
      ? `Annotation was truncated to fit the ${entryBudget.toLocaleString()}-byte remaining safety budget.`
      : null,
  };
}

export function populateTopologyPrintDocument(
  doc: Document,
  svgMarkup: string,
  zoneName: string,
  annotations: ReadonlyArray<{ text: string; x: number; y: number }>,
): void {
  const head = doc.createElement("head");
  const title = doc.createElement("title");
  title.textContent = `${zoneName} topology`;
  const style = doc.createElement("style");
  style.textContent =
    "body { font-family: system-ui, sans-serif; margin: 20px; color: #111; } .graph { border: 1px solid #ddd; border-radius: 10px; padding: 12px; }";
  head.append(title, style);

  const body = doc.createElement("body");
  const heading = doc.createElement("h1");
  heading.textContent = `${zoneName} topology`;
  const graph = doc.createElement("div");
  graph.className = "graph";
  const parsedSvg = new DOMParser().parseFromString(
    sanitizeTopologySvg(svgMarkup),
    "image/svg+xml",
  ).documentElement;
  graph.append(doc.importNode(parsedSvg, true));
  body.append(heading, graph);

  if (annotations.length > 0) {
    const annotationHeading = doc.createElement("h3");
    annotationHeading.textContent = "Annotations";
    const list = doc.createElement("ul");
    for (const annotation of annotations) {
      const item = doc.createElement("li");
      const label = doc.createElement("strong");
      label.textContent = annotation.text;
      item.append(
        label,
        doc.createTextNode(
          ` (${Math.round(annotation.x)}, ${Math.round(annotation.y)})`,
        ),
      );
      list.append(item);
    }
    body.append(annotationHeading, list);
  }

  doc.documentElement.replaceChildren(head, body);
}

const SERVICE_PATTERNS: Array<{ pattern: RegExp; service: string }> = [
  { pattern: /cloudfront\.net$/i, service: "AWS CloudFront" },
  { pattern: /elb\.amazonaws\.com$/i, service: "AWS ELB" },
  { pattern: /azureedge\.net$/i, service: "Azure Edge/CDN" },
  { pattern: /trafficmanager\.net$/i, service: "Azure Traffic Manager" },
  { pattern: /fastly\.net$/i, service: "Fastly" },
  { pattern: /akamai(net|hd)\.net$/i, service: "Akamai" },
  { pattern: /herokudns\.com$/i, service: "Heroku DNS" },
  { pattern: /vercel-dns\.com$/i, service: "Vercel" },
  { pattern: /github\.io$/i, service: "GitHub Pages" },
  { pattern: /netlify\.(app|global)$/i, service: "Netlify" },
  { pattern: /cloudflare\.com$/i, service: "Cloudflare" },
];
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 8;
export const TOPOLOGY_MODEL_NODE_LIMIT = 10_000;
export const TOPOLOGY_GRAPH_DOM_NODE_LIMIT = 80;
export const TOPOLOGY_GRAPH_DOM_EDGE_LIMIT = 160;
export const TOPOLOGY_RESULT_PAGE_SIZE = 50;
export const TOPOLOGY_NODE_LABEL_MAX_CHARS = 80;
export const TOPOLOGY_SUMMARY_RENDER_LIMIT = 120;
export const TOPOLOGY_EMAIL_RENDER_LIMIT = 40;
export const TOPOLOGY_MODEL_CHUNK_SIZE = 250;
const TOPOLOGY_LEGACY_MERMAID_RECORD_LIMIT = 500;
const TOPOLOGY_RESOLUTION_CHAIN_LIMIT = 8;
const TOPOLOGY_RESOLUTION_TARGET_LIMIT = TOPOLOGY_LEGACY_MERMAID_RECORD_LIMIT;
const TOPOLOGY_LOOKUP_CONCURRENCY = 6;
const TOPOLOGY_IPS_PER_FAMILY_LIMIT = 4;
const TOPOLOGY_PTR_HOSTS_PER_IP_LIMIT = 4;
const TOPOLOGY_CACHE_ENTRY_LIMIT = 512;
export const TOPOLOGY_ANNOTATION_LIMIT = 100;
export const TOPOLOGY_ANNOTATION_ENTRY_MAX_BYTES = 2 * 1024;
export const TOPOLOGY_ANNOTATION_TOTAL_MAX_BYTES = 64 * 1024;
export const TOPOLOGY_CANVAS_MAX_AXIS = 8192;
export const TOPOLOGY_CANVAS_MAX_PIXELS = 16 * 1024 * 1024;
export const TOPOLOGY_MERMAID_SECURITY_LEVEL = "strict" as const;
export const TOPOLOGY_MERMAID_HTML_LABELS = false;
export const TOPOLOGY_MERMAID_LABEL_MAX_BYTES = 2 * 1024;
const EMPTY_TOPOLOGY_RECORDS: DNSRecord[] = [];
const DEFAULT_TOPOLOGY_TCP_SERVICE_PORTS = [80, 443, 22];

function throwIfTopologyAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new DOMException("Topology request aborted", "AbortError");
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      throwIfTopologyAborted(signal);
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]);
    }
  };
  const workerCount = Math.min(
    values.length,
    Math.max(1, Math.floor(concurrency)),
  );
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export function escapeMermaidLabel(value: string): string {
  return retainUtf8(
    String(value ?? ""),
    TOPOLOGY_MERMAID_LABEL_MAX_BYTES,
  ).value.replace(
    /[&<>"'`\\\r\n]/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
        "`": "&#96;",
        "\\": "&#92;",
        "\r": "&#13;",
        "\n": "&#10;",
      })[character] ?? "",
  );
}

function esc(value: string): string {
  return escapeMermaidLabel(value);
}

function sanitizeId(value: string): string {
  return (
    String(value ?? "")
      .replace(/[^a-zA-Z0-9_]/g, "_")
      .replace(/^(\d)/, "_$1")
      .slice(0, 80) || "node"
  );
}

function normalizeDomain(value: string): string {
  return String(value ?? "")
    .trim()
    .replace(/\.$/, "")
    .toLowerCase();
}

function isIpAddress(value: string): boolean {
  const v = String(value ?? "").trim();
  if (!v) return false;
  // Simple IPv4/IPv6 checks for candidate filtering.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return true;
  if (v.includes(":") && /^[0-9a-f:.]+$/i.test(v)) return true;
  return false;
}

function buildBrowserUrl(address?: string): string | null {
  const raw = String(address ?? "").trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (isIpAddress(raw)) {
    return raw.includes(":") ? `http://[${raw}]` : `http://${raw}`;
  }
  if (/^[a-z0-9.-]+$/i.test(raw)) {
    return `https://${raw}`;
  }
  return null;
}

function extractTarget(record: DNSRecord): string | null {
  if (record.type === "CNAME" || record.type === "NS") {
    const target = normalizeDomain(record.content);
    return target || null;
  }
  if (record.type === "MX") {
    const parts = String(record.content ?? "")
      .trim()
      .split(/\s+/);
    const target = normalizeDomain(parts.slice(1).join(" "));
    return target || null;
  }
  if (record.type === "SRV") {
    const parts = String(record.content ?? "")
      .trim()
      .split(/\s+/);
    const target = normalizeDomain(parts.slice(3).join(" "));
    return target || null;
  }
  if (record.type === "A" || record.type === "AAAA") {
    const ip = String(record.content ?? "").trim();
    return ip || null;
  }
  return null;
}

export type TopologyGraphNode = {
  id: string;
  recordIndex: number;
  recordId: string;
  recordType: string;
  nodeType: "address" | "alias" | "mail" | "service" | "text" | "other";
  name: string;
  content: string;
  label: string;
  searchText: string;
};

export type TopologyGraphEdge = {
  id: string;
  source: string;
  target: string;
  recordType: string;
};

export type TopologyGraphModel =
  | {
      status: "ready";
      sourceRecords: readonly DNSRecord[];
      nodes: TopologyGraphNode[];
      edges: TopologyGraphEdge[];
    }
  | {
      status: "refused";
      sourceRecords: readonly DNSRecord[];
      nodes: [];
      edges: [];
      limit: number;
    };

type TopologyModelBuildOptions = {
  signal?: AbortSignal;
  chunkSize?: number;
  yieldControl?: (signal?: AbortSignal) => Promise<void>;
  onProgress?: (completed: number, total: number) => void;
};

function topologyNodeType(recordType: string): TopologyGraphNode["nodeType"] {
  switch (recordType.toUpperCase()) {
    case "A":
    case "AAAA":
      return "address";
    case "CNAME":
    case "DNAME":
    case "ALIAS":
    case "ANAME":
      return "alias";
    case "MX":
      return "mail";
    case "SRV":
    case "SVCB":
    case "HTTPS":
      return "service";
    case "TXT":
    case "SPF":
      return "text";
    default:
      return "other";
  }
}

function boundedTopologyLabel(record: DNSRecord): string {
  const value = `${record.type} ${record.name}`.trim();
  if (value.length <= TOPOLOGY_NODE_LABEL_MAX_CHARS) return value;
  return `${value.slice(0, TOPOLOGY_NODE_LABEL_MAX_CHARS - 1)}…`;
}

function yieldTopologyConstruction(signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Topology construction aborted", "AbortError"));
      return;
    }

    const browserWindow =
      typeof window === "undefined"
        ? undefined
        : (window as Window & {
            requestIdleCallback?: (
              callback: () => void,
              options?: { timeout: number },
            ) => number;
            cancelIdleCallback?: (id: number) => void;
          });
    let settled = false;
    let idleId: number | undefined;
    let timerId: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      if (idleId !== undefined) browserWindow?.cancelIdleCallback?.(idleId);
      if (timerId !== undefined) clearTimeout(timerId);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new DOMException("Topology construction aborted", "AbortError"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    if (browserWindow?.requestIdleCallback) {
      idleId = browserWindow.requestIdleCallback(finish, { timeout: 50 });
    } else {
      timerId = setTimeout(finish, 0);
    }
  });
}

/**
 * Builds one graph-model node per source record without truncation. Work is
 * yielded between deterministic chunks, and an aborted build never returns a
 * partial model.
 */
async function buildTopologyGraphModelProgressively(
  records: readonly DNSRecord[],
  options: TopologyModelBuildOptions = {},
): Promise<TopologyGraphModel> {
  if (records.length > TOPOLOGY_MODEL_NODE_LIMIT) {
    return {
      status: "refused",
      sourceRecords: records,
      nodes: [],
      edges: [],
      limit: TOPOLOGY_MODEL_NODE_LIMIT,
    };
  }

  const signal = options.signal;
  const chunkSize = Math.max(
    1,
    Math.floor(options.chunkSize ?? TOPOLOGY_MODEL_CHUNK_SIZE),
  );
  const yieldControl = options.yieldControl ?? yieldTopologyConstruction;
  const nodes = new Array<TopologyGraphNode>(records.length);
  const nodeIdByName = new Map<string, string>();

  for (let start = 0; start < records.length; start += chunkSize) {
    throwIfTopologyAborted(signal);
    const end = Math.min(records.length, start + chunkSize);
    for (let index = start; index < end; index += 1) {
      const record = records[index];
      const recordId = String(record.id ?? "");
      const id = `record_${index}_${sanitizeId(recordId || record.name)}`;
      const name = String(record.name ?? "");
      const content = String(record.content ?? "");
      const recordType = String(record.type ?? "UNKNOWN").toUpperCase();
      nodes[index] = {
        id,
        recordIndex: index,
        recordId,
        recordType,
        nodeType: topologyNodeType(recordType),
        name,
        content,
        label: boundedTopologyLabel(record),
        searchText:
          `${recordId}\n${recordType}\n${name}\n${content}`.toLowerCase(),
      };
      const normalizedName = normalizeDomain(name);
      if (normalizedName && !nodeIdByName.has(normalizedName)) {
        nodeIdByName.set(normalizedName, id);
      }
    }
    options.onProgress?.(end, records.length);
    if (end < records.length) await yieldControl(signal);
  }

  const edges: TopologyGraphEdge[] = [];
  for (let start = 0; start < records.length; start += chunkSize) {
    throwIfTopologyAborted(signal);
    const end = Math.min(records.length, start + chunkSize);
    for (let index = start; index < end; index += 1) {
      const targetName = extractTarget(records[index]);
      if (!targetName) continue;
      const target = nodeIdByName.get(normalizeDomain(targetName));
      if (!target || target === nodes[index].id) continue;
      edges.push({
        id: `edge_${index}_${target}`,
        source: nodes[index].id,
        target,
        recordType: nodes[index].recordType,
      });
    }
    if (end < records.length) await yieldControl(signal);
  }

  throwIfTopologyAborted(signal);
  return {
    status: "ready",
    sourceRecords: records,
    nodes,
    edges,
  };
}

function filterTopologyModelNodes(
  nodes: readonly TopologyGraphNode[],
  text: string,
  recordType: string,
): TopologyGraphNode[] {
  const query = text.trim().toLowerCase();
  const normalizedType = recordType.trim().toUpperCase();
  if (!query && !normalizedType) return nodes as TopologyGraphNode[];
  const matches: TopologyGraphNode[] = [];
  for (const node of nodes) {
    if (normalizedType && node.recordType !== normalizedType) continue;
    if (query && !node.searchText.includes(query)) continue;
    matches.push(node);
  }
  return matches;
}

function filterTopologySourceRecords(
  records: readonly DNSRecord[],
  text: string,
  recordType: string,
): readonly DNSRecord[] {
  const query = text.trim().toLowerCase();
  const normalizedType = recordType.trim().toUpperCase();
  if (!query && !normalizedType) return records;
  const matches: DNSRecord[] = [];
  for (const record of records) {
    const currentType = String(record.type ?? "UNKNOWN").toUpperCase();
    if (normalizedType && currentType !== normalizedType) continue;
    if (query) {
      const searchable =
        `${record.id ?? ""}\n${currentType}\n${record.name ?? ""}\n${record.content ?? ""}`.toLowerCase();
      if (!searchable.includes(query)) continue;
    }
    matches.push(record);
  }
  return matches;
}

function takeUniqueStrings(
  values: string[] | undefined,
  limit: number,
  normalize = false,
): string[] {
  if (!values?.length) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = normalize ? normalizeDomain(raw) : String(raw).trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length >= limit) break;
  }
  return result;
}

function boundExternalResolution(
  resolution: ExternalDnsResolution,
): ExternalDnsResolution {
  const chain = takeUniqueStrings(
    resolution.chain,
    TOPOLOGY_RESOLUTION_CHAIN_LIMIT,
    true,
  );
  const ipv4 = takeUniqueStrings(
    resolution.ipv4,
    TOPOLOGY_IPS_PER_FAMILY_LIMIT,
  );
  const ipv6 = takeUniqueStrings(
    resolution.ipv6,
    TOPOLOGY_IPS_PER_FAMILY_LIMIT,
  );
  const retainedIps = new Set([...ipv4, ...ipv6]);
  const reverseHostnamesByIp: Record<string, string[]> = {};
  for (const [ip, hostnames] of Object.entries(
    resolution.reverseHostnamesByIp ?? {},
  )) {
    if (!retainedIps.has(ip)) continue;
    reverseHostnamesByIp[ip] = takeUniqueStrings(
      hostnames,
      TOPOLOGY_PTR_HOSTS_PER_IP_LIMIT,
      true,
    );
  }
  const geoByIp: Record<string, { country: string; countryCode?: string }> = {};
  for (const [ip, geo] of Object.entries(resolution.geoByIp ?? {})) {
    if (retainedIps.has(ip) && geo?.country) geoByIp[ip] = geo;
  }
  const requestedName = normalizeDomain(resolution.requestedName ?? "");
  const terminal =
    normalizeDomain(resolution.terminal) ||
    chain[chain.length - 1] ||
    requestedName;
  return {
    ...resolution,
    ...(requestedName ? { requestedName } : {}),
    chain: chain.length ? chain : terminal ? [terminal] : [],
    terminal,
    ipv4,
    ipv6,
    reverseHostnamesByIp,
    geoByIp,
  };
}

function setBoundedCache<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > TOPOLOGY_CACHE_ENTRY_LIMIT) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function computeCnameChains(
  records: DNSRecord[],
  maxHops: number,
): Array<{ start: string; chain: string[] }> {
  const map = new Map<string, string>();
  for (const record of records) {
    if (record.type !== "CNAME") continue;
    const from = normalizeDomain(record.name);
    const to = normalizeDomain(record.content);
    if (from && to) map.set(from, to);
  }

  const chains: Array<{ start: string; chain: string[] }> = [];
  for (const [start] of map) {
    const seen = new Set<string>([start]);
    const chain = [start];
    let cur = start;
    let hops = 0;
    while (hops < maxHops) {
      const next = map.get(cur);
      if (!next) break;
      chain.push(next);
      hops += 1;
      if (seen.has(next)) break;
      seen.add(next);
      cur = next;
    }
    if (chain.length > 2) chains.push({ start, chain });
  }
  return chains;
}

function buildCnameMap(records: DNSRecord[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const record of records) {
    if (record.type !== "CNAME") continue;
    const from = normalizeDomain(record.name);
    const to = normalizeDomain(record.content);
    if (!from || !to) continue;
    map.set(from, to);
  }
  return map;
}

function buildAddressMaps(records: DNSRecord[]): {
  ipv4ByName: Map<string, string[]>;
  ipv6ByName: Map<string, string[]>;
} {
  const ipv4Temp = new Map<string, Set<string>>();
  const ipv6Temp = new Map<string, Set<string>>();
  for (const r of records) {
    const name = normalizeDomain(r.name);
    if (!name) continue;
    if (r.type === "A") {
      const ip = String(r.content ?? "").trim();
      if (!ip) continue;
      if (!ipv4Temp.has(name)) ipv4Temp.set(name, new Set());
      ipv4Temp.get(name)!.add(ip);
    }
    if (r.type === "AAAA") {
      const ip = String(r.content ?? "").trim();
      if (!ip) continue;
      if (!ipv6Temp.has(name)) ipv6Temp.set(name, new Set());
      ipv6Temp.get(name)!.add(ip);
    }
  }
  return {
    ipv4ByName: new Map(
      Array.from(ipv4Temp.entries()).map(([k, v]) => [k, Array.from(v)]),
    ),
    ipv6ByName: new Map(
      Array.from(ipv6Temp.entries()).map(([k, v]) => [k, Array.from(v)]),
    ),
  };
}

function resolveNameToTerminal(
  startName: string,
  cnameMap: Map<string, string>,
  ipv4ByName: Map<string, string[]>,
  ipv6ByName: Map<string, string[]>,
  maxHops: number,
): { chain: string[]; terminal: string; ipv4: string[]; ipv6: string[] } {
  const start = normalizeDomain(startName);
  if (!start) return { chain: [], terminal: "", ipv4: [], ipv6: [] };
  const chain: string[] = [start];
  const seen = new Set<string>([start]);
  let cur = start;
  let hops = 0;
  while (hops < maxHops) {
    const next = cnameMap.get(cur);
    if (!next || seen.has(next)) break;
    chain.push(next);
    seen.add(next);
    cur = next;
    hops += 1;
  }
  return {
    chain,
    terminal: cur,
    ipv4: ipv4ByName.get(cur) ?? [],
    ipv6: ipv6ByName.get(cur) ?? [],
  };
}

function pickBestResolution(
  requestedName: string,
  local: { chain: string[]; terminal: string; ipv4: string[]; ipv6: string[] },
  externalByName: Record<string, ExternalDnsResolution>,
): ExternalDnsResolution {
  const requested = normalizeDomain(requestedName);
  const localTerminal = normalizeDomain(local.terminal || requested);
  const external = externalByName[requested] || externalByName[localTerminal];
  const localFallback: ExternalDnsResolution = {
    chain: local.chain,
    terminal: local.terminal,
    ipv4: local.ipv4,
    ipv6: local.ipv6,
    source: "external",
  };
  if (!external) return localFallback;

  const localHasEndpoints = local.ipv4.length > 0 || local.ipv6.length > 0;
  const externalHasEndpoints =
    external.ipv4.length > 0 || external.ipv6.length > 0;
  const externalHasDeeperChain = external.chain.length > local.chain.length;

  // Prefer backend resolution whenever local chain does not end in IPs
  // and backend provides either deeper hop trail or terminal endpoints.
  if (!localHasEndpoints && (externalHasEndpoints || externalHasDeeperChain)) {
    return external;
  }
  if (localHasEndpoints && externalHasEndpoints) {
    return {
      ...localFallback,
      reverseHostnamesByIp: external.reverseHostnamesByIp,
    };
  }
  return localFallback;
}

function buildNodeLabel(title: string, subtitle = ""): string {
  const cleanTitle = String(title ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const cleanSubtitle = String(subtitle ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return cleanSubtitle ? `${cleanTitle} — ${cleanSubtitle}` : cleanTitle;
}

function classifyAreas(
  name: string,
  records: DNSRecord[],
  emailPathNames: Set<string>,
): Array<"email" | "web" | "infra" | "misc"> {
  const areas = new Set<"email" | "web" | "infra" | "misc">();
  const lower = normalizeDomain(name);
  const hasEmailNameHints =
    lower.includes("_dmarc") ||
    lower.includes("._domainkey") ||
    lower.includes("_bimi");
  const hasEmailTypes = records.some(
    (r) => r.type === "MX" || r.type === "SPF",
  );
  const hasEmailTxt = records.some((r) => {
    if (r.type !== "TXT") return false;
    const txt = String(r.content ?? "").toLowerCase();
    return (
      txt.includes("v=spf1") ||
      txt.includes("v=dmarc1") ||
      txt.includes("v=dkim1") ||
      txt.includes("v=bimi1")
    );
  });
  if (
    hasEmailNameHints ||
    hasEmailTypes ||
    hasEmailTxt ||
    emailPathNames.has(lower)
  ) {
    areas.add("email");
  }

  const hasInfraTypes = records.some((r) =>
    ["NS", "SOA", "CAA", "DNSKEY", "DS", "RRSIG", "NSEC", "NSEC3"].includes(
      r.type,
    ),
  );
  if (hasInfraTypes) areas.add("infra");

  const hasWebTypes = records.some((r) =>
    ["A", "AAAA", "CNAME", "SVCB", "HTTPS", "SRV"].includes(r.type),
  );
  if (hasWebTypes) areas.add("web");

  if (areas.size === 0) areas.add("misc");
  return Array.from(areas);
}

function buildTopology(
  records: DNSRecord[],
  zoneName: string,
  maxResolutionHops: number,
  isDarkTheme: boolean,
  externalResolutionByName: Record<string, ExternalDnsResolution>,
): {
  code: string;
  summary: TopologySummary;
  nodeMetaById: Record<
    string,
    { text: string; recordId?: string; address?: string }
  >;
} {
  const lines: string[] = [];
  const nodeMetaById: Record<
    string,
    { text: string; recordId?: string; address?: string }
  > = {};
  const nodeIds = new Map<string, string>();
  let nextId = 0;
  const zoneNode = "zone_root";
  const zone = normalizeDomain(zoneName);

  const sharedIpMap = new Map<string, Set<string>>();
  const detectedServices = new Map<string, string>();
  const cnameChains = computeCnameChains(records, maxResolutionHops);
  const cnameMap = buildCnameMap(records);
  const { ipv4ByName, ipv6ByName } = buildAddressMaps(records);
  const ipGeoByIp = new Map<
    string,
    { country: string; countryCode?: string }
  >();
  for (const resolution of Object.values(externalResolutionByName)) {
    for (const [ip, geo] of Object.entries(resolution.geoByIp ?? {})) {
      if (!geo?.country) continue;
      if (!ipGeoByIp.has(ip)) {
        ipGeoByIp.set(ip, geo);
      }
    }
  }
  const ipSubtitle = (ip: string) => {
    const geo = ipGeoByIp.get(ip);
    if (!geo?.country) return "IP";
    const code = geo.countryCode ? `${geo.countryCode.toUpperCase()} - ` : "";
    return `IP | GEO: ${code}${geo.country}`;
  };
  const nodeRecords = new Map<string, DNSRecord[]>();
  const edgeSet = new Set<string>();
  for (const record of records) {
    const nameRaw = normalizeDomain(record.name) || "@";
    const labelName = nameRaw === "@" ? zone : nameRaw;
    if (!nodeRecords.has(labelName)) nodeRecords.set(labelName, []);
    nodeRecords.get(labelName)!.push(record);
  }

  const emailPathNames = new Set<string>();
  const mxTrails: TopologySummary["mxTrails"] = [];
  for (const r of records) {
    if (r.type !== "MX") continue;
    const fromName = normalizeDomain(r.name) || zone;
    const rawParts = String(r.content ?? "")
      .trim()
      .split(/\s+/);
    const maybePriority = Number(rawParts[0]);
    const priority = Number.isFinite(maybePriority) ? maybePriority : null;
    const mxTarget = extractTarget(r);
    if (!mxTarget) continue;
    const localResolved = resolveNameToTerminal(
      mxTarget,
      cnameMap,
      ipv4ByName,
      ipv6ByName,
      maxResolutionHops,
    );
    const resolved = pickBestResolution(
      mxTarget,
      localResolved,
      externalResolutionByName,
    );
    mxTrails.push({
      from: fromName,
      priority,
      target: mxTarget,
      chain: resolved.chain,
      terminal: resolved.terminal,
      ipv4: resolved.ipv4,
      ipv6: resolved.ipv6,
    });
    for (const n of resolved.chain) emailPathNames.add(n);
    if (resolved.terminal) emailPathNames.add(resolved.terminal);
  }

  const idFor = (key: string) => {
    if (nodeIds.has(key)) return nodeIds.get(key)!;
    const id = `n_${nextId++}`;
    nodeIds.set(key, id);
    return id;
  };
  const setNodeMeta = (
    nodeId: string,
    text: string,
    recordId?: string,
    address?: string,
  ) => {
    nodeMetaById[nodeId] = {
      text,
      ...(recordId ? { recordId } : {}),
      ...(address ? { address } : {}),
    };
  };
  lines.push("flowchart LR");
  const zoneTitle = `Zone: ${zone || zoneName}`;
  lines.push(`  ${zoneNode}["${esc(buildNodeLabel(zoneTitle))}"]:::zone`);
  setNodeMeta(zoneNode, zoneTitle);

  const usedNames = new Set<string>();
  const areaCounts = { email: 0, web: 0, infra: 0, misc: 0 };
  type GraphUnit = {
    key: string;
    type: DNSRecord["type"];
    name: string;
    records: DNSRecord[];
    aggregate: boolean;
  };
  const units: GraphUnit[] = [];
  const aggAaaaMap = new Map<string, DNSRecord[]>();
  for (const record of records) {
    const nameRaw = normalizeDomain(record.name) || "@";
    const labelName = nameRaw === "@" ? zone : nameRaw;
    if (record.type === "A" || record.type === "AAAA") {
      const k = `${record.type}:${labelName}`;
      if (!aggAaaaMap.has(k)) aggAaaaMap.set(k, []);
      aggAaaaMap.get(k)!.push(record);
    } else {
      units.push({
        key: `record:${record.id}`,
        type: record.type,
        name: labelName,
        records: [record],
        aggregate: false,
      });
    }
  }
  for (const [k, recs] of aggAaaaMap.entries()) {
    units.push({
      key: `agg:${k}`,
      type: recs[0].type,
      name: normalizeDomain(recs[0].name) || zone,
      records: recs,
      aggregate: true,
    });
  }

  for (const unit of units) {
    const nodeRecs = nodeRecords.get(unit.name) ?? unit.records;
    const areas = classifyAreas(unit.name, nodeRecs, emailPathNames);
    for (const area of areas) areaCounts[area] += 1;

    const recordId = idFor(unit.key);
    const localResolved = resolveNameToTerminal(
      unit.name,
      cnameMap,
      ipv4ByName,
      ipv6ByName,
      maxResolutionHops,
    );
    const resolved = pickBestResolution(
      unit.name,
      localResolved,
      externalResolutionByName,
    );
    const endpointInfo =
      resolved.ipv4.length || resolved.ipv6.length
        ? `A:${resolved.ipv4.length || 0} AAAA:${resolved.ipv6.length || 0}`
        : "";
    const ttlValues = Array.from(
      new Set(unit.records.map((r) => String(r.ttl ?? "auto"))),
    );
    const proxyValues = Array.from(
      new Set(unit.records.map((r) => (r.proxied ? "proxied" : "dns-only"))),
    );
    const info = [
      `type:${unit.type}${unit.aggregate ? ` x${unit.records.length}` : ""}`,
      unit.type === "MX"
        ? (() => {
            const parts = String(unit.records[0]?.content ?? "")
              .trim()
              .split(/\s+/);
            const parsedPriority = Number(parts[0]);
            return Number.isFinite(parsedPriority)
              ? `prio:${parsedPriority}`
              : "";
          })()
        : "",
      `ttl:${ttlValues.length === 1 ? ttlValues[0] : "mixed"}`,
      proxyValues.length === 1 ? proxyValues[0] : "proxy:mixed",
      resolved.chain.length > 1 ? `resolves:${resolved.terminal}` : "",
      endpointInfo,
    ]
      .filter(Boolean)
      .join(" | ");
    const editableRecordId =
      unit.records.length === 1 && unit.records[0]?.id
        ? String(unit.records[0].id)
        : undefined;
    lines.push(
      `  ${recordId}["${esc(buildNodeLabel(unit.name, info || "record"))}"]:::record`,
    );
    setNodeMeta(
      recordId,
      info ? `${unit.name} | ${info.replace(/<br\s*\/?>/gi, " ")}` : unit.name,
      editableRecordId,
      unit.name,
    );
    lines.push(`  ${zoneNode} --> ${recordId}`);

    const targetEntries =
      unit.type === "MX"
        ? unit.records
            .map((record) => {
              const target = extractTarget(record);
              if (!target) return null;
              const parts = String(record.content ?? "")
                .trim()
                .split(/\s+/);
              const parsedPriority = Number(parts[0]);
              return {
                recordId: record.id,
                target,
                priority: Number.isFinite(parsedPriority)
                  ? parsedPriority
                  : null,
              };
            })
            .filter(
              (
                entry,
              ): entry is {
                recordId: string;
                target: string;
                priority: number | null;
              } => Boolean(entry),
            )
        : Array.from(
            new Set(
              unit.records
                .map((r) => extractTarget(r))
                .filter((v): v is string => Boolean(v)),
            ),
          ).map((target) => ({
            recordId: "",
            target,
            priority: null as number | null,
          }));

    for (const entry of targetEntries) {
      const target = entry.target;
      const isIp = unit.type === "A" || unit.type === "AAAA";
      const targetKey = `${isIp ? "ip" : "target"}:${target}`;
      const targetId = idFor(targetKey);
      const targetClass = isIp ? "ip" : "target";
      const mxPriorityNodeId =
        unit.type === "MX"
          ? idFor(
              `mxprio:${entry.recordId || unit.key}:${entry.priority ?? "na"}:${target}`,
            )
          : null;
      const edgeFromNodeId = mxPriorityNodeId ?? recordId;

      if (!usedNames.has(targetKey)) {
        lines.push(
          `  ${targetId}["${esc(buildNodeLabel(target, targetClass === "ip" ? ipSubtitle(target) : ""))}"]:::${targetClass}`,
        );
        setNodeMeta(
          targetId,
          targetClass === "ip" ? `${target} | ${ipSubtitle(target)}` : target,
          undefined,
          target,
        );
        usedNames.add(targetKey);
      }

      if (mxPriorityNodeId) {
        const mxPriorityLabel = `MX Priority ${entry.priority ?? "?"}`;
        lines.push(
          `  ${mxPriorityNodeId}["${esc(buildNodeLabel(mxPriorityLabel))}"]:::target`,
        );
        setNodeMeta(mxPriorityNodeId, mxPriorityLabel, undefined);
        const mxEdge = `${recordId}|MX|${mxPriorityNodeId}`;
        if (!edgeSet.has(mxEdge)) {
          lines.push(`  ${recordId} -- "MX" --> ${mxPriorityNodeId}`);
          edgeSet.add(mxEdge);
        }
        const targetEdge = `${mxPriorityNodeId}|P${entry.priority ?? "?"}|${targetId}`;
        if (!edgeSet.has(targetEdge)) {
          lines.push(
            `  ${mxPriorityNodeId} -- "prio ${entry.priority ?? "?"}" --> ${targetId}`,
          );
          edgeSet.add(targetEdge);
        }
      } else {
        lines.push(`  ${recordId} -- "${esc(unit.type)}" --> ${targetId}`);
        edgeSet.add(`${recordId}|${unit.type}|${targetId}`);
      }

      // Trace hostname -> CNAME chain -> terminal A/AAAA path for non-IP targets.
      if (!isIp) {
        const localResolvedTarget = resolveNameToTerminal(
          target,
          cnameMap,
          ipv4ByName,
          ipv6ByName,
          maxResolutionHops,
        );
        const resolvedTarget = pickBestResolution(
          target,
          localResolvedTarget,
          externalResolutionByName,
        );
        for (let i = 0; i < resolvedTarget.chain.length - 1; i += 1) {
          const from = resolvedTarget.chain[i];
          const to = resolvedTarget.chain[i + 1];
          const fromId = idFor(`target:${from}`);
          const toId = idFor(`target:${to}`);
          if (!usedNames.has(`target:${from}`)) {
            lines.push(`  ${fromId}["${esc(buildNodeLabel(from))}"]:::target`);
            setNodeMeta(fromId, from, undefined, from);
            usedNames.add(`target:${from}`);
          }
          if (!usedNames.has(`target:${to}`)) {
            lines.push(`  ${toId}["${esc(buildNodeLabel(to))}"]:::target`);
            setNodeMeta(toId, to, undefined, to);
            usedNames.add(`target:${to}`);
          }
          const k = `${fromId}|CNAME|${toId}`;
          if (!edgeSet.has(k)) {
            lines.push(`  ${fromId} -. "CNAME" .-> ${toId}`);
            edgeSet.add(k);
          }
        }
        for (const ip of resolvedTarget.ipv4) {
          const ipId = idFor(`ip:${ip}`);
          if (!usedNames.has(`ip:${ip}`)) {
            lines.push(
              `  ${ipId}["${esc(buildNodeLabel(ip, ipSubtitle(ip)))}"]:::ip`,
            );
            setNodeMeta(ipId, `${ip} | ${ipSubtitle(ip)}`, undefined, ip);
            usedNames.add(`ip:${ip}`);
          }
          const termId = idFor(`target:${resolvedTarget.terminal || target}`);
          const k = `${edgeFromNodeId}|A|${termId}|${ipId}`;
          if (!edgeSet.has(k)) {
            lines.push(`  ${termId} -. "A" .-> ${ipId}`);
            edgeSet.add(k);
          }
        }
        for (const ip of resolvedTarget.ipv6) {
          const ipId = idFor(`ip:${ip}`);
          if (!usedNames.has(`ip:${ip}`)) {
            lines.push(
              `  ${ipId}["${esc(buildNodeLabel(ip, ipSubtitle(ip)))}"]:::ip`,
            );
            setNodeMeta(ipId, `${ip} | ${ipSubtitle(ip)}`, undefined, ip);
            usedNames.add(`ip:${ip}`);
          }
          const termId = idFor(`target:${resolvedTarget.terminal || target}`);
          const k = `${edgeFromNodeId}|AAAA|${termId}|${ipId}`;
          if (!edgeSet.has(k)) {
            lines.push(`  ${termId} -. "AAAA" .-> ${ipId}`);
            edgeSet.add(k);
          }
        }
        if (resolvedTarget.reverseHostnamesByIp) {
          for (const [ip, ptrNames] of Object.entries(
            resolvedTarget.reverseHostnamesByIp,
          )) {
            if (!ptrNames?.length) continue;
            const ipId = idFor(`ip:${ip}`);
            if (!usedNames.has(`ip:${ip}`)) {
              lines.push(
                `  ${ipId}["${esc(buildNodeLabel(ip, ipSubtitle(ip)))}"]:::ip`,
              );
              setNodeMeta(ipId, `${ip} | ${ipSubtitle(ip)}`, undefined, ip);
              usedNames.add(`ip:${ip}`);
            }
            for (const ptrName of ptrNames) {
              const ptrKey = `target:${normalizeDomain(ptrName)}`;
              const ptrId = idFor(ptrKey);
              if (!usedNames.has(ptrKey)) {
                lines.push(
                  `  ${ptrId}["${esc(buildNodeLabel(normalizeDomain(ptrName)))}"]:::target`,
                );
                setNodeMeta(
                  ptrId,
                  normalizeDomain(ptrName),
                  undefined,
                  normalizeDomain(ptrName),
                );
                usedNames.add(ptrKey);
              }
              const ptrEdge = `${ipId}|PTR|${ptrId}`;
              if (!edgeSet.has(ptrEdge)) {
                lines.push(`  ${ipId} -. "PTR" .-> ${ptrId}`);
                edgeSet.add(ptrEdge);
              }
            }
          }
        }
      }

      if (isIp) {
        if (!sharedIpMap.has(target)) sharedIpMap.set(target, new Set());
        sharedIpMap.get(target)!.add(unit.name);
      } else {
        for (const fp of SERVICE_PATTERNS) {
          if (fp.pattern.test(target)) {
            detectedServices.set(`${fp.service}:${target}`, fp.service);
          }
        }
      }
    }
  }

  const sharedIps = Array.from(sharedIpMap.entries())
    .filter(([, names]) => names.size > 1)
    .map(([ip, names]) => ({ ip, names: Array.from(names).sort() }));

  let svcIdx = 0;
  for (const [serviceTarget, serviceName] of detectedServices.entries()) {
    const [, target] = serviceTarget.split(":", 2);
    const targetKey = `target:${target}`;
    const targetId = nodeIds.get(targetKey);
    if (!targetId) continue;
    const serviceId = `svc_${svcIdx++}`;
    lines.push(
      `  ${serviceId}["${esc(buildNodeLabel(serviceName))}"]:::service`,
    );
    setNodeMeta(serviceId, serviceName, undefined);
    lines.push(`  ${targetId} -.-> ${serviceId}`);
  }

  const zoneText = isDarkTheme ? "#dce6ff" : "#1f2a44";
  const recordText = isDarkTheme ? "#ddfff2" : "#143727";
  const targetText = isDarkTheme ? "#fff5db" : "#4a3600";
  const ipText = isDarkTheme ? "#ffe3e3" : "#5d1b1b";
  const serviceText = isDarkTheme ? "#efe8ff" : "#2f1f5d";
  lines.push(
    `  classDef zone fill:#5b8cff22,stroke:#5b8cff,stroke-width:1.5px,color:${zoneText};`,
  );
  lines.push(
    `  classDef record fill:#20c99722,stroke:#20c997,stroke-width:1.2px,color:${recordText};`,
  );
  lines.push(
    `  classDef target fill:#f59f0022,stroke:#f59f00,stroke-width:1.2px,color:${targetText};`,
  );
  lines.push(
    `  classDef ip fill:#fa525222,stroke:#fa5252,stroke-width:1.2px,color:${ipText};`,
  );
  lines.push(
    `  classDef service fill:#845ef722,stroke:#845ef7,stroke-width:1.2px,color:${serviceText};`,
  );

  return {
    code: lines.join("\n"),
    nodeMetaById,
    summary: {
      cnameChains,
      sharedIps,
      detectedServices: Array.from(detectedServices.keys()).map((key) => {
        const [name, via] = key.split(":", 2);
        return { name, via };
      }),
      mxTrails,
      areas: areaCounts,
      nodeSummaries: Array.from(nodeRecords.entries())
        .map(([name, nodeRecs]) => ({
          ...(() => {
            const resolved = resolveNameToTerminal(
              name,
              cnameMap,
              ipv4ByName,
              ipv6ByName,
              maxResolutionHops,
            );
            const bestResolved = pickBestResolution(
              name,
              resolved,
              externalResolutionByName,
            );
            return {
              name,
              records: nodeRecs,
              resolvedTo: bestResolved.chain.slice(1),
              areas: classifyAreas(name, nodeRecs, emailPathNames),
              terminal: bestResolved.terminal,
              ipv4: bestResolved.ipv4,
              ipv6: bestResolved.ipv6,
            };
          })(),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    },
  };
}

async function probeHttp(
  url: string,
  timeoutMs = 5000,
  signal?: AbortSignal,
): Promise<"up" | "down"> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  signal?.addEventListener("abort", abortFromParent, { once: true });
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    throwIfTopologyAborted(signal);
    await fetch(url, {
      method: "GET",
      mode: "no-cors",
      cache: "no-store",
      signal: controller.signal,
    });
    return "up";
  } catch {
    throwIfTopologyAborted(signal);
    return "down";
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

function resolveDohEndpoints(
  resolverMode: "dns" | "doh",
  dnsServer: string,
  customDnsServer: string,
  customUrl: string,
): string[] {
  if (resolverMode !== "doh") return [];
  const selectedDns =
    dnsServer === "custom"
      ? customDnsServer.trim() || "1.1.1.1"
      : dnsServer.trim() || "1.1.1.1";
  const preferred =
    customUrl.trim() ||
    (selectedDns === "1.1.1.1" || selectedDns === "1.0.0.1"
      ? "https://cloudflare-dns.com/dns-query"
      : selectedDns === "8.8.8.8" || selectedDns === "8.8.4.4"
        ? "https://dns.google/resolve"
        : selectedDns === "9.9.9.9" || selectedDns === "149.112.112.112"
          ? "https://dns.quad9.net:5053/dns-query"
          : "https://cloudflare-dns.com/dns-query");
  return Array.from(
    new Set([
      preferred,
      "https://cloudflare-dns.com/dns-query",
      "https://dns.google/resolve",
      "https://dns.quad9.net:5053/dns-query",
    ]),
  );
}

async function queryDoh(
  endpoints: string[],
  name: string,
  type: "CNAME" | "A" | "AAAA",
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string[]> {
  for (const endpoint of endpoints) {
    throwIfTopologyAborted(signal);
    const controller = new AbortController();
    const abortFromParent = () => controller.abort();
    signal?.addEventListener("abort", abortFromParent, { once: true });
    const timer = window.setTimeout(
      () => controller.abort(),
      Math.max(250, timeoutMs),
    );
    try {
      const url = `${endpoint}${endpoint.includes("?") ? "&" : "?"}name=${encodeURIComponent(name)}&type=${type}`;
      const res = await fetch(url, {
        cache: "no-store",
        headers: { accept: "application/dns-json" },
        signal: controller.signal,
      });
      if (!res.ok) continue;
      const data = (await res.json()) as {
        Answer?: Array<{ data?: string; type?: number }>;
      };
      const out = (data.Answer ?? [])
        .map((x) => String(x.data ?? "").trim())
        .filter(Boolean);
      const normalized = Array.from(
        new Set(out.map((x) => normalizeDomain(x))),
      );
      if (normalized.length > 0) return normalized;
    } catch {
      throwIfTopologyAborted(signal);
      continue;
    } finally {
      window.clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromParent);
    }
  }
  return [];
}

async function resolveExternalCnameToAddress(
  startName: string,
  maxHops: number,
  dohEndpoints: string[],
  timeoutMs: number,
  scanResolutionChain: boolean,
  signal?: AbortSignal,
): Promise<ExternalDnsResolution> {
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur = normalizeDomain(startName);
  if (!cur) {
    return {
      chain,
      terminal: "",
      ipv4: [],
      ipv6: [],
      source: "external",
      error: "empty name",
    };
  }
  chain.push(cur);
  seen.add(cur);
  let hops = 0;
  try {
    if (scanResolutionChain) {
      while (hops < maxHops) {
        const cnames = await queryDoh(
          dohEndpoints,
          cur,
          "CNAME",
          timeoutMs,
          signal,
        );
        const next = cnames.find(Boolean);
        if (!next || seen.has(next)) break;
        chain.push(next);
        seen.add(next);
        cur = next;
        hops += 1;
      }
    }
    const [a, aaaa] = await Promise.all([
      queryDoh(dohEndpoints, cur, "A", timeoutMs, signal),
      queryDoh(dohEndpoints, cur, "AAAA", timeoutMs, signal),
    ]);
    return boundExternalResolution({
      chain,
      terminal: cur,
      ipv4: a,
      ipv6: aaaa,
      source: "external",
    });
  } catch (error) {
    throwIfTopologyAborted(signal);
    return {
      chain,
      terminal: cur,
      ipv4: [],
      ipv6: [],
      source: "external",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function resolveTopologyBatchInBackend(
  hostnames: string[],
  maxHops: number,
  resolverMode: "dns" | "doh",
  dnsServer: string,
  customDnsServer: string,
  dohProvider: "google" | "cloudflare" | "quad9" | "custom",
  dohCustomUrl: string,
  lookupTimeoutMs: number,
  disablePtrLookups: boolean,
  tcpServicePorts: number[],
  disableGeoLookups: boolean,
  geoProvider: "auto" | "ipwhois" | "ipapi_co" | "ip_api" | "internal",
  scanResolutionChain: boolean,
  serviceHosts: string[] = [],
): Promise<{
  resolutions: ExternalDnsResolution[];
  probes: Array<{ host: string; httpsUp: boolean; httpUp: boolean }>;
  tcpProbes: Array<{ host: string; port: number; up: boolean }>;
} | null> {
  if (!TauriClient.isTauri()) return null;
  try {
    const result = await TauriClient.resolveTopologyBatch(
      hostnames,
      maxHops,
      serviceHosts,
      dohProvider,
      dohCustomUrl,
      resolverMode,
      dnsServer,
      customDnsServer,
      lookupTimeoutMs,
      disablePtrLookups,
      tcpServicePorts,
      disableGeoLookups,
      geoProvider,
      scanResolutionChain,
    );
    return {
      resolutions: (result.resolutions ?? [])
        .slice(0, TOPOLOGY_RESOLUTION_TARGET_LIMIT)
        .map((item) =>
          boundExternalResolution({
            requestedName: normalizeDomain(item.name ?? ""),
            chain: item.chain ?? [],
            terminal: item.terminal ?? "",
            ipv4: item.ipv4 ?? [],
            ipv6: item.ipv6 ?? [],
            reverseHostnamesByIp: Object.fromEntries(
              (item.reverse_hostnames ?? []).map((entry) => [
                String(entry.ip ?? ""),
                Array.from(
                  new Set(
                    (entry.hostnames ?? [])
                      .map((value) => normalizeDomain(value))
                      .filter(Boolean),
                  ),
                ),
              ]),
            ),
            geoByIp: Object.fromEntries(
              (item.geo_by_ip ?? [])
                .map((entry) => {
                  const ip = String(entry.ip ?? "").trim();
                  const country = String(entry.country ?? "").trim();
                  const countryCode = String(entry.country_code ?? "").trim();
                  if (!ip || !country) return null;
                  return [
                    ip,
                    { country, ...(countryCode ? { countryCode } : {}) },
                  ] as const;
                })
                .filter(
                  (
                    entry,
                  ): entry is readonly [
                    string,
                    { country: string; countryCode?: string },
                  ] => Boolean(entry),
                ),
            ),
            source: "external" as const,
            error: item.error ?? undefined,
          }),
        ),
      probes: (result.probes ?? [])
        .slice(0, TOPOLOGY_RESOLUTION_TARGET_LIMIT)
        .map((item) => ({
          host: item.host,
          httpsUp: Boolean(item.https_up),
          httpUp: Boolean(item.http_up),
        })),
      tcpProbes: (result.tcp_probes ?? [])
        .slice(0, TOPOLOGY_RESOLUTION_TARGET_LIMIT)
        .map((item) => ({
          host: item.host,
          port: Number(item.port),
          up: Boolean(item.up),
        })),
    };
  } catch {
    return null;
  }
}

export function ZoneTopologyTab({
  zoneName,
  records,
  isLoading = false,
  maxResolutionHops = 15,
  resolverMode = "dns",
  dnsServer = "1.1.1.1",
  customDnsServer = "",
  dohProvider = "cloudflare",
  dohCustomUrl = "",
  exportConfirmPath = true,
  exportFolderPreset = "documents",
  exportCustomPath = "",
  copyActions = ["mermaid", "svg", "png"],
  exportActions = ["mermaid", "svg", "png", "pdf"],
  disableAnnotations = false,
  disableFullWindow = false,
  lookupTimeoutMs = 1200,
  disablePtrLookups = false,
  disableGeoLookups = false,
  geoProvider = "auto",
  scanResolutionChain = true,
  disableServiceDiscovery = false,
  tcpServicePorts = DEFAULT_TOPOLOGY_TCP_SERVICE_PORTS,
  onRefresh,
  onEditRecord,
  modelYieldControl,
}: ZoneTopologyTabProps) {
  const { toast } = useToast();
  const desktop = isDesktop();
  const [svgMarkup, setSvgMarkup] = useState("");
  const [mermaidCode, setMermaidCode] = useState("");
  const [isRendering, setIsRendering] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [handTool, setHandTool] = useState(true);
  const [annotationTool, setAnnotationTool] = useState(false);
  const [annotationDraft, setAnnotationDraft] = useState("Note");
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [annotationDiagnostic, setAnnotationDiagnostic] = useState<
    string | null
  >(null);
  const [themeVersion, setThemeVersion] = useState(0);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const dragRef = useRef<{
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
  } | null>(null);
  const middleDragRestoreHandRef = useRef<boolean | null>(null);
  const userAdjustedViewRef = useRef(false);
  const autoFitDoneRef = useRef<string>("");
  const [graphSize, setGraphSize] = useState({ w: 1000, h: 600 });
  const [viewportSize, setViewportSize] = useState({ w: 0, h: 0 });
  const [discovering, setDiscovering] = useState(false);
  const [discoveryProgress, setDiscoveryProgress] = useState<DiscoveryProgress>(
    {
      label: "",
      done: 0,
      total: 0,
      requests: [],
    },
  );
  const [discovery, setDiscovery] = useState<ServiceDiscoveryItem[]>([]);
  const [nodeContextMenu, setNodeContextMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    text: string;
    recordId?: string;
    address?: string;
  }>({ open: false, x: 0, y: 0, text: "" });
  const [nodeMetaById, setNodeMetaById] = useState<
    Record<string, { text: string; recordId?: string; address?: string }>
  >({});
  const nodeContextMenuRef = useRef<HTMLDivElement | null>(null);
  const [expandGraph, setExpandGraph] = useState(false);
  const [externalResolutionByName, setExternalResolutionByName] = useState<
    Record<string, ExternalDnsResolution>
  >({});
  const [topologyResolutionReady, setTopologyResolutionReady] = useState(false);
  const [topologyResolutionProgress, setTopologyResolutionProgress] =
    useState<TopologyResolutionProgress>({
      running: false,
      total: 0,
      done: 0,
    });
  const [manualRefreshTick, setManualRefreshTick] = useState(0);
  const [activeResolutionRequests, setActiveResolutionRequests] = useState<
    string[]
  >([]);
  const resolutionCacheRef = useRef<Map<string, TopologyResolutionCacheEntry>>(
    new Map(),
  );
  const probeCacheRef = useRef<Map<string, TopologyProbeCacheEntry>>(new Map());
  const discoveryRunRef = useRef(0);
  const discoveryAbortRef = useRef<AbortController | null>(null);
  const lastResolutionRunKeyRef = useRef<string>("");
  const [isDarkThemeMode, setIsDarkThemeMode] = useState(() =>
    detectDarkThemeMode(),
  );
  const [summary, setSummary] = useState<TopologySummary>({
    cnameChains: [],
    sharedIps: [],
    detectedServices: [],
    mxTrails: [],
    areas: { email: 0, web: 0, infra: 0, misc: 0 },
    nodeSummaries: [],
  });
  const [modelSearch, setModelSearch] = useState("");
  const [modelRecordType, setModelRecordType] = useState("");
  const [modelResultPage, setModelResultPage] = useState(1);
  const [modelWindowStart, setModelWindowStart] = useState(0);
  const [selectedModelNodeId, setSelectedModelNodeId] = useState<string | null>(
    null,
  );
  const [topologyModel, setTopologyModel] = useState<TopologyGraphModel>({
    status: "ready",
    sourceRecords: EMPTY_TOPOLOGY_RECORDS,
    nodes: [],
    edges: [],
  });
  const [modelBuildProgress, setModelBuildProgress] = useState({
    running: false,
    completed: 0,
    total: 0,
  });
  const modelBuildRunRef = useRef(0);
  const modelFocusCancelRef = useRef<(() => void) | null>(null);
  const enabledCopyActions = useMemo(
    () =>
      new Set(
        (copyActions ?? []).filter(
          (v): v is "mermaid" | "svg" | "png" =>
            v === "mermaid" || v === "svg" || v === "png",
        ),
      ),
    [copyActions],
  );
  const enabledExportActions = useMemo(
    () =>
      new Set(
        (exportActions ?? []).filter(
          (v): v is "mermaid" | "svg" | "png" | "pdf" =>
            v === "mermaid" || v === "svg" || v === "png" || v === "pdf",
        ),
      ),
    [exportActions],
  );
  const dohEndpoints = useMemo(
    () =>
      resolveDohEndpoints(
        resolverMode,
        dnsServer,
        customDnsServer,
        dohCustomUrl,
      ),
    [customDnsServer, dnsServer, dohCustomUrl, resolverMode],
  );
  const topologyMaxResolutionHops = Math.max(
    1,
    Math.min(TOPOLOGY_RESOLUTION_CHAIN_LIMIT, Math.round(maxResolutionHops)),
  );
  const topologyRecordTypes = useMemo(() => {
    const types = new Set<string>();
    for (const record of records) {
      types.add(String(record.type ?? "UNKNOWN").toUpperCase());
    }
    return Array.from(types).sort((a, b) => a.localeCompare(b));
  }, [records]);
  const modelSourceRecords = useMemo(
    () =>
      records.length > TOPOLOGY_MODEL_NODE_LIMIT
        ? filterTopologySourceRecords(records, modelSearch, modelRecordType)
        : records,
    [modelRecordType, modelSearch, records],
  );
  const graphSourceRecords =
    topologyModel.status === "ready"
      ? topologyModel.sourceRecords
      : EMPTY_TOPOLOGY_RECORDS;
  const topologyRecords: DNSRecord[] =
    topologyModel.status === "ready" &&
    topologyModel.nodes.length <= TOPOLOGY_LEGACY_MERMAID_RECORD_LIMIT
      ? (topologyModel.sourceRecords as DNSRecord[])
      : EMPTY_TOPOLOGY_RECORDS;
  const matchingModelNodes = useMemo(
    () =>
      topologyModel.status === "ready"
        ? filterTopologyModelNodes(
            topologyModel.nodes,
            modelSearch,
            modelRecordType,
          )
        : [],
    [modelRecordType, modelSearch, topologyModel],
  );
  const modelResultPageCount = Math.max(
    1,
    Math.ceil(matchingModelNodes.length / TOPOLOGY_RESULT_PAGE_SIZE),
  );
  const currentModelResultPage = Math.min(
    modelResultPage,
    modelResultPageCount,
  );
  const visibleModelResults = useMemo(() => {
    const start = (currentModelResultPage - 1) * TOPOLOGY_RESULT_PAGE_SIZE;
    return matchingModelNodes.slice(start, start + TOPOLOGY_RESULT_PAGE_SIZE);
  }, [currentModelResultPage, matchingModelNodes]);
  const visibleGraphNodes = useMemo(() => {
    if (topologyModel.status !== "ready") return [];
    const maxStart = Math.max(
      0,
      topologyModel.nodes.length - TOPOLOGY_GRAPH_DOM_NODE_LIMIT,
    );
    const start = Math.min(modelWindowStart, maxStart);
    return topologyModel.nodes.slice(
      start,
      start + TOPOLOGY_GRAPH_DOM_NODE_LIMIT,
    );
  }, [modelWindowStart, topologyModel]);
  const visibleGraphEdges = useMemo(() => {
    if (topologyModel.status !== "ready" || visibleGraphNodes.length === 0)
      return [];
    const positionById = new Map<string, number>();
    visibleGraphNodes.forEach((node, index) => {
      positionById.set(node.id, index);
    });
    const edges: Array<{
      id: string;
      sourceIndex: number;
      targetIndex: number;
    }> = [];
    for (const edge of topologyModel.edges) {
      const sourceIndex = positionById.get(edge.source);
      const targetIndex = positionById.get(edge.target);
      if (sourceIndex === undefined || targetIndex === undefined) continue;
      edges.push({ id: edge.id, sourceIndex, targetIndex });
      if (edges.length >= TOPOLOGY_GRAPH_DOM_EDGE_LIMIT) break;
    }
    return edges;
  }, [topologyModel, visibleGraphNodes]);
  const visibleNodeSummaries = useMemo(
    () =>
      summary.nodeSummaries.length > TOPOLOGY_SUMMARY_RENDER_LIMIT
        ? summary.nodeSummaries.slice(0, TOPOLOGY_SUMMARY_RENDER_LIMIT)
        : summary.nodeSummaries,
    [summary.nodeSummaries],
  );
  const visibleDiscovery = useMemo(
    () =>
      discovery.length > TOPOLOGY_SUMMARY_RENDER_LIMIT
        ? discovery.slice(0, TOPOLOGY_SUMMARY_RENDER_LIMIT)
        : discovery,
    [discovery],
  );
  const recordsFingerprint = useMemo(() => {
    const parts: string[] = [];
    for (const record of topologyRecords) {
      parts.push(
        `${record.id ?? ""}|${record.type}|${normalizeDomain(record.name)}|${normalizeDomain(String(record.content ?? ""))}|${record.modified_on ?? ""}`,
      );
    }
    return `${parts.sort().join("||")}|source:${records.length}|model:${topologyModel.status}:${graphSourceRecords.length}`;
  }, [
    graphSourceRecords.length,
    records.length,
    topologyModel.status,
    topologyRecords,
  ]);
  const closeExpandGraph = useCallback(() => {
    setExpandGraph(false);
    autoFitDoneRef.current = "";
    userAdjustedViewRef.current = false;
  }, []);

  const closeNodeContextMenu = useCallback(() => {
    setNodeContextMenu((prev) => ({ ...prev, open: false }));
  }, []);
  const toggleExpandGraph = useCallback(() => {
    if (disableFullWindow) return;
    setExpandGraph((prev) => !prev);
    autoFitDoneRef.current = "";
    userAdjustedViewRef.current = false;
  }, [disableFullWindow]);

  useEffect(() => {
    const controller = new AbortController();
    const runId = ++modelBuildRunRef.current;
    let lastReportedProgress = 0;
    const isCurrentRun = () =>
      modelBuildRunRef.current === runId && !controller.signal.aborted;

    setTopologyModel({
      status: "ready",
      sourceRecords: EMPTY_TOPOLOGY_RECORDS,
      nodes: [],
      edges: [],
    });
    setModelBuildProgress({
      running: modelSourceRecords.length <= TOPOLOGY_MODEL_NODE_LIMIT,
      completed: 0,
      total: modelSourceRecords.length,
    });

    void buildTopologyGraphModelProgressively(modelSourceRecords, {
      signal: controller.signal,
      yieldControl: modelYieldControl,
      onProgress: (completed, total) => {
        if (!isCurrentRun()) return;
        if (
          completed < total &&
          completed - lastReportedProgress < TOPOLOGY_MODEL_CHUNK_SIZE * 4
        ) {
          return;
        }
        lastReportedProgress = completed;
        setModelBuildProgress({ running: true, completed, total });
      },
    })
      .then((model) => {
        if (!isCurrentRun()) return;
        setTopologyModel(model);
        setModelBuildProgress({
          running: false,
          completed: model.status === "ready" ? model.nodes.length : 0,
          total: model.sourceRecords.length,
        });
        setModelWindowStart(0);
        setSelectedModelNodeId(null);
      })
      .catch((error) => {
        if (
          !isCurrentRun() ||
          (error as { name?: string })?.name === "AbortError"
        )
          return;
        reportTopologyFailure(error, "Build DNS topology graph model");
        setModelBuildProgress({
          running: false,
          completed: 0,
          total: modelSourceRecords.length,
        });
      });

    return () => {
      controller.abort();
    };
  }, [modelSourceRecords, modelYieldControl]);

  useEffect(() => {
    setModelResultPage(1);
  }, [modelRecordType, modelSearch, topologyModel]);

  const selectAndRevealModelNode = useCallback(
    (node: TopologyGraphNode) => {
      if (topologyModel.status !== "ready") return;
      setSelectedModelNodeId(node.id);
      const maxStart = Math.max(
        0,
        topologyModel.nodes.length - TOPOLOGY_GRAPH_DOM_NODE_LIMIT,
      );
      const centeredStart = Math.max(
        0,
        node.recordIndex - Math.floor(TOPOLOGY_GRAPH_DOM_NODE_LIMIT / 2),
      );
      setModelWindowStart(Math.min(centeredStart, maxStart));

      modelFocusCancelRef.current?.();
      const focusNode = () => {
        modelFocusCancelRef.current = null;
        const element = document.getElementById(
          `topology-model-node-${node.recordIndex}`,
        );
        if (!(element instanceof HTMLElement)) return;
        element.focus({ preventScroll: true });
        element.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      };
      if (typeof requestAnimationFrame === "function") {
        const frameId = requestAnimationFrame(focusNode);
        modelFocusCancelRef.current = () => cancelAnimationFrame(frameId);
      } else {
        const timerId = setTimeout(focusNode, 0);
        modelFocusCancelRef.current = () => clearTimeout(timerId);
      }
    },
    [topologyModel],
  );

  useEffect(
    () => () => {
      modelBuildRunRef.current += 1;
      modelFocusCancelRef.current?.();
      modelFocusCancelRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const resolutionCache = resolutionCacheRef.current;
    const probeCache = probeCacheRef.current;
    return () => {
      discoveryRunRef.current += 1;
      discoveryAbortRef.current?.abort();
      discoveryAbortRef.current = null;
      resolutionCache.clear();
      probeCache.clear();
    };
  }, []);

  useEffect(() => {
    if (disableFullWindow && expandGraph) {
      closeExpandGraph();
    }
  }, [closeExpandGraph, disableFullWindow, expandGraph]);

  useEffect(() => {
    if (disableAnnotations && annotationTool) {
      setAnnotationTool(false);
    }
  }, [annotationTool, disableAnnotations]);

  useEffect(() => {
    if (!nodeContextMenu.open) return;
    const close = () => closeNodeContextMenu();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && nodeContextMenuRef.current?.contains(target)) return;
      closeNodeContextMenu();
    };
    window.addEventListener("pointerdown", onPointerDown, { capture: true });
    window.addEventListener("scroll", close, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, {
        capture: true,
      });
      window.removeEventListener("scroll", close, { capture: true });
    };
  }, [closeNodeContextMenu, nodeContextMenu.open]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setThemeVersion((v) => v + 1);
      setIsDarkThemeMode(detectDarkThemeMode());
    });
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-theme", "class", "style"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setExternalResolutionByName({});
    setTopologyResolutionReady(false);
    setMermaidCode("");
    setSvgMarkup("");
    setNodeMetaById({});
    setActiveResolutionRequests([]);
  }, [
    resolverMode,
    dnsServer,
    customDnsServer,
    dohCustomUrl,
    dohProvider,
    manualRefreshTick,
    recordsFingerprint,
    zoneName,
    maxResolutionHops,
    lookupTimeoutMs,
    disablePtrLookups,
    disableGeoLookups,
    geoProvider,
    scanResolutionChain,
    tcpServicePorts,
  ]);

  useEffect(() => {
    if (!topologyResolutionReady) return;
    if (topologyRecords.length === 0) {
      setMermaidCode("");
      setSvgMarkup("");
      setNodeMetaById({});
      setSummary({
        cnameChains: [],
        sharedIps: [],
        detectedServices: [],
        mxTrails: [],
        areas: { email: 0, web: 0, infra: 0, misc: 0 },
        nodeSummaries: [],
      });
      return;
    }
    const {
      code,
      summary: nextSummary,
      nodeMetaById: nextNodeMetaById,
    } = buildTopology(
      topologyRecords,
      zoneName,
      topologyMaxResolutionHops,
      isDarkThemeMode,
      externalResolutionByName,
    );
    setMermaidCode(code);
    setSummary(nextSummary);
    setNodeMetaById(nextNodeMetaById);
  }, [
    externalResolutionByName,
    isDarkThemeMode,
    topologyMaxResolutionHops,
    topologyRecords,
    topologyResolutionReady,
    zoneName,
  ]);

  useEffect(() => {
    const candidates = new Set<string>();
    for (const record of topologyRecords) {
      const target = extractTarget(record);
      if (!target || isIpAddress(target)) continue;
      const hostname = normalizeDomain(target);
      if (hostname) candidates.add(hostname);
    }
    const controller = new AbortController();
    let cancelled = false;
    (async () => {
      const runKey = `${recordsFingerprint}|${zoneName}|${resolverMode}|${dnsServer}|${customDnsServer.trim()}|${dohProvider}|${dohCustomUrl.trim()}|${topologyMaxResolutionHops}|${disablePtrLookups ? "noptr" : "ptr"}|${disableGeoLookups ? "nogeo" : `geo:${geoProvider}`}|${scanResolutionChain ? "chain" : "nochain"}|${manualRefreshTick}`;
      if (
        topologyResolutionReady &&
        lastResolutionRunKeyRef.current === runKey
      ) {
        return;
      }
      lastResolutionRunKeyRef.current = runKey;
      const queue = Array.from(candidates)
        .sort((a, b) => a.localeCompare(b))
        .slice(0, TOPOLOGY_RESOLUTION_TARGET_LIMIT);
      const clampedHops = topologyMaxResolutionHops;
      let total = queue.length;
      let done = 0;
      const seenTopologyNodes = new Set(
        queue.map((name) => normalizeDomain(name)),
      );
      const updateProgress = () => {
        if (cancelled) return;
        setTopologyResolutionProgress({
          running: true,
          total: Math.max(0, total),
          done: Math.max(0, done),
        });
      };
      setTopologyResolutionProgress({ running: true, total, done });
      const now = Date.now();
      const cachePrefix = `${resolverMode}|${dnsServer}|${customDnsServer.trim()}|${dohProvider}|${dohCustomUrl.trim()}|${clampedHops}|${disablePtrLookups ? "noptr" : "ptr"}|${disableGeoLookups ? "nogeo" : `geo:${geoProvider}`}|${scanResolutionChain ? "chain" : "nochain"}|`;
      if (queue.length === 0) {
        if (!cancelled) {
          setExternalResolutionByName({});
          setTopologyResolutionReady(true);
          setTopologyResolutionProgress({ running: false, total: 0, done: 0 });
          setActiveResolutionRequests([]);
        }
        return;
      }

      const byName = new Map<string, ExternalDnsResolution>();
      const unresolvedQueue: string[] = [];
      const absorbResolved = (resolved: ExternalDnsResolution) => {
        for (const hop of resolved.chain) {
          const hk = normalizeDomain(hop);
          if (!hk) continue;
          if (!seenTopologyNodes.has(hk)) {
            seenTopologyNodes.add(hk);
            total += 1;
            done += 1;
          }
        }
      };
      for (const name of queue) {
        const key = normalizeDomain(name);
        const cacheKey = `${cachePrefix}${key}`;
        const cached = resolutionCacheRef.current.get(cacheKey);
        if (cached && now - cached.ts <= TOPOLOGY_CACHE_TTL_MS) {
          done += 1;
          byName.set(key, cached.value);
          absorbResolved(cached.value);
          const term = normalizeDomain(cached.value.terminal || "");
          if (term && !byName.has(term)) byName.set(term, cached.value);
          for (const hop of cached.value.chain) {
            const hk = normalizeDomain(hop);
            if (hk && !byName.has(hk)) byName.set(hk, cached.value);
          }
        } else {
          unresolvedQueue.push(name);
        }
      }
      updateProgress();
      if (unresolvedQueue.length > 0) {
        if (!cancelled) {
          setActiveResolutionRequests(unresolvedQueue.slice(0, 12));
        }
        const backendBatch = await resolveTopologyBatchInBackend(
          unresolvedQueue,
          clampedHops,
          resolverMode,
          dnsServer,
          customDnsServer,
          dohProvider,
          dohCustomUrl,
          lookupTimeoutMs,
          disablePtrLookups,
          tcpServicePorts,
          disableGeoLookups,
          geoProvider,
          scanResolutionChain,
        );
        if (cancelled || controller.signal.aborted) return;
        if (backendBatch) {
          for (const rawResolved of backendBatch.resolutions) {
            const resolved = boundExternalResolution(rawResolved);
            done += 1;
            const requested = normalizeDomain(resolved.requestedName || "");
            if (requested) {
              byName.set(requested, resolved);
              setBoundedCache(
                resolutionCacheRef.current,
                `${cachePrefix}${requested}`,
                {
                  value: resolved,
                  ts: Date.now(),
                },
              );
            }
            absorbResolved(resolved);
            const term = normalizeDomain(resolved.terminal || "");
            if (term && !byName.has(term)) byName.set(term, resolved);
            for (const hop of resolved.chain) {
              const hk = normalizeDomain(hop);
              if (hk && !byName.has(hk)) byName.set(hk, resolved);
            }
          }
        } else {
          const fallback = await mapWithConcurrency(
            unresolvedQueue,
            TOPOLOGY_LOOKUP_CONCURRENCY,
            async (name) => {
              const resolved = await resolveExternalCnameToAddress(
                name,
                clampedHops,
                dohEndpoints,
                lookupTimeoutMs,
                scanResolutionChain,
                controller.signal,
              );
              return [name, resolved] as const;
            },
            controller.signal,
          );
          for (const [name, resolved] of fallback) {
            done += 1;
            const requested = normalizeDomain(name);
            if (requested) {
              byName.set(requested, resolved);
              setBoundedCache(
                resolutionCacheRef.current,
                `${cachePrefix}${requested}`,
                {
                  value: resolved,
                  ts: Date.now(),
                },
              );
            }
            absorbResolved(resolved);
            const term = normalizeDomain(resolved.terminal || "");
            if (term && !byName.has(term)) byName.set(term, resolved);
            for (const hop of resolved.chain) {
              const hk = normalizeDomain(hop);
              if (hk && !byName.has(hk)) byName.set(hk, resolved);
            }
          }
        }
        if (!cancelled) {
          updateProgress();
        }
      }
      if (cancelled) return;
      const next: Record<string, ExternalDnsResolution> = {};
      for (const name of queue) {
        const key = normalizeDomain(name);
        next[key] =
          byName.get(key) ??
          ({
            requestedName: key,
            chain: [key],
            terminal: key,
            ipv4: [],
            ipv6: [],
            source: "external",
            error: "no CNAME/A/AAAA records found",
          } satisfies ExternalDnsResolution);
      }
      setExternalResolutionByName(next);
      setTopologyResolutionReady(true);
      setTopologyResolutionProgress({
        running: false,
        total,
        done: Math.max(done, total),
      });
      setActiveResolutionRequests([]);
    })().catch((error) => {
      if (cancelled) return;
      reportTopologyFailure(error, "Resolve DNS topology");
      setTopologyResolutionReady(true);
      setTopologyResolutionProgress({
        running: false,
        total: candidates.size,
        done: 0,
      });
      setActiveResolutionRequests([]);
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    resolverMode,
    dnsServer,
    customDnsServer,
    dohCustomUrl,
    dohProvider,
    topologyMaxResolutionHops,
    topologyRecords,
    dohEndpoints,
    manualRefreshTick,
    recordsFingerprint,
    zoneName,
    topologyResolutionReady,
    lookupTimeoutMs,
    disablePtrLookups,
    disableGeoLookups,
    geoProvider,
    scanResolutionChain,
    tcpServicePorts,
  ]);

  useEffect(() => {
    let cancelled = false;
    async function render() {
      setIsRendering(true);
      setRenderError(null);
      try {
        const mermaidModule = await import("mermaid");
        const mermaid = mermaidModule.default;
        const styles = getComputedStyle(document.documentElement);
        const hslVar = (name: string, fallback: string) => {
          const v = styles.getPropertyValue(name).trim();
          return v ? `hsl(${v})` : fallback;
        };
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: TOPOLOGY_MERMAID_SECURITY_LEVEL,
          theme: "base",
          themeVariables: {
            primaryColor: hslVar("--primary", "#5b8cff"),
            primaryTextColor: hslVar(
              "--foreground",
              isDarkThemeMode ? "#f2f5ff" : "#0f172a",
            ),
            primaryBorderColor: hslVar("--border", "#445"),
            lineColor: hslVar("--foreground", "#d7deff"),
            background: hslVar(
              "--card",
              isDarkThemeMode ? "#131824" : "#ffffff",
            ),
            tertiaryColor: hslVar(
              "--muted",
              isDarkThemeMode ? "#20263a" : "#e2e8f0",
            ),
            textColor: hslVar(
              "--foreground",
              isDarkThemeMode ? "#e6eeff" : "#0f172a",
            ),
            secondaryTextColor: hslVar(
              "--foreground",
              isDarkThemeMode ? "#d7deff" : "#1f2937",
            ),
            tertiaryTextColor: hslVar(
              "--foreground",
              isDarkThemeMode ? "#c7d2fe" : "#334155",
            ),
            edgeLabelBackground: hslVar(
              "--card",
              isDarkThemeMode ? "#1a2132" : "#ffffff",
            ),
            fontFamily: "ui-sans-serif, system-ui, sans-serif",
          },
          flowchart: {
            curve: "basis",
            htmlLabels: TOPOLOGY_MERMAID_HTML_LABELS,
            defaultRenderer: "elk",
            nodeSpacing: 70,
            rankSpacing: 95,
            diagramPadding: 10,
            useMaxWidth: false,
          },
        });
        const id = `topology_${Date.now()}`;
        const rendered = await mermaid.render(id, mermaidCode);
        if (!cancelled) {
          const safeRenderedSvg = sanitizeTopologySvg(rendered.svg);
          const themedSvg = sanitizeTopologySvg(
            applyEdgeLabelTheme(safeRenderedSvg, isDarkThemeMode),
          );
          setSvgMarkup(themedSvg);
          const doc = new DOMParser().parseFromString(
            themedSvg,
            "image/svg+xml",
          );
          const svg = doc.querySelector("svg");
          const vb = svg?.getAttribute("viewBox");
          if (vb) {
            const parts = vb.split(/\s+/).map((p) => Number(p));
            const w = Number.isFinite(parts[2]) ? parts[2] : 1000;
            const h = Number.isFinite(parts[3]) ? parts[3] : 600;
            setGraphSize({ w, h });
          }
        }
      } catch (error) {
        if (!cancelled) {
          const diagnostic = reportTopologyFailure(
            error,
            "Render DNS topology",
          );
          setRenderError(diagnostic.message);
          setSvgMarkup("");
        }
      } finally {
        if (!cancelled) setIsRendering(false);
      }
    }
    if (!mermaidCode.trim()) return;
    void render();
    return () => {
      cancelled = true;
    };
  }, [isDarkThemeMode, mermaidCode, themeVersion]);

  useEffect(() => {
    if (!viewportRef.current || typeof ResizeObserver === "undefined") return;
    const node = viewportRef.current;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      setViewportSize({ w: rect.width, h: rect.height });
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, [expandGraph]);

  useEffect(() => {
    if (!expandGraph || typeof document === "undefined") return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeExpandGraph();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [closeExpandGraph, expandGraph]);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    panRef.current = pan;
  }, [pan]);

  const computeFitScale = useCallback(() => {
    if (!viewportSize.w || !viewportSize.h || !graphSize.w || !graphSize.h)
      return 1;
    const padding = expandGraph ? 10 : 16;
    const availW = Math.max(1, viewportSize.w - padding * 2);
    const availH = Math.max(1, viewportSize.h - padding * 2);
    const baseFit = Math.min(availW / graphSize.w, availH / graphSize.h);
    return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, baseFit));
  }, [expandGraph, graphSize.h, graphSize.w, viewportSize.h, viewportSize.w]);

  const fitAndCenterGraph = useCallback(() => {
    if (!viewportSize.w || !viewportSize.h || !graphSize.w || !graphSize.h)
      return;
    const fitScale = computeFitScale();
    const x = (viewportSize.w - graphSize.w * fitScale) / 2;
    const y = (viewportSize.h - graphSize.h * fitScale) / 2;
    setZoom(Number(fitScale.toFixed(2)));
    setPan({ x, y });
    userAdjustedViewRef.current = false;
  }, [
    computeFitScale,
    graphSize.h,
    graphSize.w,
    viewportSize.h,
    viewportSize.w,
  ]);

  const fitScaleReference = useMemo(() => computeFitScale(), [computeFitScale]);
  const zoomPercent = useMemo(() => {
    if (!fitScaleReference || !Number.isFinite(fitScaleReference))
      return Math.round(zoom * 100);
    return Math.max(1, Math.round((zoom / fitScaleReference) * 100));
  }, [fitScaleReference, zoom]);

  useEffect(() => {
    const key = `${graphSize.w}x${graphSize.h}|${viewportSize.w}x${viewportSize.h}|${records.length}|${expandGraph ? "full" : "panel"}`;
    if (!graphSize.w || !viewportSize.w) return;
    if (autoFitDoneRef.current === key && userAdjustedViewRef.current) return;
    if (autoFitDoneRef.current !== key || !userAdjustedViewRef.current) {
      fitAndCenterGraph();
      autoFitDoneRef.current = key;
    }
  }, [
    expandGraph,
    fitAndCenterGraph,
    graphSize.h,
    graphSize.w,
    records.length,
    viewportSize.h,
    viewportSize.w,
  ]);

  const zoomBy = useCallback((delta: number) => {
    userAdjustedViewRef.current = true;
    const viewport = viewportRef.current;
    if (!viewport) {
      setZoom((z) =>
        Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number((z + delta).toFixed(2)))),
      );
      return;
    }
    const oldZoom = zoomRef.current;
    const newZoom = Math.max(
      ZOOM_MIN,
      Math.min(ZOOM_MAX, Number((oldZoom + delta).toFixed(2))),
    );
    if (newZoom === oldZoom) return;
    const oldPan = panRef.current;
    const centerX = viewport.clientWidth / 2;
    const centerY = viewport.clientHeight / 2;
    const worldX = (centerX - oldPan.x) / oldZoom;
    const worldY = (centerY - oldPan.y) / oldZoom;
    const nextPan = {
      x: centerX - worldX * newZoom,
      y: centerY - worldY * newZoom,
    };
    setZoom(newZoom);
    setPan(nextPan);
  }, []);

  const zoomAtCursor = useCallback(
    (delta: number, event: WheelEvent<HTMLDivElement>) => {
      userAdjustedViewRef.current = true;
      const viewport = viewportRef.current;
      if (!viewport) {
        zoomBy(delta);
        return;
      }
      const rect = viewport.getBoundingClientRect();
      const cursorX = event.clientX - rect.left;
      const cursorY = event.clientY - rect.top;
      const oldZoom = zoomRef.current;
      const newZoom = Math.max(
        ZOOM_MIN,
        Math.min(ZOOM_MAX, Number((oldZoom + delta).toFixed(2))),
      );
      if (newZoom === oldZoom) return;
      const oldPan = panRef.current;
      const worldX = (cursorX - oldPan.x) / oldZoom;
      const worldY = (cursorY - oldPan.y) / oldZoom;
      const nextPan = {
        x: cursorX - worldX * newZoom,
        y: cursorY - worldY * newZoom,
      };
      setZoom(newZoom);
      setPan(nextPan);
    },
    [zoomBy],
  );

  const handleWheelCapture = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      zoomAtCursor(event.deltaY < 0 ? 0.08 : -0.08, event);
    },
    [zoomAtCursor],
  );

  const normalizeTo100 = useCallback(() => {
    userAdjustedViewRef.current = true;
    const scale = fitScaleReference;
    setZoom(scale);
    if (!viewportSize.w || !viewportSize.h || !graphSize.w || !graphSize.h)
      return;
    const x = (viewportSize.w - graphSize.w * scale) / 2;
    const y = (viewportSize.h - graphSize.h * scale) / 2;
    setPan({ x, y });
  }, [
    fitScaleReference,
    graphSize.h,
    graphSize.w,
    viewportSize.h,
    viewportSize.w,
  ]);

  const resetView = useCallback(() => {
    autoFitDoneRef.current = "";
    fitAndCenterGraph();
  }, [fitAndCenterGraph]);

  const handleMouseDown = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (event.button === 1) {
        event.preventDefault();
        middleDragRestoreHandRef.current = handTool;
        setHandTool(true);
      } else if (event.button !== 0) {
        return;
      } else if (!handTool) {
        return;
      }
      userAdjustedViewRef.current = true;
      dragRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        baseX: pan.x,
        baseY: pan.y,
      };
    },
    [handTool, pan.x, pan.y],
  );

  const handleMouseMove = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const dx = event.clientX - dragRef.current.startX;
    const dy = event.clientY - dragRef.current.startY;
    setPan({ x: dragRef.current.baseX + dx, y: dragRef.current.baseY + dy });
  }, []);

  const handleMouseUp = useCallback(() => {
    dragRef.current = null;
    if (middleDragRestoreHandRef.current !== null) {
      setHandTool(middleDragRestoreHandRef.current);
      middleDragRestoreHandRef.current = null;
    }
  }, []);

  const handleViewportClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (nodeContextMenu.open) {
        setNodeContextMenu((prev) => ({ ...prev, open: false }));
      }
      if (!annotationTool || !viewportRef.current) return;
      const rect = viewportRef.current.getBoundingClientRect();
      const x = (event.clientX - rect.left - pan.x) / zoom;
      const y = (event.clientY - rect.top - pan.y) / zoom;
      setAnnotations((prev) => {
        const bounded = appendBoundedTopologyAnnotation(prev, {
          id: `ann_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          x,
          y,
          text: annotationDraft.trim() || "Note",
        });
        setAnnotationDiagnostic(bounded.diagnostic);
        return bounded.annotations;
      });
    },
    [annotationDraft, annotationTool, nodeContextMenu.open, pan.x, pan.y, zoom],
  );

  const handleNodeContextMenu = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const nodeEl = target.closest(".node") as HTMLElement | null;
      if (!nodeEl) return;
      const rawId = nodeEl.getAttribute("id") ?? "";
      let normalizedNodeId = rawId
        .replace(/^flowchart-/, "")
        .replace(/^graph-/, "");
      while (/-\d+$/.test(normalizedNodeId)) {
        normalizedNodeId = normalizedNodeId.replace(/-\d+$/, "");
      }
      const meta = nodeMetaById[normalizedNodeId];
      if (!meta) return;
      event.preventDefault();
      event.stopPropagation();
      setNodeContextMenu({
        open: true,
        x: event.clientX,
        y: event.clientY,
        text: meta.text,
        recordId: meta.recordId || undefined,
        address: meta.address || undefined,
      });
    },
    [nodeMetaById],
  );

  const exportCode = useCallback(() => {
    const baseName = `${normalizeDomain(zoneName) || "zone"}-topology`;
    if (desktop) {
      void TauriClient.saveTopologyAsset(
        "mmd",
        `${baseName}.mmd`,
        mermaidCode,
        false,
        exportFolderPreset,
        exportCustomPath,
        exportConfirmPath,
      )
        .then((path) => {
          toast({ title: "Exported", description: path });
        })
        .catch((e) => {
          reportTopologyFailure(e, "Export Mermaid topology");
        });
      return;
    }
    const blob = new Blob([mermaidCode], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement("a");
      a.href = url;
      a.download = `${baseName}.mmd`;
      a.click();
    } finally {
      URL.revokeObjectURL(url);
    }
  }, [
    desktop,
    mermaidCode,
    zoneName,
    exportFolderPreset,
    exportCustomPath,
    exportConfirmPath,
    toast,
  ]);

  const copyCode = useCallback(async () => {
    const copied = await copyTopologyText(mermaidCode, "Copy Mermaid topology");
    if (!copied) return;
    toast({
      title: "Copied",
      description: "Topology Mermaid code copied to clipboard.",
    });
  }, [mermaidCode, toast]);

  const renderSvgToPngBlob = useCallback(async (): Promise<Blob | null> => {
    if (!svgMarkup.trim()) return null;
    const safeSvgMarkup = sanitizeTopologySvg(svgMarkup);
    const svgBlob = new Blob([safeSvgMarkup], {
      type: "image/svg+xml;charset=utf-8",
    });
    return await withTopologyObjectUrl(svgBlob, async (url) => {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("Failed to render safe SVG"));
        image.src = url;
      });
      const canvas = document.createElement("canvas");
      return await withBoundedTopologyCanvas(
        canvas,
        safeSvgMarkup,
        window.devicePixelRatio || 1,
        async (boundedCanvas, allocation) => {
          if (allocation.downscaled) {
            toast({
              title: "Topology downscaled",
              description: `PNG output was safely reduced to ${allocation.width}×${allocation.height} pixels.`,
            });
          }
          const ctx = boundedCanvas.getContext("2d");
          if (!ctx) return null;
          try {
            ctx.drawImage(img, 0, 0, allocation.width, allocation.height);
          } catch {
            return null;
          }
          return await new Promise<Blob | null>((resolve) => {
            try {
              boundedCanvas.toBlob((blob) => resolve(blob), "image/png");
            } catch {
              resolve(null);
            }
          });
        },
      );
    });
  }, [svgMarkup, toast]);

  const copySvg = useCallback(async () => {
    if (!svgMarkup.trim()) return;
    const svgBlob = new Blob([svgMarkup], {
      type: "image/svg+xml;charset=utf-8",
    });
    try {
      if ("ClipboardItem" in window && navigator.clipboard?.write) {
        await navigator.clipboard.write([
          new ClipboardItem({ "image/svg+xml": svgBlob }),
        ]);
      } else {
        await navigator.clipboard.writeText(svgMarkup);
      }
      toast({
        title: "Copied",
        description: "Topology SVG copied to clipboard.",
      });
    } catch (imageClipboardError) {
      const copied = await copyTopologyText(
        svgMarkup,
        "Copy SVG topology fallback",
      );
      if (!copied) {
        reportTopologyFailure(
          imageClipboardError,
          "Copy SVG topology as an image",
        );
        return;
      }
      toast({
        title: "Copied",
        description: "SVG markup copied to clipboard.",
      });
    }
  }, [svgMarkup, toast]);

  const copyPng = useCallback(async () => {
    try {
      const pngBlob = await renderSvgToPngBlob();
      if (!pngBlob) {
        reportTopologyFailure(
          new Error("Unable to render PNG from topology"),
          "Copy PNG topology",
        );
        return;
      }
      if ("ClipboardItem" in window && navigator.clipboard?.write) {
        await navigator.clipboard.write([
          new ClipboardItem({ "image/png": pngBlob }),
        ]);
        toast({
          title: "Copied",
          description: "Topology PNG copied to clipboard.",
        });
        return;
      }
      reportTopologyFailure(
        new Error("PNG clipboard writing is not supported"),
        "Copy PNG topology",
      );
    } catch (error) {
      reportTopologyFailure(error, "Copy PNG topology");
    }
  }, [renderSvgToPngBlob, toast]);

  const exportSvg = useCallback(() => {
    if (!svgMarkup.trim()) return;
    const baseName = `${normalizeDomain(zoneName) || "zone"}-topology`;
    if (desktop) {
      void TauriClient.saveTopologyAsset(
        "svg",
        `${baseName}.svg`,
        svgMarkup,
        false,
        exportFolderPreset,
        exportCustomPath,
        exportConfirmPath,
      )
        .then((path) => {
          toast({ title: "Exported", description: path });
        })
        .catch((e) => {
          reportTopologyFailure(e, "Export SVG topology");
        });
      return;
    }
    const blob = new Blob([svgMarkup], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement("a");
      a.href = url;
      a.download = `${baseName}.svg`;
      a.click();
    } finally {
      URL.revokeObjectURL(url);
    }
  }, [
    desktop,
    exportConfirmPath,
    exportCustomPath,
    exportFolderPreset,
    svgMarkup,
    toast,
    zoneName,
  ]);

  const exportPng = useCallback(async () => {
    try {
      const pngBlob = await renderSvgToPngBlob();
      if (!pngBlob) {
        reportTopologyFailure(
          new Error("Unable to render PNG from topology"),
          "Export PNG topology",
        );
        return;
      }
      const baseName = `${normalizeDomain(zoneName) || "zone"}-topology`;
      if (desktop) {
        const b64 = await blobToBase64(pngBlob);
        const path = await TauriClient.saveTopologyAsset(
          "png",
          `${baseName}.png`,
          b64,
          true,
          exportFolderPreset,
          exportCustomPath,
          exportConfirmPath,
        );
        toast({ title: "Exported", description: path });
        return;
      }
      const url = URL.createObjectURL(pngBlob);
      try {
        const a = document.createElement("a");
        a.href = url;
        a.download = `${baseName}.png`;
        a.click();
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      reportTopologyFailure(error, "Export PNG topology");
    }
  }, [
    desktop,
    exportConfirmPath,
    exportCustomPath,
    exportFolderPreset,
    renderSvgToPngBlob,
    toast,
    zoneName,
  ]);

  const printToPdf = useCallback(() => {
    if (!svgMarkup.trim()) return;
    const win = window.open("", "_blank", "noopener,noreferrer");
    if (!win) return;
    try {
      const doc = win.document;
      populateTopologyPrintDocument(doc, svgMarkup, zoneName, annotations);
      doc.close();
      win.setTimeout(() => win.print(), 0);
    } catch (error) {
      reportTopologyFailure(error, "Print topology to PDF");
      win.close();
    }
  }, [annotations, svgMarkup, zoneName]);

  const controlsDisabled =
    isLoading ||
    isRendering ||
    topologyResolutionProgress.running ||
    modelBuildProgress.running;
  const hasCopyActionsEnabled = enabledCopyActions.size > 0;
  const hasExportActionsEnabled = enabledExportActions.size > 0;
  const cursorClass = annotationTool
    ? "cursor-crosshair"
    : handTool
      ? "cursor-grab"
      : "cursor-default";
  const graphBackgroundClass = isDarkThemeMode
    ? "bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.06),transparent_55%),linear-gradient(to_bottom_right,rgba(255,255,255,0.04),rgba(0,0,0,0.15))]"
    : "bg-[radial-gradient(circle_at_top,rgba(15,23,42,0.09),transparent_55%),linear-gradient(to_bottom_right,rgba(255,255,255,0.95),rgba(226,232,240,0.75))]";
  const loadingOverlayClass = isDarkThemeMode
    ? "bg-black/35 backdrop-blur-md"
    : "bg-white/60 backdrop-blur-md";
  const panX = Math.round(pan.x);
  const panY = Math.round(pan.y);
  const topologyProgressLabel = useMemo(() => {
    if (modelBuildProgress.running) {
      return `Building graph model ${modelBuildProgress.completed}/${modelBuildProgress.total} nodes...`;
    }
    if (discovering)
      return discoveryProgress.label || "Discovering services...";
    if (!topologyResolutionProgress.running) return "Rendering topology...";
    const total = Math.max(1, topologyResolutionProgress.total);
    const done = Math.min(total, topologyResolutionProgress.done);
    const pct = Math.round((done / total) * 100);
    return `Resolving chain nodes ${done}/${total} (${pct}%)...`;
  }, [
    discovering,
    discoveryProgress.label,
    modelBuildProgress.completed,
    modelBuildProgress.running,
    modelBuildProgress.total,
    topologyResolutionProgress.done,
    topologyResolutionProgress.running,
    topologyResolutionProgress.total,
  ]);
  const activeRequestPreview = useMemo(() => {
    if (discovering) {
      if (discoveryProgress.requests.length === 0) return "";
      return `Requests: ${discoveryProgress.requests.join(", ")}`;
    }
    if (
      !topologyResolutionProgress.running ||
      activeResolutionRequests.length === 0
    )
      return "";
    const head = activeResolutionRequests.slice(0, 4).join(", ");
    const extra =
      activeResolutionRequests.length > 4
        ? ` (+${activeResolutionRequests.length - 4} more)`
        : "";
    return `Requests: ${head}${extra}`;
  }, [
    activeResolutionRequests,
    discoveryProgress.requests,
    discovering,
    topologyResolutionProgress.running,
  ]);
  const zoneBase = useMemo(() => normalizeDomain(zoneName), [zoneName]);
  const emailRecordSummary = useMemo(() => {
    let total = 0;
    const visible: DNSRecord[] = [];
    for (const record of records) {
      const name = normalizeDomain(record.name);
      const text = String(record.content ?? "").toLowerCase();
      const matches =
        record.type === "MX" ||
        record.type === "SPF" ||
        name.includes("_dmarc") ||
        name.includes("._domainkey") ||
        name.includes("_bimi") ||
        (record.type === "TXT" &&
          (text.includes("v=spf1") ||
            text.includes("v=dmarc1") ||
            text.includes("v=dkim1") ||
            text.includes("v=bimi1")));
      if (!matches) continue;
      total += 1;
      if (visible.length < TOPOLOGY_EMAIL_RENDER_LIMIT) visible.push(record);
    }
    return { total, visible };
  }, [records]);
  const mxResolvedRows = useMemo(() => {
    const cnameMap = buildCnameMap(records);
    const { ipv4ByName, ipv6ByName } = buildAddressMaps(records);
    let total = 0;
    const visible = [];
    for (const record of records) {
      if (record.type !== "MX") continue;
      total += 1;
      if (visible.length >= TOPOLOGY_SUMMARY_RENDER_LIMIT) continue;
      const from = normalizeDomain(record.name) || normalizeDomain(zoneName);
      const rawParts = String(record.content ?? "")
        .trim()
        .split(/\s+/);
      const maybePriority = Number(rawParts[0]);
      const priority = Number.isFinite(maybePriority) ? maybePriority : null;
      const target = extractTarget(record) || "";
      const local = resolveNameToTerminal(
        target,
        cnameMap,
        ipv4ByName,
        ipv6ByName,
        Math.max(1, Math.min(15, Math.round(maxResolutionHops))),
      );
      const best = pickBestResolution(target, local, externalResolutionByName);
      const chain = best.chain.length ? best.chain : local.chain;
      const ipv4 = best.ipv4.length ? best.ipv4 : local.ipv4;
      const ipv6 = best.ipv6.length ? best.ipv6 : local.ipv6;
      const terminal = best.terminal || local.terminal || target;
      const source =
        local.ipv4.length || local.ipv6.length
          ? "in-zone"
          : best.ipv4.length ||
              best.ipv6.length ||
              best.chain.length > local.chain.length
            ? "external"
            : "none";
      const reverse = Object.entries(best.reverseHostnamesByIp ?? {}).flatMap(
        ([ip, hosts]) => hosts.map((host) => `${ip} => ${host}`),
      );
      visible.push({
        id: record.id,
        from,
        priority,
        target,
        chain,
        terminal,
        ipv4,
        ipv6,
        reverse,
        source,
      });
    }
    return { total, visible };
  }, [externalResolutionByName, maxResolutionHops, records, zoneName]);

  const runDiscovery = useCallback(async () => {
    if (disableServiceDiscovery) {
      toast({
        title: "Service discovery disabled",
        description: "Enable it in Topology settings to run checks.",
      });
      return;
    }
    discoveryAbortRef.current?.abort();
    const controller = new AbortController();
    discoveryAbortRef.current = controller;
    const runId = ++discoveryRunRef.current;
    const isCurrentRun = () =>
      discoveryRunRef.current === runId && !controller.signal.aborted;
    const items: ServiceDiscoveryItem[] = [];
    setDiscovering(true);
    setDiscoveryProgress({
      label: "Preparing service discovery...",
      done: 0,
      total: 1,
      requests: [],
    });
    try {
      const hasMx = graphSourceRecords.some((r) => r.type === "MX");
      const hasNs = graphSourceRecords.some((r) => r.type === "NS");
      const hasSshHost = graphSourceRecords.some((r) =>
        normalizeDomain(r.name).includes("ssh"),
      );
      const hasSrv = graphSourceRecords.filter((r) => r.type === "SRV");
      if (hasMx)
        items.push({
          service: "SMTP",
          status: "inferred",
          details: "MX records present",
        });
      if (hasNs)
        items.push({
          service: "DNS",
          status: "inferred",
          details: "NS records present",
        });
      if (
        hasSshHost ||
        hasSrv.some((r) => String(r.content).toLowerCase().includes("22 "))
      ) {
        items.push({
          service: "SSH",
          status: "inferred",
          details: "SSH-like host/SRV detected",
        });
      }
      if (hasSrv.some((r) => normalizeDomain(r.name).includes("_ftp"))) {
        items.push({
          service: "FTP",
          status: "inferred",
          details: "FTP SRV found",
        });
      }

      const httpTargets = new Set<string>([zoneBase, `www.${zoneBase}`]);
      for (const r of graphSourceRecords) {
        if (!["A", "AAAA", "CNAME"].includes(r.type)) continue;
        const n = normalizeDomain(r.name);
        if (
          n &&
          (n === zoneBase || n.startsWith("www.") || n.startsWith("api."))
        ) {
          httpTargets.add(n);
        }
      }
      const probeHosts = Array.from(httpTargets).filter(Boolean).slice(0, 4);
      const discoveryTotal = Math.max(1, probeHosts.length + 3);
      let discoveryDone = 1;
      const setProgress = (label: string, requests: string[] = []) => {
        if (!isCurrentRun()) return;
        setDiscoveryProgress({
          label,
          done: discoveryDone,
          total: discoveryTotal,
          requests: requests.slice(0, 6),
        });
      };
      setProgress("Building discovery probe plan...", probeHosts);
      const clampedHops = topologyMaxResolutionHops;
      const probePrefix = `${resolverMode}|${dnsServer}|${customDnsServer.trim()}|${dohProvider}|${dohCustomUrl.trim()}|${clampedHops}|probe|`;
      const now = Date.now();
      const probeMap = new Map<
        string,
        { host: string; httpsUp: boolean; httpUp: boolean }
      >();
      for (const host of probeHosts) {
        const norm = normalizeDomain(host);
        const cacheKey = `${probePrefix}${norm}`;
        const cached = probeCacheRef.current.get(cacheKey);
        if (cached && now - cached.ts <= TOPOLOGY_CACHE_TTL_MS) {
          probeMap.set(norm, {
            host: norm,
            httpsUp: cached.httpsUp,
            httpUp: cached.httpUp,
          });
        }
      }
      discoveryDone += 1;
      setProgress("Running backend service probes...", probeHosts);
      const backendBatch = await resolveTopologyBatchInBackend(
        [],
        clampedHops,
        resolverMode,
        dnsServer,
        customDnsServer,
        dohProvider,
        dohCustomUrl,
        lookupTimeoutMs,
        disablePtrLookups,
        tcpServicePorts,
        true,
        geoProvider,
        scanResolutionChain,
        probeHosts,
      );
      if (!isCurrentRun()) return;
      if (backendBatch && backendBatch.probes.length > 0) {
        for (const probe of backendBatch.probes) {
          const norm = normalizeDomain(probe.host);
          probeMap.set(norm, {
            host: norm,
            httpsUp: probe.httpsUp,
            httpUp: probe.httpUp,
          });
          setBoundedCache(probeCacheRef.current, `${probePrefix}${norm}`, {
            host: norm,
            httpsUp: probe.httpsUp,
            httpUp: probe.httpUp,
            ts: Date.now(),
          });
        }
      }
      discoveryDone += 1;
      setProgress("Resolving HTTP/HTTPS service checks...", probeHosts);
      if (probeMap.size > 0) {
        for (const probe of probeMap.values()) {
          const httpsStatus: "up" | "down" = probe.httpsUp ? "up" : "down";
          const httpStatus: "up" | "down" = probe.httpUp ? "up" : "down";
          items.push({
            service: `HTTPS (${probe.host})`,
            status: httpsStatus,
            details:
              httpsStatus === "up"
                ? "Backend probe reachable"
                : "Backend probe failed",
          });
          items.push({
            service: `HTTP (${probe.host})`,
            status: httpStatus,
            details:
              httpStatus === "up"
                ? "Backend probe reachable"
                : "Backend probe failed",
          });
        }
      } else {
        for (const host of probeHosts) {
          setProgress(`Probing ${host}...`, [host]);
          const httpsStatus = await probeHttp(
            `https://${host}`,
            5000,
            controller.signal,
          );
          if (!isCurrentRun()) return;
          items.push({
            service: `HTTPS (${host})`,
            status: httpsStatus,
            details:
              httpsStatus === "up" ? "Probe reachable" : "Probe failed/blocked",
          });
          const httpStatus = await probeHttp(
            `http://${host}`,
            5000,
            controller.signal,
          );
          if (!isCurrentRun()) return;
          items.push({
            service: `HTTP (${host})`,
            status: httpStatus,
            details:
              httpStatus === "up" ? "Probe reachable" : "Probe failed/blocked",
          });
        }
      }
      discoveryDone += 1;
      setProgress("Processing TCP discovery probes...", probeHosts);
      if (backendBatch && backendBatch.tcpProbes.length > 0) {
        const serviceNameByPort: Record<number, string> = {
          21: "FTP",
          22: "SSH",
          23: "Telnet",
          25: "SMTP",
          53: "DNS",
          80: "HTTP",
          110: "POP3",
          143: "IMAP",
          443: "HTTPS",
          465: "SMTPS",
          587: "Submission",
          993: "IMAPS",
          995: "POP3S",
          3306: "MySQL",
          5432: "PostgreSQL",
        };
        for (const tcp of backendBatch.tcpProbes) {
          const label = serviceNameByPort[tcp.port] ?? `TCP ${tcp.port}`;
          items.push({
            service: `${label} (${tcp.host}:${tcp.port})`,
            status: tcp.up ? "up" : "down",
            details: tcp.up ? "TCP connect succeeded" : "TCP connect failed",
          });
        }
      }
      discoveryDone = discoveryTotal;
      setProgress("Discovery complete", []);
      if (!isCurrentRun()) return;
      setDiscovery(items);
      toast({
        title: "Discovery complete",
        description: `Found ${items.length} service signal(s).`,
      });
    } catch (error) {
      if (isCurrentRun()) {
        reportTopologyFailure(error, "Run DNS service discovery");
      }
    } finally {
      if (isCurrentRun()) {
        setDiscovering(false);
        setDiscoveryProgress({ label: "", done: 0, total: 0, requests: [] });
        discoveryAbortRef.current = null;
      }
    }
  }, [
    disableServiceDiscovery,
    resolverMode,
    dnsServer,
    customDnsServer,
    dohCustomUrl,
    dohProvider,
    topologyMaxResolutionHops,
    graphSourceRecords,
    toast,
    zoneBase,
    lookupTimeoutMs,
    disablePtrLookups,
    tcpServicePorts,
    geoProvider,
    scanResolutionChain,
  ]);

  const renderGraphControls = (forLightbox: boolean) => (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        className="h-8 px-2"
        onClick={() => zoomBy(0.1)}
        disabled={controlsDisabled}
      >
        <Plus className="h-3.5 w-3.5" />
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="h-8 px-2"
        onClick={() => zoomBy(-0.1)}
        disabled={controlsDisabled}
      >
        <Minus className="h-3.5 w-3.5" />
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="h-8 px-2"
        onClick={resetView}
        disabled={controlsDisabled}
      >
        <ZoomIn className="h-3.5 w-3.5 mr-1" />
        <span
          role="button"
          tabIndex={0}
          className="select-none"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            normalizeTo100();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              normalizeTo100();
            }
          }}
          title="Normalize zoom to 100%"
        >
          {zoomPercent}%
        </span>
      </Button>
      <Button
        size="sm"
        variant={handTool ? "default" : "outline"}
        className="h-8 px-2"
        onClick={() => {
          setHandTool((v) => !v);
          setAnnotationTool(false);
        }}
      >
        <Hand className="h-3.5 w-3.5 mr-1" />
        Hand
      </Button>
      {!disableAnnotations && (
        <>
          <Button
            size="sm"
            variant={annotationTool ? "default" : "outline"}
            className="h-8 px-2"
            onClick={() => {
              setAnnotationTool((v) => !v);
              setHandTool(false);
            }}
          >
            <StickyNote className="h-3.5 w-3.5 mr-1" />
            Annotate
          </Button>
          <Input
            value={annotationDraft}
            onChange={(e) => {
              const bounded = retainUtf8(
                e.target.value,
                TOPOLOGY_ANNOTATION_ENTRY_MAX_BYTES,
              );
              setAnnotationDraft(bounded.value);
              setAnnotationDiagnostic(
                bounded.truncated
                  ? `Annotation input was truncated to ${TOPOLOGY_ANNOTATION_ENTRY_MAX_BYTES.toLocaleString()} UTF-8 bytes.`
                  : null,
              );
            }}
            className="h-8 w-44"
            placeholder="Annotation text"
            aria-label="Annotation text"
          />
          {annotationDiagnostic && (
            <span
              className="max-w-80 text-xs text-yellow-700 dark:text-yellow-300"
              data-testid="topology-annotation-diagnostic"
              role="status"
            >
              {annotationDiagnostic}
            </span>
          )}
        </>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            className="h-8 px-2"
            disabled={(!mermaidCode && !svgMarkup) || !hasCopyActionsEnabled}
          >
            <Copy className="h-3.5 w-3.5 mr-1" />
            Copy
            <ChevronDown className="ml-1 h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={6} className="w-52">
          {enabledCopyActions.has("mermaid") && (
            <DropdownMenuItem
              onClick={() => void copyCode()}
              disabled={!mermaidCode}
            >
              <Copy className="mr-2 h-3.5 w-3.5" />
              Copy Mermaid code
            </DropdownMenuItem>
          )}
          {enabledCopyActions.has("svg") && (
            <DropdownMenuItem
              onClick={() => void copySvg()}
              disabled={!svgMarkup}
            >
              <Copy className="mr-2 h-3.5 w-3.5" />
              Copy SVG
            </DropdownMenuItem>
          )}
          {enabledCopyActions.has("png") && (
            <DropdownMenuItem
              onClick={() => void copyPng()}
              disabled={!svgMarkup}
            >
              <Copy className="mr-2 h-3.5 w-3.5" />
              Copy PNG
            </DropdownMenuItem>
          )}
          {!hasCopyActionsEnabled && (
            <DropdownMenuItem disabled>
              No copy actions enabled
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            className="h-8 px-2"
            disabled={(!mermaidCode && !svgMarkup) || !hasExportActionsEnabled}
          >
            <FileDown className="h-3.5 w-3.5 mr-1" />
            Export
            <ChevronDown className="ml-1 h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={6} className="w-52">
          {enabledExportActions.has("mermaid") && (
            <DropdownMenuItem onClick={exportCode} disabled={!mermaidCode}>
              <FileDown className="mr-2 h-3.5 w-3.5" />
              Export Mermaid code
            </DropdownMenuItem>
          )}
          {enabledExportActions.has("svg") && (
            <DropdownMenuItem onClick={exportSvg} disabled={!svgMarkup}>
              <FileDown className="mr-2 h-3.5 w-3.5" />
              Export SVG
            </DropdownMenuItem>
          )}
          {enabledExportActions.has("png") && (
            <DropdownMenuItem
              onClick={() => void exportPng()}
              disabled={!svgMarkup}
            >
              <FileDown className="mr-2 h-3.5 w-3.5" />
              Export PNG
            </DropdownMenuItem>
          )}
          {enabledExportActions.has("pdf") && (
            <DropdownMenuItem onClick={printToPdf} disabled={!svgMarkup}>
              <FileDown className="mr-2 h-3.5 w-3.5" />
              Export PDF
            </DropdownMenuItem>
          )}
          {!hasExportActionsEnabled && (
            <DropdownMenuItem disabled>
              No export actions enabled
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        size="sm"
        variant="outline"
        className="h-8 px-2"
        onClick={() => {
          resolutionCacheRef.current.clear();
          probeCacheRef.current.clear();
          setExternalResolutionByName({});
          setTopologyResolutionReady(false);
          setMermaidCode("");
          setSvgMarkup("");
          setActiveResolutionRequests([]);
          setManualRefreshTick((v) => v + 1);
          void runTopologyRefresh(onRefresh);
        }}
        disabled={isLoading}
      >
        <RefreshCw className={cn("h-3.5 w-3.5", isLoading && "animate-spin")} />
      </Button>
      {!disableFullWindow && (
        <Button
          size="sm"
          variant="outline"
          className="h-8 px-2"
          onClick={() => {
            toggleExpandGraph();
          }}
          title={expandGraph ? "Exit full window" : "Expand to full window"}
        >
          {expandGraph ? (
            <>
              <Minimize2 className="h-3.5 w-3.5 mr-1" />
              Exit full window
            </>
          ) : (
            <>
              <Maximize2 className="h-3.5 w-3.5 mr-1" />
              Full window
            </>
          )}
        </Button>
      )}
      <Button
        size="sm"
        variant="outline"
        className="h-8 px-2"
        onClick={() => void runDiscovery()}
        disabled={discovering || disableServiceDiscovery}
      >
        <Search
          className={cn("h-3.5 w-3.5 mr-1", discovering && "animate-spin")}
        />
        Discover services
      </Button>
      {forLightbox && (
        <Button
          size="sm"
          variant="outline"
          className="h-8 px-2"
          onClick={closeExpandGraph}
        >
          <Minimize2 className="h-3.5 w-3.5 mr-1" />
          Close
        </Button>
      )}
    </div>
  );

  const fullscreenLightbox =
    expandGraph && typeof document !== "undefined"
      ? createPortal(
          <div className="fixed inset-0 z-[220]">
            <button
              type="button"
              aria-label="Close full window topology view"
              className="absolute inset-0 bg-black/45 backdrop-blur-sm"
              onClick={closeExpandGraph}
            />
            <div className="absolute inset-0 bg-background/96 p-3">
              <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                <div>Topology graph - full window mode</div>
              </div>
              <div className="mb-2">{renderGraphControls(true)}</div>
              <div
                ref={expandGraph ? viewportRef : undefined}
                className={cn(
                  "relative h-[calc(100dvh-4rem)] overflow-hidden overscroll-contain rounded-xl border border-border/60 select-none",
                  graphBackgroundClass,
                  cursorClass,
                )}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
                onWheelCapture={(event) => {
                  handleWheelCapture(event);
                }}
                onTouchMoveCapture={(event) => {
                  event.stopPropagation();
                }}
                onPointerDownCapture={(event) => {
                  event.stopPropagation();
                }}
                onAuxClick={(event) => {
                  if (event.button === 1) {
                    event.preventDefault();
                    event.stopPropagation();
                  }
                }}
                onKeyDownCapture={(event) => {
                  if (
                    [
                      "ArrowUp",
                      "ArrowDown",
                      "ArrowLeft",
                      "ArrowRight",
                      "PageUp",
                      "PageDown",
                      "Home",
                      "End",
                      " ",
                    ].includes(event.key)
                  ) {
                    event.preventDefault();
                    event.stopPropagation();
                  }
                }}
                tabIndex={0}
                onClick={handleViewportClick}
                onContextMenu={handleNodeContextMenu}
              >
                <div
                  className="absolute left-0 top-0"
                  style={{
                    transform: `translate3d(${panX}px, ${panY}px, 0) scale(${zoom})`,
                    transformOrigin: "0 0",
                  }}
                >
                  <div className="relative p-4">
                    {renderError ? (
                      <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive-foreground">
                        Mermaid render failed: {renderError}
                      </div>
                    ) : (
                      <SanitizedTopologySvg svgMarkup={svgMarkup} />
                    )}

                    {annotations.map((ann) => (
                      <div
                        key={ann.id}
                        className="absolute rounded-md border border-primary/40 bg-card/90 px-2 py-1 text-[11px] shadow-lg"
                        style={{ left: ann.x, top: ann.y }}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <div className="flex items-center gap-2">
                          <span>{ann.text}</span>
                          <button
                            type="button"
                            className="text-muted-foreground hover:text-foreground"
                            onClick={() =>
                              setAnnotations((prev) => {
                                setAnnotationDiagnostic(null);
                                return prev.filter((x) => x.id !== ann.id);
                              })
                            }
                          >
                            x
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {(modelBuildProgress.running ||
                  isRendering ||
                  isLoading ||
                  topologyResolutionProgress.running ||
                  discovering) && (
                  <div
                    className={cn(
                      "absolute inset-0 z-20 flex items-center justify-center",
                      loadingOverlayClass,
                    )}
                  >
                    <div className="flex min-w-[280px] flex-col gap-2 rounded-lg border border-primary/40 bg-card/85 px-3 py-2 text-xs">
                      <div className="flex items-center gap-2">
                        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                        {topologyProgressLabel}
                      </div>
                      {activeRequestPreview ? (
                        <div className="line-clamp-2 text-[11px] text-muted-foreground">
                          {activeRequestPreview}
                        </div>
                      ) : null}
                      {(topologyResolutionProgress.running || discovering) && (
                        <div className="h-1.5 w-full rounded bg-primary/20">
                          <div
                            className="h-full rounded bg-primary transition-all duration-200"
                            style={{
                              width: `${Math.round(
                                (Math.min(
                                  Math.max(
                                    discovering
                                      ? discoveryProgress.done
                                      : topologyResolutionProgress.done,
                                    0,
                                  ),
                                  Math.max(
                                    discovering
                                      ? discoveryProgress.total
                                      : topologyResolutionProgress.total,
                                    1,
                                  ),
                                ) /
                                  Math.max(
                                    discovering
                                      ? discoveryProgress.total
                                      : topologyResolutionProgress.total,
                                    1,
                                  )) *
                                  100,
                              )}%`,
                            }}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  const nodeContextMenuPortal =
    nodeContextMenu.open && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={nodeContextMenuRef}
            className="fixed z-[260] min-w-[220px] rounded-md border border-border/70 bg-card/95 p-1 shadow-2xl backdrop-blur pointer-events-auto"
            style={{
              left: Math.max(8, nodeContextMenu.x),
              top: Math.max(8, nodeContextMenu.y),
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/60"
              onClick={async () => {
                try {
                  const copied = await copyTopologyText(
                    nodeContextMenu.text,
                    "Copy DNS topology node text",
                  );
                  if (copied) {
                    toast({
                      title: "Copied",
                      description: "Node text copied to clipboard.",
                    });
                  }
                } finally {
                  closeNodeContextMenu();
                }
              }}
            >
              <Copy className="h-3.5 w-3.5" />
              Copy node text
            </button>
            <button
              type="button"
              disabled={!buildBrowserUrl(nodeContextMenu.address)}
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/60",
                !buildBrowserUrl(nodeContextMenu.address) &&
                  "cursor-not-allowed opacity-50 hover:bg-transparent",
              )}
              onClick={() => {
                const url = buildBrowserUrl(nodeContextMenu.address);
                if (!url) return;
                window.open(url, "_blank", "noopener,noreferrer");
                closeNodeContextMenu();
              }}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open in browser
            </button>
            <button
              type="button"
              disabled={!nodeContextMenu.recordId}
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/60",
                !nodeContextMenu.recordId &&
                  "cursor-not-allowed opacity-50 hover:bg-transparent",
              )}
              onClick={() => {
                if (!nodeContextMenu.recordId || !onEditRecord) return;
                const rec = records.find(
                  (r) => String(r.id ?? "") === nodeContextMenu.recordId,
                );
                if (!rec) return;
                onEditRecord(rec);
                closeNodeContextMenu();
              }}
            >
              <Edit3 className="h-3.5 w-3.5" />
              Go to record and edit
            </button>
          </div>,
          document.body,
        )
      : null;

  return (
    <Card className="border-border/60 bg-card/70">
      <CardHeader>
        <CardTitle className="text-lg">Topology</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {topologyModel.status === "refused" && (
          <div
            role="alert"
            data-testid="topology-model-refusal"
            className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100"
          >
            Graph construction is limited to {TOPOLOGY_MODEL_NODE_LIMIT} nodes.
            Current filters match {topologyModel.sourceRecords.length} of{" "}
            {records.length} source records, so no graph nodes were constructed
            or silently omitted. Enter more specific search text or choose a
            record type until the result contains {TOPOLOGY_MODEL_NODE_LIMIT}{" "}
            records or fewer.
          </div>
        )}
        {modelBuildProgress.running && (
          <div
            role="status"
            aria-live="polite"
            data-testid="topology-model-progress"
            className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground"
          >
            Building graph model progressively: {modelBuildProgress.completed}{" "}
            of {modelBuildProgress.total} nodes completed.
          </div>
        )}
        {topologyModel.status === "ready" && !modelBuildProgress.running && (
          <div
            role="status"
            aria-live="polite"
            data-testid="topology-model-count"
            className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground"
          >
            Graph model retains all {topologyModel.nodes.length} matching nodes
            and {topologyModel.edges.length} edges from{" "}
            {topologyModel.sourceRecords.length} source records
            {records.length !== topologyModel.sourceRecords.length
              ? `; the complete ${records.length}-record source remains unchanged`
              : ""}
            . The active graph viewport renders at most{" "}
            {TOPOLOGY_GRAPH_DOM_NODE_LIMIT} nodes,{" "}
            {TOPOLOGY_GRAPH_DOM_EDGE_LIMIT} edges, and labels of at most{" "}
            {TOPOLOGY_NODE_LABEL_MAX_CHARS} characters.
          </div>
        )}

        <section
          aria-label="Topology node search and filters"
          className="space-y-3 rounded-lg border border-border/60 bg-card/55 p-3"
        >
          <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_14rem_auto]">
            <div className="space-y-1">
              <label
                htmlFor="topology-node-search"
                className="text-xs font-medium"
              >
                Search nodes
              </label>
              <Input
                id="topology-node-search"
                aria-label="Search topology nodes"
                value={modelSearch}
                onChange={(event) => setModelSearch(event.target.value)}
                placeholder="Name, content, record ID, or type"
              />
            </div>
            <div className="space-y-1">
              <label
                htmlFor="topology-record-type"
                className="text-xs font-medium"
              >
                Record type
              </label>
              <select
                id="topology-record-type"
                aria-label="Filter topology record type"
                value={modelRecordType}
                onChange={(event) => setModelRecordType(event.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <option value="">All record types</option>
                {topologyRecordTypes.map((recordType) => (
                  <option key={recordType} value={recordType}>
                    {recordType}
                  </option>
                ))}
              </select>
            </div>
            <Button
              type="button"
              variant="outline"
              className="self-end"
              disabled={!modelSearch && !modelRecordType}
              onClick={() => {
                setModelSearch("");
                setModelRecordType("");
              }}
            >
              Clear filters
            </Button>
          </div>

          {topologyModel.status === "ready" && (
            <>
              <div
                role="status"
                aria-live="polite"
                data-testid="topology-result-count"
                className="text-xs text-muted-foreground"
              >
                {matchingModelNodes.length} matching node
                {matchingModelNodes.length === 1 ? "" : "s"} in the complete{" "}
                {topologyModel.nodes.length}-node graph model.
              </div>
              <div
                aria-label="Topology node results"
                className="max-h-72 space-y-1 overflow-auto rounded-md border border-border/50 p-2"
              >
                {visibleModelResults.length === 0 ? (
                  <div className="px-2 py-3 text-xs text-muted-foreground">
                    No nodes match the current filters.
                  </div>
                ) : (
                  visibleModelResults.map((node) => (
                    <button
                      key={node.id}
                      type="button"
                      data-testid="topology-result-select"
                      className={cn(
                        "flex w-full items-center justify-between gap-3 rounded-md border px-2 py-1.5 text-left text-xs hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        selectedModelNodeId === node.id
                          ? "border-primary bg-primary/10"
                          : "border-border/50",
                      )}
                      onClick={() => selectAndRevealModelNode(node)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        selectAndRevealModelNode(node);
                      }}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">
                          {node.label}
                        </span>
                        <span className="block truncate text-muted-foreground">
                          {node.content.length > TOPOLOGY_NODE_LABEL_MAX_CHARS
                            ? `${node.content.slice(0, TOPOLOGY_NODE_LABEL_MAX_CHARS - 1)}…`
                            : node.content}
                        </span>
                      </span>
                      <span className="shrink-0 text-[10px] uppercase text-muted-foreground">
                        Focus in graph
                      </span>
                    </button>
                  ))
                )}
              </div>
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>
                  Results page {currentModelResultPage} of{" "}
                  {modelResultPageCount}; at most {TOPOLOGY_RESULT_PAGE_SIZE}{" "}
                  rows are mounted.
                </span>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={currentModelResultPage <= 1}
                    onClick={() =>
                      setModelResultPage((page) => Math.max(1, page - 1))
                    }
                  >
                    Previous
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={currentModelResultPage >= modelResultPageCount}
                    onClick={() =>
                      setModelResultPage((page) =>
                        Math.min(modelResultPageCount, page + 1),
                      )
                    }
                  >
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </section>

        {topologyModel.status === "ready" && (
          <section
            role="region"
            aria-label="Topology graph viewport"
            data-testid="topology-model-graph"
            className="space-y-2 rounded-lg border border-border/60 bg-muted/15 p-3"
          >
            <div className="text-xs text-muted-foreground">
              Graph viewport shows nodes{" "}
              {visibleGraphNodes.length > 0
                ? `${visibleGraphNodes[0].recordIndex + 1}-${visibleGraphNodes[visibleGraphNodes.length - 1].recordIndex + 1}`
                : "0"}{" "}
              of {topologyModel.nodes.length}. Selecting any search result
              reveals and focuses its node here.
            </div>
            <div className="h-[560px] overflow-auto rounded-md border border-border/50 bg-background/40">
              <div className="relative h-[660px] min-w-[944px]">
                <svg
                  aria-hidden="true"
                  data-testid="topology-graph-edges"
                  className="absolute inset-0 h-full w-full text-border"
                >
                  {visibleGraphEdges.map((edge) => {
                    const sourceX = 70 + (edge.sourceIndex % 8) * 116;
                    const sourceY = 42 + Math.floor(edge.sourceIndex / 8) * 64;
                    const targetX = 70 + (edge.targetIndex % 8) * 116;
                    const targetY = 42 + Math.floor(edge.targetIndex / 8) * 64;
                    return (
                      <line
                        key={edge.id}
                        data-testid="topology-graph-edge"
                        x1={sourceX}
                        y1={sourceY}
                        x2={targetX}
                        y2={targetY}
                        stroke="currentColor"
                        strokeWidth="1.5"
                      />
                    );
                  })}
                </svg>
                {visibleGraphNodes.map((node, index) => (
                  <button
                    key={node.id}
                    id={`topology-model-node-${node.recordIndex}`}
                    type="button"
                    data-testid="topology-graph-node"
                    aria-pressed={selectedModelNodeId === node.id}
                    aria-label={`${node.label}; ${node.nodeType} node`}
                    className={cn(
                      "absolute z-10 h-11 w-[108px] overflow-hidden rounded-md border bg-card px-1.5 py-1 text-left text-[10px] shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                      selectedModelNodeId === node.id
                        ? "border-primary bg-primary/15"
                        : "border-border/70",
                    )}
                    style={{
                      left: 16 + (index % 8) * 116,
                      top: 20 + Math.floor(index / 8) * 64,
                    }}
                    onClick={() => selectAndRevealModelNode(node)}
                  >
                    <span className="block truncate font-semibold">
                      {node.label}
                    </span>
                    <span className="block truncate text-muted-foreground">
                      {node.nodeType}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </section>
        )}

        {topologyRecords.length > 0 && renderGraphControls(false)}

        {topologyRecords.length > 0 && (
          <div>
            <div
              ref={!expandGraph ? viewportRef : undefined}
              className={cn(
                "relative overflow-hidden overscroll-contain rounded-xl border border-border/60 select-none",
                graphBackgroundClass,
                "h-[560px]",
                cursorClass,
              )}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              onWheelCapture={(event) => {
                handleWheelCapture(event);
              }}
              onTouchMoveCapture={(event) => {
                event.stopPropagation();
              }}
              onPointerDownCapture={(event) => {
                event.stopPropagation();
              }}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  event.stopPropagation();
                }
              }}
              onKeyDownCapture={(event) => {
                if (
                  [
                    "ArrowUp",
                    "ArrowDown",
                    "ArrowLeft",
                    "ArrowRight",
                    "PageUp",
                    "PageDown",
                    "Home",
                    "End",
                    " ",
                  ].includes(event.key)
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                }
              }}
              tabIndex={0}
              onClick={handleViewportClick}
              onContextMenu={handleNodeContextMenu}
            >
              <div
                className="absolute left-0 top-0"
                style={{
                  transform: `translate3d(${panX}px, ${panY}px, 0) scale(${zoom})`,
                  transformOrigin: "0 0",
                }}
              >
                <div className="relative p-4">
                  {renderError ? (
                    <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive-foreground">
                      Mermaid render failed: {renderError}
                    </div>
                  ) : (
                    <SanitizedTopologySvg svgMarkup={svgMarkup} />
                  )}

                  {annotations.map((ann) => (
                    <div
                      key={ann.id}
                      className="absolute rounded-md border border-primary/40 bg-card/90 px-2 py-1 text-[11px] shadow-lg"
                      style={{ left: ann.x, top: ann.y }}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <div className="flex items-center gap-2">
                        <span>{ann.text}</span>
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-foreground"
                          onClick={() =>
                            setAnnotations((prev) => {
                              setAnnotationDiagnostic(null);
                              return prev.filter((x) => x.id !== ann.id);
                            })
                          }
                        >
                          x
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {(modelBuildProgress.running ||
                isRendering ||
                isLoading ||
                topologyResolutionProgress.running ||
                discovering) && (
                <div
                  className={cn(
                    "absolute inset-0 z-20 flex items-center justify-center",
                    loadingOverlayClass,
                  )}
                >
                  <div className="flex min-w-[280px] flex-col gap-2 rounded-lg border border-primary/40 bg-card/85 px-3 py-2 text-xs">
                    <div className="flex items-center gap-2">
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                      {topologyProgressLabel}
                    </div>
                    {activeRequestPreview ? (
                      <div className="line-clamp-2 text-[11px] text-muted-foreground">
                        {activeRequestPreview}
                      </div>
                    ) : null}
                    {(topologyResolutionProgress.running || discovering) && (
                      <div className="h-1.5 w-full rounded bg-primary/20">
                        <div
                          className="h-full rounded bg-primary transition-all duration-200"
                          style={{
                            width: `${Math.round(
                              (Math.min(
                                Math.max(
                                  discovering
                                    ? discoveryProgress.done
                                    : topologyResolutionProgress.done,
                                  0,
                                ),
                                Math.max(
                                  discovering
                                    ? discoveryProgress.total
                                    : topologyResolutionProgress.total,
                                  1,
                                ),
                              ) /
                                Math.max(
                                  discovering
                                    ? discoveryProgress.total
                                    : topologyResolutionProgress.total,
                                  1,
                                )) *
                                100,
                            )}%`,
                          }}
                        />
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
        {fullscreenLightbox}
        {nodeContextMenuPortal}
        <div className="space-y-2">
          <details
            className="rounded-lg border border-border/60 bg-card/55 p-3 text-xs"
            open
          >
            <summary className="cursor-pointer select-none font-semibold">
              Topology summary
            </summary>
            <div className="mt-2 space-y-1 text-muted-foreground">
              {summary.cnameChains.slice(0, 6).map((chain) => (
                <div key={chain.start}>
                  CNAME chain: {chain.chain.join(" -> ")}
                </div>
              ))}
              {summary.sharedIps.slice(0, 8).map((cluster) => (
                <div key={cluster.ip}>
                  Shared IP {cluster.ip}: {cluster.names.join(", ")}
                </div>
              ))}
              {summary.detectedServices.slice(0, 8).map((svc) => (
                <div key={`${svc.name}:${svc.via}`}>
                  Provider: {svc.name} via {svc.via}
                </div>
              ))}
              {summary.mxTrails.slice(0, 10).map((mx) => (
                <div key={`${mx.from}:${mx.priority ?? "na"}:${mx.target}`}>
                  {(() => {
                    const external =
                      externalResolutionByName[
                        normalizeDomain(mx.terminal || mx.target)
                      ];
                    const chain =
                      mx.chain.length > 1
                        ? mx.chain
                        : (external?.chain ?? mx.chain);
                    const ipv4 = mx.ipv4.length
                      ? mx.ipv4
                      : (external?.ipv4 ?? []);
                    const ipv6 = mx.ipv6.length
                      ? mx.ipv6
                      : (external?.ipv6 ?? []);
                    return (
                      <>
                        MX trail {mx.from} (prio {mx.priority ?? "?"}) {"->"}{" "}
                        {mx.target}
                        {chain.length > 1
                          ? ` -> ${chain.slice(1).join(" -> ")}`
                          : ""}
                        {ipv4.length || ipv6.length
                          ? ` | A: ${ipv4.join(", ") || "none"} | AAAA: ${ipv6.join(", ") || "none"}`
                          : " | no terminal A/AAAA found"}
                      </>
                    );
                  })()}
                </div>
              ))}
            </div>
          </details>

          <details
            className="rounded-lg border border-border/60 bg-card/55 p-3 text-xs"
            open
          >
            <summary className="cursor-pointer select-none font-semibold">
              MX records resolved ({mxResolvedRows.total})
            </summary>
            <div className="mt-2 space-y-1 text-muted-foreground">
              {mxResolvedRows.total === 0 ? (
                <div>No MX records found.</div>
              ) : (
                <>
                  {mxResolvedRows.total > mxResolvedRows.visible.length && (
                    <div role="status">
                      Rendering {mxResolvedRows.visible.length} of{" "}
                      {mxResolvedRows.total} MX detail rows.
                    </div>
                  )}
                  {mxResolvedRows.visible.map((mx) => (
                    <div key={mx.id}>
                      {mx.from} | prio {mx.priority ?? "—"} | target{" "}
                      {mx.target || "—"} | chain{" "}
                      {mx.chain.length ? mx.chain.join(" -> ") : "—"} | end{" "}
                      {mx.terminal || "—"} | A {mx.ipv4.join(", ") || "none"} |
                      AAAA {mx.ipv6.join(", ") || "none"} | source {mx.source}
                      {mx.reverse.length > 0
                        ? ` | PTR ${mx.reverse.join("; ")}`
                        : ""}
                    </div>
                  ))}
                </>
              )}
            </div>
          </details>

          <details className="rounded-lg border border-border/60 bg-card/55 p-3 text-xs">
            <summary className="cursor-pointer select-none font-semibold">
              Email and related records ({emailRecordSummary.total})
            </summary>
            <div className="mt-2 space-y-1 text-muted-foreground">
              {emailRecordSummary.total === 0 ? (
                <div>No email records found.</div>
              ) : (
                <>
                  {emailRecordSummary.total >
                    emailRecordSummary.visible.length && (
                    <div role="status">
                      Rendering {emailRecordSummary.visible.length} of{" "}
                      {emailRecordSummary.total} email detail rows.
                    </div>
                  )}
                  {emailRecordSummary.visible.map((record) => (
                    <div key={record.id} className="truncate">
                      {record.type} {record.name} {"->"}{" "}
                      {String(record.content ?? "—")}
                    </div>
                  ))}
                </>
              )}
            </div>
          </details>

          {discovery.length > 0 && (
            <details className="rounded-lg border border-border/60 bg-card/55 p-3 text-xs">
              <summary className="cursor-pointer select-none font-semibold">
                Basic service discovery ({discovery.length})
              </summary>
              <div className="mt-2 space-y-1 text-muted-foreground">
                {discovery.length > visibleDiscovery.length && (
                  <div role="status">
                    Rendering {visibleDiscovery.length} of {discovery.length}{" "}
                    discovery results.
                  </div>
                )}
                {visibleDiscovery.map((item) => (
                  <div key={`${item.service}:${item.details}`}>
                    {item.service}: {item.status} ({item.details})
                  </div>
                ))}
              </div>
            </details>
          )}

          <details className="rounded-lg border border-border/60 bg-card/55 p-3 text-xs">
            <summary className="cursor-pointer select-none font-semibold">
              Nodes ({summary.nodeSummaries.length})
            </summary>
            <div className="mt-2 space-y-2 max-h-72 overflow-auto pr-1">
              {summary.nodeSummaries.length > visibleNodeSummaries.length && (
                <div role="status" className="text-muted-foreground">
                  Rendering {visibleNodeSummaries.length} of{" "}
                  {summary.nodeSummaries.length} node summaries.
                </div>
              )}
              {visibleNodeSummaries.map((node) => (
                <div
                  key={node.name}
                  className="rounded-md border border-border/50 bg-background/25 p-2"
                >
                  <div className="font-medium">{node.name}</div>
                  {node.resolvedTo.length > 0 && (
                    <div className="text-muted-foreground">
                      CNAME resolves: {node.resolvedTo.join(" -> ")}
                    </div>
                  )}
                  {(() => {
                    const external =
                      externalResolutionByName[
                        normalizeDomain(node.terminal || node.name)
                      ];
                    const ipv4 = node.ipv4.length
                      ? node.ipv4
                      : (external?.ipv4 ?? []);
                    const ipv6 = node.ipv6.length
                      ? node.ipv6
                      : (external?.ipv6 ?? []);
                    const chain = node.resolvedTo.length
                      ? [node.name, ...node.resolvedTo]
                      : (external?.chain ?? [node.name]);
                    const ptr = Object.entries(
                      external?.reverseHostnamesByIp ?? {},
                    ).flatMap(([ip, hosts]) =>
                      hosts.map((host) => `${ip} => ${host}`),
                    );
                    if (!ipv4.length && !ipv6.length && chain.length <= 1)
                      return null;
                    return (
                      <div className="text-muted-foreground">
                        Chain: {chain.join(" -> ")} | End node:{" "}
                        {node.terminal || external?.terminal || node.name} |
                        IPv4: {ipv4.join(", ") || "none"} | IPv6:{" "}
                        {ipv6.join(", ") || "none"}
                        {ptr.length > 0 ? ` | PTR: ${ptr.join("; ")}` : ""}
                      </div>
                    );
                  })()}
                  <div className="mt-1 space-y-1">
                    {node.records.slice(0, 8).map((record) => (
                      <div
                        key={record.id}
                        className="flex items-center justify-between gap-2 rounded bg-background/30 px-2 py-1"
                      >
                        <div className="min-w-0">
                          <div className="truncate">
                            <span className="font-medium">{record.type}</span>{" "}
                            <span className="text-muted-foreground">
                              {String(record.content ?? "—")}
                            </span>
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            TTL: {String(record.ttl ?? "auto")}{" "}
                            {record.proxied ? "| Proxied" : "| DNS only"}
                          </div>
                        </div>
                        {onEditRecord && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2"
                            onClick={() => onEditRecord(record)}
                          >
                            <Edit3 className="h-3.5 w-3.5 mr-1" />
                            Edit
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </details>
        </div>
      </CardContent>
    </Card>
  );
}

ZoneTopologyTab.copyTopologyText = copyTopologyText;
ZoneTopologyTab.runTopologyRefresh = runTopologyRefresh;
ZoneTopologyTab.buildTopologyGraphModelProgressively =
  buildTopologyGraphModelProgressively;
ZoneTopologyTab.filterTopologyModelNodes = filterTopologyModelNodes;
ZoneTopologyTab.yieldTopologyConstruction = yieldTopologyConstruction;
