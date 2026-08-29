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
| OpenAI Blog | RSS | `https://openai.com/blog/rss.xml` (実機検証済み、2026-08-29) |
| Hugging Face Blog | RSS | `https://huggingface.co/blog/feed.xml` (実機検証済み、2026-08-29) |

**2026-08-29、Anthropic Blogは情報源から除外した**: `https://www.anthropic.com/rss.xml`を`.github/workflows/servicenow-setup.yml`のverify-source-urlsジョブで実地検証したところHTTP 404(Next.jsアプリのエラーページ)が返り、調査の結果Anthropicは現在公式のRSSフィードを提供していないことが判明した(非公式の第三者ミラーは信頼性・継続性の観点から採用せず、ユーザー承認の上で情報源自体を4つに減らす方針にした)。

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
| `u_source_name` | String | 100 | arXiv / Hacker News / OpenAI Blog / Hugging Face Blog |
| `u_published_at` | Date/Time | - | 元記事の公開日時(取得できない場合は空) |
| `u_fetched_at` | Date/Time | - | このパイプラインが取得した日時 |
| `u_dedup_key` | String | 255 | 重複防止用キー(`u_source_url`を小文字化+末尾スラッシュ除去した正規化文字列、255文字まで)。**Unique制約を付けることを推奨** |

### 2. REST Message作成

「System Web Services > REST Message」から、以下の3レコードを作成する(いずれも認証不要・GET)。**手作業の代わりに、下記「REST Messageの自動作成(GitHub Actions)」で自動化することもできる。**

**REST Message: `AI Research - arXiv`**
- HTTPメソッド `search`: Endpoint `http://export.arxiv.org/api/query?search_query=cat:cs.AI+OR+cat:cs.CL+OR+cat:cs.LG&max_results=10&sortBy=submittedDate&sortOrder=descending`(クエリ文字列を含めた完全な静的URL。理由は下記「REST Messageの自動作成」の注記参照)

**REST Message: `AI Research - Hacker News`**
- HTTPメソッド `search`: Endpoint `http://hn.algolia.com/api/v1/search_by_date?query=AI&tags=story&hitsPerPage=20`(同上、静的URL)

**REST Message: `AI Research - Blog RSS`**
- HTTPメソッド `openai`: Endpoint `https://openai.com/blog/rss.xml`
- HTTPメソッド `huggingface`: Endpoint `https://huggingface.co/blog/feed.xml`

(2026-08-29追記: 当初あった`anthropic`メソッドは、Anthropicが公式RSSフィードを提供していないと実機検証で判明したため削除した。既に作成してしまっていた場合はservicenow-sub-agentのGitHub Actionsワークフローを再実行すると自動削除される。詳細は下記「既知の制約」参照)

#### REST Messageの自動作成(GitHub Actions、2026-08-29追加)

上記3レコードは、`.github/workflows/servicenow-setup.yml`(手動実行=workflow_dispatch)から`servicenow/scripts/setup_rest_messages.mjs`を実行することで、ServiceNowのTable API経由で自動作成できる。手順:

1. ServiceNow PDI(dev395932.service-now.com)の`System OAuth > Application Registry`で、OAuth 2.0のClient Credentials grant用アプリケーションを作成し、Client ID/Client Secretを控える。「Create an OAuth API endpoint for external clients」(旧UI)・「New Inbound Integration Experience > New Integration > OAuth - Client credentials grant」(Zurich以降の新UI)のどちらで作成したものでも、トークン取得エンドポイント(`/oauth_token.do`)は共通のため問題なく使える。Client Credentials grant typeをシステム全体で有効化し、統合用ユーザーをこのOAuthアプリケーションに割り当てること(未設定だと401エラーになる)。
2. このリポジトリのGitHub Settings > Secrets and variables > Actionsで、以下3つのRepository secretを登録する(**値は絶対にコミット・チャットに書かない**)。
   - `SERVICENOW_INSTANCE_URL`: ServiceNow PDIのインスタンス(`dev395932.service-now.com`のようなホスト名でも、`https://dev395932.service-now.com`のような完全なURLでもどちらでもよい)
   - `SERVICENOW_CLIENT_ID`: 1.で発行されたClient ID
   - `SERVICENOW_CLIENT_SECRET`: 1.で発行されたClient Secret
3. GitHub Actionsの「Actions」タブから「ServiceNow REST Messageセットアップ(PTD-048)」をworkflow_dispatchで実行する。`dry_run`を`true`のまま(初期値)で1回実行し、ログに出力される作成予定の内容(REST Message名・HTTPメソッド・エンドポイント)を確認してから、`dry_run`を`false`にして再実行すると実際に作成される。
4. 既に存在するREST Message/HTTPメソッド(名前で判定)はスキップされ、重複作成はされない。想定と異なるエンドポイントが既に設定されている場合は上書きせず警告ログのみ出す。

