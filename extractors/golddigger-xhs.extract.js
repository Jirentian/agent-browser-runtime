// GoldDigger-XHS compatible Xiaohongshu extractor for Agent Browser Runtime.
//
// This mirrors the DOM extraction shape used by GoldDigger-XHS:
// - SearchScraper: search_result note URLs and note ids.
// - PostScraper: note title/content/author/images/L1+L2 comments.
// - ProfileScraper: profile bio/stats/recent posts.
//
// Usage from the Agent Browser Runtime repo:
//   ./cli/brs.js extract /Users/zhi/.codex/skills/agent-browser-runtime/extractors/golddigger-xhs.extract.js \
//     'https://www.xiaohongshu.com/search_result?keyword=小红书获客&source=web_search_result_notes&type=51&sort=time_descending&date_filter=7' \
//     --params '{"mode":"search","maxNotes":20}' --humanize enhanced --save-html

export const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: { type: 'string', enum: ['auto', 'search', 'note', 'profile'], default: 'auto' },
    maxNotes: { type: 'integer', default: 20 },
    maxSearchScrolls: { type: 'integer', default: 3 },
    searchScrollPauseMs: { type: 'integer', default: 1500 },
    pageLoadWaitMs: { type: 'integer', default: 3000 },
    commentScrollIterations: { type: 'integer', default: 6 },
    commentScrollWaitMs: { type: 'integer', default: 800 },
    commentScrollX: { type: 'integer', default: 1100 },
    commentScrollY: { type: 'integer', default: 600 },
    commentScrollDeltaY: { type: 'integer', default: 1500 },
    expandReplies: { type: 'boolean', default: true },
    maxExpandClicks: { type: 'integer', default: 10 },
  },
};

export async function extract({ pageHtml = '', url, finalUrl, params = {}, ui }) {
  const targetUrl = finalUrl || url || '';
  const mode = params.mode === 'auto' || !params.mode ? inferMode(targetUrl) : params.mode;

  if (params.pageLoadWaitMs) {
    await sleep(params.pageLoadWaitMs);
  }

  if (mode === 'search') {
    return extractSearch({ pageHtml, url, finalUrl: targetUrl, params, ui });
  }
  if (mode === 'profile') {
    return extractProfile({ pageHtml, url, finalUrl: targetUrl, ui });
  }
  return extractNote({ pageHtml, url, finalUrl: targetUrl, params, ui });
}

async function extractSearch({ pageHtml, url, finalUrl, params, ui }) {
  const maxNotes = params.maxNotes ?? 20;
  const maxScrolls = params.maxSearchScrolls ?? 3;
  const pauseMs = params.searchScrollPauseMs ?? 1500;

  try { await ui?.waitFor?.({ selector: 'section.note-item', timeoutMs: 15000 }); } catch (_) {}

  let html = pageHtml || '';
  for (let i = 0; i < maxScrolls; i += 1) {
    await ui?.scroll?.({ count: 1, deltaY: 900, pauseMs }).catch(() => {});
    await sleep(pauseMs);
    const refreshed = await ui?.html?.({ timeoutMs: 30000 }).catch(() => null);
    if (refreshed?.html) html = refreshed.html;
  }
  if (!html) {
    const refreshed = await ui?.html?.({ timeoutMs: 30000 }).catch(() => null);
    html = refreshed?.html || '';
  }

  const notes = parseSearchNotes(html).slice(0, maxNotes);
  return {
    source: 'xiaohongshu',
    kind: 'search_results',
    url: finalUrl || url,
    keyword: extractKeyword(url, finalUrl),
    total: notes.length,
    urls: notes.map((note) => note.url),
    noteIds: notes.map((note) => note.xhsNoteId),
    notes,
  };
}

