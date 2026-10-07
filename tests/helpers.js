/** 単体テストとE2Eで共用する、履歴・作品ページの架空データを提供する。 */
import { readFile } from "node:fs/promises";

export const fixture = (name) => readFile(new URL(`fixtures/${name}`, import.meta.url), "utf8");
/** CSSやスクリプト、画像などが解析時に有効にならないことを検証するためのHTMLを足す。 */
export function withPageDecorations(html) {
  // templateではbody属性が捨てられることがあるため、実際の要素にもstyle属性を付ける。
  const decorations = `<style>body { color: red; }</style>
    <div STYLE="display:none;visibility:hidden" data-caption="a > b">装飾</div>
    <div style='color:red'>装飾</div><div style=display:none>装飾</div>
    <script>globalThis.parsedScriptRan = true; const unused = '<table id="work_outline"><tr><th>ジャンル</th><td><a>偽のタグ</a></td></tr></table>';</script>
    <img src="https://www.dlsite.com/unused-image.png" onerror="globalThis.parsedScriptRan = true">
    <iframe src="https://www.dlsite.com/unused-frame.html"></iframe>
    <link rel="stylesheet" href="https://www.dlsite.com/unused-style.css">`;
  return /<body\b[^>]*>/iu.test(html)
    ? html.replace(/<body\b[^>]*>/iu, (body) => body + decorations)
    : decorations + html;
}
// ASMRの重複、タグなし、異なる作品種別を含め、作品単位の集計を検証する。
export const tagsByWork = {
  RJ000001: ["ASMR", "日常/生活", "癒し", "耳かき", "ASMR"],
  RJ000002: ["ASMR", "癒し", "日常/生活", "ささやき"],
  RJ000003: ["ASMR", "癒し", "バイノーラル"],
  VJ000006: [],
  BJ000007: ["ASMR", "音楽"],
};
/** タグ名はHTMLエスケープし、ジャンル以外の「ファイル容量」も含む作品ページを作る。 */
export function workHtml(tags) {
  return `<html><head><title>作品情報</title></head><body><h1 id="work_name">テスト作品</h1><table id="work_outline"><tr><th>ジャンル</th><td><div class="main_genre">${tags.map((tag) => `<a>${tag.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</a>`).join("")}</div></td></tr><tr><th>ファイル容量</th><td><div class="main_genre">100 MB</div></td></tr></table></body></html>`;
}
// FANZA同人の作品。DLsiteと同じタグ名（ASMR・癒し・耳かき）はサービスをまたいで同じタグとして数える。
export const fanzaTagsByWork = {
  d_100001: ["ASMR", "耳かき", "成人向け"],
  d_100002: ["癒し", "成人向け"],
};
/** FANZA同人の作品ページ。ジャンルは定義リスト形式で、作者・シリーズのリンクは集計対象外にする。 */
export function fanzaWorkHtml(tags) {
  const items = tags.map((tag) => `<li class="genreTagList__item"><a href="/dc/doujin/-/list/=/article=keyword/id=1/">${tag.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</a></li>`).join("");
  return `<html><head><title>作品情報 - FANZA同人</title></head><body><main><h1 class="productTitle__txt">テスト作品</h1><a class="circleName__txt" href="/dc/doujin/-/list/=/article=maker/id=1/">テストサークル</a><div class="m-productInformation"><dl class="informationList"><dt class="informationList__ttl">作者</dt><dd class="informationList__txt"><a href="/dc/doujin/-/list/=/article=author/id=1/">集計しない作者</a></dd></dl><dl class="informationList"><dt class="informationList__ttl">ジャンル</dt><dd class="informationList__txt"><ul class="genreTagList">${items}</ul></dd></dl></div></main></body></html>`;
}
