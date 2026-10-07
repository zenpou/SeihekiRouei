/** ジョブの保存形式、集計対象サービス、表示用データ、タグの並び順、Xの投稿文を定義する。 */
export const STORAGE_KEY = "analysis";
// 除外設定と集計対象サービスは端末内に保存し、集計データのセッションとは独立して引き継ぐ。
export const EXCLUDED_TAGS_KEY = "excludedTags";
export const SERVICES_KEY = "services";
// type/allとstart/allで、作品種別や購入年月を絞らずにページを巡回する。
export const HISTORY_BASE = "https://www.dlsite.com/maniax/mypage/userbuy/=/type/all/start/all/sort/1/order/1/page/";
// FANZAの購入履歴は購入年月ごとに表示されるため、年月の一覧を取得してから月単位で巡回する。
export const FANZA_HISTORY_URL = "https://payment.dmm.co.jp/history/";
const FANZA_MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/u;

/**
 * 集計対象サービスの定義。originsは取得を許可する通信先、loginHostsはログイン画面への移動を検知するホスト。
 * 配列の順序がそのまま履歴取得の順序と、設定・投稿文での表示順になる。
 */
export const SERVICES = {
  dlsite: {
    id: "dlsite", label: "DLsite", optionLabel: "DLsite",
    origins: ["https://www.dlsite.com"], loginHosts: ["login.dlsite.com"],
    historyPageUrl: "https://www.dlsite.com/maniax/mypage/userbuy/=/type/all/start/all",
  },
  fanza: {
    id: "fanza", label: "FANZA", optionLabel: "FANZA同人",
    origins: ["https://www.dmm.co.jp", "https://payment.dmm.co.jp"], loginHosts: ["accounts.dmm.co.jp", "accounts.dmm.com"],
    historyPageUrl: FANZA_HISTORY_URL,
  },
};
export const SERVICE_IDS = Object.keys(SERVICES);
export const DEFAULT_SERVICES = [...SERVICE_IDS];

/** 通信・解析・保存をまたいで、エラーコードと利用者向けの説明を保持する。 */
export class AnalysisError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AnalysisError";
    this.code = code;
  }
}

/** 保存値や受信した設定から、既知のサービスだけを定義順に並べて返す。空や不正な値はnull。 */
export function normalizeServices(value) {
  if (!Array.isArray(value)) return null;
  const selected = SERVICE_IDS.filter((id) => value.includes(id));
  return selected.length ? selected : null;
}

/** ページ番号を検証し、タグ名の言語をそろえるため日本語表示を指定する。 */
export function historyUrl(page) {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("Invalid page");
  return `${HISTORY_BASE}${page}?locale=ja_JP`;
}

/**
 * サービスごとの履歴ページの取得方法を返す。DLsiteはページ番号のURL、FANZAは1ページ目で
 * 購入年月の一覧を読み、2ページ目以降は年月（pageKeys）を指定したPOSTで月ごとの履歴を取得する。
 */
export function historyRequest(service, page, pageKeys = []) {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("Invalid page");
  if (service === "dlsite") return { url: historyUrl(page), init: {} };
  if (service !== "fanza") throw new Error("Unknown service");
  if (page === 1) return { url: FANZA_HISTORY_URL, init: {} };
  const month = pageKeys[page - 2];
  if (typeof month !== "string" || !FANZA_MONTH.test(month)) throw new Error("Invalid page");
  return {
    url: FANZA_HISTORY_URL,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ purchaseDate: month }).toString(),
    },
  };
}

/** FANZAの購入年月として扱える値だけを通し、未知の値をリクエストに使わない。 */
export function isFanzaMonth(value) {
  return typeof value === "string" && FANZA_MONTH.test(value);
}

/**
 * 新しい集計の保存状態を作る。phaseはhistory（履歴取得）からtags（タグ集計）へ進む。
 * servicesは履歴を取得する順序、serviceIndexは現在取得中のサービスの位置。
 * nextPage・totalPages・pageSignatures・pageKeysは現在のサービスの履歴取得の進捗で、次のサービスへ進むときに初期化する。
 * cursorは次に処理する作品の位置、revisionは保存のたびに増える更新番号。
 * countsはMapの内容を配列で保存し、再開時に復元する。
 */