async function extractNote({ pageHtml, url, finalUrl, params, ui }) {
  try { await ui?.waitFor?.({ selector: '#detail-title', timeoutMs: 15000 }); } catch (_) {}

  let html = pageHtml || '';
  const scrollIterations = params.commentScrollIterations ?? 6;
  const waitMs = params.commentScrollWaitMs ?? 800;
  const x = params.commentScrollX ?? 1100;
  const y = params.commentScrollY ?? 600;
  const deltaY = params.commentScrollDeltaY ?? 1500;

  for (let i = 0; i < scrollIterations; i += 1) {
    await ui?.scroll?.({ x, y, deltaY, count: 1, pauseMs: waitMs }).catch(() => {});
    await sleep(waitMs);
    const refreshed = await ui?.html?.({ timeoutMs: 30000 }).catch(() => null);
    if (refreshed?.html) html = refreshed.html;
  }

  let expandClicks = 0;
  if (params.expandReplies !== false) {
    const maxExpandClicks = params.maxExpandClicks ?? 10;
    for (let i = 0; i < maxExpandClicks; i += 1) {
      const targetText = firstExpandReplyText(html);
      if (!targetText) break;
      const found = await ui?.waitFor?.({ selector: '.show-more', targetText, timeoutMs: 1500, pollMs: 200 }).catch(() => null);
      if (!found?.found) break;
      const clicked = await ui?.click?.({ selector: '.show-more', targetText, pauseAfterMs: 600 }).catch(() => null);
      if (!clicked?.ok) break;
      expandClicks += 1;
      await sleep(500);
      const refreshed = await ui?.html?.({ timeoutMs: 30000 }).catch(() => null);
      if (refreshed?.html) html = refreshed.html;
    }
  }

  if (!html) {
    const refreshed = await ui?.html?.({ timeoutMs: 30000 }).catch(() => null);
    html = refreshed?.html || '';
  }

  const data = parseNoteHtml(html, finalUrl || url);
  return {
    source: 'xiaohongshu',
    kind: 'note',
    ...data,
    rawData: {
      title: data.title,
      content: data.content,
      authorName: data.authorName,
      authorUrl: data.authorUrl,
      publishDate: data.publishDate,
      images: data.images,
      comments: data.comments,
    },
    diagnostics: {
      commentScrollIterations: scrollIterations,
      expandClicks,
      htmlLength: html.length,
    },
  };
}

async function extractProfile({ pageHtml, url, finalUrl, ui }) {
  try { await ui?.waitFor?.({ selector: '.user-name, .username', timeoutMs: 15000 }); } catch (_) {}
  let html = pageHtml || '';
  const refreshed = await ui?.html?.({ timeoutMs: 30000 }).catch(() => null);
  if (refreshed?.html) html = refreshed.html;

  const data = parseProfileHtml(html, finalUrl || url);
  return {
    source: 'xiaohongshu',
    kind: 'profile',
    ...data,
    rawData: {
      name: data.authorName,
      bio: data.bio,
      location: data.location,
      stats: [data.followerCount, data.followingCount, data.likesCount],
      recentPosts: data.recentPosts,
    },
  };
}

function parseSearchNotes(html) {
  const seen = new Set();
  const notes = [];
  const starts = [];
  const re = /<section\b[^>]*class="[^"]*\bnote-item\b[^"]*"[^>]*>/gi;
  let match;
  while ((match = re.exec(html))) starts.push(match.index);

  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : Math.min(start + 6000, html.length);
    const block = html.slice(start, end);
    const note = parseSearchCard(block);
    if (!note?.xhsNoteId || seen.has(note.xhsNoteId)) continue;
    seen.add(note.xhsNoteId);
    notes.push(note);
  }

  if (notes.length === 0) {
    for (const href of findHrefs(html, /\/(?:search_result|explore)\//)) {
      const absolute = toAbsoluteXhsUrl(href);
      const xhsNoteId = extractNoteId(absolute);
      if (!xhsNoteId || seen.has(xhsNoteId)) continue;
      seen.add(xhsNoteId);
      notes.push({ xhsNoteId, url: absolute, title: '', authorName: '', coverImage: '', likeCount: '' });
    }
  }

  return notes;
}

function parseSearchCard(block) {
  const href = firstHref(block, /\/(?:search_result|explore)\//);
  if (!href) return null;
  const url = toAbsoluteXhsUrl(href);
  const xhsNoteId = extractNoteId(url);
  const title = firstClean(block, [
    /<a[^>]*class="[^"]*\btitle\b[^"]*"[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>/i,
    /<span[^>]*class="[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
  ]);
  const authorName = firstClean(block, [
    /<div[^>]*class="[^"]*\bname\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<span[^>]*class="[^"]*\bname\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
  ]);
  const coverImage = decodeHtml(firstMatch(block, /<img[^>]*src="([^"]+)"/i));
  const likeCount = firstClean(block, [/<span[^>]*class="[^"]*\bcount\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i]);
  return { xhsNoteId, url, title, authorName, coverImage, likeCount };
}

function parseNoteHtml(html, postUrl) {
  const noteId = extractNoteId(postUrl);
  const title = firstClean(html, [/<(?:div|h1)[^>]*id="detail-title"[^>]*>([\s\S]*?)<\/(?:div|h1)>/i]);
  const content = extractDetailDesc(html);
  const header = beforeFirst(html, ['comments-el', 'list-container', 'parent-comment']);
  const authorName = firstClean(header, [
    /<[^>]*class="[^"]*\bauthor-wrapper\b[^"]*"[^>]*>[\s\S]*?<[^>]*class="[^"]*\busername\b[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i,
    /<[^>]*class="[^"]*\busername\b[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i,
  ]);
  const authorHref = firstHref(header, /\/user\/profile\//);
  const authorUrl = authorHref ? toAbsoluteXhsUrl(authorHref) : '';
  const publishDate = firstClean(header, [
    /<span[^>]*class="[^"]*\bdate\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
    /<div[^>]*class="[^"]*\bdate\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
  ]);

  return {
    postUrl,
    xhsNoteId: noteId,
    title,
    content,
    authorName,
    authorUrl,
    publishDate,
    images: extractNoteImages(html),
    comments: extractNestedComments(html),
  };
}

