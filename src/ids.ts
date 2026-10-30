import { createHash } from "node:crypto";

const hex = (seed: string, bytes: number): string =>
  createHash("sha256").update(seed).digest("hex").slice(0, bytes * 2);

/** Every thread of one delegation tree shares the trace of its root thread. */
export const traceIdOf = (rootThreadId: string): string => hex(`bb-trace:${rootThreadId}`, 16);

/** The span that stands for a whole thread; its turns are its children. */
export const threadSpanIdOf = (threadId: string): string => hex(`bb-thread:${threadId}`, 8);

export const turnSpanIdOf = (threadId: string, startedAt: number, seq: number): string =>
  hex(`bb-turn:${threadId}:${startedAt}:${seq}`, 8);
