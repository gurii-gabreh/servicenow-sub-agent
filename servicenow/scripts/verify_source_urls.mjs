// PTD-050(実機検証)の一部を肩代わりするスクリプト。
//
// このリポジトリを実装したworker-roomセッションはネットワークegressポリシーにより
// export.arxiv.org・hn.algolia.com・各社ブログドメインへ直接アクセスできない(README「既知の制約」
// 参照)。一方GitHub Actionsのランナーは通常のインターネットアクセスを持つため、このスクリプトを
// ワークフロー内で実行することで、少なくとも「情報源URLが実際に200を返すか・レスポンス形式が
// 想定通りか」をこのリポジトリ側から自動検証できる。
//
// ただし、これはあくまで“情報源URL自体の生存確認"であり、PTD-050が本来求めている
// 「ServiceNow PDI上でscheduled_job_ai_research_fetch.jsを実行し、u_ai_research_itemに
// 正しく行が入るか」まではカバーしない(ServiceNow内部のGlideRecord/XMLDocument2の挙動は
// ServiceNow上で動かさない限り検証できない)。そちらは引き続きREADME「4. 動作確認」の
// 手動実行が必要。
//
// setup_rest_messages.mjsのREST_MESSAGES定義と値を合わせること(値を変えたら両方直す)。

const SOURCES = [
  {
    label: "arXiv API",
    url: "http://export.arxiv.org/api/query?search_query=cat:cs.AI+OR+cat:cs.CL+OR+cat:cs.LG&max_results=10&sortBy=submittedDate&sortOrder=descending",
    expect: (body) => body.includes("<entry>") || body.includes("<feed"),
    expectDesc: '<entry> または <feed> を含むAtom XML',
  },
  {
    label: "Hacker News API",
    url: "http://hn.algolia.com/api/v1/search_by_date?query=AI&tags=story&hitsPerPage=20",
    expect: (body) => {
      try {
        const j = JSON.parse(body);
        return Array.isArray(j.hits);
      } catch {
        return false;
      }
    },
    expectDesc: "hits配列を含むJSON",
  },
  {
    label: "Anthropic Blog RSS",
    url: "https://www.anthropic.com/rss.xml",
    expect: (body) => body.includes("<item") || body.includes("<entry"),
    expectDesc: "<item> または <entry> を含むRSS/Atom XML",
  },
  {
    label: "OpenAI Blog RSS",
    url: "https://openai.com/blog/rss.xml",
    expect: (body) => body.includes("<item") || body.includes("<entry"),
    expectDesc: "<item> または <entry> を含むRSS/Atom XML",
  },
  {
    label: "Hugging Face Blog RSS",
    url: "https://huggingface.co/blog/feed.xml",
    expect: (body) => body.includes("<item") || body.includes("<entry"),
    expectDesc: "<item> または <entry> を含むRSS/Atom XML",
  },
];

async function checkOne(source) {
  try {
    const res = await fetch(source.url, { redirect: "follow" });
    const body = await res.text();
    const ok = res.ok && source.expect(body);
    const status = ok ? "OK" : "NG";
    console.log(`[${status}] ${source.label}: HTTP ${res.status}, ${body.length} bytes, url=${res.url}`);
    if (!ok) {
      console.log(`  期待した形式: ${source.expectDesc}`);
      console.log(`  本文先頭300文字: ${body.slice(0, 300).replace(/\s+/g, " ")}`);
    }
    return ok;
  } catch (e) {
    console.log(`[NG] ${source.label}: 例外 ${e.message} (url=${source.url})`);
    return false;
  }
}

async function main() {
  let allOk = true;
  for (const source of SOURCES) {
    const ok = await checkOne(source);
    allOk = allOk && ok;
  }
  if (!allOk) {
    console.log(
      "\n一部の情報源URLが想定通りではありません。README.mdの該当エンドポイントと、servicenow/scripts/setup_rest_messages.mjs・servicenow/scheduled_job_ai_research_fetch.jsの両方を実際のURLに合わせて修正してください。"
    );
    process.exitCode = 1;
  } else {
    console.log("\n全情報源URLが想定通りのレスポンスを返しました。");
  }
}

main();
