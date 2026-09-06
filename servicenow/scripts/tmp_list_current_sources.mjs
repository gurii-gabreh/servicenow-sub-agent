// 一時診断スクリプト(2026-09-06)。読み取り専用。役目を終えたら削除する。
//
// ユーザーがServiceNow側で直接、新しい調査対象(REST Message/HTTPメソッド)を追加した可能性が
// あるため、リポジトリのコード(setup_rest_messages.mjs)に頼らず、ServiceNow実機の
// sys_rest_message_fnテーブルを直接クエリして「今ServiceNowが実際に何を調べる設定になっているか」
// の真実を確認する。あわせてu_ai_research_itemの実際の収集実績(情報源ごとの件数)も確認する。

import { createClient } from "./lib/servicenow_client.mjs";

const client = createClient({
  instance: process.env.SN_INSTANCE,
  clientId: process.env.SN_CLIENT_ID,
  clientSecret: process.env.SN_CLIENT_SECRET,
});

async function main() {
  const token = await client.getToken();
  console.log("OAuthトークン取得成功\n");

  const restMessageNames = ["AI Research - arXiv", "AI Research - Hacker News", "AI Research - Blog RSS"];
  for (const name of restMessageNames) {
    const rm = await client.findByQuery(token, "sys_rest_message", `name=${name}`, ["sys_id", "name"]);
    if (!rm) {
      console.log(`[REST Message] "${name}": 見つからない`);
      continue;
    }
    const q = encodeURIComponent(`rest_message=${rm.sys_id}`);
    const data = await client.api(
      token,
      "GET",
      `/api/now/table/sys_rest_message_fn?sysparm_query=${q}&sysparm_fields=function_name,rest_endpoint&sysparm_limit=100`
    );
    console.log(`\n===== REST Message: "${name}" (${data.result.length}件のHTTPメソッド) =====`);
    for (const m of data.result) {
      console.log(`  - ${m.function_name}: ${m.rest_endpoint}`);
    }
  }

  // 実際の収集実績(情報源ごとの件数)
  console.log("\n===== u_ai_research_item: 情報源(u_source_name)ごとの件数 =====");
  const data = await client.api(
    token,
    "GET",
    `/api/now/table/u_ai_research_item?sysparm_fields=u_source_name&sysparm_limit=10000`
  );
  const counts = {};
  for (const row of data.result) {
    const name = row.u_source_name || "(空欄)";
    counts[name] = (counts[name] || 0) + 1;
  }
  const total = data.result.length;
  console.log(`合計 ${total} 件`);
  for (const [name, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  - ${name}: ${count}件`);
  }
}

main().catch((e) => {
  console.error(e.stack || String(e));
  process.exit(1);
});
