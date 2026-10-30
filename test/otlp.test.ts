import { describe, expect, it } from "vitest";
import { encodeAttrs, Meter, parseKeyValues, SpanQueue, tracesBody } from "../src/otlp.js";
import { setUsageGauges } from "../src/telemetry.js";

describe("otlp", () => {
  it("encodes attribute types and drops undefined", () => {
    expect(encodeAttrs({ a: "x", b: 3, c: 1.5, d: true, e: undefined })).toEqual([
      { key: "a", value: { stringValue: "x" } },
      { key: "b", value: { intValue: "3" } },
      { key: "c", value: { doubleValue: 1.5 } },
      { key: "d", value: { boolValue: true } },
    ]);
  });

  it("parses header lists with = inside values", () => {
    expect(parseKeyValues("x-otlp-token=a=b==, k = v%20w ,bad,=x")).toEqual({ "x-otlp-token": "a=b==", k: "v w" });
  });

  it("never writes a span status message", () => {
    const body = tracesBody({}, "1", [{ traceId: "t", spanId: "s", name: "n", startMs: 1, endMs: 2, error: true, attrs: {} }]);
    const span = body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(span.status).toEqual({ code: 2 });
    expect(span.startTimeUnixNano).toBe("1000000");
  });

  it("keeps cumulative sums and histograms and replaces gauges", () => {
    const m = new Meter();
    m.add("c", { a: "1" }, 2);
    m.add("c", { a: "1" }, 3);
    m.record("h", {}, 5, [1, 10]);
    m.record("h", {}, 50, [1, 10]);
    setUsageGauges(m, [{ machineId: "m", providerId: "p", planLabel: null, label: "5h", usedPercent: 40, resetsAt: "2026-01-01T00:00:00Z", cost: null }]);
    setUsageGauges(m, [{ machineId: "m", providerId: "p", planLabel: null, label: "7d", usedPercent: 10, resetsAt: null, cost: { usedUsdCents: 250, limitUsdCents: 1000 } }]);
    const metrics = (m.body({}, "1", 5000).resourceMetrics[0]!.scopeMetrics[0]!.metrics as Record<string, any>[]);
    const by = (n: string) => metrics.find((x) => x.name === n)!;
    expect(by("c").sum.dataPoints[0].asDouble).toBe(5);
    expect(by("h").histogram.dataPoints[0]).toMatchObject({ count: "2", sum: 55, bucketCounts: ["0", "1", "1"] });
    expect(by("bb.provider.usage.used_percent").gauge.dataPoints).toHaveLength(1);
    expect(by("bb.provider.usage.cost_used").gauge.dataPoints[0].asDouble).toBe(2.5);
    expect(metrics.some((x) => x.name === "bb.provider.usage.reset_time")).toBe(false);
  });

  it("drops the oldest spans when the queue is full", () => {
    const q = new SpanQueue(2);
    const sp = (n: string) => ({ traceId: "t", spanId: n, name: n, startMs: 0, endMs: 0, attrs: {} });
    q.push(sp("a"), sp("b"), sp("c"));
    expect(q.dropped).toBe(1);
    expect(q.take().map((s) => s.spanId)).toEqual(["b", "c"]);
  });
});
