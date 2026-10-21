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
      // 2026-09-18追加: category 6(世の中のニーズ・困りごと)用。"Ask HN"タグの投稿は
      // 「〇〇で困っている」「△△のやり方」等、生のニーズ・悩みが書かれることが多いため、
      // AIキーワードで絞らずtags=ask_hnのみで幅広く拾う(ユーザー指示「世の中のニーズを
      // 常に蓄積してほしい」への対応。既存のHacker News REST Messageを流用し、新規の
      // 情報源追加なしで実現できる)。
      {
        function_name: "askhn",
        rest_endpoint:
          "http://hn.algolia.com/api/v1/search_by_date?tags=ask_hn&hitsPerPage=20",
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
      // 2026-08-31(PTD-056対応): Architecture Weekly(候補6件目)は当初、www無し・Substack版
      // (architecture-weekly.com/feed、softwarearchitectureweekly.substack.com/feed)の2URLとも
      // 実地検証で失敗していたが、ユーザーの追加調査で運営者(Oskar Dudycz)のSubstackカスタム
      // ドメインは"www"付きだと判明。https://www.architecture-weekly.com/feedを実地検証した結果
      // HTTP 200・RSS 2.0を確認できたため採用した。
      { function_name: "architectureweekly", rest_endpoint: "https://www.architecture-weekly.com/feed" },
      // 2026-08-31(ユーザー依頼: Claude/Gemini/ChatGPT公式サイトの追加、無料RSS/Atom方式で統一):
      // Geminiの公式RSSは単独では見つからず、Google DeepMind Blog(Gemini含むAI研究発表)の
      // 公式RSSを実地検証(HTTP 200・RSS 2.0)の上で採用した。Anthropic(Claude)は公式RSS/Atomが
      // 依然として存在しない(CL-009で確認済み、2026-08-31にWeb検索で再確認)ため非採用。
      // ChatGPTは既存のopenaiメソッド(openai.com/blog/rss.xml→openai.com/news/rss.xmlへリダイレクト)
      // が同一の公式発表チャネルをカバーしているため、別メソッドは追加していない。詳細はREADME参照。
      { function_name: "geminideepmind", rest_endpoint: "https://deepmind.google/blog/rss.xml" },
      // 2026-09-06(ユーザー依頼: 取れる情報源は全て取る): Anthropic公式のブログRSSは依然として
      // 存在しないが、Anthropic自身が管理する公開GitHubリポジトリのReleases Atomフィードは
      // GitHub標準機能として実在し(認証不要・GET、実機検証済み)、公式発表チャネルの一種として
      // 追加できる。中身はclaude-codeのバージョンリリース情報であり、一般的なブログ記事(モデル
      // 発表・研究発表等)までは含まない点に注意(README「情報源」参照)。
      { function_name: "anthropicreleases", rest_endpoint: "https://github.com/anthropics/claude-code/releases.atom" },
      // 2026-09-06(実機検証済み、tmp_inspect_anthropic_news.mjs): 当初はNext.jsのクライアントサイド
      // レンダリングにより生HTMLに記事一覧が含まれないと懸念していたが、実際にはサーバーサイドで
      // 記事一覧(PublicationList領域)を含むHTMLが返ることを確認できたため採用した。RSSではなく
      // 生ページのHTML解析(scheduled_job_ai_research_fetch.js側にfetchAnthropicNewsHtml()を実装)。
      { function_name: "anthropicnews", rest_endpoint: "https://www.anthropic.com/news" },
      // 2026-10-10追加: category 8(世の中の動向・SEO/マーケティング業界)・category 9(働き方の動向)。
      // manager-roomでの個人キャリア実績作り相談から、Google Trends自体は無料・規約クリーンな
      // 取得手段が無く見送り、代わりに公式RSSを提供している業界メディアを採用した経緯は
      // progress-tracker-dashboardのconcept-log.json参照。全て実地検証済み(HTTP 200・<item>形式)。
      // Moz Blogは"https://moz.com/blog/feed"がリダイレクトするplain-http版の
      // "http://feedpress.me/mozblog"だと環境によって解決に失敗するため、https版を直接指定する。
      { function_name: "searchenginejournal", rest_endpoint: "https://www.searchenginejournal.com/feed/" },
      { function_name: "mozblog", rest_endpoint: "https://feedpress.me/mozblog" },
      { function_name: "fastcompanyworklife", rest_endpoint: "https://www.fastcompany.com/work-life/rss" },
      { function_name: "allworkspace", rest_endpoint: "https://allwork.space/feed/" },
      { function_name: "guardianwork", rest_endpoint: "https://www.theguardian.com/money/work-and-careers/rss" },
      { function_name: "epi", rest_endpoint: "https://www.epi.org/feed/" },
    ],
  },
  {
    // 2026-09-29追加(PTD-065): category 7(ハッカソン情報)。devpost.com/api/hackathonsは
    // Devpost公式サイト自身が使っている認証不要のJSON APIで、ユーザーがブラウザで直接
    // アクセスして有効なJSONが返ることを実地検証済み(このワークルームのegress制限で
    // curl/WebFetchからは直接検証できなかったため、ユーザー確認による実地検証)。
    name: "AI Research - Devpost",
    description: "PTD-065: Devpostハッカソン一覧API(認証不要・GET)",
    methods: [
      { function_name: "hackathons", rest_endpoint: "https://devpost.com/api/hackathons?page=1" },
    ],
  },
  {
    // 2026-10-18追加: category 2(AI最新技術)・5(AIの流行)・10(世の中の話題・トレンド)。
    // manager-roomでの相談(「AIの最新技術」+「世の中のトレンドとして再生回数が多いキーワード」を
    // 知りたい、日本・世界両方)への対応。YouTube Data API v3は他19情報源と異なりAPIキー認証が
    // 必須。エンドポイントにキーを含めない(${変数}埋め込みもしない)設計にし、キーは実行時に
    // RESTMessageV2.setQueryParameter("key", ...)で付与する
    // (scheduled_job_ai_research_fetch.js参照。理由はそちらのコメントに詳述)。
    // そのため、ここに定義するエンドポイントは常にkeyパラメータを含まない。
    name: "AI Research - YouTube",
    description: "PTD-089: YouTube Data API v3(認証はAPIキー、実行時にsetQueryParameterで付与)",
    methods: [
      // category 2用: AI関連キーワードを新着順(order=date)で検索。
      {
        function_name: "aitech",
        rest_endpoint:
          "https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=date&maxResults=10&q=" +
          encodeURIComponent('AI OR "人工知能" OR "機械学習" OR Claude OR "生成AI"'),
      },
      // category 5用: AI関連キーワードを再生回数順(order=viewCount)で検索。
      // search.listのレスポンスには再生回数の数値自体は含まれない(並び順のみ反映)。
      // 2026-10-19改善(PTD-090): 単体の"AI"というbareのOR項を削除した(2文字のため、
      // "Ai, Amor"(ポルトガル語の歌、"Ai"="Oh"の意)のような無関係な動画や、タグの
      // 偶然の一致(MrBeast動画等)まで拾ってしまうノイズの原因になっていたため)。
      // 代わりに"artificial intelligence"という具体的な英語フレーズを追加した。
      // なお実際の実行時クエリ(publishedAfterでの直近N日への絞り込みを含む)は
      // scheduled_job_ai_research_fetch.jsのYOUTUBE_ENDPOINTS.aitrendがsetEndpoint()で
      // 都度上書きするため、ここのrest_endpointは「キー無しのベース定義」として
      // q部分のみ両ファイルで一致させればよい(publishedAfterは実行時刻依存の値のため
      // 静的なこの定義には含めない)。
      // 2026-10-21追記: bareの"Claude"が俳優"Jean-Claude Van Damme"にも誤マッチしていた
      // ことが実データで判明したため、-"Jean-Claude"(Boolean NOT)を追加して除外した
      // (詳細はscheduled_job_ai_research_fetch.js側のコメント参照)。
      {
        function_name: "aitrend",
        rest_endpoint:
          "https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=viewCount&maxResults=10&q=" +
          encodeURIComponent('"artificial intelligence" OR "人工知能" OR "機械学習" OR Claude OR "生成AI" -"Jean-Claude"'),
      },
      // category 10用: 日本の急上昇動画(ジャンル問わず)。part=statisticsで再生回数を含める。
      {
        function_name: "trendjp",
        rest_endpoint:
          "https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&chart=mostPopular&regionCode=JP&maxResults=10",
      },
      // category 10用: 世界の急上昇動画(regionCode=USをグローバル指標として代用。
      // YouTube Data APIはregionCode必須で「世界共通」の値は無いため、manager-roomでの
      // 相談時にUSを代理指標とする前提で合意した)。
      {
        function_name: "trendworld",
        rest_endpoint:
          "https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&chart=mostPopular&regionCode=US&maxResults=10",
      },
    ],
  },
];
// 2026-08-29: Anthropicは公式ブログRSSフィードを提供していないことが実機検証(verify-source-urlsジョブ、
// https://www.anthropic.com/rss.xml が404)で判明したため、ブログ相当の情報源からは除外した
// (ユーザー承認済み)。詳細はprogress-tracker-dashboardのconcept-log.json参照。以前の実行で既に
// 作成されてしまった場合に備え、下記REMOVED_METHODSで明示的に削除する。
// なお2026-09-06、代替としてanthropicreleases(上記)を追加した。また
// https://www.anthropic.com/news の生HTML直接取得については、クライアントサイドレンダリング
// (Next.js)により実際に記事一覧を含むか未検証のため、verify_source_urls.mjs側での実地検証結果を
// 見てから採否を判断する(この時点ではREST Message化していない。CLAUDE.mdルール1「未知の
// スキーマを推測で決め打ちしない」に基づく)。

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
