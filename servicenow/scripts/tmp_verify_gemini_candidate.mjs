// ユーザー依頼(Claude/Gemini/ChatGPT公式サイトの追加)対応の一時検証スクリプト。
// Web検索で見つかった候補URLを実地検証する。CL-009の教訓通り、推測で採用せず実地検証する。
// 採用可否確定後、このファイルと一時ジョブは削除する。

const CANDIDATES = [
  { label: "Google DeepMind Blog(Geminiの研究発表を含む)", url: "https://deepmind.google/blog/rss.xml" },
];

function looksLikeFeed(body) {
  return body.includes("<item") || body.includes("<entry");
}

async function checkOne(source) {
  try {
    const res = await fetch(source.url, { redirect: "follow" });
    const body = await res.text();
    const ok = res.ok && looksLikeFeed(body);
    const status = ok ? "OK" : "NG";
    console.log(`[${status}] ${source.label}: HTTP ${res.status}, ${body.length} bytes, url=${res.url}`);
    if (!ok) {
      console.log(`  本文先頭300文字: ${body.slice(0, 300).replace(/\s+/g, " ")}`);
    } else {
      console.log(`  本文先頭300文字: ${body.slice(0, 300).replace(/\s+/g, " ")}`);
    }
  } catch (e) {
    console.log(`[NG] ${source.label}: 例外 ${e.message} (url=${source.url})`);
  }
}

async function main() {
  for (const c of CANDIDATES) {
    await checkOne(c);
  }
}

main();
