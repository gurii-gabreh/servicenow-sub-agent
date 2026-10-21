// AI Research Fetcher — ServiceNow Scheduled Job
//
// このファイルはGitHubとは自動連携していない。ServiceNow PDI(dev395932.service-now.com)の
// 「System Definition > Scheduled Jobs」で「Automatically run a script of your choosing」を
// 選び、このファイルの内容をそのまま貼り付けて保存する必要がある(コード変更のたびに
// 再貼り付けが必要。gas/Code.gsと同じ制約。詳細はprogress-tracker-dashboardのREADME参照)。
//
// 前提: 下記4つのREST Message(認証不要・GET専用)がSystem Web Servicesに作成済みであること。
// 詳細な設定値はこのリポジトリのREADME.md「セットアップ手順」を参照。
//   - "AI Research - arXiv"        HTTPメソッド "search"
//   - "AI Research - Hacker News"  HTTPメソッド "search"
//   - "AI Research - Blog RSS"     HTTPメソッド "openai" / "huggingface" / "mittechreview" /
//                                   "marktechpost" / "bytebytego" / "infoq" / "martinfowler" /
//                                   "architectureweekly" / "geminideepmind" / "anthropicreleases" /
//                                   "anthropicnews" / "searchenginejournal" / "mozblog" /
//                                   "fastcompanyworklife" / "allworkspace" / "guardianwork" / "epi"
//                                   (末尾6件は2026-10-10追加、category 8/9)
//   - "AI Research - Devpost"      HTTPメソッド "hackathons"(2026-09-29追加、category 7)
//   - "AI Research - YouTube"      HTTPメソッド "aitech" / "aitrend" / "trendjp" / "trendworld"
//                                   (2026-10-18追加、category 2/5/10。唯一APIキー認証が必要)
// また u_ai_research_item テーブル(フィールド定義はREADME参照)が作成済みであること。
//
// 2026-10-10追記: category 8(世の中の動向・SEO/マーケティング業界)・category 9(働き方の動向)を
// 追加した。manager-roomでの「個人の実績作り」相談(キャリア構築のための調査手段の拡張)から、
// SEOキーワード経由の世の中の動向調査と、働き方(最先端/一般的/近未来的)の調査が可能か検討し、
// Google Trends自体は無料・規約クリーンな取得手段が無かったため見送り、代わりに公式RSSを
// 提供している業界メディアを採用した(詳細はprogress-tracker-dashboardのconcept-log.json参照)。
// u_category選択肢(Choice)に8・9を追加する作業は、過去のcategory 6/7と同様にServiceNow Studio側で
// 手動登録が必要(このリポジトリのスクリプトはsys_rest_message/sys_rest_message_fnのみを自動化
// しており、u_ai_research_itemのChoice定義automationは対象外。README「セットアップ手順」参照)。
//
// 2026-08-29追記: Anthropic Blog(HTTPメソッド"anthropic")は情報源から除外した。実機検証
// (servicenow/scripts/verify_source_urls.mjs)で https://www.anthropic.com/rss.xml が
// HTTP 404を返すことを確認し、Anthropicが公式RSSフィードを現在提供していないと判明したため
// (ユーザー承認済み)。
//
// 2026-08-30追記(PTD-048拡張): MIT Technology Review AI(AI特化topicフィード)/MarkTechPost/
// ByteByteGo/InfoQ(AI/ML/Data Eng)/Martin Fowler blogの5件を追加した(候補6件のうち
// Architecture Weeklyは実地検証で2候補URLとも失敗したため未採用、ユーザー確認待ち)。
// Martin Fowler blogはAtom形式で、RSS 2.0の<link>要素(テキストとしてURLを持つ)と異なり
// <link href="..."/>のように自己終端タグの属性でURLを持つ。既存のextractTagは
// <tag>content</tag>形式の閉じタグ前提のため自己終端タグにマッチせず、そのままだと
// sourceUrlが常に空になり全件insertItem側でスキップされる(実機検証前にコードレビューで
// 発見)。これを避けるため、下記extractAttrで属性値抽出を追加し、fetchBlogRssの
// リンク抽出をRSS形式(<link>テキスト</link>)→Atom形式(<link href="...">属性)→
// <guid>の順にフォールバックするよう修正した。
//
// 既知の制約: arXiv(Atom XML)とブログ(RSS XML)のパースは、ServiceNowのXMLDocument2 API
// ではなく、あえて単純な正規表現ベースの文字列抽出にしている。実装したworker-roomセッションは
// ネットワークegress制限によりarXiv/HN/各ブログへ実地アクセスできず(詳細はPTD-045参照)、
// XMLDocument2の名前空間まわりの挙動を実機で確認できなかったため、確実性を優先してこの方式に
// した。IDやHTMLタグを含むtitle/summaryが稀に誤って切れる可能性はあるが、パイプライン全体が
// XML解析エラーで停止するリスクは避けられる。実機で問題が出た場合はここを見直すこと。
//
// 2026-08-29追記: arXiv/Hacker NewsのREST Messageは、検索クエリ・件数を${変数}によるランタイム
// 置換ではなく、エンドポイントURLに直接埋め込んだ静的URLにした(servicenow/scripts/
// setup_rest_messages.mjs参照)。ServiceNowのRESTMessageV2は${varName}をHTTPメソッド側の
// 「Variable」定義に事前登録しないと、置換されずリテラルの"${varName}"のまま送信されて
// エラーも出ずに検索結果が空になる、という既知の落とし穴があり、対話的にServiceNowへ
// ログインして確認する手段がないこのセッションからはそのリスクを取れないと判断したため。
// 検索クエリや件数を変えたい場合は、setup_rest_messages.mjs(またはREST Message自体の
// エンドポイント設定)側を書き換えること。このファイル側にsetStringParameterNoEscapeは
// もう不要(エンドポイントに値が埋め込み済みのため)。
//
// 2026-10-18追記: YouTube Data API v3(category 2/5/10用)を追加した。他19情報源と異なり
// APIキー認証が必須のため、上記の${変数}事前登録の落とし穴に加えて「APIキーをこの
// リポジトリに絶対にコミットしない」という制約(README「情報源」参照)も満たす必要がある。
// このため、エンドポイントにキーを埋め込む(${変数}方式)のではなく、RESTMessageV2の
// setQueryParameter("key", ...)で実行時にクエリパラメータとして付与する設計にした。
// この方式なら(a)${変数}の事前登録が一切不要(b)エンドポイントURL自体にもコミットされる
// コードのどこにもキーの値が現れない、の両方を満たせる。キー自体はServiceNow PDI側の
// システムプロパティ"youtube.api_key"(type: password2、暗号化保存)にのみ保持し、
// servicenow/scripts/setup_youtube_api_key.mjsがGitHub Actions Secrets経由で設定する
// (このリポジトリにコミットされることは無い)。
// 【未検証】setQueryParameterはServiceNow公式ドキュメント上のRESTMessageV2標準メソッドだが、
// このセッションはServiceNow PDIへ対話的にログインする手段が無く実機検証できていない。
// 実際にPDIへ反映後、Scheduled Jobを1回実行してu_ai_research_itemへの挿入結果を確認すること
// (README「動作確認」参照)。もし空振りする場合はsetQueryParameterではなく
// setStringParameterNoEscape+${変数}の事前登録(sys_rest_message_fn側のVariables related list)
// を疑うこと。

