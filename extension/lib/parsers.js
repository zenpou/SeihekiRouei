/** DLsite・FANZAのHTMLをJavaScriptのノードとして解析し、購入作品・ページ情報・ジャンルを取り出す。 */
import { AnalysisError, SERVICES, historyUrl, FANZA_HISTORY_URL, isFanzaMonth } from "./model.js";
import { parseDocument, selectOne, selectAll, is, textContent } from "./vendor/html-parser.js";

const normalize = (text) => (text ?? "").replace(/\s+/gu, " ").trim();
const PRODUCT_PATH = /^\/[^/]+\/work\/=\/product_id\/((?:RJ|VJ|BJ)\d+)\.html\/?$/i;
// FANZA同人の作品URL。cid=の後の作品IDだけを使い、履歴から付く参照用の末尾パラメータは捨てる。
const FANZA_PRODUCT_PATH = /^\/dc\/doujin\/-\/detail\/=\/(?:[^/]*\/)*?cid[=/](d_[a-z0-9]+)(?:\/|$)/iu;

// ブラウザのDOMを使わないため、取得HTMLのCSS・スクリプト・画像などは適用されない。
const query = (node, selector) => node ? selectOne(selector, node) : null;
const queryAll = (node, selector) => node ? selectAll(selector, node) : [];
const attribute = (node, name) => node?.attribs?.[name] ?? null;
const text = (node) => node ? textContent(node) : "";
function closest(node, selector) {
  for (let ancestor = node; ancestor; ancestor = ancestor.parent) {
    if (ancestor.name && is(ancestor, selector)) return ancestor;
  }
  return null;
}
const elementChildren = (node) => (node?.children ?? []).filter((child) => child.type === "tag");
function nextElement(node) {
  const siblings = elementChildren(node?.parent);
  return siblings[siblings.indexOf(node) + 1] ?? null;
}
const contains = (ancestor, node) => {
  for (let current = node; current; current = current.parent) if (current === ancestor) return true;
  return false;
};

function unavailableId(row) {
  // IDのない販売終了作品は作品名と購入日の固定ハッシュで識別し、ページの繰り返しも検知する。
  const identity = `${normalize(text(query(row, ".work_name")))}|${normalize(text(query(row, ".buy_date")))}`;
  let hash = 0xcbf29ce484222325n;
  for (const character of identity) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(character.codePointAt(0))) * 0x100000001b3n);
  }
  return `unavailable:${hash.toString(16)}`;
}

/** 対応するDLsiteの作品URLだけを許可し、作品IDの大文字化と表示言語の統一を行う。 */
export function workFromUrl(href, base) {
  try {
    const url = new URL(href, base);
    const match = url.pathname.match(PRODUCT_PATH);
    if (url.origin !== "https://www.dlsite.com" || !match) return null;
    url.search = "?locale=ja_JP";
    url.hash = "";
    return { id: match[1].toUpperCase(), url: url.href, service: "dlsite" };
  } catch {
    return null;
  }
}

/**
 * FANZA同人の作品URLだけを許可し、作品IDを小文字に統一した正規のURLにする。
 * 購入履歴（payment.dmm.co.jp）内の相対リンクも作品として扱えるよう、dmm.co.jp配下のホストを受け入れる。
 */
export function fanzaWorkFromUrl(href, base) {
  try {
    const url = new URL(href, base);
    const match = url.pathname.match(FANZA_PRODUCT_PATH);
    const dmmHost = url.hostname === "dmm.co.jp" || url.hostname.endsWith(".dmm.co.jp");
    if (url.protocol !== "https:" || !dmmHost || !match) return null;
    const id = match[1].toLowerCase();
    return { id, url: `https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=${id}/`, service: "fanza" };
  } catch {
    return null;
  }
}

/** サービスに応じた作品URLの検証を行う。 */
export function workFromUrlFor(service, href, base) {
  if (service === "fanza") return fanzaWorkFromUrl(href, base);
  return workFromUrl(href, base);
}

/** 認証画面を購入作品ゼロやタグなしと誤認しないよう、解析前に確認する。 */
export function assertLoggedIn(document, url, service = "dlsite") {
  const host = new URL(url).hostname;
  const loginHosts = Object.values(SERVICES).flatMap((definition) => definition.loginHosts);
  if (loginHosts.includes(host) || host.endsWith(".vivion.jp")
      || query(document, 'form input[type="password"]')) {
    throw loginRequired(service);
  }
}

function loginRequired(service) {
  const label = SERVICES[service]?.label ?? "DLsite";
  return new AnalysisError("LOGIN_REQUIRED", `${label}にログインしてから、もう一度集計してください。${label}を集計しない場合は、集計対象から外してください。`);
}

