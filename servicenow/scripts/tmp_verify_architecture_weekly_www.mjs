// PTD-056(相談): Architecture Weeklyの正しいフィードURLを再確認するための一時スクリプト。
// Web検索の結果、Architecture Weekly(運営: Oskar Dudycz)はSubstackのカスタムドメイン
// www.architecture-weekly.com(www付き)で配信されていることが判明した。2026-08-30の初回検証
// では"www"無しのarchitecture-weekly.com/feedを検証して接続失敗しており、www有りが未検証だった
// ため、これを検証する。採用可否が確定次第、このファイルと一時ジョブは削除する(使い捨て)。

const CANDIDATES = [
  { label: "Architecture Weekly (www付き, Substackカスタムドメイン)", url: "https://www.architecture-weekly.com/feed" },
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
