// PTD-049の補助: ServiceNow PDI上に既に作成済みのScheduled Job(sysauto_script)の
// scriptフィールドだけを、このリポジトリのservicenow/scheduled_job_ai_research_fetch.jsの
// 最新内容で上書き更新する。
//
// 【自動化する範囲を意図的に限定している】新規にScheduled Jobを作成する処理(run_type・
// 実行頻度等のフィールド構成)は、このセッションから実機検証する手段がなく誤設定のリスクが
// 手作業の手間より大きいと判断し、あえて自動化していない(concept-log.jsonのCL-008参照)。
// 一方、「既に人が作成済みのジョブのscript本文だけを差し替える」操作はスケジュール設定に
// 一切触れない安全な部分更新(PATCH)であり、かつ「コード変更のたびに手動で貼り直す」という
// 反復作業を代替する価値が大きいため、これだけを自動化した。
//
// 対象レコードの特定方法: 名前ではなく、scriptフィールドに"AIResearchFetcher"という
// (gs.info/gs.errorのログprefixとして使っている)目印文字列が含まれるかで検索する。
// これによりユーザーがScheduled Jobに付けた名前を問わずに特定できる。目印文字列は
// scheduled_job_ai_research_fetch.js側で今後も変更しないこと。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createClient } from "./lib/servicenow_client.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_FILE = join(__dirname, "..", "scheduled_job_ai_research_fetch.js");
const MARKER = "AIResearchFetcher";

const CLIENT_ID = process.env.SN_CLIENT_ID;
const CLIENT_SECRET = process.env.SN_CLIENT_SECRET;
const DRY_RUN = process.env.DRY_RUN === "true";

function log(...args) {
  console.log(...args);
}

async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error(
      "SN_CLIENT_ID / SN_CLIENT_SECRET が設定されていません。GitHub Actions SecretsにSN_CLIENT_ID/SN_CLIENT_SECRETを登録してください。"
    );
  }
  const newScript = readFileSync(SCRIPT_FILE, "utf8");
  if (!newScript.includes(MARKER)) {
    throw new Error(
      `${SCRIPT_FILE} に目印文字列 "${MARKER}" が見つからない。対象レコードを検索できないため中断する。`
    );
  }

  const client = createClient({ instance: process.env.SN_INSTANCE, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  log(`DRY_RUN=${DRY_RUN} (true = 実際には更新せずログ出力のみ)`);
  const token = await client.getToken();
  log("OAuthトークン取得成功");

  await client.verifyFieldsExist(token, "sysauto_script", ["name", "script", "active"]);

  const q = `scriptLIKE${MARKER}`;
  const data = await client.api(
    token,
    "GET",
    `/api/now/table/sysauto_script?sysparm_query=${encodeURIComponent(q)}&sysparm_fields=sys_id,name,script,active&sysparm_limit=10`
  );
  const matches = data.result || [];

  if (matches.length === 0) {
    throw new Error(
      `目印文字列 "${MARKER}" を含むScheduled Job(sysauto_script)が見つからなかった。README.md「3. スケジュールジョブ作成」の手順で先に手動作成してから、このスクリプトを実行すること。`
    );
  }
  if (matches.length > 1) {
    log(
      `[警告] 目印文字列 "${MARKER}" を含むScheduled Jobが${matches.length}件見つかった(通常は1件のはず): ${matches
        .map((m) => `${m.name}(${m.sys_id})`)
        .join(", ")}。意図しない重複作成の可能性があるため、先頭の1件のみ更新する。`
    );
  }

  const target = matches[0];
  log(`対象: "${target.name}" (sys_id=${target.sys_id}, active=${target.active})`);

  if (target.script === newScript) {
    log("スクリプト内容は既に最新と同一。更新の必要なし。");
    return;
  }

  if (DRY_RUN) {
    log(
      `[dry-run] PATCH /api/now/table/sysauto_script/${target.sys_id} でscriptフィールドを更新予定(${newScript.length}バイト、現在の内容とは差分あり)`
    );
    return;
  }

  await client.api(token, "PATCH", `/api/now/table/sysauto_script/${target.sys_id}`, { script: newScript });
  log(`[更新] "${target.name}" (sys_id=${target.sys_id}) のscriptフィールドを更新完了`);
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