/**
 * FANZAの年齢認証・地域制限の画面はHTTP 200で返るため、本文の有無を確認した後に判定する。
 * 購入履歴ゼロや作品のタグなしとして扱わないよう、専用のエラーにする。
 */
function assertFanzaAccessible(document, url) {
  const title = normalize(text(query(document, "title")));
  const path = new URL(url).pathname;
  if (/年齢認証/u.test(title) || path.includes("/age_check/")
      || (query(document, 'a[href*="declared=yes"], form[action*="age_check"]') && /年齢|18歳/u.test(normalize(text(document))))) {
    throw new AnalysisError("AGE_CHECK_REQUIRED", "FANZAの年齢認証ページが表示されました。ブラウザでFANZAを開いて年齢認証を済ませてから、もう一度集計してください。");
  }
  if (/not-available-in-your-region/u.test(url) || /お住まいの地域/u.test(normalize(text(query(document, "title, h1, main") ?? document)))) {
    throw new AnalysisError("FANZA_UNAVAILABLE", "お住まいの地域からはFANZAを利用できないため、FANZAの集計はできません。集計対象からFANZAを外してください。");
  }
}

/** data-valueだけのページャーと、URLにページ番号を持つページャーの両方を読む。 */
function pageNumber(element, base) {
  const value = attribute(element, "data-value");
  if (value && /^\d+$/u.test(value)) return Number(value);
  const href = attribute(element, "href");
  if (!href) return null;
  try {
    const url = new URL(href, base);
    if (url.origin !== "https://www.dlsite.com" || !url.pathname.includes("/mypage/userbuy")) return null;
    const page = url.pathname.match(/\/page\/(\d+)(?:\/|$)/u)?.[1] ?? url.searchParams.get("page");
    return page && /^\d+$/u.test(page) ? Number(page) : null;
  } catch {
    return null;
  }
}

/** DLsiteの履歴の作品一覧と次ページを返す。未知の形式を空の購入履歴として扱わない。 */
export function parseHistory(html, page, url = historyUrl(page)) {
  const document = parseDocument(html);
  assertLoggedIn(document, url, "dlsite");
  const container = query(document, "#buy_history_this");
  const table = query(container ?? document, ".work_list_main");
  const emptyMessage = /(?:購入(?:履歴|作品|商品).{0,30}(?:ありません|ございません|ありませんでした)|該当する.{0,20}(?:ありません|ございません))/u;
  const hasPurchaseInfo = (node) => attribute(node, "data-product-id") !== null
    || query(node, ".work_name, .buy_date, [data-product-id]")
    || queryAll(node, "a[href]").some((anchor) => workFromUrl(attribute(anchor, "href"), url));
  // 空履歴の案内は購入情報のない1セルの行だけ。作品名中の「購入作品はありません」等は除外しない。
  const isEmptyMessageRow = (row) => !hasPurchaseInfo(row)
    && queryAll(row, "td").length === 1 && emptyMessage.test(normalize(text(row)));
  if (!table) {
    if (container && !hasPurchaseInfo(container) && emptyMessage.test(normalize(text(container)))) {
      return { works: [], nextPage: null, totalPages: page };
    }
    throw new AnalysisError("HISTORY_FORMAT", "DLsiteの購入履歴を読み取れませんでした。DLsiteの購入履歴ページを確認してください。");
  }

  // 見出し行や入れ子の別テーブルの行は、購入作品として数えない。
  const dataRows = queryAll(table, "tr:not(.item_name)")
    .filter((row) => closest(row, "table") === table && query(row, "td"));
  const rows = dataRows.filter((row) => !isEmptyMessageRow(row));
  const works = rows.map((row) => {
    if (!query(row, ".work_name") || !query(row, ".buy_date")) {
      throw new AnalysisError("HISTORY_FORMAT", "DLsiteの購入履歴の形式が変わっているため、集計を中止しました。");
    }
    const link = queryAll(row, ".work_name a[href]")
      .map((anchor) => workFromUrl(attribute(anchor, "href"), url)).find(Boolean);
    const id = attribute(row, "data-product-id") ?? attribute(query(row, "[data-product-id]"), "data-product-id");
    // 作品リンクがなくても履歴から消さず、タグ取得不可の件数に含めるため残す。
    return link ?? { id: /^(?:RJ|VJ|BJ)\d+$/i.test(id ?? "") ? id.toUpperCase() : unavailableId(row), url: null, service: "dlsite" };
  });

  // データ行の存在する未知のテーブルを、正常なゼロ作品の履歴として返さない。
  if (!works.length && queryAll(table, "tr:not(.item_name)")
    .some((row) => query(row, "td") && !isEmptyMessageRow(row))) {
    throw new AnalysisError("HISTORY_FORMAT", "DLsiteの購入履歴の作品を読み取れませんでした。DLsiteのページ形式を確認してください。");
  }

  const pager = queryAll(document, ".page_no a, .page_no [data-value], a[rel='next']")
    .filter((element) => !closest(element, '.disabled, .is-disabled, [aria-disabled="true"]'));
  const numbers = pager.map((element) => pageNumber(element, url))
    .filter((number) => Number.isSafeInteger(number) && number > 0);
  const hasNext = pager.some((element) => {
    const number = pageNumber(element, url);
    return (number !== null && number > page)
      || ((attribute(element, "href") !== null || attribute(element, "data-value") !== null)
        && /^(?:次(?:へ|のページ)?|next|[>›»])$/iu.test(normalize(text(element))));
  });
  return {
    works,
    // 最終ページへのリンクしかない場合でも、中間ページを飛ばさず1ページずつ進める。
    nextPage: hasNext ? page + 1 : null,
    totalPages: numbers.length ? Math.max(page, ...numbers) : null,
  };
}

