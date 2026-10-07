/** 除外後の順位と投稿文を検証し、再取得せずに元の集計へ戻せることを確認する。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rankTags, visibleTags, tweetText, normalizeServices, historyRequest, viewOf, newJob } from "../extension/lib/model.js";

test("除外した上位タグを飛ばして順位を繰り上げ、残りの上位5件を投稿する", () => {
  const ranking = rankTags([["除外", 10], ["次点", 9], ["三番", 8], ["四番", 7], ["五番", 6], ["六番", 5], ["七番", 4]]);
  const visible = visibleTags(ranking, ["除外"]);
  assert.deepEqual(visible.map(({ tag }) => tag), ["次点", "三番", "四番", "五番", "六番", "七番"]);
  const text = tweetText({ ranking: visible });
  assert.ok(text.includes("1. 次点（9作品）"));
  assert.ok(text.includes("5. 六番（5作品）"));
  assert.ok(!text.includes("除外"));
  assert.ok(!text.includes("七番"));
});

test("タグ名が完全一致するものだけを除外し、元の件数と順位を変更しない", () => {
  const ranking = rankTags([["ASMR", 4], ["ASMR作品", 3], ["asmr", 2], ["癒し", 1]]);
  const original = structuredClone(ranking);
  assert.deepEqual(visibleTags(ranking, ["ASMR", "ASMR", "今回存在しないタグ"]).map(({ tag }) => tag), ["ASMR作品", "asmr", "癒し"]);
  assert.deepEqual(ranking, original);
  assert.deepEqual(visibleTags(ranking, []), original);
});

test("すべてのタグを除外した場合と、集計タグがない場合は空の順位を返す", () => {
  const ranking = rankTags([["ASMR", 4], ["癒し", 3]]);
  assert.deepEqual(visibleTags(ranking, ["ASMR", "癒し"]), []);
  assert.deepEqual(visibleTags([], ["ASMR"]), []);
});

test("集計対象の設定は既知のサービスだけを定義順に残し、空や不正な値は無効にする", () => {
  assert.deepEqual(normalizeServices(["fanza", "dlsite", "other"]), ["dlsite", "fanza"]);
  assert.deepEqual(normalizeServices(["fanza"]), ["fanza"]);
  assert.equal(normalizeServices([]), null);
  assert.equal(normalizeServices("dlsite"), null);
  assert.equal(normalizeServices(["other"]), null);
});

test("投稿文の見出しは集計対象のサービス名を定義順でつなぐ", () => {
  const ranking = rankTags([["ASMR", 1]]);
  assert.ok(tweetText({ ranking, services: ["fanza", "dlsite"] }).startsWith("私のDLsite・FANZA購入作品のタグTOP5"));
  assert.ok(tweetText({ ranking, services: ["fanza"] }).startsWith("私のFANZA購入作品のタグTOP5"));
  assert.ok(tweetText({ ranking }).startsWith("私のDLsite購入作品のタグTOP5"));
});

test("履歴の取得方法はサービスとページ番号で決まり、FANZAの年月はURLエンコードする", () => {
  assert.equal(historyRequest("dlsite", 2).url, "https://www.dlsite.com/maniax/mypage/userbuy/=/type/all/start/all/sort/1/order/1/page/2?locale=ja_JP");
  assert.equal(historyRequest("fanza", 1).init.method, undefined);
  assert.deepEqual(historyRequest("fanza", 2, ["2026-10"]).init.body, "purchaseDate=2026-10");
  assert.throws(() => historyRequest("fanza", 3, ["2026-10"]));
  assert.throws(() => historyRequest("other", 1));
});

test("表示用データは取得中のサービスと購入年月、サービス別の作品数を含む", () => {
  const job = newJob("view", 0, ["dlsite", "fanza"]);
  Object.assign(job, { serviceIndex: 1, nextPage: 3, totalPages: 4, pageKeys: ["2026-10", "2026-09", "2026-08"], works: [{ id: "RJ1", url: "a", service: "dlsite" }, { id: "d_1", url: "b", service: "fanza" }, { id: "d_2", url: null, service: "fanza" }] });
  const view = viewOf(job);
  assert.equal(view.historyService, "fanza");
  assert.equal(view.currentPageKey, "2026-09");
  assert.deepEqual(view.worksByService, { dlsite: 1, fanza: 2 });
  assert.equal(viewOf({ ...job, phase: "tags" }).historyService, null);
});
