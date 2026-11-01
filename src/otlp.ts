// OTLP/HTTP JSON encoding and a small batching exporter. No dependencies.
// Attribute values are limited to strings, numbers and booleans by type, and
// every caller builds its attributes from ids, enums and numbers only.

export type AttrValue = string | number | boolean;
export type Attrs = Record<string, AttrValue | undefined>;

const anyValue = (v: AttrValue) =>
  typeof v === "string"
    ? { stringValue: v }
    : typeof v === "boolean"
      ? { boolValue: v }
      : Number.isInteger(v)
        ? { intValue: String(v) }
        : { doubleValue: v };

export const encodeAttrs = (a: Attrs) =>
  Object.entries(a)
    .filter((e): e is [string, AttrValue] => e[1] !== undefined)
    .map(([key, v]) => ({ key, value: anyValue(v) }));

const nano = (ms: number) => String(Math.round(ms) * 1_000_000);

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startMs: number;
  endMs: number;
  error?: boolean;
  attrs: Attrs;
}

export const SCOPE = { name: "bb-plugin-otel" };

export function tracesBody(resource: Attrs, version: string, spans: readonly Span[]) {
  return {
    resourceSpans: [
      {
        resource: { attributes: encodeAttrs(resource) },
        scopeSpans: [
          {
            scope: { ...SCOPE, version },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: 1,
              startTimeUnixNano: nano(s.startMs),
              endTimeUnixNano: nano(s.endMs),
              attributes: encodeAttrs(s.attrs),
              // The status message is left out on purpose: it would carry error text.
              status: { code: s.error ? 2 : 1 },
            })),
          },
        ],
      },
    ],
  };
}

export const TOKEN_BOUNDS = [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864];
export const DURATION_BOUNDS = [0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92];

interface Series {
  name: string;
  attrs: Attrs;
}
interface SumSeries extends Series {
  value: number;
}
interface HistSeries extends Series {
  count: number;
  sum: number;
  buckets: number[];
  bounds: readonly number[];
}
interface GaugeSeries extends Series {
  value: number;
}
export interface MetricMeta {
  unit: string;
  description: string;
}

/**
 * Cumulative in-memory metrics. A flush exports only the series that changed since the
 * last delivered export, or every series when `full` is set (a periodic refresh), so an
 * idle bb sends nothing.
 */
export class Meter {
  private sums = new Map<string, SumSeries>();
  private hists = new Map<string, HistSeries>();
  private gauges = new Map<string, GaugeSeries>();
  private meta = new Map<string, MetricMeta>();
  private changed = new Set<string>();
  readonly startMs = Date.now();

  describe(name: string, unit: string, description: string) {
    this.meta.set(name, { unit, description });
  }
  private key(name: string, attrs: Attrs) {
    return name + "|" + JSON.stringify(Object.entries(attrs).filter((e) => e[1] !== undefined).sort());
  }
  add(name: string, attrs: Attrs, value: number) {
    const k = this.key(name, attrs);
    const s = this.sums.get(k) ?? { name, attrs, value: 0 };
    s.value += value;
    this.sums.set(k, s);
    this.changed.add(k);
  }
  record(name: string, attrs: Attrs, value: number, bounds: readonly number[]) {
    const k = this.key(name, attrs);
    const h = this.hists.get(k) ?? { name, attrs, count: 0, sum: 0, bounds, buckets: new Array(bounds.length + 1).fill(0) };
    h.count += 1;
    h.sum += value;
    let i = bounds.findIndex((b) => value <= b);
    if (i < 0) i = bounds.length;
    h.buckets[i]! += 1;
    this.hists.set(k, h);
    this.changed.add(k);
  }
  /** Replaces every gauge of `name` so that a window that vanished stops being reported. */
  setGauges(name: string, points: readonly { attrs: Attrs; value: number }[]) {
    for (const [k, g] of this.gauges) if (g.name === name) this.gauges.delete(k);
    for (const p of points) {
      const k = this.key(name, p.attrs);
      this.gauges.set(k, { name, attrs: p.attrs, value: p.value });
      this.changed.add(k);
    }
  }
  get empty() {
    return this.sums.size + this.hists.size + this.gauges.size === 0;
  }

