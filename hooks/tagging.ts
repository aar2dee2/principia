// Tagging a prompt into requirements. Pure, so the live check (scripts/live-check.mjs)
// sends the model exactly what the mod sends.

export type Tagged = { title: string; quote: string; refines: string | null; conflicts?: string | null; conflict_reason?: string; revisit?: string | null; kind?: 'requirement' | 'step' }

export const TAG_SYSTEM =
  'You split a developer\'s message to a coding agent into atomic, checkable requirements. ' +
  'Reply with JSON only: {"items":[{"title":string,"quote":string,"kind":"requirement"|"step","refines":string|null,"conflicts":string|null,"conflict_reason":string}]}. ' +
  'title: imperative, at most 12 words. quote: the exact words from the message it comes from. ' +
  'kind: "step" when the item is a one-off action in this session (run a command, commit, push, bump a version, create a release, open a window, start a new session, tell the user something, run an import once); ' +
  '"requirement" when it describes a lasting property of the product or the work (what it does, shows, stores, how it behaves, what must never happen). ' +
  'refines: the id of an existing requirement ONLY when this message explicitly revises that same requirement (same feature, new detail or correction). ' +
  'A different feature is a new item (refines null), even when it is related or touches the same screen. When in doubt, refines is null. ' +
  'conflicts: the id of an existing requirement this message contradicts (asks for the opposite, or for something both cannot be true at once), else null; ' +
  'conflict_reason: one short sentence saying what clashes. A refinement that simply replaces the old wording is not a conflict. ' +
  'revisit: when the user accepts something as good enough for now but names a time or condition to come back to it ("okay for now", "we can increase it later if…", "revisit when…"), that condition as a short phrase (e.g. "if contributor activity grows"); else null. Only when the message is about that very requirement; then set refines to it. ' +
  'Different properties are different requirements: how to install something and what it depends on, or what a page shows and how it looks, are separate items even when they touch the same thing. ' +
  'Read the message in the light of the agent\'s previous reply when one is given: it is usually a reaction to it. ' +
  'A request phrased as a question ("how do I make it…", "can we…", "could you…", "why isn\'t X…") IS a requirement: state the outcome the user wants. ' +
  '"Can we not get X", "couldn\'t we X", "why not X" and "shouldn\'t it X" ask FOR X: the title is X, never its opposite. ' +
  'A question about something that looks wrong ("why is it blank?", "why are there so many files?") asks for it to be fixed: a requirement. So is asking to be shown, opened or given something. ' +
  'Not requirements: questions asked only to understand how something works or what it costs, or to check whether something is possible or was done ("is that possible?", "did you overwrite X?"), approvals ("yes", "go ahead", "continue"), chit-chat, and messages that only report what happened or was decided (a status report, a message relayed from another session, "I chose not to do X"). ' +
  'If a message asks for a change, include it even when it is worded loosely. ' +
  'Examples. "Can we not show it in a separate window?" → [{"title":"Show it in a separate window"}]. ' +
  '"Why not keep the old colours?" → [{"title":"Keep the old colours"}]. ' +
  '"What does this cost per request?" → []. "How does the audit decide what is verified?" → []. ' +
  'With R12 "Install by pasting a few lines": "can we have a setup without node?" → [{"title":"Remove the Node dependency","refines":null}] (a new requirement, not a refinement of R12). ' +
  'Reply {"items":[]} when there is no requirement.'

// `lastReply` is the agent's previous answer: the message is often a reaction to it, and
// phrasings like "can we not get X" only read one way in context.
export function tagPrompt(existing: { id: string; title: string }[], text: string, lastReply = ''): string {
  const list = existing.length ? existing.map(r => `${r.id}: ${r.title}`).join('\n') : '(none)'
  const reply = lastReply.trim() ? `The agent's previous reply (context only, not requirements):\n${lastReply.trim().slice(-1500)}\n\n` : ''
  return `Existing requirements:\n${list}\n\n${reply}Message:\n${text}`
}