(function () {
    "use strict";

    var CATEGORY = {
        ARCHITECTURE: "1", // アプリ作成時に活かせる技術・アーキテクチャ・データ構造・データのやり取り
        AI_TREND: "2",     // 最新のAI技術でできること・今後の技術動向
        COMBINATION: "3",  // 既存技術の組み合わせでできる新しいこと
        USE_CASE: "4",     // AIが使われている分野・使われやすいシチュエーション
        FASHION: "5",      // AIの流行
        NEEDS: "6",        // 2026-09-18追加: 世の中のニーズ・困りごと(ユーザー指示)
        HACKATHON: "7",    // 2026-09-29追加: ハッカソン情報(PTD-065、次のハッカソン準備のための
                            // 案件探し・入賞作品からのアイデア発想が目的。他の観点と違い「今応募
                            // できる案件」という時間依存の性質を持つ)
        SEO_TREND: "8",    // 2026-10-10追加: 世の中の動向(SEO・マーケティング業界の視点から)
        WORK_STYLE: "9",    // 2026-10-10追加: 働き方の動向(最先端/一般的/近未来的)
        TREND_GENERAL: "10" // 2026-10-18追加: 世の中の話題・トレンド(YouTube再生回数ベース、
                            // ジャンル問わず)。manager-roomでのYouTube Data API活用相談から、
                            // 「AIの最新技術」(→2)「AIの流行」(→5)とは別に、ジャンルを問わない
                            // 世の中全般のトレンドを再生回数で捉える観点として新設した。
                            // 【要手動登録】u_ai_research_item.u_category のChoiceリストに
                            // "10"を追加する作業がServiceNow Studio側で別途必要(category 6/7/8/9と
                            // 同様、README「セットアップ手順」参照)。
    };

    // 情報源ごとの既定カテゴリ。5観点は本来どの記事にも当てはまり得る横断的な視点のため、
    // 自動取得の時点では「その情報源が最も関連しやすい観点」を機械的に割り当てるだけに留める
    // (内容を読んで正確に分類するのはこのパイプラインの範囲外。人が後で読み替えてよい)。
    var SOURCE_DEFAULT_CATEGORY = {
        arxiv: CATEGORY.AI_TREND,
        hackernews: CATEGORY.USE_CASE,
        openai: CATEGORY.AI_TREND,
        huggingface: CATEGORY.COMBINATION,
        // 2026-08-30追記(PTD-048拡張): ByteByteGo/InfoQ(AI/ML/Data Eng)/Martin Fowler blogは
        // いずれもソフトウェアアーキテクチャ・システム設計が主題のため観点1(アーキテクチャ)、
        // MarkTechPostはAI研究ニュース中心のため観点2(AI技術動向)、MIT Technology Review AIは
        // 一般向けのAIトレンド報道が中心のため観点5(AIの流行)を割り当てた(いずれも機械的な
        // 既定値であり、正確な分類は人が後で読み替えてよい。README「対象の5観点」参照)。
        mittechreview: CATEGORY.FASHION,
        marktechpost: CATEGORY.AI_TREND,
        bytebytego: CATEGORY.ARCHITECTURE,
        infoq: CATEGORY.ARCHITECTURE,
        martinfowler: CATEGORY.ARCHITECTURE,
        // 2026-08-31追記(PTD-056): Architecture Weeklyもソフトウェアアーキテクチャの
        // キュレーション記事が主題のため観点1(アーキテクチャ)を割り当てた。
        architectureweekly: CATEGORY.ARCHITECTURE,
        // 2026-08-31追記(ユーザー依頼: Gemini追加): Google DeepMind BlogはGeminiモデルの発表を
        // 含むAI研究動向が主題のため、openaiと同じ観点2(AI技術動向)を割り当てた。
        geminideepmind: CATEGORY.AI_TREND,
        // 2026-09-06追記(ユーザー依頼: 取れる情報源は全て取る): claude-codeのリリース情報は
        // 「最新のAI技術でできること」の実例(新機能・改善)が中心のため観点2を割り当てた。
        anthropicreleases: CATEGORY.AI_TREND,
        // 2026-10-10追記: Search Engine Journal/Moz BlogはSEO・マーケティング業界の専門メディアで、
        // 観点8(世の中の動向、SEO視点)として追加した。
        searchenginejournal: CATEGORY.SEO_TREND,
        mozblog: CATEGORY.SEO_TREND,
        // 2026-10-10追記: 働き方に関する調査(観点9)。Fast Company Work Life/Allwork.Spaceは
        // リモートワーク・AI活用等の最先端の働き方を扱う専門メディア、The Guardian(Work & Careers)は
        // 一般的な労働ニュースを扱う主要メディア、Economic Policy Institute(EPI)は労働市場・政策の
        // シンクタンクで近未来的な観点を補う(いずれも機械的な既定値であり、正確な分類は人が後で
        // 読み替えてよい)。
        fastcompanyworklife: CATEGORY.WORK_STYLE,
        allworkspace: CATEGORY.WORK_STYLE,
        guardianwork: CATEGORY.WORK_STYLE,
        epi: CATEGORY.WORK_STYLE
    };

    var stats = { inserted: 0, skipped: 0, errors: [] };

    function normalizeUrl(url) {
        if (!url) return "";
        return url.trim().replace(/\/+$/, "").toLowerCase();
    }

    // 2026-08-29追記: 情報源ごとに日付の形式がバラバラ(arXiv/HN=ISO8601、ブログRSS=RFC822等)
    // なのに対し、ServiceNowのDate/Timeフィールド(u_published_at)へ生の文字列をそのまま
    // 代入すると、形式が合わない場合エラーも出さず黙って空欄になる、という挙動を実機検証
    // (PTD-050)で確認した。標準のJavaScript Dateオブジェクトはこれらの形式をいずれも
    // パースできるため、一旦Dateへ変換してからServiceNowが確実に解釈できる
    // "yyyy-MM-dd HH:mm:ss"(UTC)形式の文字列に変換してから代入する。
    function toGlideDateTimeString(dateStr) {
        if (!dateStr) return "";
        var d = new Date(dateStr);
        if (isNaN(d.getTime())) return "";
        function pad(n) { return (n < 10 ? "0" : "") + n; }
        return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) + " " +
            pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + ":" + pad(d.getUTCSeconds());
    }

    function alreadyExists(dedupKey) {
        var gr = new GlideRecord("u_ai_research_item");
        gr.addQuery("u_dedup_key", dedupKey);
        gr.setLimit(1);
        gr.query();
        return gr.next();
    }

    // 2026-09-29追記: 他の情報源(記事・研究等)は「一度公開されたら内容が変わらない」前提で
    // sourceUrlだけをdedupKeyにしているが、ハッカソン案件は同じURLのまま開催状況(open→ended)や
    // 入賞発表の有無が後から変わる。この変化(特に「入賞発表済みになった」タイミング)を取りこぼさない
    // よう、item.dedupSuffixが指定された場合はdedupKeyにのみ反映する(u_source_urlは常に実URLの
    // ままにし、リンクとして正しく機能させる)。状態が変わるたびに新しい行が追加される設計のため、
    // 同じハッカソンが複数行に渡って残る(古い状態のスナップショットとして、傾向データの一部になる)。
    function insertItem(item) {
        var dedupKey = (normalizeUrl(item.sourceUrl) + (item.dedupSuffix || "")).substring(0, 255);
        if (!dedupKey) {
            stats.skipped++;
            return;
        }
        if (alreadyExists(dedupKey)) {
            stats.skipped++;
            return;
        }
        var gr = new GlideRecord("u_ai_research_item");
        gr.initialize();
        gr.u_category = item.category;
        gr.u_title = (item.title || "").substring(0, 200);
        gr.u_summary = (item.summary || "").substring(0, 4000);
        gr.u_source_url = (item.sourceUrl || "").substring(0, 1024);
        gr.u_source_name = item.sourceName || "";
        var publishedAtGdt = toGlideDateTimeString(item.publishedAt);
        if (publishedAtGdt) gr.u_published_at = publishedAtGdt;
        gr.u_fetched_at = new GlideDateTime();
        gr.u_dedup_key = dedupKey;
        gr.insert();
        stats.inserted++;
    }

    // ---- 汎用の正規表現ベース抽出ヘルパー ----
    // 2026-09-06追記: GitHub ReleasesのAtomフィードは<content type="html">タグの中身がHTMLエンティティで
    // エスケープされている(例: "&lt;h2&gt;What's changed&lt;/h2&gt;")。エンティティをデコードしてから
    // タグを除去しないと、"&lt;h2&gt;"のような文字列がそのまま残ってしまうため、デコードを先に行う。
    function decodeEntities(s) {
        return (s || "")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&amp;/g, "&");
    }

    function stripTags(s) {
        return decodeEntities(s || "").replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "").replace(/<[^>]+>/g, "").trim();
    }

    function extractTag(block, tagName) {
        var re = new RegExp("<" + tagName + "[^>]*>([\\s\\S]*?)<\\/" + tagName + ">", "i");
        var m = re.exec(block);
        return m ? stripTags(m[1]) : "";
    }

    // 2026-09-06追記: www.anthropic.com/news専用。CSS Modulesのクラス名は
    // "<接頭辞>-module-scss-module__<ビルド固有ハッシュ>__<意味を表す名前>"という形式で、ハッシュ部分は
    // ビルド(サイト再デプロイ)のたびに変わりうる。ハッシュを推測せず、接頭辞と意味のある末尾だけに
    // マッチさせることで、多少の再デプロイには耐えられるようにしている(ただしクラス構造自体が変わる
    // ような大規模なサイト再設計には耐えられない。README「既知の制約」参照)。
    function extractTagByClassSuffix(block, tagName, classPrefix, classSuffix) {
        var re = new RegExp(
            "<" + tagName + "[^>]*class=\"" + classPrefix + "[^\"]*" + classSuffix + "[^\"]*\"[^>]*>([\\s\\S]*?)<\\/" + tagName + ">",
            "i"
        );
        var m = re.exec(block);
        return m ? stripTags(m[1]) : "";
    }

    // Atom形式は<link href="..." rel="alternate"/>のように自己終端タグの属性でURLを持つ
    // (RSS 2.0の<link>テキスト</link>とは異なる)。fetchBlogRssのリンク抽出フォールバック用。
    function extractAttr(block, tagName, attrName) {
        var re = new RegExp("<" + tagName + "[^>]*\\s" + attrName + "=[\"']([^\"']*)[\"'][^>]*\\/?>", "i");
        var m = re.exec(block);
        return m ? m[1] : "";
    }

    function splitBlocks(xml, tagName) {
        var re = new RegExp("<" + tagName + "[^>]*>[\\s\\S]*?<\\/" + tagName + ">", "gi");
        return xml.match(re) || [];
    }

    // ---- arXiv (Atom XML) ----
    function fetchArxiv() {
        try {
            var r = new sn_ws.RESTMessageV2("AI Research - arXiv", "search");
            var response = r.execute();
            if (response.getStatusCode() !== 200) {
                stats.errors.push("arXiv: HTTP " + response.getStatusCode());
                return;
            }
            var body = response.getBody();
            var entries = splitBlocks(body, "entry");
            entries.forEach(function (entry) {
                // Atom既定名前空間下のidタグはURL(例: http://arxiv.org/abs/xxxx)
                var idUrl = extractTag(entry, "id");
                insertItem({
                    category: SOURCE_DEFAULT_CATEGORY.arxiv,
                    title: extractTag(entry, "title").replace(/\s+/g, " "),
                    summary: extractTag(entry, "summary").replace(/\s+/g, " "),
                    sourceUrl: idUrl,
                    sourceName: "arXiv",
                    publishedAt: extractTag(entry, "published")
                });
            });
        } catch (e) {
            stats.errors.push("arXiv: " + e);
        }
    }

    // ---- Hacker News (Algolia JSON API) ----
    function fetchHackerNews() {
        try {
            var r = new sn_ws.RESTMessageV2("AI Research - Hacker News", "search");
            var response = r.execute();
            if (response.getStatusCode() !== 200) {
                stats.errors.push("Hacker News: HTTP " + response.getStatusCode());
                return;
            }
            var data = JSON.parse(response.getBody());
            (data.hits || []).forEach(function (hit) {
                var url = hit.url || ("https://news.ycombinator.com/item?id=" + hit.objectID);
                insertItem({
                    category: SOURCE_DEFAULT_CATEGORY.hackernews,
                    title: hit.title || hit.story_title || "",
                    summary: "",
                    sourceUrl: url,
                    sourceName: "Hacker News",
                    publishedAt: hit.created_at || ""
                });
            });
        } catch (e) {
            stats.errors.push("Hacker News: " + e);
        }
    }

    // ---- Hacker News "Ask HN"(世の中のニーズ・困りごと、category 6) ----
    // 2026-09-18追加、ユーザー指示「世の中のニーズと、常にAIで何ができるかを蓄積してほしい」。
    // Ask HN投稿は「〇〇で困っている」「△△のやり方」等、生のニーズ・悩みが書かれることが
    // 多いため採用した。通常のstoryと違い、投稿本文がstory_textフィールドに入っている
    // (HTML形式)ため、decodeEntities+stripTagsでプレーンテキスト化してsummaryに使う。
    function fetchAskHN() {
        try {
            var r = new sn_ws.RESTMessageV2("AI Research - Hacker News", "askhn");
            var response = r.execute();
            if (response.getStatusCode() !== 200) {
                stats.errors.push("Hacker News (Ask HN): HTTP " + response.getStatusCode());
                return;
            }
            var data = JSON.parse(response.getBody());
            (data.hits || []).forEach(function (hit) {
                var url = hit.url || ("https://news.ycombinator.com/item?id=" + hit.objectID);
                insertItem({
                    category: CATEGORY.NEEDS,
                    title: hit.title || "",
                    summary: stripTags(decodeEntities(hit.story_text || "")),
                    sourceUrl: url,
                    sourceName: "Hacker News (Ask HN)",
                    publishedAt: hit.created_at || ""
                });
            });
        } catch (e) {
            stats.errors.push("Hacker News (Ask HN): " + e);
        }
    }

    // ---- ブログRSS(Anthropic / OpenAI / Hugging Face、いずれもRSS 2.0想定) ----
    function fetchBlogRss(httpMethodName, sourceKey, sourceName) {
        try {
            var r = new sn_ws.RESTMessageV2("AI Research - Blog RSS", httpMethodName);
            var response = r.execute();
            if (response.getStatusCode() !== 200) {
                stats.errors.push(sourceName + ": HTTP " + response.getStatusCode());
                return;
            }
            var body = response.getBody();
            var items = splitBlocks(body, "item");
            // Atom形式のブログの場合(RSS 2.0でなければitemが取れない)は<entry>も試す
            if (items.length === 0) items = splitBlocks(body, "entry");
            items.forEach(function (block) {
                // RSS 2.0(<link>テキスト</link>) → Atom(<link href="..."/>属性) → <guid> の順に試す
                var link = extractTag(block, "link") || extractAttr(block, "link", "href") || extractTag(block, "guid");
                // 2026-09-06追記: GitHub ReleasesのAtomフィードは<description>/<summary>を持たず、
                // 本文は<content type="html">に入っている。また日付は<pubDate>/<published>ではなく
                // <updated>のみを持つ(Atomの必須要素)。既存の他情報源(RSS 2.0中心)を壊さないよう、
                // フォールバックの末尾に追加する形にした。
                insertItem({
                    category: SOURCE_DEFAULT_CATEGORY[sourceKey],
                    title: extractTag(block, "title"),
                    summary: extractTag(block, "description") || extractTag(block, "summary") || extractTag(block, "content"),
                    sourceUrl: link,
                    sourceName: sourceName,
                    publishedAt: extractTag(block, "pubDate") || extractTag(block, "published") || extractTag(block, "updated")
                });
            });
        } catch (e) {
            stats.errors.push(sourceName + ": " + e);
        }
    }

    // ---- Anthropic News (www.anthropic.com/news、RSSではなく生HTML) ----
    // 2026-09-06追記(ユーザー依頼: 取れる情報源は全て取る): Anthropicは公式ブログRSSを提供していない
    // (README「情報源」参照)が、このページ自体は(懸念していたクライアントサイドレンダリングではなく)
    // サーバーサイドで記事一覧を含んだHTMLを返すことを、GitHub Actions実地検証
    // (tmp_inspect_anthropic_news.mjs、実際の生HTML)で確認した。ページ内には「Featured」領域(トップの
    // 注目記事、ネストが深く抽出しづらい)と「PublicationList」領域(時系列の全記事一覧、構造がシンプル)
    // の2種類のリストがあるが、後者だけで全記事を時系列に網羅できるため、後者のみを対象にする。
    function fetchAnthropicNewsHtml() {
        try {
            var r = new sn_ws.RESTMessageV2("AI Research - Blog RSS", "anthropicnews");
            var response = r.execute();
            if (response.getStatusCode() !== 200) {
                stats.errors.push("Anthropic News: HTTP " + response.getStatusCode());
                return;
            }
            var body = response.getBody();
            // <li><a href="/news/xxx" class="PublicationList-module-scss-module__<hash>__listItem">...</a></li>
            // ハッシュ部分(例: KxYrHG)はビルドのたびに変わりうるため、\w+で許容する。
            var itemRe = /<li>\s*<a href="(\/news\/[^"]+)"[^>]*class="PublicationList-module-scss-module__\w+__listItem"[^>]*>([\s\S]*?)<\/a>\s*<\/li>/g;
            var m;
            var found = 0;
            while ((m = itemRe.exec(body)) !== null) {
                var href = m[1];
                var block = m[2];
                var dateText = extractTagByClassSuffix(block, "time", "PublicationList-module-scss-module__", "__date");
                var subject = extractTagByClassSuffix(block, "span", "PublicationList-module-scss-module__", "__subject");
                var title = extractTagByClassSuffix(block, "span", "PublicationList-module-scss-module__", "__title");
                if (!title) continue; // タイトルが取れない=想定した構造ではない(サイト側の変更の可能性)ため安全にスキップ
                insertItem({
                    category: CATEGORY.AI_TREND,
                    title: title,
                    summary: subject ? ("(" + subject + ") Anthropic公式ニュース") : "Anthropic公式ニュース",
                    sourceUrl: "https://www.anthropic.com" + href,
                    sourceName: "Anthropic News",
                    publishedAt: dateText
                });
                found++;
            }
            if (found === 0) {
                // 想定した構造の記事が1件も取れなかった=サイトのHTML構造が変わった可能性が高い。
                // 静かに0件のまま終わらせず、エラーとして記録して気づけるようにする。
                stats.errors.push("Anthropic News: 想定した構造(PublicationList)の記事が0件。サイトのHTML構造が変わった可能性(README「既知の制約」参照)");
            }
        } catch (e) {
            stats.errors.push("Anthropic News: " + e);
        }
    }

    // ---- Devpost ハッカソン一覧(category 7) ----
    // 2026-09-29追加(PTD-065、ユーザー指示「次のハッカソン準備」): https://devpost.com/api/hackathons
    // はDevpost公式サイト自身が使っている認証不要のJSON API(実機検証済み: ユーザーがブラウザで
    // 直接アクセスし、有効なJSON応答を確認)。全ジャンル約14,000件の中からAI関連テーマ
    // ("Machine Learning/AI"等)のものだけを抽出する。
    //
    // 入賞作品の中身(プロジェクトの詳細・技術スタック)は、このAPIには含まれず、Devpost自体にも
    // 個別ハッカソンのプロジェクトギャラリー用の公開JSON APIが存在しない(実機検証で
    // "<hackathon-slug>.devpost.com/project-gallery.json" もエラーになることを確認済み)。
    // 正規表現でHTMLを解析するのではなく、servicenow-sub-agentのresearch-item-curationスキルと
    // 同じ考え方で、入賞発表済み(winners_announced: true)のハッカソンについてはAI自身が
    // submission_gallery_urlを直接読んで要約を書く方式にする(hackathon-winner-curationスキル、
    // SKILL.md参照)。このscheduled jobの役割は、あくまで機械的な一覧収集とsubmission_gallery_url
    // の保存までにとどめる。
    function fetchDevpostHackathons() {
        try {
            var r = new sn_ws.RESTMessageV2("AI Research - Devpost", "hackathons");
            var response = r.execute();
            if (response.getStatusCode() !== 200) {
                stats.errors.push("Devpost: HTTP " + response.getStatusCode());
                return;
            }
            var data = JSON.parse(response.getBody());
            (data.hackathons || []).forEach(function (h) {
                var themeNames = (h.themes || []).map(function (t) { return t.name || ""; });
                var isAiThemed = themeNames.some(function (name) {
                    return /machine learning|artificial intelligence|\bai\b/i.test(name);
                });
                if (!isAiThemed) return; // AI関連テーマのみ対象(全ジャンルのノイズを避ける)

                var winnersAnnounced = !!h.winners_announced;
                var openState = h.open_state || "unknown";
                // 状態が変わるたびに新しい行として残す(このdedupSuffixが無いと、最初に"open"で
                // 見つけた時点でdedupされ、後で"ended"になっても入賞発表になっても二度と拾えない)。
                var dedupSuffix = "#" + openState + (winnersAnnounced ? "-winners" : "");

                var prizeAmount = stripTags(h.prize_amount || "");
                var summaryParts = [
                    "開催状況: " + openState + (winnersAnnounced ? "(入賞発表済み)" : ""),
                    "テーマ: " + themeNames.join("・"),
                    "賞金: " + prizeAmount,
                    "応募期間: " + (h.submission_period_dates || ""),
                    "登録者数: " + (h.registrations_count != null ? String(h.registrations_count) : "不明"),
                    "主催: " + (h.organization_name || "")
                ];
                if (winnersAnnounced && h.submission_gallery_url) {
                    // hackathon-winner-curationスキルが、このURLを目印に対象アイテムを探す。
                    summaryParts.push("プロジェクトギャラリー: " + h.submission_gallery_url);
                }

                insertItem({
                    category: CATEGORY.HACKATHON,
                    title: h.title || "",
                    summary: summaryParts.filter(function (s) { return !!s; }).join(" / "),
                    sourceUrl: h.url || "",
                    sourceName: "Devpost",
                    publishedAt: "", // Devpost APIに公開日相当のフィールドが無いため空(u_fetched_atのみ)
                    dedupSuffix: dedupSuffix
                });
            });
        } catch (e) {
            stats.errors.push("Devpost: " + e);
        }
    }

    // 2026-10-18追記・実機検証で判明した修正: 当初RESTMessageV2.setQueryParameter("key", apiKey)で
    // 実行時にキーを付与する設計にしていたが、実機確認(check_fetch_log.mjs経由でsyslogを確認)した
    // ところ、4メソッド全てでGoogle側から「Method doesn't allow unregistered callers...Please use
    // API Key」という、キーが一切渡っていないことを示すHTTP 403が返っていることが判明した。
    // システムプロパティ自体は正しく読めていた(未設定スキップのメッセージではなく実際にリクエストが
    // 送信されていた)ため、原因はsetQueryParameterがこのPDIのバージョンでは期待通り機能しなかった
    // ことだと判断した。より確実な RESTMessageV2.setEndpoint() (エンドポイントURL自体を実行時に
    // 丸ごと上書きする、公式ドキュメントに長く記載されている標準メソッド)で、setup_rest_messages.mjs
    // 側のエンドポイント(キー無し)と同じベースURLに"&key=..."を実行時に追加する方式へ変更した。
    // ベースURLはsetup_rest_messages.mjsのREST_MESSAGES定義と必ず一致させること(値を変える場合は
    // 両方のファイルを同じ値に揃える、arXiv/Hacker Newsの静的URLと同じ注意点)。
    var YOUTUBE_ENDPOINTS = {
        aitech: "https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=date&maxResults=10&q=" +
            encodeURIComponent('AI OR "人工知能" OR "機械学習" OR Claude OR "生成AI"'),
        // 2026-10-19改善(PTD-090): 単体の"AI"(bareのOR項、2文字)を削除した。再生回数順
        // (order=viewCount)×全期間が対象の検索と組み合わさると、"Ai, Amor"(ポルトガル語の
        // 歌、無関係)やMrBeast動画(タグの偶然一致)等の無関係な動画が再生回数の多さだけで
        // 上位に来てしまうノイズの原因になっていたため(YouTube調査結果を確認したユーザーとの
        // 相談で判明)。"artificial intelligence"という具体的な英語フレーズに置き換えた。
        // 2026-10-21追記: 改善A適用後の実データで、クエリに残っている bare の "Claude" が
        // AIのClaudeだけでなく俳優名"Jean-Claude Van Damme"にも誤マッチしていることが
        // 判明した(実例: "Jean-Claude Van Damme Finds the Rhythm"、"Hard Target (1993) |
        // Jean-Claude Van Damme vs. The Hunters" の2件)。YouTube Data API のq引数は
        // Boolean NOT(-)演算子をサポートするため、-"Jean-Claude"を追加して除外した。
        // なお "#mobilelegends #claude"(ゲームのハッシュタグ)・アニメクリップ等への誤マッチは
        // クエリ側での一般化した除外が難しいため、research-item-curationスキルによる収集後の
        // AI判断(改善B)側で引き続き弾く方針とした(クエリ改善だけでは完全にはゼロにできない
        // ことを実データで確認済み、CL-044参照)。
        // setup_rest_messages.mjsのaitrend定義とq部分は必ず一致させること(publishedAfterは
        // 実行時刻依存のためそちら側の静的定義には含めない、下記fetchYouTubeSearch参照)。
        aitrend: "https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=viewCount&maxResults=10&q=" +
            encodeURIComponent('"artificial intelligence" OR "人工知能" OR "機械学習" OR Claude OR "生成AI" -"Jean-Claude"'),
        trendjp: "https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&chart=mostPopular&regionCode=JP&maxResults=10",
        trendworld: "https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&chart=mostPopular&regionCode=US&maxResults=10"
    };

    // 2026-10-19追加(PTD-090改善A): order=viewCountは全期間が対象のため、話題になって
    // からずっと再生数が多い古い動画ばかり拾ってしまう(「今の流行」から外れる)。
    // publishedAfter(RFC3339形式、UTC)を直近N日に絞ることで「直近の流行」に近づける。
    // GlideDateTime.getValue()はUTCで"yyyy-MM-dd HH:mm:ss"形式を返すため、TとZに置換する。
    function getPublishedAfterIso(days) {
        var gdt = new GlideDateTime();
        gdt.addDaysUTC(-days);
        return gdt.getValue().replace(" ", "T") + "Z";
    }

    // ---- YouTube Data API v3(category 2/5/10、唯一APIキー認証が必要) ----
    // 2026-10-18追加。manager-roomでの相談(「AIの最新技術」+「世の中のトレンドとして再生回数が
    // 多いキーワード」を知りたい、日本・世界両方)への対応。数値を人間が読みやすい桁区切りに
    // する簡易ヘルパー(ServiceNowのRhino/ES5エンジンはNumber.toLocaleString("ja-JP")の
    // ロケール引数を確実にサポートしない可能性があるため、自前で実装する)。
    function formatNumber(n) {
        var s = String(n);
        var sign = "";
        if (s.charAt(0) === "-") { sign = "-"; s = s.substring(1); }
        var out = "";
        for (var i = 0; i < s.length; i++) {
            if (i > 0 && (s.length - i) % 3 === 0) out += ",";
            out += s.charAt(i);
        }
        return sign + out;
    }

    // search.list系(キーワード検索)。"aitech"(category 2、新着順)・"aitrend"(category 5、
    // 再生回数順)の両方で共用する。search.listのレスポンスには統計情報(再生回数等)は
    // 含まれないため、summaryには概要欄とチャンネル名のみを使う。
    function fetchYouTubeSearch(httpMethodName, category, sourceLabel, recentDays) {
        try {
            var apiKey = gs.getProperty("youtube.api_key", "");
            if (!apiKey) {
                stats.errors.push(sourceLabel + ": システムプロパティ youtube.api_key が未設定のためスキップ");
                return;
            }
            var endpoint = YOUTUBE_ENDPOINTS[httpMethodName] + "&key=" + encodeURIComponent(apiKey);
            if (recentDays) {
                endpoint += "&publishedAfter=" + encodeURIComponent(getPublishedAfterIso(recentDays));
            }
            var r = new sn_ws.RESTMessageV2("AI Research - YouTube", httpMethodName);
            r.setEndpoint(endpoint);
            var response = r.execute();
            if (response.getStatusCode() !== 200) {
                stats.errors.push(sourceLabel + ": HTTP " + response.getStatusCode() + " " + response.getBody());
                return;
            }
            var data = JSON.parse(response.getBody());
            (data.items || []).forEach(function (it) {
                var videoId = it.id && it.id.videoId;
                if (!videoId) return;
                var snippet = it.snippet || {};
                var summaryParts = [];
                if (snippet.description) summaryParts.push(stripTags(snippet.description).substring(0, 300));
                if (snippet.channelTitle) summaryParts.push("チャンネル: " + snippet.channelTitle);
                insertItem({
                    category: category,
                    title: snippet.title || "",
                    summary: summaryParts.join(" / "),
                    sourceUrl: "https://www.youtube.com/watch?v=" + videoId,
                    sourceName: sourceLabel,
                    publishedAt: snippet.publishedAt || ""
                });
            });
        } catch (e) {
            stats.errors.push(sourceLabel + ": " + e);
        }
    }

    // videos.list?chart=mostPopular(地域別トレンド動画一覧、category 10)。こちらは統計情報
    // (再生回数)を直接含むレスポンスのため、summaryに再生回数を含められる。
    function fetchYouTubeTrending(httpMethodName, sourceLabel) {
        try {
            var apiKey = gs.getProperty("youtube.api_key", "");
            if (!apiKey) {
                stats.errors.push(sourceLabel + ": システムプロパティ youtube.api_key が未設定のためスキップ");
                return;
            }
            var r = new sn_ws.RESTMessageV2("AI Research - YouTube", httpMethodName);
            r.setEndpoint(YOUTUBE_ENDPOINTS[httpMethodName] + "&key=" + encodeURIComponent(apiKey));
            var response = r.execute();
            if (response.getStatusCode() !== 200) {
                stats.errors.push(sourceLabel + ": HTTP " + response.getStatusCode() + " " + response.getBody());
                return;
            }
            var data = JSON.parse(response.getBody());
            (data.items || []).forEach(function (it) {
                var videoId = it.id;
                if (!videoId) return;
                var snippet = it.snippet || {};
                var statistics = it.statistics || {};
                var summaryParts = [];
                if (statistics.viewCount) summaryParts.push("再生回数: " + formatNumber(statistics.viewCount));
                if (snippet.channelTitle) summaryParts.push("チャンネル: " + snippet.channelTitle);
                insertItem({
                    category: CATEGORY.TREND_GENERAL,
                    title: snippet.title || "",
                    summary: summaryParts.join(" / "),
                    sourceUrl: "https://www.youtube.com/watch?v=" + videoId,
                    sourceName: sourceLabel,
                    publishedAt: snippet.publishedAt || ""
                });
            });
        } catch (e) {
            stats.errors.push(sourceLabel + ": " + e);
        }
    }

    // ---- 実行 ----
    fetchArxiv();
    fetchHackerNews();
    fetchAskHN();
    fetchBlogRss("openai", "openai", "OpenAI Blog");
    fetchBlogRss("huggingface", "huggingface", "Hugging Face Blog");
    fetchBlogRss("mittechreview", "mittechreview", "MIT Technology Review AI");
    fetchBlogRss("marktechpost", "marktechpost", "MarkTechPost");
    fetchBlogRss("bytebytego", "bytebytego", "ByteByteGo");
    fetchBlogRss("infoq", "infoq", "InfoQ (AI/ML/Data Eng)");
    fetchBlogRss("martinfowler", "martinfowler", "Martin Fowler blog");
    fetchBlogRss("architectureweekly", "architectureweekly", "Architecture Weekly");
    fetchBlogRss("geminideepmind", "geminideepmind", "Google DeepMind Blog (Gemini)");
    fetchBlogRss("anthropicreleases", "anthropicreleases", "Anthropic (claude-code releases via GitHub)");
    fetchAnthropicNewsHtml();
    fetchDevpostHackathons();
    fetchBlogRss("searchenginejournal", "searchenginejournal", "Search Engine Journal");
    fetchBlogRss("mozblog", "mozblog", "Moz Blog");
    fetchBlogRss("fastcompanyworklife", "fastcompanyworklife", "Fast Company (Work Life)");
    fetchBlogRss("allworkspace", "allworkspace", "Allwork.Space");
    fetchBlogRss("guardianwork", "guardianwork", "The Guardian (Work & Careers)");
    fetchBlogRss("epi", "epi", "Economic Policy Institute");
    fetchYouTubeSearch("aitech", CATEGORY.AI_TREND, "YouTube (AI最新技術)");
    fetchYouTubeSearch("aitrend", CATEGORY.FASHION, "YouTube (AI流行・再生回数順)", 30);
    fetchYouTubeTrending("trendjp", "YouTube (急上昇・日本)");
    fetchYouTubeTrending("trendworld", "YouTube (急上昇・世界)");

    gs.info(
        "[AIResearchFetcher] inserted=" + stats.inserted +
        " skipped(duplicate/empty)=" + stats.skipped +
        " errors=" + JSON.stringify(stats.errors)
    );
    if (stats.errors.length > 0) {
        gs.error("[AIResearchFetcher] " + stats.errors.length + "件のエラー: " + JSON.stringify(stats.errors));
    }
})();
