// PTD-089: YouTube Data API v3のAPIキーを、ServiceNow PDIのシステムプロパティ
// "youtube.api_key"(type: password2、暗号化保存)として設定する。
//
// GitHub Actionsワークフロー(.github/workflows/servicenow-setup.yml)からのみ実行される想定。
// このリポジトリにAPIキーの値を一切含めない(README「情報源」の方針通り)。GitHub Actions
// SecretsのYOUTUBE_API_KEYを、ワークフロー側でYOUTUBE_API_KEY環境変数として渡す
// (このスクリプト自身はSecretsの値をログ出力しない)。ServiceNow API呼び出しの共通処理は
// lib/servicenow_client.mjsを再利用する(setup_rest_messages.mjsと共有)。
//
// 設計判断: sys_propertiesのtype列を"password2"にすることで、ServiceNow標準の暗号化機能で
// 値を保存する(他の資格情報系システムプロパティと同じ扱い)。REST Message側のエンドポイントには
// キーを含めず、scheduled_job_ai_research_fetch.js側がgs.getProperty("youtube.api_key")で
// 読み取り、RESTMessageV2.setQueryParameter("key", ...)で実行時にのみ付与する
// (詳細はscheduled_job_ai_research_fetch.jsのコメント参照)。

import { createClient } from "./lib/servicenow_client.mjs";

const CLIENT_ID = process.env.SN_CLIENT_ID;
const CLIENT_SECRET = process.env.SN_CLIENT_SECRET;
const DRY_RUN = process.env.DRY_RUN === "true";
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

const PROPERTY_NAME = "youtube.api_key";

function log(...args) {
  console.log(...args);
}

async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error(
      "SN_CLIENT_ID / SN_CLIENT_SECRET が設定されていません。GitHub Actions SecretsにSN_CLIENT_ID/SN_CLIENT_SECRETを登録してください。"
    );
  }
  if (!YOUTUBE_API_KEY) {
    // キー未登録でもワークフロー全体を失敗させない(他のジョブ=REST Message作成等は独立して
    // 進められるようにする)。未設定の場合、scheduled_job_ai_research_fetch.js側は
    // gs.getProperty()が空文字を返すため、YouTube関連のfetch関数だけが安全にスキップされる。
    log(
      "[スキップ] YOUTUBE_API_KEY が設定されていません。GitHub Actions SecretsにYOUTUBE_API_KEYを登録すると、" +
        'このスクリプトがServiceNow側のシステムプロパティ"' +
        PROPERTY_NAME +
        '"へ反映します。'
    );
    return;
  }

  const client = createClient({ instance: process.env.SN_INSTANCE, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  log(`DRY_RUN=${DRY_RUN} (true = 実際には設定せずログ出力のみ)`);
  const token = await client.getToken();
  log("OAuthトークン取得成功");

  await client.verifyFieldsExist(token, "sys_properties", ["name", "value", "type", "description"]);

  const existing = await client.findByQuery(token, "sys_properties", `name=${PROPERTY_NAME}`, ["sys_id"]);

  if (DRY_RUN) {
    log(
      `[dry-run] システムプロパティ"${PROPERTY_NAME}"を${existing ? "更新" : "作成"}予定(値はログに出力しません)`
    );
    return;
  }

  const body = {
    name: PROPERTY_NAME,
    value: YOUTUBE_API_KEY,
    type: "password2",
    description: "PTD-089: YouTube Data API v3のAPIキー。scheduled_job_ai_research_fetch.jsが読み取り、setQueryParameterで実行時にのみ付与する。",
  };

  if (existing) {
    await client.api(token, "PATCH", `/api/now/table/sys_properties/${existing.sys_id}`, body);
    log(`[更新] システムプロパティ"${PROPERTY_NAME}" (sys_id=${existing.sys_id})(値はログに出力しません)`);
  } else {
    const created = await client.api(token, "POST", "/api/now/table/sys_properties", body);
    log(`[作成] システムプロパティ"${PROPERTY_NAME}" (sys_id=${created.result.sys_id})(値はログに出力しません)`);
  }

  log(DRY_RUN ? "dry-run完了(何も設定していません)" : "完了");
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
