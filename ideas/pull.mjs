// Pulls what the people and places in sources.json have published lately: Hacker News
// (Algolia's open API, no key), their feeds, and their newest public repositories. Writes one
// JSONL of items, deduplicated by URL, and a markdown digest ranked by attention and recency.
// Usage: bun ideas/pull.mjs [outDir]   (default ~/.claude/principia/ideas)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import bundled from './sources.json'
const outDir = process.argv[2] || path.join(os.homedir(), '.claude', 'principia', 'ideas')
fs.mkdirSync(outDir, { recursive: true })
// Your own sources.json in the ideas folder replaces the bundled one.
const own = path.join(outDir, 'sources.json')
const sources = fs.existsSync(own) ? JSON.parse(fs.readFileSync(own, 'utf8')) : bundled
if (!fs.existsSync(own)) fs.writeFileSync(own, JSON.stringify(bundled, null, 2))
const itemsFile = path.join(outDir, 'items.jsonl')
const seen = new Map()
if (fs.existsSync(itemsFile)) for (const l of fs.readFileSync(itemsFile, 'utf8').split('\n')) { if (l.trim()) { const it = JSON.parse(l); seen.set(it.url, it) } }

const get = async (url, headers = {}) => {
  const r = await fetch(url, { headers: { 'user-agent': 'principia-ideas/0.1', ...headers } })
  if (!r.ok) throw new Error(`${r.status} ${url}`)
  return r
}
const since = Math.floor(Date.now() / 1000) - sources.hn.days * 86400
const fresh = []
const add = it => { if (!it.url || seen.has(it.url)) return; seen.set(it.url, it); fresh.push(it) }

// Hacker News: stories matching the queries, and everything the named people posted.
for (const q of sources.hn.queries) {
  const u = `https://hn.algolia.com/api/v1/search?${new URLSearchParams({ query: q, tags: 'story', hitsPerPage: '30', numericFilters: `created_at_i>${since},points>${sources.hn.minPoints}` })}`
  try {
    for (const h of (await (await get(u)).json()).hits) add({ source: 'hn', via: q, title: h.title, url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`, hn: `https://news.ycombinator.com/item?id=${h.objectID}`, points: h.points, comments: h.num_comments, by: h.author, at: h.created_at })
  } catch (e) { console.error('hn', q, e.message) }
}
for (const who of sources.hn.people) {
  const u = `https://hn.algolia.com/api/v1/search_by_date?${new URLSearchParams({ tags: `author_${who}`, hitsPerPage: '30', numericFilters: `created_at_i>${since}` })}`
  try {
    for (const h of (await (await get(u)).json()).hits) {
      const isStory = (h._tags || []).includes('story')
      add({ source: 'hn', via: `@${who}`, title: isStory ? h.title : `${who} commented: ${unescape((h.comment_text || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').slice(0, 160)}`, url: `https://news.ycombinator.com/item?id=${h.objectID}`, hn: `https://news.ycombinator.com/item?id=${h.objectID}`, points: h.points ?? 0, comments: h.num_comments ?? 0, by: who, at: h.created_at, kind: isStory ? 'story' : 'comment' })
    }
  } catch (e) { console.error('hn', who, e.message) }
}

// Feeds: RSS or Atom, read with regexes (no dependency), newest 15 entries each.
const unescape = t => t.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x2F;/g, '/')
const tag = (xml, name) => { const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml); return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim() : '' }
const attr = (xml, name, a) => { const m = new RegExp(`<${name}[^>]*\\s${a}="([^"]+)"`, 'i').exec(xml); return m ? m[1] : '' }
for (const f of sources.feeds) {
  try {
    const xml = await (await get(f.url, { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' })).text()
    const entries = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || []
    for (const e of entries.slice(0, 15)) {
      const url = tag(e, 'link') || attr(e, 'link', 'href')
      const at = tag(e, 'pubDate') || tag(e, 'published') || tag(e, 'updated')
      if (at && Date.parse(at) && Date.parse(at) / 1000 < since) continue
      add({ source: 'feed', via: f.name, title: tag(e, 'title'), url, at: at ? new Date(at).toISOString() : '', summary: (tag(e, 'description') || tag(e, 'summary') || tag(e, 'content')).slice(0, 400) })
    }
  } catch (e) { console.error('feed', f.name, e.message) }
}

// GitHub: repositories pushed to lately by the named accounts (public API, 60 calls/hour unkeyed).
for (const who of sources.github) {
  try {
    const repos = await (await get(`https://api.github.com/users/${who}/repos?sort=pushed&per_page=10`, { accept: 'application/vnd.github+json' })).json()
    for (const r of Array.isArray(repos) ? repos : []) {
      if (Date.parse(r.pushed_at) / 1000 < since) continue
      add({ source: 'github', via: who, title: `${r.full_name}: ${r.description || ''}`.trim(), url: r.html_url, at: r.pushed_at, points: r.stargazers_count })
    }
  } catch (e) { console.error('github', who, e.message) }
}

fs.appendFileSync(itemsFile, fresh.map(it => JSON.stringify(it)).join('\n') + (fresh.length ? '\n' : ''))
// The digest: new since the last pull, grouped by where it came from, hottest first.
const bySource = new Map()
for (const it of fresh) bySource.set(it.via, [...(bySource.get(it.via) || []), it])
const lines = [`# Ideas pulled ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, '', `${fresh.length} new items (${seen.size} known in total). Hacker News via Algolia, feeds, GitHub.`, '']
for (const [via, list] of [...bySource.entries()].sort((a, b) => b[1].length - a[1].length)) {
  lines.push(`## ${via}  (${list.length})`)
  for (const it of list.sort((a, b) => (b.points || 0) - (a.points || 0)).slice(0, 25)) lines.push(`- ${it.points ? `${it.points} pts · ` : ''}${it.comments ? `${it.comments} comments · ` : ''}${it.title} — ${it.url}${it.hn && it.hn !== it.url ? ` (HN ${it.hn})` : ''}`)
  lines.push('')
}
const digest = path.join(outDir, `digest-${new Date().toISOString().slice(0, 10)}.md`)
fs.writeFileSync(digest, lines.join('\n'))
console.log(`${fresh.length} new items → ${digest}`)
