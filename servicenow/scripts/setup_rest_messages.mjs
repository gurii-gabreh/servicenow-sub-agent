// PTD-048: ServiceNow Table API経由でREST Message(3件)を自動作成するスクリプト。
//
// GitHub Actionsワークフロー(.github/workflows/servicenow-setup.yml)からのみ実行される想定。
// このリポジトリに認証情報は一切含めない。GitHub Actions Secrets(SERVICENOW_INSTANCE_URL/
// SERVICENOW_CLIENT_ID/SERVICENOW_CLIENT_SECRET)が、ワークフロー側でSN_INSTANCE/SN_CLIENT_ID/
// SN_CLIENT_SECRETという環境変数名にマッピングされて渡される(このスクリプト自身はSecretsの
// 値をログ出力しない)。ServiceNow API呼び出しの共通処理はlib/servicenow_client.mjsに切り出して
// いる(sync_scheduled_job.mjsと共有)。
//
// 設計判断: README記載の当初案ではarXiv/Hacker Newsのエンドポイントに ${search_query} のような
// ランタイム変数を使う想定だったが、ServiceNowのRESTMessageV2は ${varName} を使う場合、
// HTTPメソッド側の「Variable」定義(sys_rest_message_fn_param_defs)に事前登録しておかないと
// 変数が置換されずリテラルの "${varName}" のまま送信されて“エラーも出ずに"検索結果が空になる
// (静かに壊れる)という既知の落とし穴がある。このスクリプトはServiceNowに対話的にログインして
// 手作業でこの落とし穴を確認する手段がないため、そもそも変数を使わない設計に変更した:
// scheduled_job_ai_research_fetch.jsが渡す値は固定(検索クエリや件数を実行のたびに変えていない)
// ため、クエリ文字列をエンドポイントURLに直接埋め込んだ「変数なし」の静的URLにした。
// この値を変えたい場合は、このファイルとscheduled_job_ai_research_fetch.jsの両方を
// 同じ値に合わせて修正すること(2箇所で値が食い違うと片方だけ古いクエリのまま動く)。
//
// 未知のスキーマ(REST APIから作成する場合のフィールド名・選択肢値)を推測で決め打ちしない方針
// (CLAUDE.mdルール1)のため、authentication_typeの選択肢値はsys_choiceテーブルから、
// フィールドの実在確認はsys_dictionaryテーブルから、実行時に動的に取得している。

import { createClient } from "./lib/servicenow_client.mjs";

const CLIENT_ID = process.env.SN_CLIENT_ID;
const CLIENT_SECRET = process.env.SN_CLIENT_SECRET;
const DRY_RUN = process.env.DRY_RUN === "true";

// 情報源URLは verify_source_urls.mjs と揃えること(値を変えたら両方直す)
const REST_MESSAGES = [
  {
    name: "AI Research - arXiv",
    description: "PTD-046: arXiv Atom API(認証不要・GET)",
    methods: [
      {
        function_name: "search",
        rest_endpoint:
          "http://export.arxiv.org/api/query?search_query=cat:cs.AI+OR+cat:cs.CL+OR+cat:cs.LG&max_results=10&sortBy=submittedDate&sortOrder=descending",
      },
    ],
  },
  {
    name: "AI Research - Hacker News",
    description: "PTD-046: Hacker News Algolia API(認証不要・GET)",
    methods: [
      {
        function_name: "search",
        rest_endpoint:
          "http://hn.algolia.com/api/v1/search_by_date?query=AI&tags=story&hitsPerPage=20",
      },
    ],
  },
  {
    name: "AI Research - Blog RSS",
    description: "PTD-046: 各社ブログRSS(認証不要・GET)",
    methods: [
      { function_name: "openai", rest_endpoint: "https://openai.com/blog/rss.xml" },
      { function_name: "huggingface", rest_endpoint: "https://huggingface.co/blog/feed.xml" },
      // 2026-08-30(PTD-048拡張): 以下5件はtmp_verify_candidate_urls.mjsによるGitHub Actions実地
      // 検証(HTTP 200・想定形式)を通過済み。MIT Technology ReviewはAI特化のtopicフィード
      // (/topic/artificial-intelligence/feed/)を採用した(全体feedは無関係な記事が混ざるため、
      // このパイプラインの目的=AI観点の収集により合致するAI特化版を選択)。
      {
        function_name: "mittechreview",
        rest_endpoint: "https://www.technologyreview.com/topic/artificial-intelligence/feed/",
      },
      { function_name: "marktechpost", rest_endpoint: "https://www.marktechpost.com/feed/" },
      { function_name: "bytebytego", rest_endpoint: "https://blog.bytebytego.com/feed" },
      { function_name: "infoq", rest_endpoint: "https://feed.infoq.com/ai-ml-data-eng/" },
      { function_name: "martinfowler", rest_endpoint: "https://martinfowler.com/feed.atom" },
      // Architecture Weekly(候補6件目)は両候補URL(architecture-weekly.com/feed、
      // softwarearchitectureweekly.substack.com/feed)とも実地検証で失敗(前者はfetch failed=
      // 名前解決/接続失敗、後者はHTTP 403・Cloudflareのbot対策ページ)したため未採用。
      // progress-tracker-dashboardのPTD-048へ相談事項として記録し、ユーザー確認待ち。
    ],
  },
];
// 2026-08-29: Anthropicは公式RSSフィードを提供していないことが実機検証(verify-source-urlsジョブ、
// https://www.anthropic.com/rss.xml が404)で判明したため、情報源から除外した(ユーザー承認済み)。
// 詳細はprogress-tracker-dashboardのconcept-log.json参照。以前の実行で既に作成されてしまった
// 場合に備え、下記REMOVED_METHODSで明示的に削除する。

