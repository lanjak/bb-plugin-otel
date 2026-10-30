import type { FinishedTurn } from "./fold.js";
import { DURATION_BOUNDS, Meter, SpanQueue, TOKEN_BOUNDS, type Attrs } from "./otlp.js";
import { threadSpanIdOf, traceIdOf, turnSpanIdOf } from "./ids.js";

export interface ThreadCtx {
  threadId: string;
  projectId: string;
  projectName?: string;
  environmentId: string | null;
  providerId: string;
  parentThreadId: string | null;
  rootThreadId: string;
  originPluginId: string | null;
}

export interface Enabled {
  traces: boolean;
  metrics: boolean;
}

// Only harnesses whose model vendor is certain are named; anything else leaves the attribute out.
const VENDOR: Record<string, string> = { "claude-code": "anthropic", codex: "openai" };

export class Telemetry {
  readonly meter = new Meter();
  readonly queue = new SpanQueue();

  constructor(private isEnabled: () => Enabled) {
    const m = this.meter;
    m.describe("gen_ai.client.token.usage", "{token}", "Input and output tokens per bb turn");
    m.describe("gen_ai.client.operation.duration", "s", "Duration of a bb turn");
    m.describe("bb.gen_ai.client.cache_tokens", "{token}", "Cache read and write tokens per bb turn");
    m.describe("bb.gen_ai.client.cost", "USD", "Cost the provider reported for bb turns");
    m.describe("bb.turns", "{turn}", "Finished bb turns");
    m.describe("bb.thread.transitions", "{event}", "bb thread lifecycle events");
    m.describe("bb.thread.active.duration", "s", "Time a bb thread stayed active");
    m.describe("bb.automation.runs", "{run}", "Finished threads started by automations");
    m.describe("bb.provider.usage.used_percent", "%", "Provider quota window used");
    m.describe("bb.provider.usage.reset_time", "s", "Provider quota window reset, unix seconds");
    m.describe("bb.provider.usage.cost_used", "USD", "Spend in a provider quota window");
    m.describe("bb.provider.usage.cost_limit", "USD", "Spend limit of a provider quota window");
  }

  static spanAttrs(c: ThreadCtx): Attrs {
    return {
      "bb.thread.id": c.threadId,
      "bb.project.id": c.projectId,
      "bb.project.name": c.projectName,
      "bb.environment.id": c.environmentId ?? undefined,
      "bb.provider.id": c.providerId,
      "bb.parent_thread.id": c.parentThreadId ?? undefined,
      "bb.root_thread.id": c.rootThreadId,
      "bb.origin.plugin": c.originPluginId ?? undefined,
      "bb.automation.run": c.originPluginId === "automations" ? true : undefined,
    };
  }

  turn(c: ThreadCtx, t: FinishedTurn) {
    const model = t.model ?? "unknown";
    const failed = t.status === "failed";
    const seconds = Math.max(0, t.endedAt - t.startedAt) / 1000;
    const enabled = this.isEnabled();
    if (enabled.traces)
      this.queue.push({
        traceId: traceIdOf(c.rootThreadId),
        spanId: turnSpanIdOf(c.threadId, t.startedAt, t.startSeq),
        parentSpanId: threadSpanIdOf(c.threadId),
        name: `chat ${model}`,
        startMs: t.startedAt,
        endMs: t.endedAt,
        error: failed,
        attrs: {
          ...Telemetry.spanAttrs(c),
          "gen_ai.operation.name": "chat",
          "gen_ai.request.model": model,
          "gen_ai.provider.name": VENDOR[c.providerId],
          "gen_ai.usage.input_tokens": t.tokens.input,
          "gen_ai.usage.output_tokens": t.tokens.output,
          "gen_ai.usage.cache_read.input_tokens": t.tokens.cacheRead,
          "gen_ai.usage.cache_creation.input_tokens": t.tokens.cacheWrite,
          "bb.usage.reasoning_tokens": t.tokens.reasoning,
          "bb.cost.usd": t.usd || undefined,
          "bb.turn.status": t.status,
          "bb.turn.initiator": t.initiator ?? undefined,
          // The provider's own session id: Claude Code reports it as session.id.
          "session.id": t.providerThreadId ?? undefined,
          "error.type": failed ? "turn_failed" : undefined,
        },
      });
    if (!enabled.metrics) return;
    const base: Attrs = {
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": model,
      "gen_ai.provider.name": VENDOR[c.providerId],
      "bb.provider.id": c.providerId,
      "bb.project.id": c.projectId,
    };
    const m = this.meter;
    m.record("gen_ai.client.token.usage", { ...base, "gen_ai.token.type": "input" }, t.tokens.input, TOKEN_BOUNDS);
    m.record("gen_ai.client.token.usage", { ...base, "gen_ai.token.type": "output" }, t.tokens.output, TOKEN_BOUNDS);
    m.add("bb.gen_ai.client.cache_tokens", { ...base, "bb.cache.type": "read" }, t.tokens.cacheRead);
    m.add("bb.gen_ai.client.cache_tokens", { ...base, "bb.cache.type": "write" }, t.tokens.cacheWrite);
    if (t.usd > 0) m.add("bb.gen_ai.client.cost", base, t.usd);
    m.record("gen_ai.client.operation.duration", { ...base, "error.type": failed ? "turn_failed" : undefined }, seconds, DURATION_BOUNDS);
    m.add("bb.turns", { ...base, "bb.turn.status": t.status }, 1);
  }

