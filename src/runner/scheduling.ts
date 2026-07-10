// Job-list construction and the per-pool concurrency scheduler used to run a
// batch's jobs while respecting both a total concurrency cap and a per-key-pool
// cap (so one provider's key pool can't starve/flood the others).

import type { InputItem } from "../inputResolver";
import type { Model } from "../config/models";
import type { ResolvedPrompt } from "../config/prompts";

interface Job {
  id: string;
  inputId: string;
  inputName: string;
  inputType: string;
  modelId: string;
  modelLabel: string;
  provider: string;
  promptId: string;
  promptLabel: string;
  variant: number;
  status: string;
  file: string | null;
  error: string | null;
  keyMask: string | null;
  attempts: number;
  ms: number;
  usage: unknown;
  cost?: import("./cost").CostBreakdown | null;
  wrapped: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  note?: string;
  truncated?: boolean;
  finishReason?: string | null;
  [key: string]: unknown;
}

interface BuildJobsOptions {
  inputItems: InputItem[];
  models: Model[];
  prompts: ResolvedPrompt[];
  variants: number;
}

// Build the flat job list = inputs × models × prompts × variants.
function buildJobs({ inputItems, models, prompts, variants }: BuildJobsOptions): Job[] {
  const jobs: Job[] = [];
  for (const input of inputItems) {
    for (const model of models) {
      for (const prompt of prompts) {
        for (let v = 1; v <= variants; v++) {
          jobs.push({
            id: `${input.id}__${model.id}__${prompt.id}__v${v}`,
            inputId: input.id,
            inputName: input.name,
            inputType: input.type,
            modelId: model.id,
            modelLabel: model.label,
            provider: model.provider,
            promptId: prompt.id,
            promptLabel: prompt.label,
            variant: v,
            status: "pending",
            file: null,
            error: null,
            keyMask: null,
            attempts: 0,
            ms: 0,
            usage: null,
            cost: null,
            wrapped: false,
            startedAt: null,
            finishedAt: null,
          });
        }
      }
    }
  }
  return jobs;
}

interface KeyManagerLike {
  poolSize(poolName: string): number;
}

function buildPoolLimits(models: Model[], km: KeyManagerLike, maxPoolConcurrency: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of models) {
    if (out.has(m.keyEnv)) continue;
    const poolSize = km.poolSize(m.keyEnv);
    out.set(m.keyEnv, Math.max(1, Math.min(maxPoolConcurrency, poolSize || 1)));
  }
  return out;
}

interface RunJobsByPoolOptions<J> {
  totalConcurrency: number;
  poolLimits: Map<string, number>;
  keyFor: (job: J) => string | null | undefined;
  worker: (job: J) => Promise<unknown>;
}

type JobResult<J> = { ok: true; value: unknown } | { ok: false; error: unknown; job: J };

async function runJobsByPool<J>(jobs: J[], { totalConcurrency, poolLimits, keyFor, worker }: RunJobsByPoolOptions<J>): Promise<JobResult<J>[]> {
  const totalLimit = Math.max(1, Math.min(parseInt(String(totalConcurrency), 10) || 1, jobs.length || 1));
  const queues = new Map<string, J[]>();
  for (const job of jobs) {
    const pool = keyFor(job) || "default";
    if (!queues.has(pool)) queues.set(pool, []);
    (queues.get(pool) as J[]).push(job);
  }
  if (!jobs.length) return [];

  const poolOrder = [...queues.keys()];
  const activeByPool = new Map(poolOrder.map((pool) => [pool, 0]));
  const limits = new Map(poolOrder.map((pool) => [pool, Math.max(1, parseInt(String(poolLimits.get(pool)), 10) || 1)]));
  const results: JobResult<J>[] = [];
  let activeTotal = 0;
  let done = 0;
  let cursor = 0;

  return new Promise((resolve) => {
    const maybeStart = () => {
      if (done >= jobs.length) return resolve(results);
      let startedAny: boolean;
      do {
        startedAny = false;
        if (activeTotal >= totalLimit) return;
        for (let scanned = 0; scanned < poolOrder.length && activeTotal < totalLimit; scanned++) {
          const pool = poolOrder[cursor % poolOrder.length] as string;
          cursor = (cursor + 1) % poolOrder.length;
          const q = queues.get(pool);
          if (!q || !q.length) continue;
          if ((activeByPool.get(pool) || 0) >= (limits.get(pool) as number)) continue;

          const job = q.shift() as J;
          activeTotal++;
          activeByPool.set(pool, (activeByPool.get(pool) || 0) + 1);
          startedAny = true;
          Promise.resolve()
            .then(() => worker(job))
            .then((value) => results.push({ ok: true, value }))
            .catch((error) => results.push({ ok: false, error, job }))
            .finally(() => {
              activeTotal--;
              activeByPool.set(pool, Math.max(0, (activeByPool.get(pool) || 1) - 1));
              done++;
              maybeStart();
            });
        }
      } while (startedAny && activeTotal < totalLimit);
    };
    maybeStart();
  });
}

export { buildJobs, buildPoolLimits, runJobsByPool };
export type { Job, BuildJobsOptions, RunJobsByPoolOptions, JobResult, KeyManagerLike };
