// PTD-058: 「おすすめ順」表示用の簡易ヒューリスティックスコアリング。
//
// 前提: 明示的な「いいね」等の評価データがまだ存在しないため(2026-09-02時点)、
// このプロジェクト(progress-tracker-dashboard / study-app / kizashi等)でこれまで
// 繰り返し重視されてきたキーワードとの一致度でスコアを付ける代用ロジック。
// data/concept-log.jsonやCLAUDE.mdコア規則で繰り返し登場する関心領域
// (AIエージェント基盤、無料/低コスト、自動化、セキュリティ等)を基準にしている。
// 精度は限定的なので、実際にサイトを使いながら重み付けを調整していく想定。
//
// キーワードは英語(情報源の多くが英語ブログのため)。将来的に「いいね」機能等の
// 明示的なフィードバックが実装されたら、そちらを優先するロジックへ差し替える。

const KEYWORD_WEIGHTS = [
  // AIエージェント設計・アーキテクチャ(このプロジェクトで最も繰り返し扱っているテーマ)
  { re: /\bagent(ic)?\b/i, weight: 3 },
  { re: /\barchitecture\b/i, weight: 3 },
  { re: /\bmcp\b|model context protocol/i, weight: 3 },
  { re: /\brag\b|retrieval.augmented/i, weight: 3 },
  { re: /\bembedding|vector (db|database|search)\b/i, weight: 2 },
  { re: /\bmemory\b/i, weight: 2 },
  // 自動化・運用(GitHub Actions等の無料インフラでの自動化を重視)
  { re: /\bautomat(e|ion|ed)\b/i, weight: 2 },
  { re: /\bworkflow\b/i, weight: 1 },
  { re: /\bopen[- ]?source\b|open weight/i, weight: 2 },
  { re: /\bfree\b|no.cost|zero.cost/i, weight: 2 },
  // セキュリティ(OWASP等の学習テーマとも関連)
  { re: /\bsecurity\b|vulnerabilit(y|ies)|owasp/i, weight: 2 },
  // モバイル・iPhone対応(ルール8「PCだけでなくiPhoneでも使えるアプリ」)
  { re: /\biphone|ios\b|mobile\b/i, weight: 1 },
  // Anthropic/Claude関連(利用中のツール)
  { re: /\banthropic\b|\bclaude\b/i, weight: 2 },
  // モデル性能・新モデル発表(日次AI技術リサーチRoutineと同じ関心軸)
  { re: /\bbenchmark|swe.bench|terminal.bench\b/i, weight: 1 },
  { re: /\bnew model\b|\brelease[sd]?\b/i, weight: 1 },
];

/**
 * item: { title, rawSummary, summaryJa, pointsJa, applicableTechJa }
 * を受け取り、数値スコア(大きいほど「おすすめ」上位)を返す。
 */
export function scoreItem(item) {
  const text = [
    item.title,
    item.rawSummary,
    item.summaryJa,
    Array.isArray(item.pointsJa) ? item.pointsJa.join(" ") : "",
    item.applicableTechJa,
  ]
    .filter(Boolean)
    .join(" ");

  let score = 0;
  for (const { re, weight } of KEYWORD_WEIGHTS) {
    if (re.test(text)) score += weight;
  }

  // 日本語要約済み(curated)の項目は、実際に中身を確認できる分だけ少し優先表示する
  if (item.curated) score += 1;

  return score;
}
