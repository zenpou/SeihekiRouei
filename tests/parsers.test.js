/** 保存したHTMLを使い、ブラウザDOMなしでのDLsite・FANZAの作品抽出・ページ送り・タグ抽出と誤判定防止を検証する。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHistory, parseTags, workFromUrl, parseFanzaHistory, parseFanzaTags, fanzaWorkFromUrl, parseHistoryFor, parseTagsFor } from "../extension/lib/parsers.js";
import { historyUrl } from "../extension/lib/model.js";
import { fixture, workHtml, fanzaWorkHtml, withPageDecorations } from "./helpers.js";

test("購入履歴の作品・相対URL・次ページ・最終ページを読む", async () => {
  const result = parseHistory(await fixture("history-1.html"), 1);
  assert.deepEqual(result.works.map((work) => work.id), ["RJ000001", "RJ000002"]);
  assert.equal(result.works[1].url, "https://www.dlsite.com/maniax/work/=/product_id/RJ000002.html?locale=ja_JP");
  assert.equal(result.nextPage, 2);
  assert.equal(result.totalPages, 3);
});

test("最終ページへのリンクだけでも中間のページを飛ばさない", async () => {
  const result = parseHistory(await fixture("history-2.html"), 2);
  assert.equal(result.nextPage, 3);
  assert.equal(result.works[2].url, null);
  assert.equal(result.works[2].id, "RJ000004");
});

test("作品IDのない販売終了作品でもページが繰り返されたことを判別できる", () => {
  const html = '<table class="work_list_main"><tr><td class="work_name">販売終了作品A</td><td class="buy_date">2026/10/01</td></tr></table>';
  assert.equal(parseHistory(html, 1).works[0].id, parseHistory(html, 2).works[0].id);
});

test("最終ページの無効な次へをたどらない", async () => {
  assert.equal(parseHistory(await fixture("history-3.html"), 3).nextPage, null);
});

test("data-valueのみのページ切替にも対応する", async () => {
  const html = (await fixture("history-1.html")).replace(/ href="[^"]*mypage[^"]*"/gu, "");
  assert.equal(parseHistory(html, 1).nextPage, 2);
});

test("作品のない購入履歴を扱う", async () => {
  assert.deepEqual(parseHistory(await fixture("empty-history.html"), 1).works, []);
  assert.equal(parseHistory('<table class="work_list_main"><tr><th>作品名</th></tr></table>', 1).nextPage, null);
  const messageRow = '<table class="work_list_main"><tr><td colspan="2">購入履歴はありません。</td></tr></table>';
  assert.deepEqual(parseHistory(messageRow, 1).works, []);
});

test("空履歴の案内と同じ文言を含む作品名でも購入作品を保持する", async () => {
  // 案内文と作品名は文章だけでは区別できないため、購入行の構造を優先する回帰テスト。
  const html = (await fixture("history-1.html")).replace("作品1", "購入作品はありません ～テスト作品～");
  const result = parseHistory(html, 1);
  assert.deepEqual(result.works.map(({ id }) => id), ["RJ000001", "RJ000002"]);
  assert.equal(result.nextPage, 2);
  const delisted = '<table class="work_list_main"><tr data-product-id="RJ000004"><td class="work_name">購入商品はございません</td><td class="buy_date">2026/10/01</td></tr></table>';
  assert.deepEqual(parseHistory(delisted, 1).works, [{ id: "RJ000004", url: null, service: "dlsite" }]);
});

test("空履歴の文言を含む不正な購入行も形式エラーにする", () => {
  const missingDate = '<table class="work_list_main"><tr><td class="work_name">購入作品はありません</td></tr></table>';
  assert.throws(() => parseHistory(missingDate, 1), { code: "HISTORY_FORMAT" });
  const changedFields = '<table class="work_list_main"><tr><td class="changed_name">購入作品はありません</td><td class="changed_date">2026/10/01</td></tr></table>';
  assert.throws(() => parseHistory(changedFields, 1), { code: "HISTORY_FORMAT" });
  const changedTable = '<div id="buy_history_this"><table class="changed_table"><tr><td class="work_name">購入作品はありません</td><td class="buy_date">2026/10/01</td></tr></table></div>';
  assert.throws(() => parseHistory(changedTable, 1), { code: "HISTORY_FORMAT" });
});

test("ログイン画面や未知のHTMLを購入作品ゼロとして扱わない", () => {
  assert.throws(() => parseHistory("<html>登録してください</html>", 1, "https://login.dlsite.com/register"), { code: "LOGIN_REQUIRED" });
  assert.throws(() => parseHistory('<form><input type="password"></form>', 1), { code: "LOGIN_REQUIRED" });
  assert.throws(() => parseHistory("<html>アクセスを確認中</html>", 1), { code: "HISTORY_FORMAT" });
  assert.throws(() => parseHistory('<table class="work_list_main"><tr><td class="unknown">作品</td></tr></table>', 1), { code: "HISTORY_FORMAT" });
});

test("購入日が失われた作品行は形式エラーになる", async () => {
  const html = (await fixture("history-1.html")).replaceAll('class="buy_date"', 'class="new_date"');
  assert.throws(() => parseHistory(html, 1), { code: "HISTORY_FORMAT" });
});

test("tdで構成された既知の見出し行を作品として数えない", async () => {
  const html = (await fixture("history-1.html")).replace('<tr class="item_name"><th>作品名</th><th>購入日</th></tr>', '<tr class="item_name"><td class="work_name">作品名</td><td class="buy_date">購入日</td></tr>');
  assert.equal(parseHistory(html, 1).works.length, 2);
});

test("一部の行だけ形式が変わった場合も作品を黙って欠落させない", async () => {
  const html = (await fixture("history-1.html")).replace('class="work_name"', 'class="changed_name"');
  assert.throws(() => parseHistory(html, 1), { code: "HISTORY_FORMAT" });
});

test("タグだけを抽出し、重複・声優・おすすめ・容量を除外する", async () => {
  assert.deepEqual(parseTags(await fixture("work.html"), "https://www.dlsite.com/home/work/=/product_id/RJ000001.html"), ["ASMR", "日常/生活"]);
});

test("インラインCSS・スクリプト・画像を含むHTMLをDOMなしで読み取る", async () => {
  const history = parseHistory(withPageDecorations(await fixture("history-1.html")), 1);
  assert.deepEqual(history.works.map(({ id }) => id), ["RJ000001", "RJ000002"]);
  assert.equal(history.nextPage, 2);
  assert.deepEqual(parseTags(withPageDecorations(await fixture("work.html")), history.works[0].url), ["ASMR", "日常/生活"]);
  assert.equal(globalThis.parsedScriptRan, undefined);
});

test("HTMLエンティティを含むタグ名とURLを復元する", () => {
  const url = "https://www.dlsite.com/home/work/=/product_id/RJ000001.html";
  assert.deepEqual(parseTags(workHtml(["A & B", "タグ<特別>", "癒し"]), url), ["A & B", "タグ<特別>", "癒し"]);
  const html = '<table class="work_list_main"><tr><td class="work_name"><a href="&#47;home/work/=/product_id/RJ000001.html">作品</a></td><td class="buy_date">2026/10/01</td></tr></table>';
  assert.equal(parseHistory(html, 1).works[0].id, "RJ000001");
});

test("有効な作品のタグなしと、未知のページ・販売終了を区別する", () => {
  const url = "https://www.dlsite.com/home/work/=/product_id/RJ000001.html";
  assert.deepEqual(parseTags(workHtml([]), url), []);
  assert.throws(() => parseTags("<title>確認中</title>", url), { code: "WORK_FORMAT" });
  assert.throws(() => parseTags("<title>作品が見つかりません</title>", url), { code: "WORK_UNAVAILABLE" });
});

test("外部・HTTP・不正な作品URLをフェッチ対象にしない", () => {
  for (const href of ["https://evil.example/home/work/=/product_id/RJ000001.html", "http://www.dlsite.com/home/work/=/product_id/RJ000001.html", "javascript:alert(1)", "/home/profile", "https://www.dlsite.com.evil.example/home/work/=/product_id/RJ000001.html"]) {
    assert.equal(workFromUrl(href, historyUrl(1)), null);
  }
});

const fanzaUrl = "https://payment.dmm.co.jp/history/";
const fanzaWorkUrl = "https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=d_100001/";

test("FANZAの購入履歴の1ページ目から購入年月の一覧と同人作品を読む", async () => {
  const result = parseFanzaHistory(await fixture("fanza-history.html"), 1, fanzaUrl);
  assert.deepEqual(result.pageKeys, ["2026-10", "2026-09", "2026-08"]);
  assert.equal(result.nextPage, 2);
  assert.equal(result.totalPages, 4);
  // 動画の購入は同人作品に含めず、参照用パラメータを除いた正規のURLにする。
  assert.deepEqual(result.works, [{ id: "d_100001", url: fanzaWorkUrl, service: "fanza" }]);
});

test("FANZAの月別履歴から相対URL・大文字IDの作品を読み、年月の一覧に沿って次へ進む", async () => {
  const keys = ["2026-10", "2026-09", "2026-08"];
  const september = parseFanzaHistory(await fixture("fanza-history-2026-09.html"), 3, fanzaUrl, keys);
  assert.deepEqual(september.works.map(({ id }) => id), ["d_100002", "d_100003"]);
  assert.equal(september.works[0].url, "https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=d_100002/");
  assert.equal(september.nextPage, 4);
  assert.equal(september.totalPages, 4);
  // 購入のない月は作品ゼロで、最後の月なら次ページはない。
  const august = parseFanzaHistory(await fixture("fanza-history-2026-08.html"), 4, fanzaUrl, keys);
  assert.deepEqual(august.works, []);
  assert.equal(august.nextPage, null);
});

test("FANZAで購入履歴のない利用者と、年月の選択肢が別の形式になった場合を扱う", () => {
  const empty = '<div id="main-history-purchase"><p>購入履歴はありません。</p></div>';
  assert.deepEqual(parseFanzaHistory(empty, 1, fanzaUrl), { works: [], nextPage: null, totalPages: 1, pageKeys: [] });
  const renamed = '<select name="month"><option value="all">すべて</option><option value="2026-10">2026年10月</option></select><table><tr><td class="grand-total">0</td></tr></table>';
  assert.deepEqual(parseFanzaHistory(renamed, 1, fanzaUrl).pageKeys, ["2026-10"]);
});

test("FANZAのログイン画面・年齢認証・未知のページを購入ゼロとして扱わない", () => {
  assert.throws(() => parseFanzaHistory("<html>ログイン</html>", 1, "https://accounts.dmm.co.jp/service/login/password/"), (error) => error.code === "LOGIN_REQUIRED" && error.message.includes("FANZA"));
  assert.throws(() => parseFanzaHistory('<form><input type="password"></form>', 1, fanzaUrl), { code: "LOGIN_REQUIRED" });
  const ageCheck = '<html><head><title>年齢認証 - FANZA</title></head><body><p>あなたは18歳以上ですか？</p><a href="https://www.dmm.co.jp/age_check/=/declared=yes/rurl=x">はい</a></body></html>';
  assert.throws(() => parseFanzaHistory(ageCheck, 1, fanzaUrl), { code: "AGE_CHECK_REQUIRED" });
  assert.throws(() => parseFanzaTags(ageCheck, fanzaWorkUrl), { code: "AGE_CHECK_REQUIRED" });
  assert.throws(() => parseFanzaHistory("<html>メンテナンス中</html>", 1, fanzaUrl), { code: "HISTORY_FORMAT" });
  assert.throws(() => parseFanzaHistory("<html><p>合計 1,000円</p></html>", 1, fanzaUrl), { code: "HISTORY_FORMAT" });
});

test("FANZAの作品ページからジャンルだけを抽出し、作者・シリーズ・ナビ・おすすめを除外する", async () => {
  assert.deepEqual(parseFanzaTags(await fixture("fanza-work.html"), fanzaWorkUrl), ["ASMR", "耳かき"]);
  assert.deepEqual(parseFanzaTags(withPageDecorations(await fixture("fanza-work.html")), fanzaWorkUrl), ["ASMR", "耳かき"]);
  assert.deepEqual(parseFanzaTags(fanzaWorkHtml(["A & B", "タグ<特別>"]), fanzaWorkUrl), ["A & B", "タグ<特別>"]);
});

test("FANZAの作品情報が表形式でもジャンル行のリンクだけを読む", () => {
  const table = '<main><h1 class="productTitle__txt">作品</h1><table class="productInformation"><tr><th>サークル</th><td><a>除外サークル</a></td></tr><tr><td class="label">ジャンル：</td><td><a href="/g/1">成人向け</a><a href="/g/2">ASMR</a></td></tr></table></main>';
  assert.deepEqual(parseFanzaTags(table, fanzaWorkUrl), ["成人向け", "ASMR"]);
  const siblings = '<main><div class="productInfo"><div class="item"><span>ジャンル</span><div><a>癒し</a></div></div><div class="item"><span>作者</span><div><a>除外作者</a></div></div></div></main>';
  assert.deepEqual(parseFanzaTags(siblings, fanzaWorkUrl), ["癒し"]);
});

test("FANZAの有効な作品のジャンルなしと、販売終了・未知のページを区別する", () => {
  assert.deepEqual(parseFanzaTags(fanzaWorkHtml([]), fanzaWorkUrl), []);
  const noGenre = '<main><h1 class="productTitle__txt">作品</h1><dl><dt>作者</dt><dd><a>作者</a></dd></dl></main>';
  assert.deepEqual(parseFanzaTags(noGenre, fanzaWorkUrl), []);
  assert.throws(() => parseFanzaTags("<title>ページが見つかりません - FANZA</title>", fanzaWorkUrl), { code: "WORK_UNAVAILABLE" });
  assert.throws(() => parseFanzaTags("<main><p>この商品は現在販売しておりません。</p></main>", fanzaWorkUrl), { code: "WORK_UNAVAILABLE" });
  assert.throws(() => parseFanzaTags("<title>確認中</title>", fanzaWorkUrl), { code: "WORK_FORMAT" });
  assert.throws(() => parseFanzaTags("<main><h1>お住まいの地域からはご利用いただけません</h1></main>", fanzaWorkUrl), { code: "FANZA_UNAVAILABLE" });
});

test("FANZA同人以外や不正なURLを作品として扱わない", () => {
  for (const href of ["https://www.dmm.co.jp/digital/videoa/-/detail/=/cid=abc00001/", "https://book.dmm.co.jp/product/1/", "http://www.dmm.co.jp/dc/doujin/-/detail/=/cid=d_1/", "https://www.dmm.co.jp.evil.example/dc/doujin/-/detail/=/cid=d_1/", "https://www.dmm.co.jp/dc/doujin/-/list/=/article=keyword/id=1/", "javascript:alert(1)"]) {
    assert.equal(fanzaWorkFromUrl(href, fanzaUrl), null);
  }
  // 購入履歴のホストからの相対リンクも、作品IDを小文字にしたwww.dmm.co.jpの正規URLへそろえる。
  assert.deepEqual(fanzaWorkFromUrl("/dc/doujin/-/detail/=/cid=D_12AB/?x=1#top", fanzaUrl), { id: "d_12ab", url: "https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=d_12ab/", service: "fanza" });
  assert.equal(workFromUrl(fanzaWorkUrl, fanzaUrl), null);
});

test("サービス名で解析関数を振り分け、未知のサービスは拒否する", async () => {
  assert.equal((await Promise.resolve(parseHistoryFor("dlsite", await fixture("history-1.html"), 1))).works.length, 2);
  assert.equal(parseHistoryFor("fanza", await fixture("fanza-history.html"), 1, fanzaUrl).pageKeys.length, 3);
  assert.deepEqual(parseTagsFor("fanza", fanzaWorkHtml(["ASMR"]), fanzaWorkUrl), ["ASMR"]);
  assert.throws(() => parseTagsFor("unknown", "", fanzaWorkUrl));
});
