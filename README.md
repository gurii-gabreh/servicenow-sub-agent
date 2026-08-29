# servicenow-sub-agent

ServiceNow PDI(Personal Developer Instance、`dev395932.service-now.com`)上で、AI・アプリ開発に関わる5つの観点を無料の外部情報源から定期的に自動収集し、1つのテーブルに蓄積するリサーチパイプライン。進捗・実装ナレッジは`gurii-gabreh/progress-tracker-dashboard`の`data/tasks.json`(タスクID: **PTD-046**)で一元管理している。

## 対象の5観点

| category値 | 観点 |
|---|---|
| 1 | アプリ作成時に活かせる技術、アーキテクチャ的要素やデータ構造、データのやり取り |
| 2 | 最新のAI技術でできること、今後できると思われる技術の動向 |
| 3 | 今ある技術を組み合わせるとできる新しいこと |
| 4 | AIが使われている分野や、使われやすいシチュエーション |
| 5 | AIの流行 |

## 情報源(すべて無料・認証不要の公開API/RSS)

| 情報源 | 種別 | エンドポイント |
|---|---|---|
| arXiv | API(Atom XML) | `http://export.arxiv.org/api/query` |
| Hacker News | API(JSON、Algolia) | `http://hn.algolia.com/api/v1/search_by_date` |
| Anthropic Blog | RSS | `https://www.anthropic.com/rss.xml` (要確認、下記「既知の制約」参照) |
| OpenAI Blog | RSS | `https://openai.com/blog/rss.xml` (要確認) |
| Hugging Face Blog | RSS | `https://huggingface.co/blog/feed.xml` (要確認) |

いずれもAPIキー・OAuth等の認証情報は不要。**ServiceNow認証情報や、万一将来他の情報源で認証が必要になった場合のAPIキー等は、このリポジトリには絶対にコミットしない**(ServiceNow PDI内のシステムプロパティ等でのみ保持する)。

## アーキテクチャ

```
[ServiceNow Scheduled Job] --日次実行-->
  各情報源をREST Message経由でGET
    -> arXiv (Atom XML) / Hacker News (JSON) / Blog RSS(XML) をパース
    -> 正規化(category/title/summary/source_url/source_name/published_at)
    -> u_dedup_key(source_urlの正規化文字列)で重複チェック
    -> 新規のみ u_ai_research_item テーブルへ insert
```

GAS(`progress-tracker-dashboard/gas/Code.gs`)と同じく、**ServiceNow側のコードはGitHubと自動連携していない**。このリポジトリの`servicenow/scheduled_job_ai_research_fetch.js`を、ServiceNowのスケジュールジョブエディタへ手動でコピー&ペーストする必要がある(コード変更のたびに再貼り付けが必要)。

## セットアップ手順(手動、ServiceNow PDI側)

### 1. テーブル作成: `u_ai_research_item`

Studio(または「システム定義 > テーブル」)から新規テーブルを作成し、以下のフィールドを追加する。

| フィールド名(列名) | 型 | 長さ/選択肢 | 説明 |
|---|---|---|---|
| `u_category` | Choice | 1〜5(上表参照) | 観点分類 |
| `u_title` | String | 200 | タイトル |
| `u_summary` | String | 4000 | 要約 |
| `u_source_url` | String | 1024 | 出典URL |
| `u_source_name` | String | 100 | arXiv / Hacker News / Anthropic Blog / OpenAI Blog / Hugging Face Blog |
| `u_published_at` | Date/Time | - | 元記事の公開日時(取得できない場合は空) |
| `u_fetched_at` | Date/Time | - | このパイプラインが取得した日時 |
| `u_dedup_key` | String | 255 | 重複防止用キー(`u_source_url`を小文字化+末尾スラッシュ除去した正規化文字列、255文字まで)。**Unique制約を付けることを推奨** |

### 2. REST Message作成

「System Web Services > REST Message」から、以下の3レコードを作成する(いずれも認証不要・GET)。