export function parseTagged(reply: string): Tagged[] {
  try {
    const json = reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1)
    const items = (JSON.parse(json) as { items?: Tagged[] }).items ?? []
    return items.filter(i => typeof i.title === 'string' && i.title.trim()).map(i => ({ ...i, kind: i.kind === 'step' ? 'step' as const : 'requirement' as const }))
  } catch {
    return []
  }
}

// ---------- a whole past conversation (/ledger import, rebuilt ledgers, /ledger refresh) ----------

// whileWorking: sent while the agent was busy (stored as a queued command, not a prompt).
export type PastPrompt = { at: number; text: string; lastReply: string; whileWorking?: boolean }
export type BackfillItem = { title: string; quote: string; msg: number; refines: string | null; status?: string }

// Three passes, each fed what it needs, so early requirements are never lost and every status
// is judged against everything that happened after the ask:
//   1. asks: the messages in chunks of 8, each given every requirement found so far;
//   2. gaps: all the developer's messages plus the whole ledger: what isn't covered yet;
//   3. status: the whole ledger plus every agent reply, in order: how far each one got.
const RULES =
  'A request phrased as a question ("how do I…", "can we…", "can we not get X" asking FOR X) is a requirement. ' +
  'A question about something that looks wrong ("why is it blank?", "why are there so many files?", "why do I see temp sessions?") asks for it to be fixed: a requirement. ' +
  'So is asking to be shown, opened or given something ("open it for me", "give me the exact file names"). ' +
  'Not requirements: questions asked only to understand how something works, whether something is possible ("is that possible?"), already true ("does it avoid X?") or already done ("did you overwrite X?", "did we track Y?"), approvals ("yes", "go ahead"), and chit-chat. ' +
  'Different properties are different requirements (how to install something vs what it depends on). '

export const ASKS_SYSTEM =
  'You keep a ledger of what a developer asked a coding agent for, reading their messages in order, a few at a time. ' +
  'You are given the requirements found so far and the next messages, each after a short excerpt of the agent reply it answers. ' +
  'Reply with JSON only: {"items":[{"title":string,"quote":string,"msg":number,"refines":string|null}]}: every NEW requirement in these messages. ' +
  'title: imperative, at most 12 words. quote: the exact words. msg: the message number. ' +
  'refines: the id of an existing requirement this message explicitly revises (same feature, new detail or correction), else null. ' +
  'A message can hold several requirements: list each. Do not repeat one already in the list. ' + RULES

export const GAPS_SYSTEM =
  'You check a requirements ledger against every message a developer sent a coding agent. ' +
  'Reply with JSON only: {"items":[{"title":string,"quote":string,"msg":number,"refines":null}]}: asks that NO ledger item covers. ' +
  'title: imperative, at most 12 words. quote: the exact words. msg: the message number. Merge duplicates. Reply {"items":[]} when everything is covered. ' + RULES

export const STATUS_SYSTEM =
  'You judge how far a coding agent got with each requirement in a ledger, from everything the agent said, in order. ' +
  'Reply with JSON only: {"progress":[{"id":string,"status":string,"why":string}]}, one entry for EVERY requirement. ' +
  'status, as the conversation stands at its end: "captured" (never started), "in_progress" (worked on, not finished), ' +
  '"implemented" (the agent did it or said it was done), "blocked" (it could not), "needs_clarification" (waiting on the developer). ' +
  'Work that was delivered but not yet tested is "implemented", not "in_progress". Something waiting for the developer to supply or decide is "needs_clarification"; ' +
  'something the agent tried and could not do (refused, failed, out of its reach) is "blocked". "in_progress" only when work started and is unfinished at the end. ' +
  'A decision that was only written down, with nothing built, is "captured". Work still running or unchecked when the conversation ends (a render in flight, a fix not yet confirmed) is "in_progress", not "implemented". ' +
  'Never "verified". A requirement later withdrawn or replaced by the developer is "implemented" only if what replaced it was done; else "captured". ' +
  'why: one short sentence of evidence, naming the message it comes from.'

