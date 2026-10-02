import type { Job, JobKind, JobProgress, Store } from "./store.js";

/**
 * 非同期ジョブの実行。
 * - 待ち行列は DB（jobs テーブル）。PostgreSQL では FOR UPDATE SKIP LOCKED で取り出すため、
 *   AWS で複数のコンテナを動かしても1つのジョブは1回だけ実行される
 * - 実行中に落ちたジョブは staleMs を過ぎると失敗扱いにする
 */
export interface JobContext {
  job: Job;
  report: (p: JobProgress) => Promise<void>;
}
export type JobHandler = (ctx: JobContext) => Promise<unknown>;

/** 失敗理由をHTTPステータスつきで返すためのエラー */
export class JobError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface JobRunnerOptions {
  concurrency?: number;
  pollMs?: number;
  staleMs?: number;
  log?: (msg: string) => void;
}

export class JobRunner {
  private running = 0;
  private timer: NodeJS.Timeout | null = null;
  private lastSweep = 0;
  private readonly concurrency: number;
  private readonly pollMs: number;
  private readonly staleMs: number;
  private readonly log: (msg: string) => void;
  private idle: Array<() => void> = [];

  constructor(
    private readonly store: Store,
    private readonly handlers: Partial<Record<JobKind, JobHandler>>,
    opts: JobRunnerOptions = {},
  ) {
    this.concurrency = opts.concurrency ?? 4;
    this.pollMs = opts.pollMs ?? 500;
    this.staleMs = opts.staleMs ?? 10 * 60_000;
    this.log = opts.log ?? ((m) => console.error(m));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 新しいジョブを登録した直後に呼ぶと、待たずに取りかかる */
  kick(): void {
    void this.tick();
  }

  async tick(): Promise<void> {
    if (Date.now() - this.lastSweep > 60_000) {
      this.lastSweep = Date.now();
      try {
        const n = await this.store.failStaleJobs(new Date(Date.now() - this.staleMs));
        if (n) this.log(`[jobs] ${n}件の止まったジョブを失敗にしました`);
      } catch (e) {
        this.log(`[jobs] 掃除に失敗: ${(e as Error).message}`);
      }
    }
    while (this.running < this.concurrency) {
      let job: Job | null;
      try {
        job = await this.store.claimJob();
      } catch (e) {
        this.log(`[jobs] 取り出しに失敗: ${(e as Error).message}`);
        return;
      }
      if (!job) break;
      this.running++;
      void this.execute(job).finally(() => {
        this.running--;
        if (this.running === 0) this.idle.splice(0).forEach((f) => f());
      });
    }
  }

  private async execute(job: Job): Promise<void> {
    const handler = this.handlers[job.kind];
    try {
      if (!handler) throw new JobError(`未対応のジョブです: ${job.kind}`, 500);
      const result = await handler({ job, report: (p) => this.store.updateJobProgress(job.id, p) });
      await this.store.finishJob(job.id, { status: "done", result });
    } catch (e) {
      const status = (e as { status?: number }).status;
      await this.store.finishJob(job.id, {
        status: "failed",
        error: (e as Error).message || "処理に失敗しました",
        errorStatus: typeof status === "number" ? status : 500,
      });
    }
  }

  /** テスト用: 実行中のジョブがなくなるまで待つ */
  async drain(): Promise<void> {
    await this.tick();
    if (this.running === 0) return;
    await new Promise<void>((r) => this.idle.push(r));
  }
}
