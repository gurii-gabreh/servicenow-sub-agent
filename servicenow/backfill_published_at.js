// 1回限りのバックフィル用スクリプト(System Definition > Scripts - Backgroundで実行)。
//
// scheduled_job_ai_research_fetch.jsのu_published_at代入処理に、日付形式の不一致で
// 黙って空欄になるバグがあった(2026-08-29発見・修正)。修正後の新規取得分は正しく
// 日付が入るが、修正前に既に取り込み済みの既存レコード(u_published_atが空欄のまま)は
// 遡って直らないため、このスクリプトで1回だけ実行して埋める。
//
// 処理内容: scheduled_job_ai_research_fetch.jsと同じ4つの情報源(arXiv/Hacker News/
// OpenAI Blog/Hugging Face Blog)を再取得し、u_dedup_keyが一致する既存レコードのうち
// u_published_atが空のものだけを更新する(新規insertは一切行わない)。
// 実行後は用済みになるので削除してよい。

(function () {
    "use strict";

    function normalizeUrl(url) {
        if (!url) return "";
        return url.trim().replace(/\/+$/, "").toLowerCase();
    }

    function toGlideDateTimeString(dateStr) {
        if (!dateStr) return "";
        var d = new Date(dateStr);
        if (isNaN(d.getTime())) return "";
        function pad(n) { return (n < 10 ? "0" : "") + n; }
        return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) + " " +
            pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + ":" + pad(d.getUTCSeconds());
    }

    function stripTags(s) {
        return (s || "").replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "").replace(/<[^>]+>/g, "").trim();
    }

    function extractTag(block, tagName) {
        var re = new RegExp("<" + tagName + "[^>]*>([\\s\\S]*?)<\\/" + tagName + ">", "i");
        var m = re.exec(block);
        return m ? stripTags(m[1]) : "";
    }

    function splitBlocks(xml, tagName) {
        var re = new RegExp("<" + tagName + "[^>]*>[\\s\\S]*?<\\/" + tagName + ">", "gi");
        return xml.match(re) || [];
    }

    var stats = { updated: 0, alreadyHadDate: 0, noMatch: 0, noPublishedAt: 0, errors: [] };

    function backfillOne(sourceUrl, publishedAt) {
        var dedupKey = normalizeUrl(sourceUrl).substring(0, 255);
        if (!dedupKey) return;
        var gdtStr = toGlideDateTimeString(publishedAt);
        if (!gdtStr) {
            stats.noPublishedAt++;
            return;
        }
        var gr = new GlideRecord("u_ai_research_item");
        gr.addQuery("u_dedup_key", dedupKey);
        gr.setLimit(1);
        gr.query();
        if (!gr.next()) {
            stats.noMatch++;
            return;
        }
        if (gr.u_published_at && gr.u_published_at.toString()) {
            stats.alreadyHadDate++;
            return;
        }
        gr.u_published_at = gdtStr;
        gr.update();
        stats.updated++;
    }

    // ---- arXiv ----
    try {
        var rArxiv = new sn_ws.RESTMessageV2("AI Research - arXiv", "search");
        var respArxiv = rArxiv.execute();
        if (respArxiv.getStatusCode() === 200) {
            splitBlocks(respArxiv.getBody(), "entry").forEach(function (entry) {
                backfillOne(extractTag(entry, "id"), extractTag(entry, "published"));
            });
        } else {
            stats.errors.push("arXiv: HTTP " + respArxiv.getStatusCode());
        }
    } catch (e) {
        stats.errors.push("arXiv: " + e);
    }

    // ---- Hacker News ----
    try {
        var rHn = new sn_ws.RESTMessageV2("AI Research - Hacker News", "search");
        var respHn = rHn.execute();
        if (respHn.getStatusCode() === 200) {
            var dataHn = JSON.parse(respHn.getBody());
            (dataHn.hits || []).forEach(function (hit) {
                var url = hit.url || ("https://news.ycombinator.com/item?id=" + hit.objectID);
                backfillOne(url, hit.created_at || "");
            });
        } else {
            stats.errors.push("Hacker News: HTTP " + respHn.getStatusCode());
        }
    } catch (e) {
        stats.errors.push("Hacker News: " + e);
    }

    // ---- ブログRSS(openai / huggingface) ----
    [
        { method: "openai", name: "OpenAI Blog" },
        { method: "huggingface", name: "Hugging Face Blog" }
    ].forEach(function (blog) {
        try {
            var r = new sn_ws.RESTMessageV2("AI Research - Blog RSS", blog.method);
            var response = r.execute();
            if (response.getStatusCode() !== 200) {
                stats.errors.push(blog.name + ": HTTP " + response.getStatusCode());
                return;
            }
            var body = response.getBody();
            var items = splitBlocks(body, "item");
            if (items.length === 0) items = splitBlocks(body, "entry");
            items.forEach(function (block) {
                var link = extractTag(block, "link") || extractTag(block, "guid");
                backfillOne(link, extractTag(block, "pubDate") || extractTag(block, "published"));
            });
        } catch (e) {
            stats.errors.push(blog.name + ": " + e);
        }
    });

    gs.info(
        "[BackfillPublishedAt] updated=" + stats.updated +
        " alreadyHadDate=" + stats.alreadyHadDate +
        " noMatch(既存レコード無し)=" + stats.noMatch +
        " noPublishedAt(日付取得不可)=" + stats.noPublishedAt +
        " errors=" + JSON.stringify(stats.errors)
    );
})();