export function newJob(id = crypto.randomUUID(), now = Date.now(), services = DEFAULT_SERVICES) {
  const selected = normalizeServices(services);
  if (!selected) throw new AnalysisError("INVALID_SETTING", "集計対象のサービスを1つ以上選んでください。");
  return {
    id, revision: 0, status: "running", phase: "history",
    services: selected, serviceIndex: 0,
    nextPage: 1, totalPages: null, historyPages: 0, pageKeys: null,
    works: [], pageSignatures: [], cursor: 0, counts: [],
    unavailableCount: 0, taglessCount: 0,
    startedAt: now, updatedAt: now, finishedAt: null, error: null,
  };
}

/** サービスをまたいで作品を一意に識別する。DLsiteとFANZAの作品IDは別の体系のため、サービス名を付ける。 */
export function workKey(work) {
  return `${work.service ?? "dlsite"}:${work.id}`;
}

/** 作品数の降順で並べ、同数のタグは日本語の名前順にする。 */
export function rankTags(counts) {
  return counts.map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, "ja"));
}

/** 元の件数を変更せず、除外されていないタグを順位順で返す。 */
export function visibleTags(ranking, excludedTags = []) {
  const excluded = new Set(excludedTags);
  return ranking.filter(({ tag }) => !excluded.has(tag));
}

/** 大きい作品一覧や再開用データを含めず、ポップアップに必要な状態だけを返す。 */
export function viewOf(job) {
  if (!job) return { status: "idle", ranking: [], services: [] };
  const services = job.services ?? ["dlsite"];
  const worksByService = Object.fromEntries(services.map((service) => [service, 0]));
  for (const work of job.works) {
    const service = work.service ?? "dlsite";
    worksByService[service] = (worksByService[service] ?? 0) + 1;
  }
  const historyService = job.phase === "history" ? services[job.serviceIndex ?? 0] ?? null : null;
  return {
    id: job.id, revision: job.revision, status: job.status, phase: job.phase,
    services, historyService,
    nextPage: job.nextPage, totalPages: job.totalPages, historyPages: job.historyPages,
    // FANZAでは2ページ目以降が購入年月に対応するため、進捗表示用に現在の年月も返す。
    currentPageKey: historyService === "fanza" && job.nextPage !== null && job.nextPage >= 2
      ? job.pageKeys?.[job.nextPage - 2] ?? null : null,
    totalWorks: job.works.length, worksByService, processedWorks: job.cursor,
    analyzedWorks: job.cursor - job.unavailableCount,
    unavailableCount: job.unavailableCount, taglessCount: job.taglessCount,
    finishedAt: job.finishedAt, error: job.error, ranking: rankTags(job.counts),
  };
}

/** 集計対象のサービス名を「DLsite・FANZA」のように定義順でつなぐ。 */
export function serviceNames(services = []) {
  const known = normalizeServices(services) ?? ["dlsite"];
  return known.map((id) => SERVICES[id].label).join("・");
}

/** 上位5タグだけを投稿文に含める。取得不可作品の注釈は付けない。 */
export function tweetText(view) {
  const lines = [`私の${serviceNames(view.services)}購入作品のタグTOP5`];
  for (const [index, { tag, count }] of view.ranking.slice(0, 5).entries()) {
    lines.push(`${index + 1}. ${tag}（${count}作品）`);
  }
  lines.push("#SeihekiRouei");
  return lines.join("\n");
}

/** 日本語や記号をURLSearchParamsでエンコードし、投稿の編集画面を開くURLを作る。 */
export function tweetUrl(view) {
  const url = new URL("https://x.com/intent/tweet");
  url.searchParams.set("text", tweetText(view));
  return url.href;
}

/** WorkerのメッセージやStorageで扱えるよう、Errorを通常のオブジェクトに変換する。 */
export function errorInfo(error) {
  return {
    code: error.code ?? "UNKNOWN",
    message: error instanceof AnalysisError ? error.message
      : "集計を続けられませんでした。Chromeと通信環境を確認し、もう一度集計してください。",
  };
}
