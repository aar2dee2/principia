// Pure helpers for what the agent does: plan steps and the requirements they serve,
// preview links in command output, and readable failure text.

import type { ActivityEvent, PlanStep, Requirement } from '../types'

const IDS = /\bR(\d+)\b/g
const WORD = /[a-z0-9]{3,}/g
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'add', 'make', 'use', 'show', 'all'])

const words = (s: string) => new Set((s.toLowerCase().match(WORD) ?? []).filter(w => !STOP.has(w)))

// Requirement ids a plan step serves: the ids it names ("[R2] Add tests"), else the
// requirement whose title it overlaps most (at least half of the title's words).
export function linkStep(text: string, reqs: Requirement[]): string[] {
  const named = [...text.matchAll(IDS)].map(m => `R${m[1]}`).filter(id => reqs.some(r => r.id === id))
  if (named.length) return [...new Set(named)]
  const w = words(text)
  let best: { id: string; score: number } | undefined
  for (const r of reqs) {
    const t = words(r.title)
    if (!t.size) continue
    const score = [...t].filter(x => w.has(x)).length / t.size
    if (score >= 0.5 && (!best || score > best.score)) best = { id: r.id, score }
  }
  return best ? [best.id] : []
}

type RawItem = { content?: unknown; text?: unknown; title?: unknown; status?: unknown }

// TodoWrite's `todos` and the desktop app's update_plan `items`.
export function planFrom(input: Record<string, unknown>, reqs: Requirement[]): PlanStep[] | undefined {
  const raw = (Array.isArray(input.todos) ? input.todos : Array.isArray(input.items) ? input.items : undefined) as RawItem[] | undefined
  if (!raw) return undefined
  return raw
    .map(item => {
      const text = String(item.content ?? item.text ?? item.title ?? '').trim()
      const st = String(item.status ?? 'pending')
      const status: PlanStep['status'] = st === 'completed' || st === 'done' ? 'completed' : st === 'in_progress' || st === 'active' ? 'in_progress' : 'pending'
      return { text, status, reqIds: linkStep(text, reqs) }
    })
    .filter(s => s.text)
}

export const PLAN_TOOLS = new Set(['TodoWrite', 'mcp__ccd_turn__update_plan'])

