// manager-room依頼(2026-08-30): sc_cat_item(カタログアイテム)の更新後にname/sys_updated_onを
// システムログへ出力するBusiness Ruleを新規作成する。
//
// 【方針上の注記】concept-log.jsonのCL-011では「新規作成(when/対象テーブル等、間違うと動作が
// 壊れるリスクの高い設定)は自動化せず人が一度だけUIで作成する」を原則としていたが、今回のBusiness
// Ruleはログ出力のみで他のレコード・処理に一切影響しない最低リスクの内容であり、かつユーザーから
// 「指示されたら自動更新まで全て行ってよい」という直近の追加合意があったため、このケースに限り
// 新規作成も含めて自動化する。判断の経緯はconcept-log.jsonに記録する。
//
// 未検証スキーマを推測で決め打ちしない方針(CLAUDE.mdルール1)のため、sys_scriptのフィールド実在は
// sys_dictionaryから、whenの選択肢値はsys_choiceから、実行時に動的に確認する。

import { createClient } from "./lib/servicenow_client.mjs";

const CLIENT_ID = process.env.SN_CLIENT_ID;
const CLIENT_SECRET = process.env.SN_CLIENT_SECRET;
const DRY_RUN = process.env.DRY_RUN === "true";

const BR_NAME = "AI-managed: sc_cat_item update logger";
const BR_SCRIPT = `(function executeRule(current, previous /*null when async*/) {
    gs.info("[AI-managed BR] sc_cat_item updated: name=" + current.getValue("name") + ", sys_updated_on=" + current.getValue("sys_updated_on"));
})(current, previous);
`;

function log(...args) {
  console.log(...args);
}

async function ensureBusinessRule(client, token) {
  const existing = await client.findByQuery(token, "sys_script", `name=${BR_NAME}`, [
    "sys_id",
    "script",
    "active",
    "collection",
    "when",
    "action_update",
  ]);
  if (existing) {
    log(`[スキップ] Business Rule "${BR_NAME}" は既に存在 (sys_id=${existing.sys_id})`);
    if (existing.script !== BR_SCRIPT) {
      log(`[警告] 既存のscript内容が想定と異なる(上書きしていません)。手動で確認してください。`);
    }
    return existing;
  }

  const whenAfter = await client.findChoiceValue(token, "sys_script", "when", "after");
  const body = {
    name: BR_NAME,
    collection: "sc_cat_item",
    active: true,
    action_insert: false,
    action_update: true,
    action_delete: false,
    action_query: false,
    order: 100,
    script: BR_SCRIPT,
    description:
      "manager-room依頼(2026-08-30)によりworker-room(servicenow-sub-agent)が自動作成。sc_cat_item更新時にname/sys_updated_onをgs.info()でログ出力するのみ。詳細はprogress-tracker-dashboardのtasks.json参照。",
  };
  if (whenAfter) body.when = whenAfter;

  if (DRY_RUN) {
    log(`[dry-run] POST /api/now/table/sys_script body=${JSON.stringify(body)}`);
    return { sys_id: "DRY-RUN", ...body };
  }
  const created = await client.api(token, "POST", "/api/now/table/sys_script", body);
  log(`[作成] Business Rule "${BR_NAME}" (sys_id=${created.result.sys_id})`);
  return created.result;
}

async function verifyByTouchingCatalogItem(client, token) {
  const item = await client.findByQuery(token, "sc_cat_item", "active=true", ["sys_id", "name"]);
  if (!item) {
    log("[警告] 動作確認用のsc_cat_itemレコードが見つからなかった(有効なカタログアイテムが1件も無い可能性)。動作確認はスキップします。手動でカタログアイテムを1件更新して確認してください。");
    return;
  }
  log(`動作確認対象: "${item.name}" (sys_id=${item.sys_id})`);

  const beforeTouch = new Date();
  // 値そのものは変えず同じnameを再代入する(Table APIのPATCHはGlideRecord.update()を呼ぶため、
  // 値が変化していなくてもupdate系Business Ruleは発火する)。
  await client.api(token, "PATCH", `/api/now/table/sc_cat_item/${item.sys_id}`, { name: item.name });
  log("カタログアイテムを更新(name再代入)。Business Ruleの発火を待ってsyslogを確認します。");

  await new Promise((r) => setTimeout(r, 3000));

  const q = `messageLIKE[AI-managed BR] sc_cat_item updated^sys_created_on>=${toGlideDateTimeString(
    beforeTouch
  )}^ORDERBYDESCsys_created_on`;
  const data = await client.api(
    token,
    "GET",
    `/api/now/table/syslog?sysparm_query=${encodeURIComponent(q)}&sysparm_fields=message,sys_created_on&sysparm_limit=5`
  );
  const rows = data.result || [];
  const hit = rows.find((r) => r.message && r.message.includes(item.name));
  if (hit) {
    log(`[動作確認OK] syslogに出力を確認: "${hit.message}"`);
  } else {
    log(
      `[警告] syslogに期待したログが見つからなかった(候補${rows.length}件: ${JSON.stringify(
        rows
      )})。Business Ruleが正しく発火していないか、ログ反映に時間がかかっている可能性がある。数分後にsyslogを手動確認してください(messageに"[AI-managed BR] sc_cat_item updated"を含む行)。`
    );
  }
}

function toGlideDateTimeString(date) {
  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }
  return (
    date.getUTCFullYear() +
    "-" +
    pad(date.getUTCMonth() + 1) +
    "-" +
    pad(date.getUTCDate()) +
    " " +
    pad(date.getUTCHours()) +
    ":" +
    pad(date.getUTCMinutes()) +
    ":" +
    pad(date.getUTCSeconds())
  );
}

async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error(
      "SN_CLIENT_ID / SN_CLIENT_SECRET が設定されていません。GitHub Actions SecretsにSN_CLIENT_ID/SN_CLIENT_SECRETを登録してください。"
    );
  }
  const client = createClient({ instance: process.env.SN_INSTANCE, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  log(`DRY_RUN=${DRY_RUN} (true = 実際には作成せずログ出力のみ)`);
  const token = await client.getToken();
  log("OAuthトークン取得成功");

  await client.verifyFieldsExist(token, "sys_script", [
    "name",
    "collection",
    "when",
    "action_insert",
    "action_update",
    "action_delete",
    "action_query",
    "active",
    "order",
    "script",
  ]);

  const businessRule = await ensureBusinessRule(client, token);

  if (!DRY_RUN && businessRule.active) {
    await verifyByTouchingCatalogItem(client, token);
  } else if (DRY_RUN) {
    log("[dry-run] 動作確認(カタログアイテムの実更新)はdry-runではスキップします。");
  }

  log(DRY_RUN ? "dry-run完了(何も作成していません)" : "完了");
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