export type LedgerItem = { id: string; title: string; status: string; at: number; quote: string; refinements: { at: number; text: string }[]; why?: string }
// A model call's answer, or why there was none (a rate limit, a timeout…), kept so a failed
// import can say what went wrong. `undefined` is a plain no answer.
export type NoAnswer = { reason: string }
export type Complete = (system: string, prompt: string, maxTokens: number) => Promise<string | NoAnswer | undefined>
const answered = (r: string | NoAnswer | undefined): r is string => typeof r === 'string'
const noAnswer = (r: string | NoAnswer | undefined) => `no answer${r && typeof r === 'object' && r.reason ? ` (${r.reason})` : ''}`
export type PastReply = { at: number; text: string }

const ASK_CHUNK = 8
const ledgerList = (items: LedgerItem[], withStatus = false) =>
  items.length ? items.map(r => `${r.id}${withStatus ? ` [${r.status}]` : ''}: ${r.title}`).join('\n') : '(none yet)'

export function asksPrompt(known: LedgerItem[], prompts: PastPrompt[], start: number): string {
  const msgs = prompts
    .map((p, i) => `${p.lastReply ? `[agent before message ${start + i + 1}]: ${p.lastReply.slice(-600)}\n` : ''}[message ${start + i + 1}]: ${p.text}`)
    .join('\n\n')
  return `Requirements so far:\n${ledgerList(known)}\n\nNext messages:\n${msgs}`
}

export function gapsPrompt(known: LedgerItem[], prompts: PastPrompt[], start: number): string {
  const msgs = prompts.map((p, i) => `[message ${start + i + 1}]: ${p.text.slice(0, 2000)}`).join('\n\n')
  return `Ledger:\n${ledgerList(known)}\n\nThe developer's messages:\n${msgs}`
}

// The conversation for judging status: each message (short) and every agent reply after it.
export function statusPrompt(known: LedgerItem[], prompts: PastPrompt[], replies: PastReply[], from = 0, to = prompts.length): string {
  const parts: string[] = []
  for (let i = from; i < to; i++) {
    const p = prompts[i]!
    const next = prompts[i + 1]?.at ?? Number.POSITIVE_INFINITY
    parts.push(`[message ${i + 1}]: ${p.text.slice(0, 400)}`)
    for (const r of replies) if (r.at >= p.at && r.at < next) parts.push(`[agent]: ${r.text.slice(0, 1800)}`)
  }
  return `Ledger, with the status so far:\n${ledgerList(known, true)}\n\nThe conversation:\n${parts.join('\n\n')}`
}

const parseItems = (reply: string): BackfillItem[] => {
  let raw: { items?: unknown } = {}
  try {
    raw = JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1))
  } catch {
    // A reply cut off mid-list: keep every item that arrived whole.
    raw = { items: [...reply.matchAll(/\{[^{}]*"title"[^{}]*\}/g)].flatMap(m => { try { return [JSON.parse(m[0])] } catch { return [] } }) }
  }
  return (Array.isArray(raw.items) ? raw.items : []).filter((i): i is BackfillItem => typeof i?.title === 'string' && i.title.trim() && Number.isInteger(i?.msg))
}

export function parseChunk(reply: string): { items: BackfillItem[]; progress: Progress[] } {
  let progress: Progress[] = []
  try {
    progress = progressFrom((JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1)) as { progress?: unknown }).progress)
  } catch { /* none */ }
  return { items: parseItems(reply), progress }
}