  /** A thread lifecycle event; `activeMs` is set when an active stretch ended. */
  lifecycle(c: ThreadCtx, state: string, activeMs?: number) {
    if (!this.isEnabled().metrics) return;
    const a: Attrs = { "bb.thread.state": state, "bb.provider.id": c.providerId, "bb.project.id": c.projectId };
    this.meter.add("bb.thread.transitions", a, 1);
    if (activeMs !== undefined) this.meter.record("bb.thread.active.duration", { "bb.provider.id": c.providerId, "bb.project.id": c.projectId }, activeMs / 1000, DURATION_BOUNDS);
    if (c.originPluginId === "automations" && (state === "idle" || state === "failed"))
      this.meter.add("bb.automation.runs", { "bb.thread.state": state, "bb.project.id": c.projectId }, 1);
  }

  /** The thread's own span, children of its parent's span; sent once when it is archived or deleted. */
  threadSpan(c: ThreadCtx, createdAt: number, endedAt: number, state: string) {
    if (!this.isEnabled().traces) return;
    this.queue.push({
      traceId: traceIdOf(c.rootThreadId),
      spanId: threadSpanIdOf(c.threadId),
      parentSpanId: c.parentThreadId ? threadSpanIdOf(c.parentThreadId) : undefined,
      name: "bb.thread",
      startMs: createdAt,
      endMs: endedAt,
      attrs: { ...Telemetry.spanAttrs(c), "bb.thread.final_state": state },
    });
  }
}

export interface UsageWindowInput {
  machineId: string;
  providerId: string;
  planLabel: string | null;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  cost: { usedUsdCents: number; limitUsdCents: number } | null;
}

/** Sets the provider quota gauges. Account email and display names are not exported. */
export function setUsageGauges(meter: Meter, windows: readonly UsageWindowInput[]) {
  const attrs = (w: UsageWindowInput): Attrs => ({
    "bb.machine.id": w.machineId,
    "bb.provider.id": w.providerId,
    "bb.provider.plan": w.planLabel ?? undefined,
    "bb.usage.window": w.label,
  });
  meter.setGauges("bb.provider.usage.used_percent", windows.map((w) => ({ attrs: attrs(w), value: w.usedPercent })));
  meter.setGauges(
    "bb.provider.usage.reset_time",
    windows.flatMap((w) => {
      const t = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
      return Number.isFinite(t) ? [{ attrs: attrs(w), value: t / 1000 }] : [];
    }),
  );
  meter.setGauges("bb.provider.usage.cost_used", windows.flatMap((w) => (w.cost ? [{ attrs: attrs(w), value: w.cost.usedUsdCents / 100 }] : [])));
  meter.setGauges("bb.provider.usage.cost_limit", windows.flatMap((w) => (w.cost ? [{ attrs: attrs(w), value: w.cost.limitUsdCents / 100 }] : [])));
}
