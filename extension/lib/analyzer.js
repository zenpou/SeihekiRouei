/** 各サービスの全購入履歴の収集と、作品単位のタグ集計を行う。通信・保存方法は呼び出し側から受け取る。 */
import { AnalysisError, errorInfo, workKey, isFanzaMonth } from "./model.js";

// 中止済みの保存要求が拒否された場合は、利用者向けのエラーにせず処理だけを止める。
class JobStopped extends Error {}

/** 保存済みジョブから再開し、ページ取得後・作品処理後・完了時に進捗を保存する。 */
export async function analyze(initial, { getHistory, getTags, checkpoint, now = Date.now }) {
  const job = structuredClone(initial);
  const save = async () => {
    job.updatedAt = now();
    job.revision += 1;
    // コピーを渡し、保存処理中のデータが後続の更新で書き換わらないようにする。
    if (!await checkpoint(structuredClone(job))) throw new JobStopped();
  };

  try {
    // 保存済み作品も既読に含め、ページ境界の重複や再開による二重計上を防ぐ。
    const seen = new Set(job.works.map(workKey));
    while (job.phase === "history") {
      const service = job.services[job.serviceIndex];
      if (!service) {
        job.phase = "tags";
        await save();
        break;
      }
      if (job.nextPage === null) {
        // 現在のサービスの履歴を取り終えたら、ページ進捗を初期化して次のサービスへ進む。
        job.serviceIndex += 1;
        Object.assign(job, { nextPage: 1, totalPages: null, pageSignatures: [], pageKeys: null });
        continue;
      }
      const page = job.nextPage;
      const result = await getHistory(service, page, job.pageKeys ?? []);
      // 年月一覧のように取得範囲が決まっている履歴では、作品のない月や同じ作品集合の月を異常としない。
      const bounded = Array.isArray(result.pageKeys) || Array.isArray(job.pageKeys);
      const signature = result.works.map(workKey).sort().join(",");
      if (!bounded && ((signature && job.pageSignatures.includes(signature)) || (!result.works.length && result.nextPage !== null))) {
        throw new AnalysisError("PAGINATION_ERROR", "購入履歴のページが繰り返されています。全件取得できないため、集計を中止しました。");
      }
      if (result.nextPage !== null && result.nextPage !== page + 1) {
        throw new AnalysisError("PAGINATION_ERROR", "購入履歴のページ順を確認できないため、集計を中止しました。");
      }
      if (Array.isArray(result.pageKeys)) {
        if (!result.pageKeys.every(isFanzaMonth)) {
          throw new AnalysisError("HISTORY_FORMAT", "FANZAの購入年月を読み取れませんでした。FANZAの購入履歴ページを確認してください。");
        }
        job.pageKeys = result.pageKeys;
      }
      for (const work of result.works) {
        const entry = { ...work, service: work.service ?? service };
        if (!seen.has(workKey(entry))) {
          seen.add(workKey(entry));
          job.works.push(entry);
        }
      }
      if (signature) job.pageSignatures.push(signature);
      job.historyPages += 1;
      job.totalPages = result.totalPages === null ? job.totalPages : Math.max(job.totalPages ?? 1, result.totalPages);
      job.nextPage = result.nextPage;
      await save();
    }

    // countsとcursorを一緒に保存することで、再開時も処理済み作品を数え直さない。
    const counts = new Map(job.counts);
    while (job.cursor < job.works.length) {
      const work = job.works[job.cursor];
      if (!work.url) {
        job.unavailableCount += 1;
      } else {
        try {
          // 同一作品内のタグ重複を除き、出現回数ではなく購入作品数として数える。
          const tags = [...new Set(await getTags(work))];
          if (!tags.length) job.taglessCount += 1;
          for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
        } catch (error) {
          // 公開終了などで取得不能な作品だけを除外し、通信や形式の異常では全体を止める。
          if (error.code !== "WORK_UNAVAILABLE") throw error;
          job.unavailableCount += 1;
        }
      }
      job.cursor += 1;
      job.counts = [...counts.entries()];
      await save();
    }
    job.status = "completed";
    job.finishedAt = now();
    await save();
  } catch (error) {
    if (error instanceof JobStopped) return;
    job.status = "error";
    job.error = errorInfo(error);
    // 保存自体の失敗では最後の保存地点を残し、offscreenからbackgroundへも異常を通知する。
    try { await save(); } catch { /* 保存できない場合の通知は呼び出し側に任せる。 */ }
    throw error;
  }
}
