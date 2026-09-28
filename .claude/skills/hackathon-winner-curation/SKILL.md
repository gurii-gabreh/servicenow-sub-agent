---
name: hackathon-winner-curation
description: Curate category-7 (hackathon) items in servicenow-sub-agent's data/research-items.json by actually reading the Devpost project-gallery page of ended, winners-announced AI hackathons and writing real Japanese analysis (summaryJa, pointsJa, applicableTechJa) about the winning projects, so the user can use this as inspiration material when brainstorming their next hackathon entry. Use this whenever the user asks to "ハッカソンの入賞作品を見て/要約して", "入賞作品情報をまとめて", or otherwise wants the accumulated Devpost hackathon data turned into project-idea inspiration (see PTD-065 in progress-tracker-dashboard's data/tasks.json).
---

# Curating hackathon winner info in research-items.json

## Why this exists

servicenow-sub-agentのScheduled Job(`servicenow/scheduled_job_ai_research_fetch.js`)は、Devpostのハッカソン一覧API(`https://devpost.com/api/hackathons`)から**機械的に**AI関連ハッカソンの一覧(category 7)を収集する。しかし入賞作品の中身(実際に何を作ったか・技術スタック・なぜ評価されたか)は、このAPIには含まれず、Devpost自体にも個別ハッカソンのプロジェクトギャラリー用の公開JSON APIが存在しない(2026-09-29、実地検証済み)。

正規表現でHTMLを解析する(壊れやすい)代わりに、既存の`research-item-curation`スキルと全く同じ考え方を踏襲する: **機械的な収集はScheduled Job側だけにとどめ、実際にページを読んで理解する部分はAIが担当する。** ユーザーが「そろそろ入賞作品を見てほしい」と思った時に、このスキルを呼び出す想定(完全自動ではない。research-item-curationと同じ運用)。

## 前提知識

- `data/research-items.json`のcategory 7の各アイテムの`rawSummary`は、`scheduled_job_ai_research_fetch.js`の`fetchDevpostHackathons()`が組み立てたテキストで、`開催状況: ended(入賞発表済み) / テーマ: ... / 賞金: ... / 応募期間: ... / 登録者数: ... / 主催: ... / プロジェクトギャラリー: https://xxx.devpost.com/project-gallery` という形式。
- `プロジェクトギャラリー: `の後ろにあるURLが、実際に読みに行くべきページ。
- 同じハッカソンでも、開催状況が変わるたびに別レコードとして追加される設計(`dedupSuffix`による状態追跡、README「ハッカソン情報(category 7)」参照)ため、同じ`title`で複数件ヒットすることがある。**入賞発表済み(`(入賞発表済み)`を含む)の最新のものだけを対象にする。**

## 手順

1. **対象を選ぶ**: `data/research-items.json`を読み、`category === 7`かつ`rawSummary`に`(入賞発表済み)`を含み、かつ`curated !== true`のアイテムを列挙する。全件やる必要はなく、ユーザーが指定した件数・期間(例: 直近○件、特定のハッカソン名)があればそれに従う。指定が無ければ新しいもの(`createdAt`降順)から数件を提案し、どこまでやるかユーザーに確認する。

2. **`rawSummary`から`プロジェクトギャラリー: `以降のURLを抜き出す**。URLが無い(想定した形式でない)場合は、そのアイテムをスキップしてよい(黙ってスキップするのではなく、対象外だった旨を最後にまとめて報告する)。

3. **実際にそのURLを読む**(WebFetch等)。研究記事の要約(research-item-curationのstep 2)と同じ心構えで、**翻訳ではなく本物の理解に基づいた分析**を書く:
   - `summaryJa`: このハッカソンの入賞作品全体として、どんな傾向・特徴があったか(1〜3文)。個別プロジェクトを全部列挙するのではなく、「AIエージェント系が多かった」「〇〇(技術)を使った作品が優勝した」のような、次の自分の企画に活かせる粒度でまとめる。
   - `pointsJa`: 特に目を引いた作品・アイデア・技術の組み合わせを1〜3個、具体的に(プロジェクト名・何をしたか・なぜ評価されたと思うか)。
   - `applicableTechJa`: このハッカソンの傾向・入賞パターンが、ユーザー自身の次のハッカソン挑戦(PTD-065、PTD-020「AIエンジニアとしての方向性」参照)にどう活かせそうか。無理にこじつけない(該当しなければ空でよい、research-item-curation step 2と同じ方針)。
   - ページが取得できない・ギャラリーがまだ空(「No submissions yet」等)の場合は、その旨を`summaryJa`に正直に書く(存在しない情報を作らない、CLAUDE.mdルール3・5)。

4. **`curated: true`を設定し、`score`を+1する**(`lib/score_items.mjs`の`if (item.curated) score += 1`規約に合わせる。research-item-curationのstep 3と同じ)。

5. **Pythonスクリプト経由で書き込む**(`data/research-items.json`は大きいファイルのため、手でJSON全体を編集しない。対象の`sysId`のみを変更し、他のエントリには触れない。research-item-curationのstep 4と同じ方針)。

6. **`main`へ直接commit・push**(このリポジトリの既存の慣行。research-item-curationのstep 5と同じ、ライブアプリの確認ステップは不要)。

7. **完了したら、ユーザーへ簡潔に報告する**: 何件処理したか、どんな傾向が見えたか(ブレインストーミングのきっかけになる一言を添えるとよい)。

## 関連

- 一覧側の機械的収集の設計は`servicenow/scheduled_job_ai_research_fetch.js`の`fetchDevpostHackathons()`とREADME「ハッカソン情報(category 7)」を参照。
- 記事系の同種スキルは`.claude/skills/research-item-curation/`(このスキルはそちらをcategory 7・入賞作品向けに特化させたもの)。
- 進捗管理はprogress-tracker-dashboardの`data/tasks.json`のPTD-065。