function parseProfileHtml(html, profileUrl) {
  const stats = extractProfileStats(html);
  return {
    userId: extractUserId(profileUrl),
    authorName: firstClean(html, [
      /<[^>]*class="[^"]*\buser-name\b[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i,
      /<[^>]*class="[^"]*\busername\b[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i,
    ]),
    bio: firstClean(html, [
      /<[^>]*class="[^"]*\buser-desc\b[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i,
      /<[^>]*class="[^"]*\bbio\b[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i,
      /<[^>]*class="[^"]*\bdesc\b[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i,
    ]),
    redId: (firstClean(html, [
      /<[^>]*class="[^"]*\buser-redId\b[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i,
    ]).replace(/^小红书号[：:]?\s*/, '')) || '',
    location: firstClean(html, [
      /<[^>]*class="[^"]*\buser-ip\b[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i,
      /<[^>]*class="[^"]*\bip-container\b[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i,
    ]),
    followerCount: stats[0] || '0',
    followingCount: stats[1] || '0',
    likesCount: stats[2] || '0',
    recentPosts: extractRecentPosts(html).slice(0, 10),
  };
}

function extractDetailDesc(html) {
  const block = firstMatch(html, /<[^>]*id="detail-desc"[^>]*>([\s\S]*?)<\/div>\s*(?:<!---->)?/i);
  return block ? cleanText(stripHtmlPreservingEmoji(block)) : '';
}

function extractNoteImages(html) {
  const start = html.indexOf('swiper-wrapper');
  const scoped = start >= 0 ? html.slice(start, Math.min(html.length, start + 50000)) : html;
  const seen = new Set();
  const out = [];
  for (const match of scoped.matchAll(/<img[^>]*(?:src|data-src)="([^"]+)"/gi)) {
    const src = decodeHtml(match[1]);
    if (!src || src.includes('data:image')) continue;
    const key = src.split('/').pop()?.split('!')[0] || src;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(src);
  }
  return out;
}

function extractNestedComments(html) {
  const section = commentsSection(html);
  const parentBlocks = splitCommentBlocks(section);
  return parentBlocks.map(parseParentComment).filter((item) => item.nickname && item.content);
}

function splitCommentBlocks(html) {
  const markers = [];
  const re = /<[^>]*class="[^"]*\bparent-comment\b[^"]*"[^>]*>/gi;
  let match;
  while ((match = re.exec(html))) markers.push(match.index);
  return markers.map((start, index) => {
    const end = index + 1 < markers.length ? markers[index + 1] : html.length;
    return html.slice(start, end);
  });
}

// 2026-08 layout: a parent-comment block contains one main comment-item
// (class="comment-item") followed by zero or more reply comment-items
// (class="comment-item comment-item-sub"). Each comment unit wraps its fields
// in a .comment-inner-container: a.name (nickname) + div.content (note-text).
// We no longer split on reply-container (its class/structure changed).
function parseParentComment(block) {
  const units = splitCommentUnits(block);
  if (units.length === 0) return parseCommentFields(block);
  const main = parseCommentFields(units[0]);
  const replies = units.slice(1)
    .map(parseCommentFields)
    .filter((item) => item.nickname && item.content);
  return { ...main, replies };
}

// Split a parent-comment block into per-comment units by comment-item markers,\nexcluding the wrapping parent-comment tag itself.
function splitCommentUnits(block) {
  const starts = [];
  const re = /<div[^>]*id="comment-[a-f0-9]{24}"[^>]*class="[^"]*\bcomment-item\b[^"]*"[^>]*>/gi;
  let match;
  while ((match = re.exec(block))) starts.push(match.index);
  return starts.map((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1] : block.length;
    return block.slice(start, end);
  });
}

function parseCommentFields(block) {
  const name = firstClean(block, [
    /<a[^>]*class="[^"]*\bname\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i,
    /<[^>]*class="[^"]*\bauthor-wrapper\b[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i,
  ]);
  const href = firstHref(block, /\/user\/profile\//);
  const content = firstClean(block, [
    /<div[^>]*class="[^"]*\bcontent\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
  ], true);
  const date = firstClean(block, [
    /<span[^>]*class="[^"]*\bdate\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
    /<div[^>]*class="[^"]*\bdate\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /selected-disabled-search[^>]*>([\s\S]*?)<\/span>/i,
  ]);
  const likes = firstClean(block, [
    /<span[^>]*class="[^"]*\blike-wrapper\b[^"]*"[^>]*>[\s\S]*?<span[^>]*class="[^"]*\bcount\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
    /<span[^>]*class="[^"]*\bcount\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
  ]);
  return {
    nickname: name,
    profileUrl: href ? toAbsoluteXhsUrl(href) : '',
    content,
    date,
    likes,
  };
}

