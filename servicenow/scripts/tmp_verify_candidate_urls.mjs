// PTD-048追加6候補の実地検証用の一時スクリプト。verify_source_urls.mjsと同じ判定ロジックで、
// まだREST_MESSAGES/SOURCESに採用していない候補URLだけを検証する。
// 検証後、採用したものだけをsetup_rest_messages.mjs・verify_source_urls.mjsへ正式に追加し、
// このファイルと.github/workflows/servicenow-setup.ymlの一時ジョブは削除する(使い捨て)。

const CANDIDATES = [
  {
    label: "MIT Technology Review AI (全体feed)",
    url: "https://www.technologyreview.com/feed/",
  },
  {
    label: "MIT Technology Review AI (AI特化topic feed)",
    url: "https://www.technologyreview.com/topic/artificial-intelligence/feed/",
  },
  { label: "MarkTechPost", url: "https://www.marktechpost.com/feed/" },
  { label: "ByteByteGo", url: "https://blog.bytebytego.com/feed" },
  { label: "InfoQ (AI/ML/Data Eng)", url: "https://feed.infoq.com/ai-ml-data-eng/" },
  { label: "Martin Fowler blog", url: "https://martinfowler.com/feed.atom" },
  { label: "Architecture Weekly (独自ドメイン)", url: "https://architecture-weekly.com/feed" },
  {
    label: "Architecture Weekly (Substack)",
    url: "https://softwarearchitectureweekly.substack.com/feed",
  },
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
      console.log(`  本文先頭200文字: ${body.slice(0, 200).replace(/\s+/g, " ")}`);
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
