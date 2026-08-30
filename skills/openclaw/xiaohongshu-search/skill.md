---
slug: xiaohongshu-search
display_name: Xiaohongshu (小红书) Search & Profile
version: 1.0.0
tags: [browser, xiaohongshu, xhs, redbook, scraping, social-media, ugc, chinese-market, research]
---

# Xiaohongshu (小红书 / RED) Search, Note & Profile

## Description

Use Agent Browser Runtime to search Xiaohongshu (小红书 / RED), read note bodies and
comment threads, and collect user-profile data through a persistent logged-in Chrome
profile. All actions run through the humanized UI primitives (`brs ui`) and are parsed by
the bundled `extractors/golddigger-xhs.extract.js` (search / note / profile modes).

Use this when a task needs **real Chinese social-media UGC**: word-of-mouth, product or
store reviews, 探店/种草 notes, competitor/creator account research, consumer trends, or
"what do commenters actually say" questions. Do NOT use it for English/overseas info,
breaking news, technical docs, or papers — those belong to general web search.

> Xiaohongshu content is subjective UGC and frequently contains soft ads / sponsorships.
> Report sample sizes (how many notes/comments read) and cross-check before strong claims.

## Prerequisites

- Agent Browser Runtime stack running from the repo root (`docker compose up -d`),
  extension connected (`brs status` shows `"extensionConnected": true`).
- A persistent Chrome profile that is **logged in to xiaohongshu.com** (log in once via noVNC).
- Python 3 (used only for pretty-printing JSON).

## Commands

A wrapper is provided at `scripts/xiaohongshu/xhs.sh` (run it from anywhere; it resolves the
repo root itself). Each command is serial and takes ~15–60s (humanized scrolling + comment
expansion). Do not run concurrently.

```bash
cd scripts/xiaohongshu

# Ensure runtime is up and a xiaohongshu tab is open (caches lease/tab in $TMPDIR)
./xhs.sh setup

# Search: prints a numbered note list (noteId / likes / author / title).
# Raw JSON saved to $TMPDIR/xhs_last_search.json
./xhs.sh search "keyword" [N=20]

# Read the Nth note from the last search: body + image count + top-level comments + replies.
# Raw JSON saved to $TMPDIR/xhs_last_note.json
./xhs.sh read 1

# User profile: nickname, redId (小红书号), bio, IP location, following/followers,
# likes+saves, and recent notes. Pass a userId or a full profile URL.
./xhs.sh profile 5e3d7d02000000000100795b
./xhs.sh profile "https://www.xiaohongshu.com/user/profile/<userId>"

# Fallback: navigate directly to a note URL/id. Often returns 404/300031 on a stale
# xsec_token — prefer `read` (clicking a card mints a fresh token).
./xhs.sh open <noteUrl|noteId>
```

## Standard workflow

1. `search "<keyword>"` to get candidate notes.
2. Pick high-like / relevant notes and `read <n>` for body + comment threads.
3. For author/competitor research, take the userId/profile URL and run `profile <id>`.
4. Summarize: distinguish note-author claims vs. comment-section consensus vs. likely ads;
   state how many notes/comments were read.

## What you can / cannot get

**Available:** note title, body, hashtags, image count, publish date, author nickname/userId;
comment text, commenter nickname, comment likes, nested replies (verified on a live note:
50 top-level + 167 replies = 217 comments with zero missing nicknames); profile: nickname,
redId (小红书号), bio, IP location, following/followers, likes+saves count, recent-note list.

**Not available (platform limits, not tooling bugs):**
- Another user's **saved / liked** tabs — Xiaohongshu does not render these on others'
  profiles (privacy); no tool can read them for an account you don't own.
- Deleted / followers-only / geo-restricted content.
- Direct navigation to a note URL often fails **xsec_token** validation (404 / 300031):
  the token is minted by page JS when a card is clicked. Always open notes via `read`
  (card click), never by hand-building URLs.

## Maintenance

If Xiaohongshu changes its DOM and fields come back empty, update the selectors in
`extractors/golddigger-xhs.extract.js` against fresh HTML
(`brs browse-html <lease> <tab>`):

- Search cards: `section.note-item`; title `.title a span`; author `.name`; likes `.count`.
- Note: `#detail-title` / `#detail-desc`; comment unit `div[id^="comment-"].comment-item`
  (replies additionally have `comment-item-sub`); nickname `a.name`; body `div.content`.
- Profile: `.user-name` / `.user-desc` / `.user-redId` (redId) / `.user-IP`; numeric stats
  `.user-interactions .count` in order: following, followers, likes+saves.
