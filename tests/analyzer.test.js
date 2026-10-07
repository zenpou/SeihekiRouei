/** 通信・保存を差し替え、全ページ取得、複数サービスの集計、作品単位の集計、再開、中止、投稿文を検証する。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../extension/lib/analyzer.js";
import { parseHistory, parseFanzaHistory } from "../extension/lib/parsers.js";
import { newJob, viewOf, AnalysisError, tweetUrl, tweetText } from "../extension/lib/model.js";
import { fixture, tagsByWork, fanzaTagsByWork } from "./helpers.js";

test("全ページ・全作品を処理し、作品とタグの重複を除いて降順集計する", async () => {
  // 3ページを通じたIDの重複、リンクなし、404、タグなしをまとめて確認する。
  let final;
  const pages = [], requests = [];
  await analyze(newJob("test", Date.now(), ["dlsite"]), {
    async getHistory(service, page) {
      assert.equal(service, "dlsite");
      pages.push(page);
      return parseHistory(await fixture(`history-${page}.html`), page);
    },
    async getTags(work) {
      requests.push(work.id);
      if (work.id === "RJ000005") throw new AnalysisError("WORK_UNAVAILABLE", "404");
      return tagsByWork[work.id];
    },
    async checkpoint(job) { final = job; return true; },
  });
  const view = viewOf(final);
  assert.deepEqual(view.services, ["dlsite"]);
  assert.deepEqual(view.worksByService, { dlsite: 7 });
  assert.deepEqual(pages, [1, 2, 3]);
  assert.equal(requests.filter((id) => id === "RJ000002").length, 1);
  assert.equal(final.status, "completed");
  assert.equal(view.totalWorks, 7);
  assert.equal(view.analyzedWorks, 5);
  assert.equal(view.unavailableCount, 2);
  assert.equal(view.taglessCount, 1);
  assert.equal(view.ranking[0].tag, "ASMR");
  assert.equal(view.ranking[0].count, 4);
  assert.equal(view.ranking[1].tag, "癒し");
  assert.equal(view.ranking[1].count, 3);
  assert.equal(view.ranking[2].count, 2);
  assert.equal(view.ranking.length, 7);
});

test("中断後のチェックポイントから作品を二重計上せず再開する", async () => {
  const job = newJob("resume");
  Object.assign(job, { phase: "tags", nextPage: null, works: [{ id: "RJ000001", url: "one" }, { id: "RJ000002", url: "two" }], cursor: 1, counts: [["ASMR", 1]] });
  let final;
  await analyze(job, {
    getHistory() { throw new Error("must not fetch history"); },
    async getTags(work) { assert.equal(work.id, "RJ000002"); return ["ASMR", "癒し"]; },
    async checkpoint(next) { final = next; return true; },
  });
  assert.equal(viewOf(final).ranking[0].count, 2);
  assert.equal(final.cursor, 2);
});

test("同じ履歴ページの繰り返しは全件取得成功と扱わない", async () => {
  let final;
  await assert.rejects(analyze(newJob("repeat"), {
    async getHistory(service, page) { return { works: [{ id: "RJ000001", url: "one" }], nextPage: page + 1, totalPages: 2 }; },
    getTags() { throw new Error("must not fetch tags"); },
    async checkpoint(next) { final = next; return true; },
  }), { code: "PAGINATION_ERROR" });
  assert.equal(final.status, "error");
});

test("通信エラーは作品を除外せず集計を失敗させる", async () => {
  const job = newJob("error");
  Object.assign(job, { phase: "tags", works: [{ id: "RJ000001", url: "one" }] });
  let final;
  await assert.rejects(analyze(job, {
    async getTags() { throw new AnalysisError("NETWORK_ERROR", "通信失敗"); },
    async checkpoint(next) { final = next; return true; },
  }), { code: "NETWORK_ERROR" });
  assert.equal(final.status, "error");
  assert.equal(final.unavailableCount, 0);
  assert.equal(final.cursor, 0);
});

test("キャンセル済みのジョブのチェックポイントは処理を停止する", async () => {
  let checkpoints = 0;
  await analyze(newJob("cancel"), {
    async getHistory() { return { works: [], nextPage: null, totalPages: 1 }; },
    getTags() { throw new Error("must not fetch tags"); },
    async checkpoint() { checkpoints += 1; return false; },
  });
  assert.equal(checkpoints, 1);
});

test("ゼロ作品は正常完了し、タグはない", async () => {
  let final;
  await analyze(newJob("empty"), {
    async getHistory() { return { works: [], nextPage: null, totalPages: 1 }; },
    async checkpoint(job) { final = job; return true; },
  });
  assert.equal(final.status, "completed");
  assert.deepEqual(viewOf(final).ranking, []);
});

test("上位5つだけを、日本語と特殊文字を壊さずツイートURLにする", () => {
  const view = { ranking: Array.from({ length: 6 }, (_, i) => ({ tag: `タグ${i} & # + /`, count: 20 - i })), unavailableCount: 2 };
  const url = new URL(tweetUrl(view));
  assert.equal(url.origin, "https://x.com");
  assert.equal(url.pathname, "/intent/tweet");
  assert.equal(url.searchParams.get("text"), tweetText(view));
  assert.ok(!tweetText(view).includes("タグ5"));
  assert.ok(tweetText(view).includes("#SeihekiRouei"));
  assert.ok(!tweetText(view).includes("取得不可"));
  assert.equal([...url.searchParams].length, 1);
});

/** DLsiteとFANZAの履歴をフィクスチャから返し、作品ページのタグはサービスごとの表から返す。 */
function combinedSources(record = {}) {
  return {
    async getHistory(service, page, pageKeys) {
      (record.history ??= []).push([service, page]);
      if (service === "dlsite") return parseHistory(await fixture(`history-${page}.html`), page);
      const name = page === 1 ? "fanza-history.html" : `fanza-history-${pageKeys[page - 2]}.html`;
      return parseFanzaHistory(await fixture(name), page, "https://payment.dmm.co.jp/history/", pageKeys);
    },
    async getTags(work) {
      (record.tags ??= []).push(`${work.service}:${work.id}`);
      if (work.id === "RJ000005" || work.id === "d_100003") throw new AnalysisError("WORK_UNAVAILABLE", "404");
      return work.service === "fanza" ? fanzaTagsByWork[work.id] : tagsByWork[work.id];
    },
  };
}

