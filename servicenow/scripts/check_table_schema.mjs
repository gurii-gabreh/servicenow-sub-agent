// PTD-124診断用(一時スクリプト): u_ai_research_itemテーブルの既存1件を全フィールド取得し、
// u_dedup_keyフィールドが実在するか(レスポンスのキーとして現れるか)を直接確認する。
// 読み取り専用。原因判明後は削除する。

import { createClient } from "./lib/servicenow_client.mjs";

const CLIENT_ID = process.env.SN_CLIENT_ID;
const CLIENT_SECRET = process.env.SN_CLIENT_SECRET;

function log(...args) {
  console.log(...args);
}

async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("SN_CLIENT_ID / SN_CLIENT_SECRET が設定されていません。");
  }
  const client = createClient({ instance: process.env.SN_INSTANCE, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const token = await client.getToken();
  log("OAuthトークン取得成功");

  // sysparm_fieldsを指定せず、全フィールドを取得する(u_dedup_keyがキーとして現れるかを見る)
  const data = await client.api(token, "GET", "/api/now/table/u_ai_research_item?sysparm_limit=5");
  const rows = data.result || [];
  log(`取得件数: ${rows.length}`);
  for (const row of rows) {
    log("----------------------------------------");
    log(`sys_id: ${row.sys_id}`);
    log(`u_dedup_key というキーは存在するか: ${"u_dedup_key" in row}`);
    log(`u_dedup_key の値: "${row.u_dedup_key}"`);
    log("全フィールド名一覧: " + Object.keys(row).join(", "));
  }

  // sys_dictionaryでの確認も併せて行う(既存スクリプトと同じ手法、ACL次第で信頼度は下がる)
  const dictData = await client.api(
    token,
    "GET",
    `/api/now/table/sys_dictionary?sysparm_query=${encodeURIComponent("name=u_ai_research_item")}&sysparm_fields=element,column_label,internal_type,max_length&sysparm_limit=50`
  );
  const dictRows = dictData.result || [];
  log("----------------------------------------");
  log(`sys_dictionary上のフィールド定義: ${dictRows.length}件`);
  for (const d of dictRows) {
    log(`  element=${d.element} label=${d.column_label} type=${d.internal_type} max_length=${d.max_length}`);
  }
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
