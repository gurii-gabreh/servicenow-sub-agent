// 一時的な調査用スクリプト。u_published_atがOpenAI Blog由来のレコードで全件空欄になっている
// 原因(pubDateタグが本当に無いのか、抽出処理側の問題か)を切り分けるため、実際のRSS生データの
// 最初の1〜2件分をそのままログに出す。ServiceNow認証は不要(情報源への素のGETのみ)。
// 原因特定後は用済みになるので削除してよい。

const TARGETS = [
  { label: "OpenAI Blog", url: "https://openai.com/blog/rss.xml" },
  { label: "Hugging Face Blog", url: "https://huggingface.co/blog/feed.xml" },
];

function splitBlocks(xml, tagName) {
  const re = new RegExp(`<${tagName}[^>]*>[\\s\\S]*?<\\/${tagName}>`, "gi");
  return xml.match(re) || [];
}

async function main() {
  for (const target of TARGETS) {
    console.log(`\n========== ${target.label} (${target.url}) ==========`);
    const res = await fetch(target.url, { redirect: "follow" });
    const body = await res.text();
    console.log(`HTTP ${res.status}, final url=${res.url}, ${body.length} bytes`);

    let items = splitBlocks(body, "item");
    let tagUsed = "item";
    if (items.length === 0) {
      items = splitBlocks(body, "entry");
      tagUsed = "entry";
    }
    console.log(`検出したブロック数(${tagUsed}): ${items.length}`);

    // ルート要素直下の名前空間宣言(xmlns:...)も確認しておく(dc:date等を使っている場合の手がかり)
    const rootMatch = body.match(/<(rss|feed)\b[^>]*>/i);
    if (rootMatch) {
      console.log(`ルート要素: ${rootMatch[0]}`);
    }

    for (const item of items.slice(0, 2)) {
      console.log(`\n--- ${target.label} 1件分の生データ ---`);
      console.log(item);
    }
  }
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