/** DLsiteのジャンル欄のタグだけを抽出する。有効な作品のタグなしと、未知のページ形式を区別する。 */
export function parseTags(html, url) {
  const document = parseDocument(html);
  assertLoggedIn(document, url, "dlsite");
  const outline = query(document, "#work_outline");
  if (!outline) {
    const message = normalize(text(query(document, "#main_inner, main") ?? query(document, "title")));
    if (/(?:作品|商品|ページ).{0,20}(?:見つかりません|存在しません|販売終了|販売を終了)/u.test(message)) {
      throw new AnalysisError("WORK_UNAVAILABLE", "販売終了などにより作品情報を取得できませんでした。");
    }
    throw new AnalysisError("WORK_FORMAT", "作品のタグを読み取れませんでした。DLsiteの作品ページの形式を確認してください。");
  }
  // 作品の詳細表に限定し、声優・容量・おすすめ作品などのリンクを混ぜない。
  const genreRows = queryAll(outline, "tr")
    .filter((row) => /^(?:ジャンル|genre)$/iu.test(normalize(text(query(row, "th")))));
  const anchors = genreRows.length
    ? genreRows.flatMap((row) => queryAll(row, "td a"))
    : queryAll(outline, '.main_genre a[href*="/genre/"]');
  return [...new Set(anchors.map((anchor) => normalize(text(anchor))).filter(Boolean))];
}

/** 購入年月の選択肢を持つselectを探す。idが変わっても、年月形式の値を持つselectを受け入れる。 */
function fanzaMonths(document) {
  const monthsOf = (select) => [...new Set(queryAll(select, "option")
    .map((option) => attribute(option, "value")).filter(isFanzaMonth))];
  const named = query(document, 'select#purchaseDate, select[name="purchaseDate"]');
  if (named) return monthsOf(named);
  const candidates = queryAll(document, "select").map(monthsOf).filter((months) => months.length);
  return candidates.length ? candidates[0] : null;
}

/** FANZAの購入履歴に含まれるFANZA同人の作品リンクを、同一ページ内の重複を除いて返す。 */
function fanzaWorks(document, url) {
  const works = new Map();
  for (const anchor of queryAll(document, "a[href]")) {
    const work = fanzaWorkFromUrl(attribute(anchor, "href"), url);
    if (work && !works.has(work.id)) works.set(work.id, work);
  }
  return [...works.values()];
}

/**
 * FANZAの購入履歴を読む。1ページ目は購入年月の一覧（pageKeys）を返し、2ページ目以降は
 * pageKeys[page - 2]の月の履歴として扱う。動画・ブックスなど同人以外の購入は作品に含めない。
 */
export function parseFanzaHistory(html, page, url = FANZA_HISTORY_URL, pageKeys = []) {
  const document = parseDocument(html);
  assertLoggedIn(document, url, "fanza");
  const months = fanzaMonths(document);
  const works = fanzaWorks(document, url);
  const body = normalize(text(query(document, "main, #main-history-purchase") ?? document));
  const emptyMessage = /(?:購入(?:履歴|商品|作品)|ご利用履歴|履歴).{0,20}(?:ありません|ございません|ありませんでした)/u;
  // 月別の表（合計金額の欄）か、作品リンクか、空履歴の案内があれば購入履歴ページとみなす。
  const hasHistoryContent = months !== null || works.length > 0
    || query(document, ".grand-total, [class*='history']") !== null || emptyMessage.test(body);
  if (!hasHistoryContent) {
    assertFanzaAccessible(document, url);
    throw new AnalysisError("HISTORY_FORMAT", "FANZAの購入履歴を読み取れませんでした。FANZAの購入履歴ページを確認してください。");
  }
  if (page === 1) {
    // 年月の選択肢がない場合は、空履歴の案内があるときだけ購入ゼロとして扱う。
    if (months === null && !works.length) {
      if (emptyMessage.test(body)) return { works: [], nextPage: null, totalPages: 1, pageKeys: [] };
      throw new AnalysisError("HISTORY_FORMAT", "FANZAの購入年月の一覧を読み取れませんでした。FANZAの購入履歴ページを確認してください。");
    }
    const keys = months ?? [];
    return { works, nextPage: keys.length ? 2 : null, totalPages: keys.length + 1, pageKeys: keys };
  }
  // 月別の表示では保存済みの年月一覧に沿って進み、ページ内の選択肢で一覧を置き換えない。
  return { works, nextPage: page <= pageKeys.length ? page + 1 : null, totalPages: pageKeys.length + 1, pageKeys };
}

