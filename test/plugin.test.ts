import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../server.js";
import { threadSpanIdOf, traceIdOf } from "../src/ids.js";

const CANARY = "CANARY-PROMPT-TEXT-do-not-export";

interface Hit { path: string; headers: IncomingMessage["headers"]; body: any }

async function collector(status = 200) {
  const hits: Hit[] = [];
  let code = status;
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      hits.push({ path: req.url!, headers: req.headers, body: JSON.parse(raw) });
      res.statusCode = code;
      res.end("{}");
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { hits, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, setStatus: (s: number) => (code = s), close: () => srv.close() };
}

const thread = (id: string, over: Record<string, unknown> = {}) => ({
  id, projectId: "proj_1", environmentId: "env_1", providerId: "claude-code", parentThreadId: null, originPluginId: null,
  title: CANARY, createdAt: Date.now() + 1000, ...over,
});

function ev(threadId: string, rows: [string, unknown][]) {
  return rows.map(([type, data], i) => ({ id: `e${i}`, threadId, seq: i + 1, createdAt: 5000 + i * 100, type, data }));
}

async function setup(url: string, settings: Record<string, unknown> = {}, events: Record<string, any[]> = {}, usage: unknown = { machines: [] }) {
  const handlers = new Map<string, (p: any) => unknown>();
  const kv = new Map<string, unknown>();
  let service: ((s: AbortSignal) => Promise<void>) | undefined;
  let onChange: ((v: any) => void) | undefined;
  const logs: string[] = [];
  const values: Record<string, unknown> = {
    endpoint: url, headers: "x-otlp-token=tok123", resourceAttributes: "deployment.environment=test", traces: true, metrics: true,
    usageWindows: true, flushSeconds: 3600, usagePollSeconds: 300, ...settings,
  };
  let disposeHook: (() => unknown) | undefined;
  const bb: any = {
    log: { debug: () => {}, info: () => {}, warn: (m: string) => logs.push(m), error: () => {} },
    settings: { define: () => ({ get: async () => values, onChange: (f: any) => (onChange = f) }) },
    status: { needsConfiguration: (m: string) => logs.push(`needs: ${m}`) },
    storage: { kv: { get: async (k: string) => kv.get(k), set: async (k: string, v: unknown) => void kv.set(k, structuredClone(v)), delete: async (k: string) => void kv.delete(k) } },
    events: { on: (n: string, f: any) => void handlers.set(n, f) },
    background: { service: (_: string, s: any) => (service = s.start) },
    onDispose: (f: () => unknown) => (disposeHook = f),
    sdk: {
      projects: { get: async () => ({ name: "personal" }) },
      threads: {
        get: async ({ threadId }: { threadId: string }) => thread(threadId, threadId === "child" ? { parentThreadId: "root" } : {}),
        events: {
          list: async ({ threadId, order, afterSeq, limit }: any) => {
            let rows = events[threadId] ?? [];
            if (afterSeq !== undefined) rows = rows.filter((r) => r.seq > Number(afterSeq));
            if (order === "desc") rows = [...rows].reverse();
            return rows.slice(0, Number(limit));
          },
        },
      },
      plugins: { callRpc: async ({ outputSchema }: any) => outputSchema.parse(usage) },
    },
  };
  await plugin(bb);
  const ac = new AbortController();
  return {
    emit: async (name: string, t: any) => { await handlers.get(name)!({ thread: t }); },
    run: async () => { const done = service!(ac.signal); await new Promise((r) => setTimeout(r, 150)); ac.abort(); await done; },
    flush: async () => disposeHook!(),
    setSettings: (v: Record<string, unknown>) => onChange!({ ...values, ...v }),
    logs,
  };
}

const turnEvents = (extra: [string, unknown][] = []) =>
  ev("t1", [
    ["client/turn/requested", { execution: { model: "claude-x" }, initiator: "user", target: { kind: "new" }, input: [{ type: "text", text: CANARY }] }],
    ["thread/identity", { providerThreadId: "sess-1" }],
    ["turn/started", { providerThreadId: "sess-1" }],
    ["item/agentMessage/delta", { delta: CANARY }],
    ["thread/tokenUsage/updated", { providerThreadId: "sess-1", tokenUsage: { total: { totalTokens: 130, inputTokens: 100, cachedInputTokens: 20, cacheReadInputTokens: 20, outputTokens: 30, reasoningOutputTokens: 0 }, last: {}, modelContextWindow: null } }],
    ["thread/contextWindowUsage/updated", { providerThreadId: "sess-1", contextWindowUsage: { usedTokens: 1, modelContextWindow: 2, estimated: false, cost: { amount: 0.25, currency: "USD" } } }],
    ["turn/completed", { providerThreadId: "sess-1", status: "failed", error: { message: CANARY } }],
    ...extra,
  ]);

const closers: (() => void)[] = [];
afterEach(() => closers.splice(0).forEach((c) => c()));

