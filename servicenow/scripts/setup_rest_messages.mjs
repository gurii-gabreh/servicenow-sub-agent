// PTD-048: ServiceNow Table API経由でREST Message(3件)を自動作成するスクリプト。
//
// GitHub Actionsワークフロー(.github/workflows/servicenow-setup.yml)からのみ実行される想定。
// このリポジトリに認証情報は一切含めない。SN_CLIENT_ID/SN_CLIENT_SECRETはGitHub Actions
// Secretsから環境変数として渡される(このスクリプト自身はSecretsの値をログ出力しない)。
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

const INSTANCE = process.env.SN_INSTANCE || "dev395932.service-now.com";
const CLIENT_ID = process.env.SN_CLIENT_ID;
const CLIENT_SECRET = process.env.SN_CLIENT_SECRET;
const DRY_RUN = process.env.DRY_RUN === "true";
const BASE = `https://${INSTANCE}`;

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
      { function_name: "anthropic", rest_endpoint: "https://www.anthropic.com/rss.xml" },
      { function_name: "openai", rest_endpoint: "https://openai.com/blog/rss.xml" },
      { function_name: "huggingface", rest_endpoint: "https://huggingface.co/blog/feed.xml" },
    ],
  },
];

function log(...args) {
  console.log(...args);
}

async function getToken() {
  const res = await fetch(`${BASE}/oauth_token.do`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OAuthトークン取得に失敗: HTTP ${res.status} ${text}`);
  }
  const data = JSON.parse(text);
  if (!data.access_token) {
    throw new Error(`OAuthレスポンスにaccess_tokenが含まれていない: ${text}`);
  }
  return data.access_token;
}

async function api(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} が失敗: HTTP ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function findChoiceValue(token, table, element, labelIncludes) {
  const q = encodeURIComponent(`name=${table}^element=${element}`);
  const data = await api(
    token,
    "GET",
    `/api/now/table/sys_choice?sysparm_query=${q}&sysparm_fields=value,label&sysparm_limit=50`
  );
  const rows = data.result || [];
  const hit = rows.find((r) => (r.label || "").toLowerCase().includes(labelIncludes.toLowerCase()));
  if (!hit) {
    log(
      `[警告] ${table}.${element}: 「${labelIncludes}」を含む選択肢が見つからなかった。候補一覧: ${JSON.stringify(
        rows
      )} → この項目は未設定のまま作成します(ServiceNow側のデフォルト値に依存)`
    );
    return null;
  }
  return hit.value;
}

async function verifyFieldsExist(token, table, fields) {
  const q = encodeURIComponent(`name=${table}^elementIN${fields.join(",")}`);
  const data = await api(
    token,
    "GET",
    `/api/now/table/sys_dictionary?sysparm_query=${q}&sysparm_fields=element&sysparm_limit=100`
  );
  const found = new Set((data.result || []).map((r) => r.element));
  const missing = fields.filter((f) => !found.has(f));
  if (missing.length > 0) {
    log(
      `[警告] テーブル${table}に見つからないフィールド: ${missing.join(
        ", "
      )} (フィールド名がこのServiceNowバージョンでは異なる可能性。このまま作成を試みますが、失敗した場合はここを疑ってください)`
    );
  } else {
    log(`[確認OK] テーブル${table}のフィールド ${fields.join(", ")} は実在を確認`);
  }
}

async function findByQuery(token, table, query) {
  const q = encodeURIComponent(query);
  const data = await api(token, "GET", `/api/now/table/${table}?sysparm_query=${q}&sysparm_limit=1`);
  return (data.result || [])[0] || null;
}

async function ensureRestMessage(token, name, description, authNoAuthValue) {
  const existing = await findByQuery(token, "sys_rest_message", `name=${name}`);
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
  const created = await api(token, "POST", "/api/now/table/sys_rest_message", body);
  log(`[作成] REST Message "${name}" (sys_id=${created.result.sys_id})`);
  return created.result;
}

async function ensureMethod(token, restMessage, method, authInheritValue) {
  if (!DRY_RUN && !String(restMessage.sys_id).startsWith("DRY-RUN-")) {
    const existing = await findByQuery(
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
  const created = await api(token, "POST", "/api/now/table/sys_rest_message_fn", body);
  log(`  [作成] HTTPメソッド "${method.function_name}" (sys_id=${created.result.sys_id})`);
}

async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error(
      "SN_CLIENT_ID / SN_CLIENT_SECRET が設定されていません。GitHub Actions SecretsにSN_CLIENT_ID/SN_CLIENT_SECRETを登録してください。"
    );
  }
  log(`DRY_RUN=${DRY_RUN} (true = 実際には作成せずログ出力のみ)`);
  const token = await getToken();
  log("OAuthトークン取得成功");

  await verifyFieldsExist(token, "sys_rest_message", ["name", "description", "authentication_type"]);
  await verifyFieldsExist(token, "sys_rest_message_fn", [
    "function_name",
    "rest_message",
    "rest_endpoint",
    "http_method",
    "authentication_type",
  ]);

  const authNoAuth = await findChoiceValue(token, "sys_rest_message", "authentication_type", "no authentication");
  const authInherit = await findChoiceValue(
    token,
    "sys_rest_message_fn",
    "authentication_type",
    "inherit"
  );

  for (const rm of REST_MESSAGES) {
    const restMessage = await ensureRestMessage(token, rm.name, rm.description, authNoAuth);
    for (const method of rm.methods) {
      await ensureMethod(token, restMessage, method, authInherit);
    }
  }

  log(DRY_RUN ? "dry-run完了(何も作成していません)" : "完了");
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
