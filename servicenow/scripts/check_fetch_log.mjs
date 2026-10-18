// PTD-089診断用: Scheduled Job「AI Research Fetcher」が出力したgs.info/gs.errorのログを
// syslogテーブルから読み取り、直近の実行結果(inserted/skipped/errors)を確認する。
//
// GitHub Actionsワークフロー(.github/workflows/servicenow-check-logs.yml)から手動実行する想定。
// 読み取り専用(POST/PATCH/DELETEは一切行わない)。他のスクリプトと同じくlib/servicenow_client.mjs
// を再利用し、認証情報はGitHub Actions Secrets経由の環境変数からのみ読む。

import { createClient } from "./lib/servicenow_client.mjs";

const CLIENT_ID = process.env.SN_CLIENT_ID;
const CLIENT_SECRET = process.env.SN_CLIENT_SECRET;

function log(...args) {
  console.log(...args);
}

async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error(
      "SN_CLIENT_ID / SN_CLIENT_SECRET が設定されていません。GitHub Actions SecretsにSN_CLIENT_ID/SN_CLIENT_SECRETを登録してください。"
    );
  }
  const client = createClient({ instance: process.env.SN_INSTANCE, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const token = await client.getToken();
  log("OAuthトークン取得成功");

  await client.verifyFieldsExist(token, "syslog", ["message", "source", "sys_created_on", "level"]);

  const q = encodeURIComponent("messageLIKEAIResearchFetcher^ORDERBYDESCsys_created_on");
  const data = await client.api(
    token,
    "GET",
    `/api/now/table/syslog?sysparm_query=${q}&sysparm_fields=sys_created_on,level,message,source&sysparm_limit=20`
  );
  const rows = data.result || [];
  log(`AIResearchFetcher関連ログ: ${rows.length}件(新しい順、最大20件)`);
  log("----------------------------------------");
  for (const r of rows) {
    log(`[${r.sys_created_on}] level=${r.level} source=${r.source}`);
    log(r.message);
    log("----------------------------------------");
  }
  if (rows.length === 0) {
    log("該当ログが見つかりませんでした。Scheduled Jobが実際に実行されたか、スクリプトが正しく保存されているか確認してください。");
  }
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