**設計判断**: 当初案ではarXiv/Hacker Newsのクエリを`${変数}`によるランタイム置換にする想定だったが、ServiceNowのRESTMessageV2は`${varName}`をHTTPメソッド側の「Variable」定義に事前登録しないと、置換されずリテラルの`"${varName}"`のまま送信されて**エラーも出ずに検索結果が空になる**という既知の落とし穴がある。このworker-roomセッションはServiceNowへ対話的にログインしてその変数定義まわりの挙動を実機確認する手段がなく、かつscheduled_job_ai_research_fetch.jsが渡す値は常に固定(実行のたびに変えていない)ため、そもそも変数を使わずクエリ文字列をエンドポイントURLに直接埋め込んだ静的URLに設計変更した。検索クエリや件数を変更したい場合は、`servicenow/scripts/setup_rest_messages.mjs`とこのREADME、`servicenow/scheduled_job_ai_research_fetch.js`のコメントを合わせて修正すること。

### 3. スケジュールジョブ作成

「System Definition > Scheduled Jobs」から「Automatically run a script of your choosing」を選択し、`servicenow/scheduled_job_ai_research_fetch.js`の内容をそのまま貼り付ける。実行頻度は日次を推奨(無料PDIのリソース枠内で十分)。

**この手順は手動のまま残している(2026-08-29時点であえて自動化していない)**。理由: (1) UI操作としてはスクリプトの貼り付け+頻度選択+保存のみで、上記REST Message作成(3レコード×複数フィールド)より手間が小さい、(2) Table API経由で`sysauto_script`(Scheduled Script Execution)を作成する場合に必要な`run_type`等のフィールド構成を、このセッションからは実機で検証する手段がなく、誤った設定で「一見成功したが実際には動かない/意図しない頻度で動く」スケジュールジョブを作ってしまうリスクの方が、手作業の手間より大きいと判断した。将来これを自動化したい場合は、まずServiceNow PDI上で実際に`sysauto_script`テーブルの必須フィールドをTable API(`GET /api/now/table/sysauto_script?sysparm_limit=1`等)で確認してから着手すること。

### 4. 動作確認

いきなりスケジュール実行に任せず、まず「System Definition > Scripts - Background」で同じスクリプトを1回手動実行し、`u_ai_research_item`に想定通り行が増えるか、エラーログ(`gs.error`)が出ていないかを確認することを強く推奨する(下記「既知の制約」も参照)。

## 既知の制約

- **RSS URLの実地検証結果(2026-08-29更新)**: この実装を行ったworker-roomセッション自身は、ネットワークegressポリシーにより`export.arxiv.org`・`hn.algolia.com`・`www.anthropic.com`等への外部アクセスが遮断される環境だったため(詳細はprogress-tracker-dashboardのPTD-045参照)、当初はAPI/RSS URLを実地検証できていなかった。2026-08-29、`.github/workflows/servicenow-setup.yml`の`verify-source-urls`ジョブ(GitHub Actionsランナーから実行、通常のインターネットアクセスを持つ)を実際に実行した結果、arXiv API・Hacker News API・OpenAI Blog RSS・Hugging Face Blog RSSの4件はHTTP 200・期待した形式で正常に確認できた。一方Anthropic Blog(`https://www.anthropic.com/rss.xml`)はHTTP 404(Next.jsアプリのエラーページ)であることが判明し、Anthropicが公式RSSフィードを提供していないことが分かったため情報源から除外した(上記「情報源」表参照)。このverify-source-urlsジョブは「情報源URL自体の生存確認」に留まり、ServiceNow上で`scheduled_job_ai_research_fetch.js`を実行した際の`u_ai_research_item`への実際の書き込みまでは検証できないため、PTD-050の手動確認(「4. 動作確認」)は引き続き必要
- **ServiceNow自体からのアクセスはこのセッションの制約を受けない**: 上記の実地未確認はこのCloud上のworker-roomセッションのネットワーク制限によるものであり、実際にスケジュールジョブを実行するServiceNow PDI自体のネットワークとは無関係。ServiceNow側は通常、外部の公開HTTPSエンドポイントへ問題なくアクセスできる
- arXivのAtom XMLパース部分(`parseArxivXml`)は、ServiceNowの`XMLDocument2`の挙動をこのセッションから実機確認できていないため、他の2つ(JSON/RSS)より検証の優先度を上げることを推奨する
- **ServiceNow PDIの制約**: 開発・テスト目的限定というServiceNowのToSに従うこと。また、インスタンス作成から90日以上経過し、かつ10日間ログインが無い場合に自動回収される制約がある。本パイプラインが蓄積したデータを失わないよう、定期的に(90日を待たずに)ログインするか、必要であれば蓄積データを外部へエクスポートする運用を検討すること(現時点でエクスポートの自動化までは実装していない)
- 重複排除は`u_source_url`を正規化した`u_dedup_key`の完全一致のみで判定している(ServiceNowの標準ハッシュAPIを実機確認できなかったため、あえてハッシュ化せず正規化文字列そのものを使う設計にした)。同じ記事が`http://`と`https://`のように大きく異なる形で重複する場合までは防げない

## 意味のある実装判断の記録

DB設計(単一テーブル+category列による分類、dedup_keyによる重複防止)や、REST Message + Scheduled Jobという構成についての判断根拠は、`gurii-gabreh/progress-tracker-dashboard`の`data/concept-log.json`にも記録している(CLAUDE.mdコア規則の指示に従い)。