test("DLsiteとFANZAの履歴を順に取得し、同じタグ名をサービスをまたいで合算する", async () => {
  let final;
  const record = {};
  await analyze(newJob("both"), { ...combinedSources(record), async checkpoint(job) { final = job; return true; } });
  assert.deepEqual(record.history, [["dlsite", 1], ["dlsite", 2], ["dlsite", 3], ["fanza", 1], ["fanza", 2], ["fanza", 3], ["fanza", 4]]);
  // 最初の表示と10月の月別表示に同じ作品があっても、FANZAの作品ページは1回だけ取得する。
  assert.equal(record.tags.filter((key) => key === "fanza:d_100001").length, 1);
  const view = viewOf(final);
  assert.equal(final.status, "completed");
  assert.equal(view.totalWorks, 10);
  assert.deepEqual(view.worksByService, { dlsite: 7, fanza: 3 });
  assert.equal(view.unavailableCount, 3);
  assert.equal(view.taglessCount, 1);
  assert.deepEqual(view.ranking.slice(0, 2), [{ tag: "ASMR", count: 5 }, { tag: "癒し", count: 4 }]);
  assert.deepEqual(view.ranking.filter(({ count }) => count === 2).map(({ tag }) => tag).sort(), ["成人向け", "日常/生活", "耳かき"]);
  assert.equal(view.ranking.length, 8);
  assert.ok(tweetText(view).startsWith("私のDLsite・FANZA購入作品のタグTOP5\n1. ASMR（5作品）"));
});

test("FANZAだけを対象にした場合はDLsiteへ通信せず、投稿文の見出しもFANZAだけにする", async () => {
  let final;
  const record = {};
  await analyze(newJob("fanza-only", Date.now(), ["fanza"]), { ...combinedSources(record), async checkpoint(job) { final = job; return true; } });
  assert.ok(record.history.every(([service]) => service === "fanza"));
  const view = viewOf(final);
  assert.equal(view.totalWorks, 3);
  assert.equal(view.ranking[0].tag, "成人向け");
  assert.ok(tweetText(view).startsWith("私のFANZA購入作品のタグTOP5"));
});

test("FANZAの履歴取得中に中断しても、保存済みの購入年月から再開して二重計上しない", async () => {
  // 1回目は3ページ目（2026-09）の保存後に停止し、2回目はその状態から続きを取得する。
  let saved;
  const first = {};
  await analyze(newJob("resume-fanza"), {
    ...combinedSources(first),
    async checkpoint(job) {
      saved = job;
      return !(job.phase === "history" && job.services[job.serviceIndex] === "fanza" && job.nextPage === 4);
    },
  });
  assert.equal(saved.status, "running");
  assert.deepEqual(saved.pageKeys, ["2026-10", "2026-09", "2026-08"]);
  let final;
  const second = {};
  await analyze(saved, { ...combinedSources(second), async checkpoint(job) { final = job; return true; } });
  assert.deepEqual(second.history, [["fanza", 4]]);
  assert.equal(final.status, "completed");
  assert.equal(viewOf(final).totalWorks, 10);
  assert.equal(viewOf(final).ranking[0].count, 5);
});

test("FANZAの年月一覧が不正な場合は集計を中止する", async () => {
  let final;
  await assert.rejects(analyze(newJob("bad-keys", Date.now(), ["fanza"]), {
    async getHistory() { return { works: [], nextPage: 2, totalPages: 2, pageKeys: ["2026-13"] }; },
    getTags() { throw new Error("must not fetch tags"); },
    async checkpoint(job) { final = job; return true; },
  }), { code: "HISTORY_FORMAT" });
  assert.equal(final.status, "error");
});

test("集計対象が空の設定では集計を開始しない", () => {
  assert.throws(() => newJob("none", Date.now(), []), { code: "INVALID_SETTING" });
  assert.throws(() => newJob("unknown", Date.now(), ["unknown"]), { code: "INVALID_SETTING" });
  assert.deepEqual(newJob("ordered", Date.now(), ["fanza", "dlsite"]).services, ["dlsite", "fanza"]);
});
