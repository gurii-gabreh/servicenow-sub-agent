// 一時的な調査用スクリプト。sc_cat_item更新ログBusiness Ruleがsyslogで確認できない原因を切り分ける。
// 原因特定後は削除してよい。

import { createClient } from "./lib/servicenow_client.mjs";

const CLIENT_ID = process.env.SN_CLIENT_ID;
const CLIENT_SECRET = process.env.SN_CLIENT_SECRET;

function log(...args) {
  console.log(...args);
}

async function main() {
  const client = createClient({ instance: process.env.SN_INSTANCE, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const token = await client.getToken();
  log("OAuthトークン取得成功");

  // 1. syslogテーブルをそもそも読めるか(直近10件、フィルタ無し)
  const anyLogs = await client.api(
    token,
    "GET",
    `/api/now/table/syslog?sysparm_query=ORDERBYDESCsys_created_on&sysparm_fields=message,source,sys_created_on&sysparm_limit=10`
  );
  log(`[1] syslog直近10件(フィルタ無し): ${(anyLogs.result || []).length}件`);
  (anyLogs.result || []).forEach((r) => log(`    ${r.sys_created_on} [${r.source}] ${r.message}`));

  // 2. Business Ruleレコード自体の現在の設定を確認
  const br = await client.findByQuery(token, "sys_script", "name=AI-managed: sc_cat_item update logger", [
    "sys_id", "active", "collection", "when", "action_update", "action_insert", "condition", "filter_condition",
  ]);
  log(`[2] Business Rule現在の設定: ${JSON.stringify(br)}`);

  // 3. sc_cat_itemを実際に「別の値」に変更してsys_updated_onが動くか確認
  const item = await client.findByQuery(token, "sc_cat_item", "active=true", ["sys_id", "name", "short_description", "sys_updated_on"]);
  log(`[3] 対象アイテム(変更前): ${JSON.stringify(item)}`);

  const marker = "AI-diag-" + Date.now();
  const beforeTouch = new Date();
  await client.api(token, "PATCH", `/api/now/table/sc_cat_item/${item.sys_id}`, {
    short_description: (item.short_description || "") + " " + marker,
  });
  log(`[3] short_descriptionへマーカーを追記してPATCH実行: ${marker}`);

  await new Promise((r) => setTimeout(r, 8000));

  const after = await client.findByQuery(token, "sc_cat_item", `sys_id=${item.sys_id}`, ["sys_updated_on", "short_description"]);
  log(`[3] 対象アイテム(変更後、8秒待機): ${JSON.stringify(after)}`);

  // マーカーを元に戻す(後片付け)
  await client.api(token, "PATCH", `/api/now/table/sc_cat_item/${item.sys_id}`, {
    short_description: item.short_description || "",
  });
  log("[3] short_descriptionを元の値に戻した");

  // 4. syslogをmessageのみでフィルタ(日付フィルタ無し)、直近を確認
  const q2 = `messageLIKEAI-managed BR^ORDERBYDESCsys_created_on`;
  const logs2 = await client.api(
    token,
    "GET",
    `/api/now/table/syslog?sysparm_query=${encodeURIComponent(q2)}&sysparm_fields=message,sys_created_on&sysparm_limit=10`
  );
  log(`[4] messageLIKE"AI-managed BR"(日付フィルタ無し): ${(logs2.result || []).length}件`);
  (logs2.result || []).forEach((r) => log(`    ${r.sys_created_on} ${r.message}`));

  // 5. マーカー文字列でも検索(直近の実更新に対応するログがあるか)
  const q3 = `messageLIKE${marker}`;
  const logs3 = await client.api(
    token,
    "GET",
    `/api/now/table/syslog?sysparm_query=${encodeURIComponent(q3)}&sysparm_fields=message,sys_created_on&sysparm_limit=10`
  );
  log(`[5] messageLIKE"${marker}": ${(logs3.result || []).length}件`);
  (logs3.result || []).forEach((r) => log(`    ${r.sys_created_on} ${r.message}`));
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
