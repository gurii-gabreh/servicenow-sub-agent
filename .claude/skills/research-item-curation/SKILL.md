---
name: research-item-curation
description: Curate raw items in servicenow-sub-agent's data/research-items.json by writing real Japanese analysis (summaryJa, pointsJa, applicableTechJa) for high-value uncurated items, so the viewer site can eventually show only picked/analyzed content instead of the full raw feed. Use this whenever the user asks to "ピックアップ", "キュレーション", "厳選", or increase the curated count in servicenow-sub-agent, or asks for a trend/technology/hackathon-material report drawn from research-items.json.
---

# Curating research-items.json

## Why this exists

`servicenow-sub-agent`'s ServiceNow pipeline collects ~2500 raw AI-news items (title, English summary, source, category 1-5, a keyword-heuristic `score`) with zero human/AI judgment applied — see `data/research-items.json`. As of 2026-09-06 only a small fraction (29/2481) carry real analysis (`curated: true` + `summaryJa`/`pointsJa`/`applicableTechJa`). The user wants the eventual viewer site to show only this curated subset instead of the raw firehose (PTD-062-style plan: grow curated count first, then flip the site) — this skill is the "grow curated count" half.

## Steps

1. **Pick candidates, don't curate blindly.** Load `data/research-items.json`, filter to `curated != true`, and rank by `score` desc (the field already reflects keyword relevance to this project's recurring interests — agent/architecture/MCP/RAG/security/free-tier). Prefer recent items (last 30-60 days) unless the user asked for a specific older topic. A batch of 5-15 items per pass is reasonable — this is real reading and judgment, not a mechanical bulk operation.

2. **Read each item's `rawSummary` (HTML-entity-escaped) and `sourceUrl`.** Write genuine Japanese analysis, not a translation:
   - `summaryJa`: 1-3 sentences, what it actually is/does
   - `pointsJa`: 1-3 bullet points — what's notable or reusable about it, specifically
   - `applicableTechJa`: how it connects to *this* project family (progress-tracker-dashboard, servicenow-sub-agent, the "永久無料" constraint, an existing task like PTD-061's embedding search) — skip this field's specificity rather than force a fake connection when there isn't one.

3. **Set `curated: true` and bump `score` by 1** (matches `lib/score_items.mjs`'s own `if (item.curated) score += 1` convention, so re-running `sync_recompute_scores.mjs`/`recompute_scores.mjs` later stays consistent).

4. **Write via a Python script, not by hand-editing JSON in an editor** — this file is large (~1.7MB); load it, mutate only the target `sysId` entries, dump with `ensure_ascii=False, indent=2`, keep a trailing newline. Never touch entries outside your target set (existing curated entries must survive untouched — `export_research_items.mjs` itself already promises this on the ServiceNow-sync side, and this skill must keep the same promise on the human-curation side).

5. **Commit and push directly to `main`** (this repo's established convention — see other `research-items.json` commits). This does not require a live-app confirmation step the way study-app content changes do, since research-items.json is a moving research feed the user has already asked to grow via this exact skill.

## Related work

- The trend-report generation this skill's curation feeds into (grouping by category, keyword frequency, picking top-score candidates, pairing with external hackathon research) is a separate but related skill-in-progress; see progress-tracker-dashboard's task tracker for its status.
- Once curated count is large enough to be useful as a standalone feed (no fixed threshold set yet — ask the user when it feels ready), the next phase is changing the GitHub Pages viewer (`index.html`) to filter to `curated: true` only — a separate, user-confirmed step, not automatic.