// 過去に存在した情報源のうち、廃止されたHTTPメソッド。存在すれば削除する(冪等: 無ければ何もしない)。
const REMOVED_METHODS = [{ restMessageName: "AI Research - Blog RSS", function_name: "anthropic" }];

function log(...args) {
  console.log(...args);
}

async function ensureRestMessage(client, token, name, description, authNoAuthValue) {
  const existing = await client.findByQuery(token, "sys_rest_message", `name=${name}`);
  if (existing) {
    log(`[スキップ] REST Message "${name}" は既に存在 (sys_id=${existing.sys_id})`);
    return existing;
  }
  const body = { name, description };
  if (authNoAuthValue) body.authentication_type = authNoAuthValue;
  if (DRY_RUN) {
    log(`[dry-run] POST /api/now/table/sys_rest_message body=${JSON.stringify(body)}`);
    return { sys_id: `DRY-RUN-${name}`, name };
  }
  const created = await client.api(token, "POST", "/api/now/table/sys_rest_message", body);
  log(`[作成] REST Message "${name}" (sys_id=${created.result.sys_id})`);
  return created.result;
}

async function ensureMethod(client, token, restMessage, method, authInheritValue) {
  if (!DRY_RUN && !String(restMessage.sys_id).startsWith("DRY-RUN-")) {
    const existing = await client.findByQuery(
      token,
      "sys_rest_message_fn",
      `rest_message=${restMessage.sys_id}^function_name=${method.function_name}`
    );
    if (existing) {
      log(`  [スキップ] HTTPメソッド "${method.function_name}" は既に存在 (sys_id=${existing.sys_id})`);
      if (existing.rest_endpoint && existing.rest_endpoint !== method.rest_endpoint) {
        log(
          `  [警告] endpointが想定と異なる(既存設定は変更していません)。想定=${method.rest_endpoint} 実際=${existing.rest_endpoint}`
        );
      }
      return existing;
    }
  }
  const body = {
    function_name: method.function_name,
    rest_message: restMessage.sys_id,
    rest_endpoint: method.rest_endpoint,
    http_method: "GET",
  };
  if (authInheritValue) body.authentication_type = authInheritValue;
  if (DRY_RUN) {
    log(`  [dry-run] POST /api/now/table/sys_rest_message_fn body=${JSON.stringify(body)}`);
    return;
  }
  const created = await client.api(token, "POST", "/api/now/table/sys_rest_message_fn", body);
  log(`  [作成] HTTPメソッド "${method.function_name}" (sys_id=${created.result.sys_id})`);
}

async function cleanupRemovedMethods(client, token) {
  for (const removed of REMOVED_METHODS) {
    const restMessage = await client.findByQuery(token, "sys_rest_message", `name=${removed.restMessageName}`);
    if (!restMessage) continue;
    const existing = await client.findByQuery(
      token,
      "sys_rest_message_fn",
      `rest_message=${restMessage.sys_id}^function_name=${removed.function_name}`
    );
    if (!existing) continue;
    if (DRY_RUN) {
      log(
        `[dry-run] 廃止済みのHTTPメソッド "${removed.restMessageName}" / "${removed.function_name}" (sys_id=${existing.sys_id}) を削除予定`
      );
      continue;
    }
    await client.api(token, "DELETE", `/api/now/table/sys_rest_message_fn/${existing.sys_id}`);
    log(`[削除] 廃止済みのHTTPメソッド "${removed.restMessageName}" / "${removed.function_name}" (sys_id=${existing.sys_id})`);
  }
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

  await client.verifyFieldsExist(token, "sys_rest_message", ["name", "description", "authentication_type"]);
  await client.verifyFieldsExist(token, "sys_rest_message_fn", [
    "function_name",
    "rest_message",
    "rest_endpoint",
    "http_method",
    "authentication_type",
  ]);

  const authNoAuth = await client.findChoiceValue(token, "sys_rest_message", "authentication_type", "no authentication");
  const authInherit = await client.findChoiceValue(
    token,
    "sys_rest_message_fn",
    "authentication_type",
    "inherit"
  );

  for (const rm of REST_MESSAGES) {
    const restMessage = await ensureRestMessage(client, token, rm.name, rm.description, authNoAuth);
    for (const method of rm.methods) {
      await ensureMethod(client, token, restMessage, method, authInherit);
    }
  }

  await cleanupRemovedMethods(client, token);

  log(DRY_RUN ? "dry-run完了(何も作成・削除していません)" : "完了");
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
