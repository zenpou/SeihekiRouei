/** ローカルHTTPSサーバーと実際の拡張を使うE2E設定。失敗時だけ調査用トレースを残す。 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  // 1回の集計はDLsiteとFANZAの履歴・作品ページを600ms間隔で取得するため、再集計を含むケースに余裕を持たせる。
  timeout: 60000,
  // ブラウザとサーバーを複数同時に立ち上げず、各ケースを順番に検証する。
  workers: 1,
  reporter: "list",
  use: { trace: "retain-on-failure" },
});
