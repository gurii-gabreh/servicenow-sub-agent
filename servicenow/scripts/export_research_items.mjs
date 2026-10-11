// PTD-058: u_ai_research_item テーブルの全件をServiceNow Table API経由でエクスポートし、
// data/research-items.json へマージ保存するスクリプト。
//
// GitHub Actionsワークフロー(.github/workflows/servicenow-export-research.yml)からのみ
// 実行される想定。認証情報の扱いはsetup_rest_messages.mjs・sync_scheduled_job.mjsと同じ
// (SN_INSTANCE/SN_CLIENT_ID/SN_CLIENT_SECRET環境変数、このファイル自身には一切含めない)。
//
// 設計判断:
// - このリポジトリのworker-roomセッション自身はServiceNowへ直接アクセスできない
//   (README「既知の制約」参照)ため、実データの取得は必ずGitHub Actionsランナー経由で行う。
// - 既存のdata/research-items.jsonに日本語要約(summaryJa/pointsJa/applicableTechJa)が
//   既に付与されている行は、再実行時に上書きしない(sysIdでマージし、curated:trueの項目は
//   raw側の値[title/rawSummary等]だけ最新化してJapanese欄はそのまま保持する)。
// - スコア(score)は日本語要約とは別に、このスクリプト実行のたびに再計算する
//   (score_items.mjsのロジックをここでも呼び出す)。

import { createClient } from "./lib/servicenow_client.mjs";
import { scoreItem } from "./lib/score_items.mjs";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = `${__dirname}/../../data/research-items.json`;

const CLIENT_ID = process.env.SN_CLIENT_ID;
const CLIENT_SECRET = process.env.SN_CLIENT_SECRET;
const SN_INSTANCE = process.env.SN_INSTANCE;

const TABLE = "u_ai_research_item";
const PAGE_SIZE = 500; // ServiceNowのsysparm_limit上限(デフォルト設定)に配慮した控えめな値
const FIELDS = [
  "sys_id",
  "u_category",
  "u_title",
  "u_summary",
  "u_source_url",
  "u_source_name",
  "u_published_at",
  "u_fetched_at",
  "u_dedup_key",
  "sys_created_on",
];

const CATEGORY_LABELS = {
  1: "アプリ作成時に活かせる技術、アーキテクチャ的要素やデータ構造、データのやり取り",
  2: "最新のAI技術でできること、今後できると思われる技術の動向",
  3: "今ある技術を組み合わせるとできる新しいこと",
  4: "AIが使われている分野や、使われやすいシチュエーション",
  5: "AIの流行",
  // 2026-09-29修正: category 6(2026-09-18追加の「世の中のニーズ・困りごと」)がこの定義に
  // 反映されていなかった(research-items.jsonのcategoriesメタデータに出てこない見落とし)。
  // category 7(ハッカソン情報)追加のタイミングで一緒に修正した。
  6: "世の中のニーズ・困りごと",
  7: "ハッカソン情報(応募できる案件・入賞作品)",
};

async function fetchAllRows(client, token) {
  const rows = [];
  let offset = 0;
  for (;;) {
    const fieldsParam = encodeURIComponent(FIELDS.join(","));
    const path =
      `/api/now/table/${TABLE}?sysparm_fields=${fieldsParam}` +
      `&sysparm_limit=${PAGE_SIZE}&sysparm_offset=${offset}` +
      `&sysparm_query=ORDERBYDESCsys_created_on`;
    const data = await client.api(token, "GET", path);
    const page = data.result || [];
    rows.push(...page);
    console.log(`  取得済み: ${rows.length}件(このページ ${page.length}件、offset=${offset})`);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

// 2026-10-11追加(PTD-058追補): 収集元(特にHacker NewsのAsk HN投稿)の本文に、投稿者が
// 誤って貼り付けた実在しそうなAPIキーがそのまま含まれていたことがあり、GitHub Push
// Protectionがそれを検知してpushが2026-09-28以降14回連続で失敗していた(原因調査の経緯は
// progress-tracker-dashboardのdata/tasks.json PTD-058参照)。GitHub側の「許可」機能で
// 回避するのではなく、こちらのデータ取り込み時点でキー形式の文字列を黒塗りする方針にした
// (元が公開投稿由来でも、実在しそうな認証情報をそのまま自分たちのリポジトリへ恒久的に
// 残すのは避けるべきと判断。将来また同様の投稿が収集されても同じ問題が再発しないようにする)。
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/g, // OpenAI(sk-/sk-proj-/sk-svcacct-等、いずれもsk-始まり)
  /gh[pousr]_[A-Za-z0-9]{36,}/g, // GitHub Personal/OAuth/App/Refresh token
  /AKIA[0-9A-Z]{16}/g, // AWS Access Key ID
  /AIza[0-9A-Za-z_-]{35}/g, // Google API Key
  /xox[baprs]-[0-9A-Za-z-]{10,}/g, // Slack token
];

function redactSecrets(text) {
  if (!text) return text;
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match) => {
      const head = match.slice(0, 6);
      return `${head}***REDACTED(${match.length}chars)***`;
    });
  }
  return result;
}