describe("plugin", () => {
  it("exports a turn span and metrics, with the token header, and never any text", async () => {
    const c = await collector();
    closers.push(c.close);
    const t = thread("t1");
    const p = await setup(c.url, {}, { t1: turnEvents() });
    await p.emit("thread.active", t);
    await p.emit("thread.failed", t);
    await p.flush();

    const traces = c.hits.find((h) => h.path === "/v1/traces")!;
    const metrics = c.hits.find((h) => h.path === "/v1/metrics")!;
    expect(traces.headers["x-otlp-token"]).toBe("tok123");
    const attrs = (o: any) => Object.fromEntries(o.attributes.map((a: any) => [a.key, Object.values(a.value)[0]]));
    expect(attrs(traces.body.resourceSpans[0].resource)).toMatchObject({ "service.name": "bb", "deployment.environment": "test" });
    const span = traces.body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.name).toBe("chat claude-x");
    expect(span.status).toEqual({ code: 2 });
    expect(span.traceId).toBe(traceIdOf("t1"));
    expect(span.parentSpanId).toBe(threadSpanIdOf("t1"));
    expect(attrs(span)).toMatchObject({
      "bb.thread.id": "t1", "bb.project.id": "proj_1", "bb.project.name": "personal", "session.id": "sess-1",
      "gen_ai.request.model": "claude-x", "gen_ai.usage.input_tokens": "100", "gen_ai.usage.output_tokens": "30",
      "gen_ai.usage.cache_read.input_tokens": "20", "bb.turn.status": "failed",
    });
    const names = metrics.body.resourceMetrics[0].scopeMetrics[0].metrics.map((m: any) => m.name);
    expect(names).toEqual(expect.arrayContaining(["gen_ai.client.token.usage", "gen_ai.client.operation.duration", "bb.gen_ai.client.cost", "bb.thread.transitions"]));
    // Privacy: prompt, reply, error text and the thread title appear nowhere on the wire.
    expect(JSON.stringify(c.hits)).not.toContain(CANARY);
  });

  it("puts a child thread in its parent's trace, under the parent's thread span", async () => {
    const c = await collector();
    closers.push(c.close);
    const rows = ev("child", [["turn/started", {}], ["turn/completed", { status: "completed" }]]);
    const p = await setup(c.url, {}, { child: rows });
    await p.emit("thread.idle", thread("child", { parentThreadId: "root" }));
    await p.emit("thread.deleted", thread("child", { parentThreadId: "root" }));
    await p.flush();
    const spans = c.hits.find((h) => h.path === "/v1/traces")!.body.resourceSpans[0].scopeSpans[0].spans;
    const thr = spans.find((s: any) => s.name === "bb.thread");
    expect(spans.every((s: any) => s.traceId === traceIdOf("root"))).toBe(true);
    expect(thr.parentSpanId).toBe(threadSpanIdOf("root"));
  });

  it("does not replay history of a thread that predates the plugin", async () => {
    const c = await collector();
    closers.push(c.close);
    const p = await setup(c.url, {}, { t1: turnEvents() });
    await p.emit("thread.idle", thread("t1", { createdAt: 1 }));
    await p.flush();
    expect(c.hits.find((h) => h.path === "/v1/traces")).toBeUndefined();
  });

  it("honours the per-signal switches", async () => {
    const c = await collector();
    closers.push(c.close);
    const p = await setup(c.url, { traces: false }, { t1: turnEvents() });
    await p.emit("thread.idle", thread("t1"));
    await p.flush();
    expect(c.hits.map((h) => h.path)).toEqual(["/v1/metrics"]);
  });

  it("exports provider usage windows as gauges and no account details", async () => {
    const c = await collector();
    closers.push(c.close);
    const usage = { machines: [{ id: "m1", displayName: "box", providers: [{ providerId: "claude-code", accountLabel: "me@example.com", usage: { status: "ok", accountEmail: "me@example.com", planLabel: "Max", windows: [{ label: "5 hour", usedPercent: 42, resetsAt: "2026-10-30T12:00:00Z", cost: null }] } }] }] };
    const p = await setup(c.url, {}, {}, usage);
    await p.run();
    const m = c.hits.find((h) => h.path === "/v1/metrics")!.body.resourceMetrics[0].scopeMetrics[0].metrics;
    const g = m.find((x: any) => x.name === "bb.provider.usage.used_percent").gauge.dataPoints[0];
    expect(g.asDouble).toBe(42);
    expect(JSON.stringify(c.hits)).not.toContain("example.com");
  });

  it("keeps spans when the collector fails and delivers them on the next flush", async () => {
    const c = await collector(503);
    closers.push(c.close);
    const p = await setup(c.url, {}, { t1: turnEvents() });
    await p.emit("thread.idle", thread("t1"));
    await p.flush();
    expect(p.logs.some((l) => l.includes("HTTP 503"))).toBe(true);
    c.setStatus(200);
    c.hits.length = 0;
    await p.flush();
    expect(c.hits.some((h) => h.path === "/v1/traces")).toBe(true);
  });

  it("asks for configuration when no endpoint is set", async () => {
    const p = await setup("", {});
    expect(p.logs.some((l) => l.startsWith("needs:"))).toBe(true);
  });
});
