// 一時診断スクリプト(PTD-046拡張、2026-09-06)。
//
// verify_source_urls.mjsで https://www.anthropic.com/news の生HTMLが
// href="/news/..." を5件以上含むことを確認できたが、実際のタイトル・日付が
// どのタグ構造に入っているかは未確認。CLAUDE.mdルール1(未知のスキーマを
// 推測で決め打ちしない)に従い、実際の周辺HTMLをダンプしてから抽出ロジックを
// 設計するための使い捨てスクリプト。役目を終えたら削除する。

async function main() {
  const res = await fetch("https://www.anthropic.com/news", { redirect: "follow" });
  const body = await res.text();
  console.log(`HTTP ${res.status}, ${body.length} bytes`);

  const re = /href="\/news\/[^"]*"/g;
  let m;
  let count = 0;
  const seen = new Set();
  while ((m = re.exec(body)) !== null && count < 6) {
    const idx = m.index;
    const href = m[0];
    if (seen.has(href)) continue;
    seen.add(href);
    const start = Math.max(0, idx - 300);
    const end = Math.min(body.length, idx + 300);
    console.log(`\n===== match #${count + 1}: ${href} =====`);
    console.log(body.slice(start, end));
    count++;
  }

  console.log(`\n\n(参考)本文中の href="/news/ 出現回数: ${(body.match(/href="\/news\//g) || []).length}`);
}

main().catch((e) => {
  console.error(e.stack || String(e));
  process.exit(1);
});
