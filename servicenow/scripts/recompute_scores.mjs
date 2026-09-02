// data/research-items.json の全項目に対してscoreだけを再計算するユーティリティ。
// Claudeによる手動キュレーション(summaryJa等の追加)の後、export_research_items.mjsを
// 再実行せずにスコアだけ更新したい場合に使う(手作業実行、ワークフローには組み込まない)。
import { readFileSync, writeFileSync } from "node:fs";
import { scoreItem } from "./lib/score_items.mjs";

const path = new URL("../../data/research-items.json", import.meta.url);
const d = JSON.parse(readFileSync(path, "utf-8"));
for (const item of d.items) {
  item.score = scoreItem(item);
}
d.generatedAt = new Date().toISOString();
writeFileSync(path, JSON.stringify(d, null, 2) + "\n", "utf-8");
console.log(`スコア再計算完了: ${d.items.length}件`);
