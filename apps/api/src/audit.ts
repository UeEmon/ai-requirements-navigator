import type { Store } from "./store.js";

/**
 * 監査ログ。誰が・いつ・何をしたかと、AIに送った内容の要約を残す。
 * APIキーや個人の認証情報は記録しない。
 */
export type AuditAction =
  | "org.create"
  | "org.limits.update"
  | "provider.create"
  | "provider.update"
  | "provider.delete"
  | "project.create"
  | "project.phase"
  | "ai.round"
  | "ai.guide"
  | "ai.uml"
  | "decision.create"
  | "uml.adopt"
  | "requirement.update"
  | "requirement.delete"
  | "spec.export"
  | "ai.tasks"
  | "tasks.export"
  | "integration.create"
  | "integration.update"
  | "integration.delete"
  | "ai.screens"
  | "screen.feedback"
  | "baseline.create"
  | "change.create"
  | "ai.impact"
  | "change.decide"
  | "document.create"
  | "document.delete"
  | "ai.analysis"
  | "analysis.adopt"
  | "nfr.profile"
  | "nfr.item"
  | "ai.nfr"
  | "nfr.requirements"
  | "auth.login"
  | "token.create"
  | "token.revoke"
  | "webhook.create"
  | "webhook.delete"
  | "impl.report"
  | "test_run.record"
  | "question.create"
  | "question.answer"
  | "handoff.pack";

export interface AuditInput {
  orgId: string;
  actor: string;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  detail?: Record<string, unknown>;
}

/** 監査ログの書き込みに失敗しても、本来の処理は止めない（記録の失敗はログに出す） */
export async function audit(store: Store, e: AuditInput): Promise<void> {
  try {
    await store.addAudit({
      orgId: e.orgId,
      actor: e.actor,
      action: e.action,
      targetType: e.targetType ?? "",
      targetId: e.targetId ?? "",
      detail: e.detail ?? {},
    });
  } catch (err) {
    console.error(`[audit] 記録に失敗しました: ${e.action} ${(err as Error).message}`);
  }
}

/** 長い文字列は先頭だけ残す（監査ログの肥大化を防ぐ） */
export const clip = (s: string, n = 2000) => (s.length > n ? `${s.slice(0, n)}…（${s.length}文字）` : s);

/** 保持期間を過ぎた監査ログを定期的に削除する */
export function scheduleAuditPurge(store: Store, retentionDays: number): () => void {
  const run = async () => {
    try {
      const n = await store.purgeAudit(new Date(Date.now() - retentionDays * 86_400_000));
      if (n) console.log(`[audit] 保持期間（${retentionDays}日）を過ぎた ${n}件を削除しました`);
    } catch (e) {
      console.error(`[audit] 削除に失敗しました: ${(e as Error).message}`);
    }
  };
  void run();
  const t = setInterval(run, 86_400_000);
  t.unref?.();
  return () => clearInterval(t);
}
