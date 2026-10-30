// Folds a thread's event rows into finished turns. Reads only ids, enums, model
// names and numbers; no event text field is ever touched.

export interface EventRow {
  seq: number;
  createdAt: number;
  type: string;
  // biome-ignore lint: event payloads differ by type; fields are read one by one below
  data: any;
}

export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export interface Totals {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface OpenTurn {
  startSeq: number;
  startedAt: number;
  model: string | null;
  initiator: string | null;
  tokens: Tokens;
  usd: number;
}

export interface ThreadState {
  afterSeq: number;
  model: string | null;
  initiator: string | null;
  providerThreadId: string | null;
  sessions: Record<string, { total: Totals | null; usd: number | null }>;
  turn: OpenTurn | null;
}

export interface FinishedTurn extends OpenTurn {
  endedAt: number;
  endSeq: number;
  status: "completed" | "failed" | "interrupted";
  providerThreadId: string | null;
}

export const USAGE_EVENT_TYPES = [
  "client/turn/requested",
  "thread/identity",
  "turn/started",
  "turn/completed",
  "thread/tokenUsage/updated",
  "thread/contextWindowUsage/updated",
] as const;

export const newState = (afterSeq: number): ThreadState => ({
  afterSeq,
  model: null,
  initiator: null,
  providerThreadId: null,
  sessions: {},
  turn: null,
});

const zero = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
const FIELDS = [
  "totalTokens",
  "inputTokens",
  "cachedInputTokens",
  "cacheReadInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
] as const;
const same = (a: Totals, b: Totals) => FIELDS.every((f) => a[f] === b[f]);

/** What a session's new cumulative total adds; a restarted worker counts in full. */
function added(prev: Totals | null, total: Totals, last: Totals): Totals {
  if (prev === null) return total;
  const restarted =
    total.totalTokens < prev.totalTokens ||
    (prev.totalTokens > 0 && same(total, last) && !same(total, prev));
  if (restarted) return total;
  const out = { ...total };
  for (const f of FIELDS) {
    const v = total[f];
    if (v !== undefined) out[f] = Math.max(0, v - (prev[f] ?? 0));
  }
  return out;
}

function tokensOf(t: Totals): Tokens {
  const cacheWrite = t.cacheWriteInputTokens ?? 0;
  const cacheRead = t.cacheReadInputTokens ?? Math.max(0, t.cachedInputTokens - cacheWrite);
  return { input: t.inputTokens, output: t.outputTokens, cacheRead, cacheWrite, reasoning: t.reasoningOutputTokens };
}

function open(state: ThreadState, row: EventRow): OpenTurn {
  state.turn ??= {
    startSeq: row.seq,
    startedAt: row.createdAt,
    model: state.model,
    initiator: state.initiator,
    tokens: zero(),
    usd: 0,
  };
  return state.turn;
}

/** Applies rows (oldest first) to `state` and returns the turns they finished. */
export function fold(state: ThreadState, rows: readonly EventRow[]): FinishedTurn[] {
  const done: FinishedTurn[] = [];
  for (const row of rows) {
    if (row.seq <= state.afterSeq) continue;
    state.afterSeq = row.seq;
    const d = row.data ?? {};
    switch (row.type) {
      case "client/turn/requested":
        if (typeof d.execution?.model === "string") state.model = d.execution.model;
        if (typeof d.initiator === "string" && d.target?.kind !== "steer") state.initiator = d.initiator;
        break;
      case "thread/identity":
        if (typeof d.providerThreadId === "string") state.providerThreadId = d.providerThreadId;
        break;
      case "turn/started":
        state.turn = null;
        open(state, row);
        break;
      case "thread/tokenUsage/updated": {
        const id = String(d.providerThreadId ?? "");
        const s = state.sessions[id] ?? { total: null, usd: null };
        const delta = added(s.total, d.tokenUsage.total, d.tokenUsage.last);
        state.sessions[id] = { ...s, total: d.tokenUsage.total };
        const t = tokensOf(delta);
        const turn = open(state, row);
        for (const k of Object.keys(t) as (keyof Tokens)[]) turn.tokens[k] += t[k];
        break;
      }
      case "thread/contextWindowUsage/updated": {
        const cost = d.contextWindowUsage?.cost;
        if (!cost || cost.currency !== "USD") break;
        const id = String(d.providerThreadId ?? "");
        const s = state.sessions[id] ?? { total: null, usd: null };
        const gain = s.usd === null || cost.amount < s.usd ? cost.amount : cost.amount - s.usd;
        state.sessions[id] = { ...s, usd: cost.amount };
        if (gain > 0) open(state, row).usd += gain;
        break;
      }
      case "turn/completed": {
        const turn = open(state, row);
        done.push({
          ...turn,
          model: turn.model ?? state.model,
          endedAt: row.createdAt,
          endSeq: row.seq,
          status: d.status === "failed" || d.status === "interrupted" ? d.status : "completed",
          providerThreadId: state.providerThreadId,
        });
        state.turn = null;
        break;
      }
    }
  }
  return done;
}
