import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { fold, newState, USAGE_EVENT_TYPES, type EventRow, type ThreadState } from "./src/fold.js";
import { makePost, parseKeyValues, tracesBody, type Attrs, type Post } from "./src/otlp.js";
import { accountHashOf } from "./src/ids.js";
import { setUsageGauges, Telemetry, type ThreadCtx, type UsageWindowInput } from "./src/telemetry.js";

const VERSION = "0.1.1";
const PAGE = 100;
const MAX_DEPTH = 8;
const USAGE_PLUGIN = "bb--provider-usage";

const usageSchema = z.object({
  machines: z.array(
    z.object({
      id: z.string(),
      providers: z.array(
        z.object({
          providerId: z.string(),
          usage: z
            .object({
              status: z.string(),
              accountEmail: z.string().nullable().optional(),
              planLabel: z.string().nullable().optional(),
              windows: z
                .array(
                  z.object({
                    label: z.string(),
                    usedPercent: z.number(),
                    resetsAt: z.string().nullable(),
                    cost: z.object({ usedUsdCents: z.number(), limitUsdCents: z.number() }).nullable().optional(),
                  }),
                )
                .optional(),
            })
            .nullable(),
        }),
      ),
    }),
  ),
});

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    endpoint: {
      type: "string",
      label: "OTLP/HTTP endpoint",
      default: "",
      experimental_schema: z.string().refine((v) => v === "" || /^https?:\/\/\S+$/.test(v), "Use an http:// or https:// URL"),
    },
    headers: { type: "string", label: "Headers (name=value,name=value)", secret: true },
    resourceAttributes: { type: "string", label: "Resource attributes (name=value,name=value)", default: "" },
    traces: { type: "boolean", label: "Export spans", default: true },
    metrics: { type: "boolean", label: "Export metrics", default: true },
    usageWindows: { type: "boolean", label: "Export provider usage windows", default: true },
    flushSeconds: { type: "number", label: "Flush interval (seconds)", default: 10, experimental_schema: z.number().int().min(1).max(3600) },
    usagePollSeconds: { type: "number", label: "Usage poll interval (seconds)", default: 300, experimental_schema: z.number().int().min(30).max(86400) },
    metricsRefreshSeconds: {
      type: "number",
      label: "Full metrics refresh (seconds, 0 = only changed series)",
      default: 3600,
      experimental_schema: z.number().int().min(0).max(86400),
    },
  });

  let cfg = await settings.get();
  const tel = new Telemetry(() => ({ traces: cfg.traces, metrics: cfg.metrics }));
  let post: Post | null = null;
  let resource: Attrs = {};
  const configure = () => {
    post = cfg.endpoint ? makePost({ endpoint: cfg.endpoint, headers: parseKeyValues(cfg.headers ?? "") }) : null;
    resource = {
      "service.name": "bb",
      "bb.plugin.name": "bb-plugin-otel",
      "bb.plugin.version": VERSION,
      ...parseKeyValues(cfg.resourceAttributes),
    };
  };
  configure();
  if (!cfg.endpoint) bb.status.needsConfiguration("Set endpoint with `bb plugin config otel set endpoint http://collector:4318`.");
  settings.onChange((next) => {
    cfg = next;
    configure();
  });

  // Per-thread context, kept for the life of the plugin; a thread's project and parent do not change often.
  const ctxs = new Map<string, ThreadCtx>();
  const projectNames = new Map<string, string | undefined>();
  const since = (await bb.storage.kv.get<number>("since")) ?? Date.now();
  await bb.storage.kv.set("since", since);

  const projectName = async (id: string) => {
    if (!projectNames.has(id)) {
      const p = await bb.sdk.projects.get({ projectId: id }).catch(() => undefined);
      const name = (p as { name?: unknown } | undefined)?.name;
      projectNames.set(id, typeof name === "string" ? name : undefined);
    }
    return projectNames.get(id);
  };

  // Machine names by host id, and host ids by environment id. Hosts are few; the list is
  // read again at most once a minute when an unknown id turns up.
  const hostNames = new Map<string, string>();
  const envHosts = new Map<string, string | null>();
  let hostsReadAt = 0;
  const hostName = async (hostId: string) => {
    if (!hostNames.has(hostId) && Date.now() - hostsReadAt > 60_000) {
      hostsReadAt = Date.now();
      const hosts = await Promise.resolve()
        .then(() => bb.sdk.hosts.list())
        .catch(() => []);
      for (const h of hosts as { id?: unknown; name?: unknown }[])
        if (typeof h.id === "string" && typeof h.name === "string") hostNames.set(h.id, h.name);
    }
    return hostNames.get(hostId);
  };
  const hostOf = async (environmentId: string | null) => {
    if (!environmentId) return null;
    if (!envHosts.has(environmentId)) {
      const env = await Promise.resolve()
        .then(() => bb.sdk.environments.get({ environmentId }))
        .catch(() => undefined);
      const id = (env as { hostId?: unknown } | undefined)?.hostId;
      if (env) envHosts.set(environmentId, typeof id === "string" ? id : null);
      return typeof id === "string" ? id : null;
    }
    return envHosts.get(environmentId) ?? null;
  };

  type Thread = {
    id: string;
    projectId: string;
    environmentId: string | null;
    providerId: string;
    parentThreadId: string | null;
    originPluginId: string | null;
    createdAt: number;
  };
  async function ctxOf(t: Thread): Promise<ThreadCtx> {
    const known = ctxs.get(t.id);
    if (known) return known;
    let root = t.id;
    let parent = t.parentThreadId;
    for (let i = 0; parent && i < MAX_DEPTH; i++) {
      root = parent;
      parent = (ctxs.get(parent)?.parentThreadId ?? (await bb.sdk.threads.get({ threadId: parent }).catch(() => null))?.parentThreadId) ?? null;
    }
    const machineId = (await hostOf(t.environmentId)) ?? undefined;
    const c: ThreadCtx = {
      machineId,
      machineName: machineId ? await hostName(machineId) : undefined,
      threadId: t.id,
      projectId: t.projectId,
      projectName: await projectName(t.projectId),
      environmentId: t.environmentId,
      providerId: t.providerId,
      parentThreadId: t.parentThreadId,
      rootThreadId: root,
      originPluginId: t.originPluginId,
    };
    ctxs.set(t.id, c);
    return c;
  }

  const list = (threadId: string, extra: Record<string, unknown>) =>
    bb.sdk.threads.events.list({ threadId, types: [...USAGE_EVENT_TYPES], limit: String(PAGE), ...extra } as never) as Promise<EventRow[]>;

  /** A thread that existed before this plugin did starts at its newest event, with only the model read back. */
  async function initState(t: Thread): Promise<ThreadState> {
    if (t.createdAt >= since) return newState(0);
    const newest = (await list(t.id, { order: "desc", limit: "1" }))[0];
    const state = newState(newest?.seq ?? 0);
    const back = await list(t.id, { order: "desc", limit: "20" });
    for (const row of back.slice().reverse()) {
      if (row.type === "client/turn/requested" && typeof row.data?.execution?.model === "string") state.model = row.data.execution.model;
      if (row.type === "thread/identity" && typeof row.data?.providerThreadId === "string") state.providerThreadId = row.data.providerThreadId;
    }
    return state;
  }

  const chains = new Map<string, Promise<unknown>>();
  const serial = <T>(id: string, work: () => Promise<T>): Promise<T> => {
    const next = (chains.get(id) ?? Promise.resolve()).catch(() => undefined).then(work);
    chains.set(id, next);
    void next.finally(() => chains.get(id) === next && chains.delete(id)).catch(() => undefined);
    return next;
  };

  const sync = (t: Thread) =>
    serial(t.id, async () => {
      const key = `st:${t.id}`;
      const state = (await bb.storage.kv.get<ThreadState>(key)) ?? (await initState(t));
      const c = await ctxOf(t);
      for (;;) {
        const rows = await list(t.id, { order: "asc", afterSeq: String(state.afterSeq) });
        for (const turn of fold(state, rows)) tel.turn(c, turn);
        if (rows.length < PAGE) break;
      }
      await bb.storage.kv.set(key, state);
    });

  const active = new Map<string, number>();
  const guard = (name: string, fn: () => Promise<void>) =>
    fn().catch((e) => bb.log.warn(`${name} failed: ${e instanceof Error ? e.message : String(e)}`));

  bb.events.on("thread.created", ({ thread }) => guard("created", async () => tel.lifecycle(await ctxOf(thread), "created")));
  bb.events.on("thread.active", ({ thread }) =>
    guard("active", async () => {
      active.set(thread.id, Date.now());
      tel.lifecycle(await ctxOf(thread), "active");
      await sync(thread);
    }),
  );
  for (const state of ["idle", "failed"] as const)
    bb.events.on(`thread.${state}`, ({ thread }) =>
      guard(state, async () => {
        await sync(thread);
        const from = active.get(thread.id);
        active.delete(thread.id);
        tel.lifecycle(await ctxOf(thread), state, from === undefined ? undefined : Date.now() - from);
      }),
    );
  for (const state of ["archived", "deleted"] as const)
    bb.events.on(`thread.${state}`, ({ thread }) =>
      guard(state, async () => {
        if (state === "archived") await sync(thread);
        const c = await ctxOf(thread);
        tel.lifecycle(c, state);
        tel.threadSpan(c, thread.createdAt, Date.now(), state);
        if (state === "deleted") {
          await bb.storage.kv.delete(`st:${thread.id}`);
          ctxs.delete(thread.id);
        }
      }),
    );

  let lastError = "";
  let nextFull = Date.now() + cfg.metricsRefreshSeconds * 1000;
  async function flush() {
    if (!post) return;
    let failure: unknown;
    try {
      for (let batch = tel.queue.take(); batch.length > 0; batch = tel.queue.take()) {
        try {
          await post("/v1/traces", tracesBody(resource, VERSION, batch));
        } catch (e) {
          tel.queue.push(...batch);
          throw e;
        }
      }
      if (cfg.metrics) {
        const now = Date.now();
        const full = cfg.metricsRefreshSeconds > 0 && now >= nextFull;
        const out = tel.meter.collect(resource, VERSION, now, full);
        if (out) {
          try {
            await post("/v1/metrics", out.body);
          } catch (e) {
            tel.meter.restore(out.keys);
            throw e;
          }
          if (full) nextFull = now + cfg.metricsRefreshSeconds * 1000;
        }
      }
      lastError = "";
    } catch (e) {
      failure = e;
    }
    if (failure) {
      const msg = failure instanceof Error ? failure.message : String(failure);
      if (msg !== lastError) bb.log.warn(`export failed: ${msg}`);
      lastError = msg;
    }
  }

  async function pollUsage() {
    const snapshot = await bb.sdk.plugins.callRpc({
      pluginId: USAGE_PLUGIN,
      method: "getUsage",
      input: { force: false, machineIds: null, providerIds: [], maxAgeMs: cfg.usagePollSeconds * 1000 },
      outputSchema: usageSchema,
      signal: AbortSignal.timeout(45_000),
    });
    const names = new Map<string, string | undefined>();
    for (const m of snapshot.machines) names.set(m.id, await hostName(m.id));
    const windows: UsageWindowInput[] = snapshot.machines.flatMap((m) =>
      m.providers.flatMap((p) =>
        p.usage?.status === "ok"
          ? (p.usage.windows ?? []).map((w) => ({
              machineId: m.id,
              machineName: names.get(m.id),
              accountHash: p.usage?.accountEmail ? accountHashOf(p.usage.accountEmail) : undefined,
              providerId: p.providerId,
              planLabel: p.usage?.planLabel ?? null,
              label: w.label,
              usedPercent: w.usedPercent,
              resetsAt: w.resetsAt,
              cost: w.cost ?? null,
            }))
          : [],
      ),
    );
    setUsageGauges(tel.meter, windows);
  }

  bb.background.service("export", {
    async start(signal) {
      let nextUsage = 0;
      while (!signal.aborted) {
        if (cfg.usageWindows && cfg.metrics && Date.now() >= nextUsage) {
          nextUsage = Date.now() + cfg.usagePollSeconds * 1000;
          await pollUsage().catch((e) => bb.log.debug(`usage poll failed: ${e instanceof Error ? e.message : String(e)}`));
        }
        await flush();
        await sleep(cfg.flushSeconds * 1000, signal);
      }
    },
  });
  bb.onDispose(flush);

}