/** 「ジャンル」の見出しに対応する値の要素を返す。表・定義リスト・汎用の並びに対応する。 */
function fanzaGenreValues(label) {
  if (label.name === "th" || label.name === "td") {
    const row = closest(label, "tr");
    return queryAll(row, "td").filter((cell) => cell !== label && !contains(cell, label) && !contains(label, cell));
  }
  if (label.name === "dt") {
    const values = [];
    for (let sibling = nextElement(label); sibling && sibling.name !== "dt"; sibling = nextElement(sibling)) {
      if (sibling.name === "dd") values.push(sibling);
    }
    return values;
  }
  // 見出しと値が兄弟として並ぶ形式。見出しが入れ子なら、親をたどって最初の兄弟要素を使う。
  for (let node = label, depth = 0; node && depth < 3; node = node.parent, depth += 1) {
    const sibling = nextElement(node);
    if (sibling) return [sibling];
  }
  return [];
}

/** FANZA同人の作品ページからジャンルを抽出する。シリーズや作者など、他の項目のリンクは混ぜない。 */
export function parseFanzaTags(html, url) {
  const document = parseDocument(html);
  assertLoggedIn(document, url, "fanza");
  const isLabel = (node) => /^ジャンル[:：]?$/u.test(normalize(text(node)));
  // 同じ文字列を持つ入れ子の要素のうち、最も内側の見出しだけを使う。
  const candidates = queryAll(document, "th, td, dt, div, span, p, li, h2, h3, h4")
    .filter((node) => isLabel(node) && !elementChildren(node).some(isLabel) && !closest(node, "nav, header, footer, aside"));
  // サイト全体のジャンル一覧などを混ぜないよう、作品情報の表・定義リスト内の見出しを優先する。
  const scoped = candidates.filter((node) => closest(node, "table, dl, [class*='nformation'], [class*='productInfo'], [class*='product-info']"));
  const labels = scoped.length ? scoped : candidates;
  if (labels.length) {
    const values = labels.flatMap(fanzaGenreValues);
    const anchors = values.flatMap((value) => queryAll(value, "a"));
    const items = anchors.length ? anchors : values.flatMap((value) => queryAll(value, "li"));
    return [...new Set(items.map((item) => normalize(text(item))).filter(Boolean))];
  }
  const message = normalize(text(query(document, "main, #main, #w") ?? query(document, "title")));
  if (/(?:販売(?:を)?終了|販売しておりません|(?:ご)?購入(?:いただけ|でき)ません|(?:ページ|商品|作品)(?:は|が)?(?:見つかりません|存在しません))/u.test(message)) {
    throw new AnalysisError("WORK_UNAVAILABLE", "販売終了などによりFANZAの作品情報を取得できませんでした。");
  }
  assertFanzaAccessible(document, url);
  // 作品ページの既知の要素があれば、ジャンル欄のない有効な作品としてタグなしを返す。
  const canonical = attribute(query(document, 'meta[property="og:url"], link[rel="canonical"]'), "content")
    ?? attribute(query(document, 'link[rel="canonical"]'), "href") ?? "";
  if (query(document, ".productTitle__txt, .circleName__txt") || FANZA_PRODUCT_PATH.test(safePath(canonical))) return [];
  throw new AnalysisError("WORK_FORMAT", "作品のタグを読み取れませんでした。FANZAの作品ページの形式を確認してください。");
}

function safePath(href) {
  try {
    return new URL(href).pathname;
  } catch {
    return "";
  }
}

/** サービスに応じた購入履歴の解析を行う。 */
export function parseHistoryFor(service, html, page, url, pageKeys = []) {
  if (service === "fanza") return parseFanzaHistory(html, page, url ?? FANZA_HISTORY_URL, pageKeys);
  if (service === "dlsite") return parseHistory(html, page, url ?? historyUrl(page));
  throw new Error("Unknown service");
}

/** サービスに応じた作品ページの解析を行う。 */
export function parseTagsFor(service, html, url) {
  if (service === "fanza") return parseFanzaTags(html, url);
  if (service === "dlsite") return parseTags(html, url);
  throw new Error("Unknown service");
}