function normalizeRow(row) {
  return {
    sysId: row.sys_id,
    category: Number(row.u_category) || null,
    title: redactSecrets(row.u_title || ""),
    sourceName: row.u_source_name || "",
    sourceUrl: row.u_source_url || "",
    publishedAt: row.u_published_at || "",
    fetchedAt: row.u_fetched_at || "",
    createdAt: row.sys_created_on || "",
    rawSummary: redactSecrets(row.u_summary || ""),
  };
}

function loadExisting() {
  if (!existsSync(OUTPUT_PATH)) return { items: [] };
  try {
    return JSON.parse(readFileSync(OUTPUT_PATH, "utf-8"));
  } catch (e) {
    console.log(`[警告] 既存の${OUTPUT_PATH}の読み込みに失敗、新規として扱う: ${e.message}`);
    return { items: [] };
  }
}

async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET || !SN_INSTANCE) {
    console.error(
      "SN_CLIENT_ID / SN_CLIENT_SECRET / SN_INSTANCE のいずれかが未設定です。GitHub Actions Secretsを確認してください。"
    );
    process.exit(1);
  }

  const client = createClient({ instance: SN_INSTANCE, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  console.log(`ServiceNow(${client.BASE})へOAuthトークンを取得中...`);
  const token = await client.getToken();

  console.log(`${TABLE}テーブルから全件取得中(ページサイズ${PAGE_SIZE})...`);
  const rawRows = await fetchAllRows(client, token);
  console.log(`取得完了: 合計${rawRows.length}件`);

  const existing = loadExisting();
  const existingBySysId = new Map((existing.items || []).map((it) => [it.sysId, it]));

  const mergedItems = rawRows.map((row) => {
    const normalized = normalizeRow(row);
    const prior = existingBySysId.get(normalized.sysId);
    const merged = {
      ...normalized,
      curated: prior?.curated || false,
      summaryJa: prior?.summaryJa || "",
      pointsJa: prior?.pointsJa || [],
      applicableTechJa: prior?.applicableTechJa || "",
    };
    merged.score = scoreItem(merged);
    return merged;
  });

  // sys_created_on 降順(新しい順)。ServiceNow側のORDERBYDESCと合わせて明示的にも並べ替える。
  mergedItems.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  const curatedCount = mergedItems.filter((it) => it.curated).length;

  const output = {
    schema: "servicenow-sub-agent research items v1",
    description:
      "ServiceNow PDI上のu_ai_research_itemテーブル(PTD-046の自動収集パイプライン)からエクスポートした全件。" +
      "curated:trueの項目のみsummaryJa/pointsJa/applicableTechJa(日本語の概要・ポイント・活かせる技術)が" +
      "付与されている。curated:falseは収集元の生データ(title/rawSummaryは元記事のまま、英語が多い)のみ。" +
      "servicenow/scripts/export_research_items.mjs(GitHub Actions)による自動生成・マージ。" +
      "日本語要約フィールドはこのスクリプトでは上書きしない(Claudeによる手動キュレーションのみが更新する)。",
    categories: CATEGORY_LABELS,
    generatedAt: new Date().toISOString(),
    itemCount: mergedItems.length,
    curatedCount,
    items: mergedItems,
  };

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf-8");
  console.log(`書き出し完了: ${OUTPUT_PATH} (総件数=${mergedItems.length}, 日本語要約済み=${curatedCount})`);
}

main().catch((e) => {
  console.error("エクスポート中にエラー:", e);
  process.exit(1);
});
