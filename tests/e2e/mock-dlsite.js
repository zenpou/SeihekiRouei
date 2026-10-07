/** DLsite・FANZAとXの応答をローカルHTTPSで再現し、実サービスに触れずに拡張の通信を検証する。 */
import { createServer } from "node:https";
import { createHash, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fixture, tagsByWork, workHtml, fanzaTagsByWork, fanzaWorkHtml, withPageDecorations } from "../helpers.js";

/** 毎回空きポートを使い、テスト用の名前解決・証明書設定をブラウザ起動引数として返す。 */
export async function createMockDlsite() {
  const [key, cert] = await Promise.all([
    readFile(new URL("../fixtures/test-key.pem", import.meta.url)),
    readFile(new URL("../fixtures/test-cert.pem", import.meta.url)),
  ]);
  // 実サービスに使わない公開テスト鍵。この証明書の公開鍵だけをテストブラウザで許可する。
  const spki = new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" });
  const fingerprint = createHash("sha256").update(spki).digest("base64");
  let options = { loggedIn: true, fanzaLoggedIn: true, failWork: false, delayed: false, empty: false, loginMarkup: false };
  const requests = [];
  const errors = [];
  const readBody = (request) => new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => resolve(body));
  });
  const server = createServer({ key, cert }, async (request, response) => {
    try {
      const url = new URL(request.url, `https://${request.headers.host}`);
      const body = request.method === "POST" ? await readBody(request) : "";
      requests.push({ url: url.href, method: request.method, body, cookie: request.headers.cookie ?? "" });
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      if (url.hostname === "x.com" && url.pathname === "/intent/tweet") {
        response.end("<title>投稿画面</title><h1>ツイートを編集</h1>");
      } else if (url.hostname === "login.dlsite.com" || url.hostname === "accounts.dmm.co.jp") {
        response.end('<form><input type="password"></form>');
      } else if (url.hostname.endsWith(".dmm.co.jp")) {
        await serveFanza(url, body, request, response);
      } else if (!options.loggedIn || !request.headers.cookie?.includes("test-session=mock-login")) {
        // ChromeがCookieを送信したことも確認し、未ログイン時の遷移を再現する。
        response.writeHead(302, { Location: "https://login.dlsite.com/login" });
        response.end();
      } else if (url.pathname.includes("/mypage/userbuy/")) {
        const page = url.pathname.match(/\/page\/(\d+)/u)?.[1];
        response.end(withPageDecorations(await fixture(options.empty ? "empty-history.html" : `history-${page}.html`)));
      } else {
        const id = url.pathname.match(/product_id\/([^/.]+)/u)?.[1].toUpperCase();
        if (options.delayed) await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
        if (id === "RJ000005") {
          response.writeHead(404);
          response.end("Not found");
        } else if (options.failWork) {
          response.writeHead(403);
          response.end("Forbidden");
        } else {
          response.end(withPageDecorations(options.loginMarkup ? '<form><input type="password"></form>' : workHtml(tagsByWork[id])));
        }
      }
    } catch (error) {
      errors.push(error.message);
      if (!response.headersSent) response.writeHead(500);
      response.end("Fixture error");
    }
  });
  /** FANZAの購入履歴（最初の表示と月別のPOST）と、同人作品ページを再現する。 */
  async function serveFanza(url, body, request, response) {
    if (url.hostname === "payment.dmm.co.jp" && url.pathname === "/history/") {
      if (!options.fanzaLoggedIn || !request.headers.cookie?.includes("fanza-session=mock-login")) {
        response.writeHead(302, { Location: "https://accounts.dmm.co.jp/service/login/password/=/path=https%3A%2F%2Fpayment.dmm.co.jp%2Fhistory%2F" });
        response.end();
        return;
      }
      const month = new URLSearchParams(body).get("purchaseDate");
      const name = request.method === "POST" && month ? `fanza-history-${month}.html` : "fanza-history.html";
      response.end(withPageDecorations(await fixture(name)));
      return;
    }
    const id = url.pathname.match(/cid=([^/]+)/u)?.[1].toLowerCase();
    if (url.hostname === "www.dmm.co.jp" && id) {
      if (options.delayed) await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
      if (id === "d_100003") {
        response.writeHead(404);
        response.end("Not found");
      } else if (options.failWork) {
        response.writeHead(403);
        response.end("Forbidden");
      } else {
        response.end(withPageDecorations(fanzaWorkHtml(fanzaTagsByWork[id])));
      }
      return;
    }
    response.writeHead(404);
    response.end("Not found");
  }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  server.unref();
  const hosts = ["www.dlsite.com", "login.dlsite.com", "www.dmm.co.jp", "payment.dmm.co.jp", "accounts.dmm.co.jp", "x.com"];
  return {
    requests, errors,
    // テスト専用ブラウザの名前解決だけを変え、指定したホスト以外への通信先は解決させない。
    args: [
      `--host-resolver-rules=${hosts.map((host) => `MAP ${host}:443 127.0.0.1:${port}`).join(", ")}, MAP * ~NOTFOUND`,
      `--ignore-certificate-errors-spki-list=${fingerprint}`,
      "--no-proxy-server",
    ],
    configure(next) { options = { ...options, ...next }; },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