  /**
   * Takes the series to export: the changed ones, or all when `full`. Returns null when
   * there is nothing to send. Call `restore` with the keys when delivery fails.
   */
  collect(resource: Attrs, version: string, nowMs: number, full: boolean): { body: ReturnType<Meter["body"]>; keys: string[] } | null {
    const keys = full ? [...this.sums.keys(), ...this.hists.keys(), ...this.gauges.keys()] : [...this.changed];
    if (keys.length === 0) return null;
    const pick = new Set(keys);
    this.changed.clear();
    return { body: this.body(resource, version, nowMs, (k) => pick.has(k)), keys };
  }
  restore(keys: readonly string[]) {
    for (const k of keys) if (this.sums.has(k) || this.hists.has(k) || this.gauges.has(k)) this.changed.add(k);
  }

  body(resource: Attrs, version: string, nowMs: number, include: (key: string) => boolean = () => true) {
    const start = nano(this.startMs);
    const now = nano(nowMs);
    const info = (name: string) => ({ name, unit: this.meta.get(name)?.unit ?? "", description: this.meta.get(name)?.description ?? "" });
    const byName = <T extends Series>(m: Map<string, T>) => {
      const out = new Map<string, T[]>();
      for (const [k, s] of m) if (include(k)) out.set(s.name, [...(out.get(s.name) ?? []), s]);
      return out;
    };
    const metrics: unknown[] = [];
    for (const [name, list] of byName(this.sums))
      metrics.push({
        ...info(name),
        sum: {
          aggregationTemporality: 2,
          isMonotonic: true,
          dataPoints: list.map((s) => ({ attributes: encodeAttrs(s.attrs), startTimeUnixNano: start, timeUnixNano: now, asDouble: s.value })),
        },
      });
    for (const [name, list] of byName(this.hists))
      metrics.push({
        ...info(name),
        histogram: {
          aggregationTemporality: 2,
          dataPoints: list.map((h) => ({
            attributes: encodeAttrs(h.attrs),
            startTimeUnixNano: start,
            timeUnixNano: now,
            count: String(h.count),
            sum: h.sum,
            bucketCounts: h.buckets.map(String),
            explicitBounds: h.bounds,
          })),
        },
      });
    for (const [name, list] of byName(this.gauges))
      metrics.push({
        ...info(name),
        gauge: { dataPoints: list.map((g) => ({ attributes: encodeAttrs(g.attrs), timeUnixNano: now, asDouble: g.value })) },
      });
    return {
      resourceMetrics: [
        { resource: { attributes: encodeAttrs(resource) }, scopeMetrics: [{ scope: { ...SCOPE, version }, metrics }] },
      ],
    };
  }
}

/** "a=b,c=d" as in OTEL_EXPORTER_OTLP_HEADERS; values may contain "=". */
export function parseKeyValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of text.split(",")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const dec = (s: string) => {
      try {
        return decodeURIComponent(s.trim());
      } catch {
        return s.trim();
      }
    };
    out[dec(part.slice(0, i))] = dec(part.slice(i + 1));
  }
  return out;
}

export interface ExporterConfig {
  endpoint: string;
  headers: Record<string, string>;
  timeoutMs?: number;
}

export type Post = (path: "/v1/traces" | "/v1/metrics", body: unknown) => Promise<void>;

export function makePost(cfg: ExporterConfig, fetchFn: typeof fetch = fetch): Post {
  const base = cfg.endpoint.replace(/\/+$/, "");
  return async (path, body) => {
    const res = await fetchFn(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...cfg.headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 10_000),
    });
    if (!res.ok) throw new Error(`${path} returned HTTP ${res.status}`);
    await res.arrayBuffer().catch(() => undefined);
  };
}

/** Spans wait here until a flush delivers them; the oldest drop first when full. */
export class SpanQueue {
  private items: Span[] = [];
  dropped = 0;
  constructor(private readonly max = 5000) {}
  push(...spans: Span[]) {
    this.items.push(...spans);
    const over = this.items.length - this.max;
    if (over > 0) {
      this.items.splice(0, over);
      this.dropped += over;
    }
  }
  take(n = 500): Span[] {
    return this.items.splice(0, n);
  }
  get size() {
    return this.items.length;
  }
}
