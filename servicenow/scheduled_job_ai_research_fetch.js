// AI Research Fetcher — ServiceNow Scheduled Job
//
// このファイルはGitHubとは自動連携していない。ServiceNow PDI(dev395932.service-now.com)の
// 「System Definition > Scheduled Jobs」で「Automatically run a script of your choosing」を
// 選び、このファイルの内容をそのまま貼り付けて保存する必要がある(コード変更のたびに
// 再貼り付けが必要。gas/Code.gsと同じ制約。詳細はprogress-tracker-dashboardのREADME参照)。
//
// 前提: 下記3つのREST Message(認証不要・GET専用)がSystem Web Servicesに作成済みであること。
// 詳細な設定値はこのリポジトリのREADME.md「セットアップ手順」を参照。
//   - "AI Research - arXiv"        HTTPメソッド "search"
//   - "AI Research - Hacker News"  HTTPメソッド "search"
//   - "AI Research - Blog RSS"     HTTPメソッド "openai" / "huggingface" / "mittechreview" /
//                                   "marktechpost" / "bytebytego" / "infoq" / "martinfowler" /
//                                   "architectureweekly"
// また u_ai_research_item テーブル(フィールド定義はREADME参照)が作成済みであること。
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

(function () {
    "use strict";

    var CATEGORY = {
        ARCHITECTURE: "1", // アプリ作成時に活かせる技術・アーキテクチャ・データ構造・データのやり取り
        AI_TREND: "2",     // 最新のAI技術でできること・今後の技術動向
        COMBINATION: "3",  // 既存技術の組み合わせでできる新しいこと
        USE_CASE: "4",     // AIが使われている分野・使われやすいシチュエーション
        FASHION: "5"       // AIの流行
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
        architectureweekly: CATEGORY.ARCHITECTURE
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

    function insertItem(item) {
        var dedupKey = normalizeUrl(item.sourceUrl).substring(0, 255);
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
    function stripTags(s) {
        return (s || "").replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "").replace(/<[^>]+>/g, "").trim();
    }

    function extractTag(block, tagName) {
        var re = new RegExp("<" + tagName + "[^>]*>([\\s\\S]*?)<\\/" + tagName + ">", "i");
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
                insertItem({
                    category: SOURCE_DEFAULT_CATEGORY[sourceKey],
                    title: extractTag(block, "title"),
                    summary: extractTag(block, "description") || extractTag(block, "summary"),
                    sourceUrl: link,
                    sourceName: sourceName,
                    publishedAt: extractTag(block, "pubDate") || extractTag(block, "published")
                });
            });
        } catch (e) {
            stats.errors.push(sourceName + ": " + e);
        }
    }

    // ---- 実行 ----
    fetchArxiv();
    fetchHackerNews();
    fetchBlogRss("openai", "openai", "OpenAI Blog");
    fetchBlogRss("huggingface", "huggingface", "Hugging Face Blog");
    fetchBlogRss("mittechreview", "mittechreview", "MIT Technology Review AI");
    fetchBlogRss("marktechpost", "marktechpost", "MarkTechPost");
    fetchBlogRss("bytebytego", "bytebytego", "ByteByteGo");
    fetchBlogRss("infoq", "infoq", "InfoQ (AI/ML/Data Eng)");
    fetchBlogRss("martinfowler", "martinfowler", "Martin Fowler blog");
    fetchBlogRss("architectureweekly", "architectureweekly", "Architecture Weekly");

    gs.info(
        "[AIResearchFetcher] inserted=" + stats.inserted +
        " skipped(duplicate/empty)=" + stats.skipped +
        " errors=" + JSON.stringify(stats.errors)
    );
    if (stats.errors.length > 0) {
        gs.error("[AIResearchFetcher] " + stats.errors.length + "件のエラー: " + JSON.stringify(stats.errors));
    }
})();