function extractProfileStats(html) {
  const matches = [...html.matchAll(/<[^>]*class="[^"]*(?:\bcount\b|\bdata-count\b)[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/gi)]
    .map((match) => cleanText(match[1]))
    .filter(Boolean);
  return matches.slice(0, 3);
}

function extractRecentPosts(html) {
  const blocks = [];
  const re = /<[^>]*class="[^"]*(?:\bnote-item\b|\bcover-container\b)[^"]*"[^>]*>/gi;
  let match;
  while ((match = re.exec(html))) blocks.push(match.index);

  return blocks.map((start, index) => {
    const end = index + 1 < blocks.length ? blocks[index + 1] : Math.min(start + 5000, html.length);
    const block = html.slice(start, end);
    const title = firstClean(block, [
      /<[^>]*class="[^"]*(?:\btitle\b|\bnote-title\b|\bfooter-content\b)[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i,
    ]);
    const href = firstHref(block, /\/(?:explore|search_result)\//);
    return {
      title,
      link: href ? toAbsoluteXhsUrl(href) : '',
    };
  }).filter((post) => post.title || post.link);
}

function commentsSection(html) {
  const start = firstPositiveIndex(html, ['list-container', 'comments-el', 'parent-comment']);
  if (start < 0) return html;
  const end = html.indexOf('end-container', start);
  return html.slice(start, end > start ? end : html.length);
}

function firstExpandReplyText(html) {
  const match = html.match(/>[^<]*(展开\s*\d+\s*条回复)[^<]*</);
  return match ? cleanText(match[1]) : '';
}

function inferMode(url) {
  if (/\/user\/profile\//i.test(url)) return 'profile';
  if (/\/search_result\b/i.test(url) && /[?&]keyword=/i.test(url)) return 'search';
  return 'note';
}

function extractKeyword(url, finalUrl) {
  try {
    const parsed = new URL(finalUrl || url);
    return parsed.searchParams.get('keyword') || '';
  } catch (_) {
    return '';
  }
}

function extractNoteId(value) {
  if (!value) return '';
  try {
    const parsed = new URL(value, 'https://www.xiaohongshu.com');
    const parts = parsed.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || '';
  } catch (_) {
    const path = String(value).split('?')[0];
    const parts = path.split('/').filter(Boolean);
    return parts[parts.length - 1] || '';
  }
}

function extractUserId(value) {
  if (!value) return '';
  try {
    const parsed = new URL(value, 'https://www.xiaohongshu.com');
    const parts = parsed.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || '';
  } catch (_) {
    const parts = String(value).split('?')[0].split('/').filter(Boolean);
    return parts[parts.length - 1] || '';
  }
}

function findHrefs(html, pattern) {
  const out = [];
  for (const match of html.matchAll(/href="([^"]+)"/gi)) {
    const href = decodeHtml(match[1]);
    if (pattern.test(href)) out.push(href);
  }
  return out;
}

function firstHref(html, pattern) {
  for (const href of findHrefs(html, pattern)) return href;
  return '';
}

function toAbsoluteXhsUrl(href) {
  try {
    return new URL(decodeHtml(href), 'https://www.xiaohongshu.com').toString();
  } catch (_) {
    return decodeHtml(href || '');
  }
}

function firstClean(html, patterns, preserveEmoji = false) {
  for (const pattern of patterns) {
    const value = firstMatch(html, pattern);
    if (value) return cleanText(preserveEmoji ? stripHtmlPreservingEmoji(value) : value);
  }
  return '';
}

function firstMatch(html, pattern) {
  const match = html.match(pattern);
  return match?.[1] || '';
}

function beforeFirst(html, markers) {
  const index = firstPositiveIndex(html, markers);
  return index >= 0 ? html.slice(0, index) : html;
}

function firstPositiveIndex(html, markers) {
  let best = -1;
  for (const marker of markers) {
    const index = html.indexOf(marker);
    if (index >= 0 && (best < 0 || index < best)) best = index;
  }
  return best;
}

function stripHtmlPreservingEmoji(value) {
  return String(value || '')
    .replace(/<img[^>]*class="[^"]*note-content-emoji[^"]*"[^>]*>/g, '[表情]')
    .replace(/<img[^>]*picasso-static\.xiaohongshu\.com[^>]*>/g, '[表情]')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
}

function cleanText(value) {
  return decodeHtml(stripTags(String(value || ''))).replace(/\s+/g, ' ').trim();
}

function stripTags(value) {
  return String(value || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ');
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#x3D;/g, '=');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