function addItems(items: LedgerItem[], found: BackfillItem[], prompts: PastPrompt[], counter: { n: number }) {
  for (const it of found) {
    const at = prompts[it.msg - 1]?.at ?? 0
    const target = it.refines ? items.find(x => x.id === it.refines) : undefined
    if (target) target.refinements.push({ at, text: it.quote || it.title })
    else items.push({ id: `R${++counter.n}`, title: it.title, status: 'captured', at, quote: it.quote || it.title, refinements: [] })
  }
}

// Builds a ledger from a whole conversation (or, with `seed` and addNew false, re-judges an existing
// one). Fails as a whole if any call gets no answer: a half-read ledger looks complete and isn't.
export async function buildLedger(
  prompts: PastPrompt[], replies: PastReply[], complete: Complete, opts: { seed?: LedgerItem[]; addNew?: boolean } = {},
): Promise<{ items: LedgerItem[]; failed?: string }> {
  const items: LedgerItem[] = (opts.seed ?? []).map(r => ({ ...r, refinements: [...r.refinements] }))
  const counter = { n: items.reduce((n, r) => Math.max(n, Number(r.id.slice(1)) || 0), 0) }
  if (opts.addNew !== false) {
    // 1. asks
    for (let start = 0; start < prompts.length; start += ASK_CHUNK) {
      const reply = await complete(ASKS_SYSTEM, asksPrompt(items, prompts.slice(start, start + ASK_CHUNK), start), 4000)
      if (!answered(reply)) return { items, failed: `${noAnswer(reply)} for messages ${start + 1}-${Math.min(start + ASK_CHUNK, prompts.length)}` }
      addItems(items, parseItems(reply), prompts, counter)
    }
    // 2. gaps: a dozen messages at a time against the whole ledger (wider slices let asks slip)
    const GAP = 12
    for (let start = 0; start < prompts.length; start += GAP) {
      const reply = await complete(GAPS_SYSTEM, gapsPrompt(items, prompts.slice(start, start + GAP), start), 4000)
      if (!answered(reply)) return { items, failed: `${noAnswer(reply)} checking messages ${start + 1}-${Math.min(start + GAP, prompts.length)} for gaps` }
      addItems(items, parseItems(reply).filter(i => !i.refines).map(i => ({ ...i, msg: i.msg })), prompts, counter)
    }
  }
  if (!items.length) return { items }
  // 3. status
  const failed = await judgeStatuses(items, prompts, replies, complete)
  return failed ? { items, failed } : { items }
}

// Judges every requirement's status against the whole conversation: all at once if it fits, else
// in order, carrying statuses forward. Used by rebuilds, /ledger refresh, and every few turns live.
export async function judgeStatuses(items: LedgerItem[], prompts: PastPrompt[], replies: PastReply[], complete: Complete): Promise<string | undefined> {
  const SLICE = 30
  for (let from = 0; from < prompts.length; from += SLICE) {
    const reply = await complete(STATUS_SYSTEM, statusPrompt(items, prompts, replies, from, Math.min(prompts.length, from + SLICE)), 8000)
    if (!answered(reply)) return `${noAnswer(reply)} judging status for messages ${from + 1}-${Math.min(prompts.length, from + SLICE)}`
    for (const p of parseChunk(reply).progress) {
      const r = items.find(x => x.id === p.id)
      // Keep the evidence from when the status last changed; a later slice with nothing new keeps it.
      if (r && (p.status !== r.status || !r.why)) { r.status = p.status; r.why = p.why }
    }
  }
  return undefined
}

// A session's own record of its turns (kept by the plugin from its hooks, no transcript needed),
// in the shape the status pass reads.
export type Turn = { at: number; ask: string; answer: string }
export const turnsAsConversation = (turns: Turn[]): { prompts: PastPrompt[]; replies: PastReply[] } => ({
  prompts: turns.map(t => ({ at: t.at, text: t.ask, lastReply: '' })),
  replies: turns.filter(t => t.answer).map(t => ({ at: t.at + 1, text: t.answer })),
})

// ---------- progress: what the agent's work moved, judged by Haiku ----------

