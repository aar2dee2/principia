// Builds gallery.html from picks.json: one card per pick with the page's own preview image
// (its og:image, fetched once), why it matters to you, and the links. Open it in a browser to
// see things before trying them. Usage: bun ideas/gallery.mjs [dir]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = process.argv[2] || path.join(os.homedir(), '.claude', 'principia', 'ideas')
const picksFile = path.join(dir, 'picks.json')
const picks = fs.existsSync(picksFile) ? JSON.parse(fs.readFileSync(picksFile, 'utf8')) : []
const previews = path.join(dir, 'previews.json')
const cache = fs.existsSync(previews) ? JSON.parse(fs.readFileSync(previews, 'utf8')) : {}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
async function preview(url) {
  if (cache[url] !== undefined) return cache[url]
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000)
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'Mozilla/5.0 principia-ideas/0.1' }, redirect: 'follow' })
    clearTimeout(t)
    const html = (await r.text()).slice(0, 200_000)
    const m = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(html) || /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i.exec(html) || /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i.exec(html)
    const d = /<meta[^>]+(?:property=["']og:description["']|name=["']description["'])[^>]+content=["']([^"']+)["']/i.exec(html)
    cache[url] = { image: m ? new URL(m[1], url).href : '', description: d ? d[1].slice(0, 300) : '' }
  } catch {
    cache[url] = { image: '', description: '' }
  }
  return cache[url]
}
for (const p of picks.filter(p => !p.dropped)) p.preview = await preview(p.url)
fs.writeFileSync(previews, JSON.stringify(cache))

const BUCKETS = [['project', 'For your projects'], ['pattern', 'Ways of working worth copying'], ['craft', 'Presenting complex things well'], ['weird', 'Weird and interesting'], ['try', 'Try it: there is something to click']]
const card = p => `
<a class="card${p.kept ? ' kept' : ''}${p.tried ? ' tried' : ''}" href="${esc(p.url)}" target="_blank" rel="noopener">
  ${p.preview?.image ? `<img loading="lazy" src="${esc(p.preview.image)}" alt="">` : '<div class="noimg"></div>'}
  <div class="body">
    <div class="meta">${esc(p.via)}${p.points ? ` · ${p.points} pts` : ''}${p.comments ? ` · ${p.comments} comments` : ''}${p.at ? ` · ${esc(String(p.at).slice(0, 10))}` : ''}</div>
    <h3>${esc(p.title)}</h3>
    <p class="why">${esc(p.why)}</p>
    ${p.project ? `<div class="tag">${esc(p.project)}</div>` : ''}
    ${p.hn && p.hn !== p.url ? `<div class="links"><span onclick="event.preventDefault();event.stopPropagation();window.open('${esc(p.hn)}')">HN thread</span></div>` : ''}
  </div>
</a>`
const sections = BUCKETS.map(([k, label]) => {
  const list = picks.filter(p => !p.dropped && p.buckets?.includes(k)).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  return list.length ? `<h2>${label} <small>${list.length}</small></h2><div class="grid">${list.map(card).join('')}</div>` : ''
}).join('')
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ideas</title>
<style>
:root{color-scheme:light dark;--bg:#0f1115;--card:#171a21;--text:#e7e9ee;--dim:#9aa3b2;--acc:#7aa2f7;--line:#262b36}
@media(prefers-color-scheme:light){:root{--bg:#f7f7f9;--card:#fff;--text:#1b1f27;--dim:#5b6472;--acc:#2f5fd0;--line:#e3e6ec}}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 -apple-system,system-ui,sans-serif;padding:24px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim);margin:28px 0 10px}h2 small{color:var(--dim);font-weight:400;margin-left:6px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
.card{display:block;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;color:inherit;text-decoration:none;transition:transform .12s}
.card:hover{transform:translateY(-2px);border-color:var(--acc)}.card.kept{border-color:#5fb27a}.card.tried{opacity:.7}
.card img{width:100%;aspect-ratio:1.91;object-fit:cover;display:block;background:#222}.noimg{width:100%;aspect-ratio:1.91;background:linear-gradient(135deg,#2a2f3a,#1a1d25)}
.body{padding:12px 14px 14px}.meta{font-size:12px;color:var(--dim)}h3{font-size:15px;margin:6px 0 6px;line-height:1.3}.why{margin:0;color:var(--dim);font-size:13px}
.tag{display:inline-block;margin-top:8px;font-size:11px;padding:2px 8px;border-radius:999px;background:var(--line);color:var(--text)}.links{margin-top:8px;font-size:12px;color:var(--acc)}
.sub{color:var(--dim);font-size:13px}
</style></head><body>
<h1>Ideas</h1><div class="sub">${picks.filter(p => !p.dropped).length} picks, judged against your projects by Principia · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · click a card to see it; i in the Principia window marks keep, try or drop</div>
${sections || '<p class="sub">Nothing judged yet. Run /ledger ideas in a Claude Code session.</p>'}
</body></html>`
fs.writeFileSync(path.join(dir, 'gallery.html'), html)
console.log(`gallery: ${path.join(dir, 'gallery.html')} (${picks.length} picks)`)
