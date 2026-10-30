import { describe, expect, it } from "vitest";
import { fold, newState, type EventRow } from "../src/fold.js";

const totals = (input: number, output: number, cacheRead = 0) => ({
  totalTokens: input + output + cacheRead,
  inputTokens: input,
  cachedInputTokens: cacheRead,
  cacheReadInputTokens: cacheRead,
  outputTokens: output,
  reasoningOutputTokens: 0,
});
let seq = 0;
const row = (type: string, data: unknown, createdAt = 1000 + seq * 10): EventRow => ({ seq: ++seq, createdAt, type, data });
const usage = (id: string, total: ReturnType<typeof totals>, last = total) =>
  row("thread/tokenUsage/updated", { providerThreadId: id, tokenUsage: { total, last, modelContextWindow: null } });

describe("fold", () => {
  it("turns cumulative totals into per-turn deltas", () => {
    seq = 0;
    const s = newState(0);
    const done = fold(s, [
      row("client/turn/requested", { execution: { model: "m1" }, initiator: "user", target: { kind: "new" } }),
      row("thread/identity", { providerThreadId: "sess" }),
      row("turn/started", { providerThreadId: "sess" }),
      usage("sess", totals(100, 10)),
      usage("sess", totals(250, 30, 50), totals(150, 20, 50)),
      row("turn/completed", { status: "completed" }),
      row("turn/started", {}),
      usage("sess", totals(300, 40, 50), totals(50, 10)),
      row("turn/completed", { status: "failed", error: { message: "SECRET ERROR TEXT" } }),
    ]);
    expect(done).toHaveLength(2);
    expect(done[0]).toMatchObject({ model: "m1", initiator: "user", status: "completed", providerThreadId: "sess", tokens: { input: 250, output: 30, cacheRead: 50 } });
    expect(done[1]).toMatchObject({ status: "failed", tokens: { input: 50, output: 10, cacheRead: 0 } });
    expect(JSON.stringify(done)).not.toContain("SECRET");
  });

  it("counts a restarted worker in full and sums cost gains", () => {
    seq = 0;
    const s = newState(0);
    const cost = (amount: number) => row("thread/contextWindowUsage/updated", { providerThreadId: "a", contextWindowUsage: { cost: { amount, currency: "USD" } } });
    const done = fold(s, [
      row("turn/started", {}),
      usage("a", totals(100, 10)),
      usage("a", totals(20, 5), totals(20, 5)), // lower total: worker restarted
      cost(0.5),
      cost(0.75),
      row("thread/contextWindowUsage/updated", { providerThreadId: "a", contextWindowUsage: { cost: { amount: 9, currency: "EUR" } } }),
      row("turn/completed", { status: "completed" }),
    ]);
    expect(done[0]!.tokens).toMatchObject({ input: 120, output: 15 });
    expect(done[0]!.usd).toBeCloseTo(0.75);
  });

  it("skips rows it has already seen", () => {
    seq = 0;
    const s = newState(0);
    const rows = [row("turn/started", {}), row("turn/completed", { status: "completed" })];
    expect(fold(s, rows)).toHaveLength(1);
    expect(fold(s, rows)).toHaveLength(0);
  });
});
