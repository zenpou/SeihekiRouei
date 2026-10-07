/** offscreenから届くHTMLを解析し、要求IDとともに結果・エラーを返す専用Worker。 */
import { parseHistoryFor, parseTagsFor } from "./lib/parsers.js";
import { errorInfo } from "./lib/model.js";

// WorkerにはブラウザDOMがないため、取得HTMLのCSSやスクリプトが有効になる経路を作らない。
self.addEventListener("message", ({ data }) => {
  try {
    let result;
    // serviceの省略時はDLsiteとして扱い、以前の形式の要求も解析できるようにする。
    const service = data.service ?? "dlsite";
    if (data.action === "history") result = parseHistoryFor(service, data.html, data.page, data.url, data.pageKeys ?? []);
    else if (data.action === "tags") result = parseTagsFor(service, data.html, data.url);
    else throw new Error("Unknown parse action");
    self.postMessage({ id: data.id, result });
  } catch (error) {
    // Errorの独自プロパティがメッセージ転送で失われないよう、コードと説明を明示して返す。
    self.postMessage({ id: data.id, error: errorInfo(error) });
  }
});
