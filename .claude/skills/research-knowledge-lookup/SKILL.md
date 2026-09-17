---
name: research-knowledge-lookup
description: Consult servicenow-sub-agent's accumulated research knowledge (data/research-items.json) before answering a question, instead of answering from memory. Use this whenever the user says something like "servicenow sub agentの調査結果/ナレッジを見て" or otherwise asks you to check what this repo's research pipeline has already collected, on any topic covered by its 5 research angles (AI/agent, architecture, MCP/RAG, security, free-tier tooling — see README.md). This is a *lookup* skill (read and cite what's already there); it is not the research-item-curation skill (which *writes* Japanese analysis into uncurated items) — use that one instead if the user asks to curate/pick/score items rather than look something up.
---

# servicenow-sub-agentの蓄積ナレッジを確認する(Research knowledge lookup)

## これは何か

CLAUDE.mdルール26(2026-09-17追加、ユーザー指示)への対応。servicenow-sub-agentの
リサーチパイプラインが自動収集した`data/research-items.json`(2026-09時点で約2800件、
うち`curated: true`の厳選済みはごく一部)を、質問に答える前に実際に確認する手順。
確認せず記憶だけで回答しないこと(CLAUDE.mdルール1「必ずネット上/蓄積データ等の
最新情報を基に回答する」に基づく)。

## 手順

1. **ファイルが大きい(約2MB、2800件超)ことに注意する。** `Read`ツールでそのまま
   全件読み込もうとせず、`python3`または`jq`でキーワード・カテゴリ・スコア等の
   条件に絞って抽出してから読むこと(例: `python3 -c "import json; d=json.load(open('data/research-items.json')); [print(...) for it in d['items'] if 'キーワード' in it['title'].lower()]"`)。

2. **`curated: true`の項目を優先する。** これらは`summaryJa`/`pointsJa`/
   `applicableTechJa`に人(AI)による日本語の分析が既に書かれており、生の英語
   ローデータより信頼度が高い(research-item-curationスキルによって書かれたもの)。
   質問に関連する`curated: true`項目が見つかれば、それを一次情報として回答に使う。

3. **`curated: true`に一致が無ければ、`curated: false`の生データも見る。** ただし
   これは自動収集されたRSS/API由来の英語の要約(`rawSummary`)で、人による検証・
   要約は入っていない。生データを根拠に使う場合は、必ず「未キュレーション(未検証)
   の生データに基づく」旨を明記し、`sourceUrl`・`sourceName`・`publishedAt`を
   引用して出典を示すこと(CLAUDE.mdルール5「根拠となる情報がないものは回答に
   含めない。回答時は根拠も添える」に基づく)。

4. **該当する情報が見つからなければ、正直に「見つからなかった」と報告する。**
   無理に関連付けたり、見つからない代わりに一般知識で答えたりしない
   (CLAUDE.mdルール3「わからないことはわからないとはっきり言う」に基づく)。

5. これはあくまで**参照(読み取り)専用**の手順。`research-items.json`への書き込み
   (要約を追加してcurated化する等)が必要な場合はresearch-item-curationスキルを
   使うこと(このスキルでは書き込みを行わない)。