// Haiku never says verified: that still needs a passing check or the person's acceptance.
export const PROGRESS = ['captured', 'in_progress', 'implemented', 'blocked', 'needs_clarification'] as const
export type ProgressStatus = (typeof PROGRESS)[number]
export type Progress = { id: string; status: ProgressStatus; why: string }

function progressFrom(raw: unknown): Progress[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((p): p is Progress => typeof p?.id === 'string' && (PROGRESS as readonly string[]).includes(p?.status) && typeof p?.why === 'string')
}




// ---------- after each turn: what the agent found, and whether it went against a requirement ----------

export type OnYou = { text: string; kind: 'decision' | 'blocker' | 'manual'; id?: string }
export type TurnReview = {
  findings: { text: string }[]
  conflicts: { id: string; reason: string }[]
  progress: Progress[]
  // What the agent said only the person can do: a decision to make, something blocking on
  // them (run a command, grant access), or a check by hand.
  onYou: OnYou[]
}

export const REVIEW_SYSTEM =
  'You review a coding agent\'s report to its user for things the user would want to act on and might miss in a long chat. ' +
  'Reply with JSON only: {"findings":[{"text":string}],"on_you":[{"text":string,"kind":"decision"|"blocker"|"manual","id":string|null}],"conflicts":[{"id":string,"reason":string}],"progress":[{"id":string,"status":string,"why":string}]}. ' +
  'findings: at most 3, each one sentence, ONLY: a failure or error the agent hit, data lost or at risk, a part of what was asked that it skipped or left undone, ' +
  'or a decision it made on its own that changes what the user asked for. ' +
  'Not findings: how the agent worked (how many times it did something, what it cited, how it measured), its reasoning or caveats, routine progress, plans, or restating the request. ' +
  'on_you: what the report says only the user can do, each one sentence with the requirement id when there is one: "decision" (a choice the agent asks the user to make), ' +
  '"blocker" (something the user must run, grant, provide or approve before work can go on or ship, such as a command the agent is not allowed to run), ' +
  '"manual" (a check the user should do by hand). Only what the report states; never invent one. ' +
  'conflicts: requirements (by id) that what the agent did goes against, with a one-sentence reason. The user\'s own words are what was asked: a question the user asked ' +
  '("why is X?") is not an instruction to change X, and a rename, removal or substitution the user asked for is not a conflict with the old wording. ' +
  'progress: requirements whose status this turn changed, judged from the report and the work list: "in_progress" (worked on, not finished), ' +
  '"implemented" (finished, or the agent says it is done), "blocked" (it could not), "needs_clarification" (it is waiting on the user). ' +
  'Use the developer\'s message that started the turn to see which requirements the turn was about. A summary, audit or status report in the reply that says items are done ' +
  '(or blocked, or waiting) counts for EVERY requirement it covers, not just the latest one. Include each requirement whose status should change; never "verified". why: one short sentence. ' +
  'Reply {"findings":[],"on_you":[],"conflicts":[],"progress":[]} when there is nothing.'

export function reviewPrompt(reqs: { id: string; title: string; status?: string }[], answer: string, work: string[] = [], ask = ''): string {
  const list = reqs.length ? reqs.map(r => `${r.id}${r.status ? ` [${r.status}]` : ''}: ${r.title}`).join('\n') : '(none)'
  const asked = ask.trim() ? `\n\nThe developer's message that started this turn:\n${ask.trim().slice(0, 3000)}` : ''
  const done = work.length ? `\n\nWhat the agent did this turn:\n${work.slice(-40).join('\n')}` : ''
  return `Requirements, with their current status:\n${list}${asked}${done}\n\nThe agent's report:\n${answer.slice(-6000)}`
}

