/** ログイン済みのDLsite・FANZAからHTMLを取得し、アクセス間隔・再試行・タイムアウトを管理する。 */
import { AnalysisError, SERVICES, historyRequest } from "./model.js";
import { parseHistoryFor, parseTagsFor, workFromUrlFor } from "./parsers.js";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const LOGIN_HOSTS = Object.values(SERVICES).flatMap((service) => service.loginHosts);

/**
 * 通常はfetchで取得し、テストでは通信と待機を差し替える。
 * offscreenでは解析関数も差し替え、取得HTMLをDOMのないWorkerへ渡す。
 */
export function createClient({
  fetchImpl = fetch, wait = sleep, interval = 600, timeout = 20000,
  parseHistoryImpl = parseHistoryFor, parseTagsImpl = parseTagsFor,
} = {}) {
  let requested = false;

  /** 成功したHTMLと最終URLを返し、取得不可と通信障害を別のエラーとして扱う。 */
  async function getHtml(service, url, init = {}) {
    const { label, origins } = SERVICES[service];
    // 作品ページは並列取得せず、連続するリクエストの間に最低600msの間隔を置く。
    if (requested) await wait(interval);
    requested = true;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      let retryDelay = null;
      try {
        const response = await fetchImpl(url, {
          ...init,
          // Cookieを直接読み取らず、Chromeに既存のログインCookieの送信を任せる。
          credentials: "include", cache: "no-store", signal: controller.signal,
          headers: { Accept: "text/html", ...(init.headers ?? {}) },
        });
        const finalUrl = response.url || url;
        if (LOGIN_HOSTS.includes(new URL(finalUrl).hostname) || response.status === 401) {
          throw new AnalysisError("LOGIN_REQUIRED", `${label}にログインしてから、もう一度集計してください。${label}を集計しない場合は、集計対象から外してください。`);
        }
        if ([404, 410].includes(response.status)) {
          throw new AnalysisError("WORK_UNAVAILABLE", "作品ページが公開されていません。");
        }
        if (response.status === 429 || response.status >= 500) {
          const retryAfter = response.headers.get("retry-after");
          const seconds = retryAfter && /^\d+$/u.test(retryAfter) ? Number(retryAfter)
            : retryAfter ? Math.max(0, (Date.parse(retryAfter) - Date.now()) / 1000) : 0;
          // 長い制限は無理に再試行せず、時間を置いての再集計を案内する。
          if (seconds > 60 || attempt === 2) {
            throw new AnalysisError("RATE_LIMIT", `${label}が混雑しているか、アクセスが制限されています。時間を置いて再集計してください。`);
          }
          // 指数的に待機を増やし、サーバー指定のRetry-Afterより短く待たない。
          retryDelay = Math.max(1000 * 2 ** attempt, Number.isFinite(seconds) ? seconds * 1000 : 0);
        } else {
          if (!response.ok) {
            throw new AnalysisError("HTTP_ERROR", `${label}から情報を取得できませんでした（HTTP ${response.status}）。購入履歴をブラウザで確認してください。`);
          }
          if (!origins.includes(new URL(finalUrl).origin)) {
            throw new AnalysisError("WORK_UNAVAILABLE", `${label}以外に移動したページは集計できません。`);
          }
          return { html: await response.text(), url: finalUrl };
        }
      } catch (error) {
        // 判定済みの認証・HTTPエラーは再試行せず、通信例外とタイムアウトだけを再試行する。
        if (error instanceof AnalysisError) throw error;
        if (attempt === 2) {
          throw new AnalysisError("NETWORK_ERROR", `${label}への通信に失敗しました。通信環境を確認して、もう一度集計してください。`);
        }
        retryDelay = 1000 * 2 ** attempt;
      } finally {
        clearTimeout(timer);
      }
      await wait(retryDelay);
    }
  }

  return {
    async getHistory(service, page, pageKeys = []) {
      if (!SERVICES[service]) throw new Error("Unknown service");
      try {
        const { url, init } = historyRequest(service, page, pageKeys);
        const result = await getHtml(service, url, init);
        return await parseHistoryImpl(service, result.html, page, result.url, pageKeys);
      } catch (error) {
        // 作品ページの404は除外できるが、履歴ページの404では全件取得を続けられない。
        if (error.code === "WORK_UNAVAILABLE") {
          throw new AnalysisError("HISTORY_UNAVAILABLE", `${SERVICES[service].label}の購入履歴ページを取得できませんでした。${SERVICES[service].label}で購入履歴を確認してください。`);
        }
        throw error;
      }
    },
    async getTags(work) {
      const service = work.service ?? "dlsite";
      if (!SERVICES[service] || !workFromUrlFor(service, work.url, work.url)) throw new Error("Invalid work URL");
      const result = await getHtml(service, work.url);
      return parseTagsImpl(service, result.html, result.url);
    },
  };
}