**REST Message: `AI Research - arXiv`**
- HTTPメソッド `search`: Endpoint `http://export.arxiv.org/api/query`
  - 変数: `search_query`(デフォルト `cat:cs.AI+OR+cat:cs.CL+OR+cat:cs.LG`)、`max_results`(デフォルト `10`)、`sortBy=submittedDate`、`sortOrder=descending` をクエリパラメータに含める

**REST Message: `AI Research - Hacker News`**
- HTTPメソッド `search`: Endpoint `http://hn.algolia.com/api/v1/search_by_date?query=${query}&tags=story&hitsPerPage=${hits}`

**REST Message: `AI Research - Blog RSS`**
- HTTPメソッド `anthropic`: Endpoint `https://www.anthropic.com/rss.xml`
- HTTPメソッド `openai`: Endpoint `https://openai.com/blog/rss.xml`
- HTTPメソッド `huggingface`: Endpoint `https://huggingface.co/blog/feed.xml`

### 3. スケジュールジョブ作成

「System Definition > Scheduled Jobs」から「Automatically run a script of your choosing」を選択し、`servicenow/scheduled_job_ai_research_fetch.js`の内容をそのまま貼り付ける。実行頻度は日次を推奨(無料PDIのリソース枠内で十分)。

### 4. 動作確認

いきなりスケジュール実行に任せず、まず「System Definition > Scripts - Background」で同じスクリプトを1回手動実行し、`u_ai_research_item`に想定通り行が増えるか、エラーログ(`gs.error`)が出ていないかを確認することを強く推奨する(下記「既知の制約」も参照)。

## 既知の制約

- **RSS URLは実地未確認**: この実装を行ったworker-roomセッションは、ネットワークegressポリシーにより`export.arxiv.org`・`hn.algolia.com`・`www.anthropic.com`等への外部アクセスが遮断される環境だったため(詳細はprogress-tracker-dashboardのPTD-045参照)、上記のAPI/RSS URLをこのセッションから実地検証できていない。arXiv APIとHacker News Algolia APIは長年安定している既知の公開APIのため形式には比較的自信があるが、特に3つのブログRSSのURLパスは変更されている可能性がある。**上記「4. 動作確認」を必ず行い、404やパースエラーが出る場合はブラウザで実際のRSS URLを確認して修正すること**
- **ServiceNow自体からのアクセスはこのセッションの制約を受けない**: 上記の実地未確認はこのCloud上のworker-roomセッションのネットワーク制限によるものであり、実際にスケジュールジョブを実行するServiceNow PDI自体のネットワークとは無関係。ServiceNow側は通常、外部の公開HTTPSエンドポイントへ問題なくアクセスできる
- arXivのAtom XMLパース部分(`parseArxivXml`)は、ServiceNowの`XMLDocument2`の挙動をこのセッションから実機確認できていないため、他の2つ(JSON/RSS)より検証の優先度を上げることを推奨する
- **ServiceNow PDIの制約**: 開発・テスト目的限定というServiceNowのToSに従うこと。また、インスタンス作成から90日以上経過し、かつ10日間ログインが無い場合に自動回収される制約がある。本パイプラインが蓄積したデータを失わないよう、定期的に(90日を待たずに)ログインするか、必要であれば蓄積データを外部へエクスポートする運用を検討すること(現時点でエクスポートの自動化までは実装していない)
- 重複排除は`u_source_url`を正規化した`u_dedup_key`の完全一致のみで判定している(ServiceNowの標準ハッシュAPIを実機確認できなかったため、あえてハッシュ化せず正規化文字列そのものを使う設計にした)。同じ記事が`http://`と`https://`のように大きく異なる形で重複する場合までは防げない

## 意味のある実装判断の記録

DB設計(単一テーブル+category列による分類、dedup_keyによる重複防止)や、REST Message + Scheduled Jobという構成についての判断根拠は、`gurii-gabreh/progress-tracker-dashboard`の`data/concept-log.json`にも記録している(CLAUDE.mdコア規則の指示に従い)。