export function parseReview(reply: string): TurnReview {
  try {
    const json = reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1)
    const r = JSON.parse(json) as Partial<TurnReview> & { on_you?: { text?: unknown; kind?: unknown; id?: unknown }[] }
    const onYou: OnYou[] = (Array.isArray(r.on_you) ? r.on_you : [])
      .filter(o => typeof o?.text === 'string' && (o.text as string).trim() && ['decision', 'blocker', 'manual'].includes(String(o?.kind)))
      .map(o => ({ text: (o.text as string).trim(), kind: o.kind as OnYou['kind'], id: typeof o.id === 'string' && /^R\d+$/.test(o.id) ? o.id : undefined }))
    return {
      findings: (r.findings ?? []).filter(f => typeof f?.text === 'string' && f.text.trim()).slice(0, 3),
      conflicts: (r.conflicts ?? []).filter(c => typeof c?.id === 'string' && typeof c?.reason === 'string'),
      progress: progressFrom(r.progress),
      onYou,
    }
  } catch {
    return { findings: [], conflicts: [], progress: [], onYou: [] }
  }
}

// ---------- research and writing: an audit by another model ----------

export type AuditItem = { id: string; cleared: boolean; note: string }

export const AUDIT_SYSTEM =
  'You are an adversarial auditor of research and writing produced by an AI agent. For each item you are given the claim (what the user asked for) ' +
  'and the agent\'s answer with the sources it attached. Find gaps, misattributions, unsupported claims, numbers without a source, sources that do not say what is claimed, ' +
  'and parts of the ask left unanswered. Be strict: an item is cleared only when every factual claim in the answer is supported by an attached source and the ask is fully answered. ' +
  'Reply with JSON only: {"items":[{"id":string,"cleared":boolean,"note":string}]}. note: one or two sentences naming the gap, or what was checked when cleared.'

export function auditPrompt(items: { id: string; title: string; sources: string[]; answer: string }[]): string {
  return items.map(it => `### ${it.id}: ${it.title}\nSources attached:\n${it.sources.length ? it.sources.map(s => `- ${s}`).join('\n') : '(none)'}\n\nThe agent's answer:\n${it.answer.slice(-5000)}`).join('\n\n')
}

export function parseAudit(reply: string): AuditItem[] {
  try {
    const json = reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1)
    const items = (JSON.parse(json) as { items?: Partial<AuditItem>[] }).items ?? []
    return items.filter(i => typeof i.id === 'string' && typeof i.cleared === 'boolean').map(i => ({ id: i.id as string, cleared: i.cleared as boolean, note: String(i.note ?? '') }))
  } catch {
    return []
  }
}

// ---------- the files a session created: what each is for ----------

export type FileNote = { path: string; why: string; contains: string; use: string }

export const FILES_SYSTEM =
  'You describe files an AI coding agent created during a work session, for the person it works for. For each file you get its path, the start of its contents, ' +
  'and the message the person had sent when it was created. Reply with JSON only: {"files":[{"path":string,"why":string,"contains":string,"use":string}]}. ' +
  'why: why it was created, one short sentence. contains: what is in it, one short sentence (say "binary" or "empty" when so). ' +
  'use: what it is for in this session now: "part of the product", "a test", "a one-off script", "scratch output", "a report for the person", "a download", "unknown". Plain words, no speculation beyond the contents.'

export function filesPrompt(files: { path: string; head: string; ask: string }[]): string {
  return files.map(f => `### ${f.path}\nMessage at the time: ${f.ask.slice(0, 400) || '(none)'}\nContents start:\n${f.head.slice(0, 1600)}`).join('\n\n')
}

export function parseFiles(reply: string): FileNote[] {
  try {
    const json = reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1)
    const items = (JSON.parse(json) as { files?: Partial<FileNote>[] }).files ?? []
    return items.filter(i => typeof i.path === 'string').map(i => ({ path: i.path as string, why: String(i.why ?? ''), contains: String(i.contains ?? ''), use: String(i.use ?? '') }))
  } catch {
    return []
  }
}