// Local dev servers and common preview hosts printed by a command.
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[\w.-]+\.(?:localhost|test|vercel\.app|netlify\.app|pages\.dev|fly\.dev|onrender\.com|ngrok-free\.app|ngrok\.io))(?::\d+)?(?:\/[^\s'"`)<>\]]*)?/gi

export function previewUrls(output: string): string[] {
  return [...new Set((output.match(URL_RE) ?? []).map(u => u.replace(/[.,;:]+$/, '').replace('0.0.0.0', 'localhost')))].slice(0, 5)
}

export function failureText(tool: string, text: string): string {
  const first = text.replace(/\s+/g, ' ').trim()
  return `${tool}: ${first.length > 220 ? `${first.slice(0, 219)}…` : first || 'failed'}`
}

// Your words alone: without the reminders the app puts around a message, and nothing at all
// for a command wrapper (a slash command's output, an IDE notice). Mirrors the importer.
export function humanText(text: string): string {
  const t = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
  return /^<(local-command|command-|ide_|user-prompt-submit-hook)/.test(t) ? '' : t
}

// ---------- shared by the pane and the window ----------

export type ReqFilterName = 'all' | 'open' | 'unverified' | 'verified' | 'revisit' | 'conflicts' | 'yours' | 'agents'

export const REQ_FILTERS: { value: ReqFilterName; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'unverified', label: 'Done, not verified' },
  { value: 'verified', label: 'Verified' },
  { value: 'revisit', label: 'To revisit' },
  { value: 'conflicts', label: 'Conflicts' },
  { value: 'yours', label: 'Asked by you' },
  { value: 'agents', label: 'Added by the agent' },
]

export const isVerified = (r: Requirement) => r.status === 'verified' && !r.needsReverify

export function filterReqs(reqs: Requirement[], query: string, filter: ReqFilterName): Requirement[] {
  const q = query.trim().toLowerCase()
  return reqs.filter(r => {
    if (q && !`${r.id} ${r.title} ${r.history.map(h => h.text).join(' ')}`.toLowerCase().includes(q)) return false
    switch (filter) {
      case 'open': return !isVerified(r) && r.status !== 'deferred' && r.status !== 'revisit'
      case 'unverified': return r.status === 'implemented' || Boolean(r.needsReverify)
      case 'verified': return isVerified(r)
      case 'revisit': return r.status === 'revisit'
      case 'conflicts': return Boolean(r.conflict)
      case 'yours': return r.history[0]?.by !== 'agent'
      case 'agents': return r.history[0]?.by === 'agent'
      default: return true
    }
  })
}

// What still stands between a requirement and verified; '' when nothing does.
export function gapOf(r: Requirement, plan: PlanStep[] = []): string {
  if (r.conflict) return `Conflicting instruction: ${r.conflict.reason}`
  if (r.needsReverify) return 'Changed after it was done; check it again'
  if (r.status === 'verified' || r.status === 'deferred' || r.status === 'revisit') return ''
  if (plan.length && !plan.some(s => s.reqIds.includes(r.id)) && r.status === 'captured') return "Not in the agent's plan"
  switch (r.status) {
    case 'implemented': return 'Agent says done; no passing check yet'
    case 'captured': return "Not in the agent's work yet"
    case 'in_progress': return 'Still in progress'
    case 'blocked': return 'Blocked'
    case 'needs_clarification': return 'Waiting on you'
  }
  return ''
}

// Files that may hold secrets: never copied for diffs (their diff opens the file instead).
const SECRET = /(^|[\\/])(\.env(\..*)?|\.npmrc|\.netrc|\.pgpass|id_(rsa|ed25519|ecdsa)[^\\/]*|[^\\/]*\.(pem|key|p12|pfx)|credentials[^\\/]*|secrets?\.[a-z]+)$/i
export const isSecretPath = (file: string) => SECRET.test(file)

// ---------- how much activity is kept ----------

// Activity is kept per session, not per turn, so a requirement from the first hour still has
// its edits and tests a day later. Only the newest events keep their full text (commands,
// plans, the agent's messages); older ones keep what the list and the links need.
export const EVENTS_MAX = 1500
export const EVENTS_FULL = 200
const LEAN_DETAIL = 160

export function trimEvents(list: ActivityEvent[], max = EVENTS_MAX, full = EVENTS_FULL): ActivityEvent[] {
  const kept = list.length > max ? list.slice(-max) : list
  const cut = Math.max(0, kept.length - full)
  if (!cut) return kept
  return kept.map((ev, i) => {
    if (i >= cut) return ev
    const { diff: _diff, ...rest } = ev
    return rest.detail && rest.detail.length > LEAN_DETAIL ? { ...rest, detail: `${rest.detail.slice(0, LEAN_DETAIL - 1)}…` } : rest
  })
}

// ---------- which requirements an event was for ----------

// Events carry the requirements their turn worked on. Ones recorded before that (or imported)
// are placed by time: an event belongs to the turn your latest message before it started, and
// that turn worked on what the message asked for or refined. `asks` are the times of all your
// messages, when known. A message that asked nothing new ("yes, go ahead", a question) carries
// on with what the message before it asked: the work it starts is still for those requirements.
export function linker(reqs: Requirement[], asks: number[] = []): (ev: ActivityEvent) => string[] {
  // Requirements captured from one message are saved a few milliseconds apart: times within a
  // few seconds of each other (and not split by another message) are one message.
  const marks = [
    ...asks.map(at => ({ at, id: '' })),
    ...reqs.flatMap(r => r.history.filter(h => h.by !== 'agent').map(h => ({ at: h.at, id: r.id }))),
  ].sort((a, b) => a.at - b.at)
  const byTime = new Map<number, string[]>()
  let start = -Infinity
  for (const m of marks) {
    if (m.at - start > 5000 || (!m.id && m.at !== start)) start = m.at
    const ids = byTime.get(start) ?? []
    byTime.set(start, m.id ? [...ids, m.id] : ids)
  }
  // A message with no requirement of its own continues the previous message's.
  let carry: string[] = []
  for (const [at, ids] of byTime) {
    if (ids.length) carry = ids
    else byTime.set(at, carry)
  }
  const starts = [...byTime.keys()]
  return ev => {
    if (ev.reqIds) return ev.reqIds
    let lo = 0
    let hi = starts.length - 1
    let start: number | undefined
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if ((starts[mid] ?? 0) <= ev.at) { start = starts[mid]; lo = mid + 1 } else hi = mid - 1
    }
    return start === undefined ? [] : [...new Set(byTime.get(start) ?? [])]
  }
}
