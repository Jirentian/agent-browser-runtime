#!/usr/bin/env python3
"""Pretty-print xhs.sh JSON output. Usage: fmt.py search|note|profile <json_file>"""
import json, sys, urllib.parse

kind = sys.argv[1]
path = sys.argv[2]
with open(path, encoding="utf-8") as f:
    d = json.load(f)
r = d.get("result", d)

if kind == "search":
    notes = r.get("notes", [])
    kw = urllib.parse.unquote(r.get("keyword", ""))
    print(f"keyword: {kw}  hits: {len(notes)}")
    for i, n in enumerate(notes, 1):
        title = n.get("title") or "(no title)"
        author = n.get("authorName") or ""
        likes = n.get("likeCount") or "?"
        nid = n.get("xhsNoteId", "")
        print(f"{i:>2}. {nid} | \u2764{str(likes):>6} | {author[:14]:<14} | {title[:42]}")

elif kind == "note":
    print("title:", r.get("title", ""))
    print("author:", r.get("authorName", ""), "| published:", r.get("publishDate", ""))
    print("body:", (r.get("content", "") or "")[:800])
    imgs = r.get("images", [])
    print(f"images: {len(imgs)}")
    cm = r.get("comments", [])
    tot = sum(len(x.get("replies", [])) for x in cm)
    print(f"\n=== comments: {len(cm)} top-level / {tot} replies ===")
    for x in cm[:20]:
        nick = x.get("nickname", "?")
        content = (x.get("content") or "")[:60]
        likes = x.get("likes", "")
        print(f"  {nick}: {content}  (\u2764{likes})")
        for rp in (x.get("replies", [])[:2]):
            rnick = rp.get("nickname", "?")
            rcontent = (rp.get("content") or "")[:50]
            print(f"      \u2514 {rnick}: {rcontent}")

elif kind == "profile":
    print("nickname:", r.get("authorName", ""))
    print("redId (xiaohongshu id):", r.get("redId", ""))
    print("bio:", r.get("bio", ""))
    print("IP location:", r.get("location", ""))
    print(f"following {r.get('followingCount','?')} | followers {r.get('followerCount','?')} | likes+saves {r.get('likesCount','?')}")
    print("userId:", r.get("userId", ""))
    posts = r.get("recentPosts", [])
    print(f"\n=== recent notes ({len(posts)}) ===")
    for i, p in enumerate(posts, 1):
        print(f"{i:>2}. {p.get('title','(no title)')[:42]}\n     {p.get('link','')}")
    print("\nNote: other users' 'saves'/'likes' tabs are private and not shown on profiles.")
