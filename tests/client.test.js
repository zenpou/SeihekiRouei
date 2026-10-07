/** 実サービスへ通信せず、Cookie送信の指定・待機間隔・HTTP判定・再試行・タイムアウト・FANZAの月別取得を検証する。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../extension/lib/client.js";
import { fixture, fanzaWorkHtml } from "./helpers.js";

const work = { id: "RJ000001", url: "https://www.dlsite.com/home/work/=/product_id/RJ000001.html" };

test("ChromeのログインCookieを付け、リクエスト間隔を空ける", async () => {
  const waits = [], options = [];
  const html = await fixture("work.html");
  const client = createClient({
    async fetchImpl(url, init) { options.push(init); return new Response(html); },
    async wait(delay) { waits.push(delay); },
  });
  await client.getTags(work);
  await client.getTags(work);
  assert.ok(options.every((init) => init.credentials === "include" && init.cache === "no-store"));
  assert.deepEqual(waits, [600]);
});

test("429のRetry-Afterを守って再試行する", async () => {
  const waits = [];
  let requests = 0;
  const client = createClient({
    async fetchImpl() { requests += 1; return requests === 1 ? new Response("", { status: 429, headers: { "Retry-After": "3" } }) : new Response(await fixture("work.html")); },
    async wait(delay) { waits.push(delay); },
  });
  assert.deepEqual(await client.getTags(work), ["ASMR", "日常/生活"]);
  assert.equal(requests, 2);
  assert.deepEqual(waits, [3000]);
});

test("長いアクセス制限では再試行を打ち切り、成功として扱わない", async () => {
  const client = createClient({ async fetchImpl() { return new Response("", { status: 429, headers: { "Retry-After": "120" } }); } });
  await assert.rejects(client.getTags(work), { code: "RATE_LIMIT" });
});

test("ログインへのリダイレクトを明示する", async () => {
  const response = new Response("ログイン画面");
  Object.defineProperty(response, "url", { value: "https://login.dlsite.com/register?user=self" });
  const client = createClient({ async fetchImpl() { return response; } });
  await assert.rejects(client.getHistory("dlsite", 1), { code: "LOGIN_REQUIRED" });
});

test("購入履歴404と作品404を区別する", async () => {
  const client = createClient({ async fetchImpl() { return new Response("", { status: 404 }); }, async wait() {} });
  await assert.rejects(client.getTags(work), { code: "WORK_UNAVAILABLE" });
  await assert.rejects(client.getHistory("dlsite", 1), { code: "HISTORY_UNAVAILABLE" });
});

test("403でログイン成功やタグなしを推測しない", async () => {
  const client = createClient({ async fetchImpl() { return new Response("", { status: 403 }); } });
  await assert.rejects(client.getTags(work), { code: "HTTP_ERROR" });
});

test("通信失敗は3回までで終了する", async () => {
  let count = 0;
  const waits = [];
  const client = createClient({ async fetchImpl() { count += 1; throw new TypeError("offline"); }, async wait(delay) { waits.push(delay); } });
  await assert.rejects(client.getTags(work), { code: "NETWORK_ERROR" });
  assert.equal(count, 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test("応答のない通信はタイムアウトして終了する", async () => {
  let count = 0;
  const client = createClient({
    timeout: 5,
    fetchImpl(url, { signal }) {
      count += 1;
      return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    },
    async wait() {},
  });
  await assert.rejects(client.getTags(work), { code: "NETWORK_ERROR" });
  assert.equal(count, 3);
});

const fanzaWork = { id: "d_100001", url: "https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=d_100001/", service: "fanza" };

test("FANZAの購入履歴は1ページ目をGETし、2ページ目以降は購入年月をPOSTで指定する", async () => {
  const calls = [];
  const client = createClient({
    async fetchImpl(url, init) {
      calls.push({ url, method: init.method ?? "GET", body: init.body, type: init.headers["Content-Type"] });
      return new Response(await fixture(calls.length === 1 ? "fanza-history.html" : "fanza-history-2026-09.html"));
    },
    async wait() {},
  });
  const first = await client.getHistory("fanza", 1);
  assert.deepEqual(first.pageKeys, ["2026-10", "2026-09", "2026-08"]);
  assert.deepEqual(first.works.map(({ id }) => id), ["d_100001"]);
  const third = await client.getHistory("fanza", 3, first.pageKeys);
  assert.deepEqual(third.works.map(({ id }) => id), ["d_100002", "d_100003"]);
  assert.equal(third.nextPage, 4);
  assert.deepEqual(calls, [
    { url: "https://payment.dmm.co.jp/history/", method: "GET", body: undefined, type: undefined },
    { url: "https://payment.dmm.co.jp/history/", method: "POST", body: "purchaseDate=2026-09", type: "application/x-www-form-urlencoded" },
  ]);
  // 保存済みの年月一覧にない位置や不正な値は、リクエストに使わない。
  await assert.rejects(client.getHistory("fanza", 5, first.pageKeys));
  await assert.rejects(client.getHistory("fanza", 2, ["2026-9"]));
});

test("FANZAのログイン画面へのリダイレクトと作品404を判定し、サービス名を案内する", async () => {
  const response = new Response("ログイン");
  Object.defineProperty(response, "url", { value: "https://accounts.dmm.co.jp/service/login/password/=/path=x" });
  const client = createClient({ async fetchImpl() { return response; } });
  await assert.rejects(client.getHistory("fanza", 1), (error) => error.code === "LOGIN_REQUIRED" && error.message.includes("FANZA"));
  const notFound = createClient({ async fetchImpl() { return new Response("", { status: 404 }); }, async wait() {} });
  await assert.rejects(notFound.getTags(fanzaWork), { code: "WORK_UNAVAILABLE" });
});

test("FANZAの作品ページからタグを読み、DLsiteのURLをFANZAの作品として取得しない", async () => {
  const client = createClient({ async fetchImpl() { return new Response(fanzaWorkHtml(["ASMR", "成人向け"])); }, async wait() {} });
  assert.deepEqual(await client.getTags(fanzaWork), ["ASMR", "成人向け"]);
  await assert.rejects(client.getTags({ ...fanzaWork, url: work.url }), { message: "Invalid work URL" });
  await assert.rejects(client.getTags({ ...work, service: "fanza" }), { message: "Invalid work URL" });
});

test("FANZAの作品ページが別サイトへ移動した場合は取得不可として扱う", async () => {
  const response = new Response(fanzaWorkHtml(["ASMR"]));
  Object.defineProperty(response, "url", { value: "https://www.dmm.com/moved/" });
  const client = createClient({ async fetchImpl() { return response; } });
  await assert.rejects(client.getTags(fanzaWork), { code: "WORK_UNAVAILABLE" });
});
