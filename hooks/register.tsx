import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type {
  ActivityEvent,
  Delivery,
  EventKind,
  Filter,
  Reply,
  ReplyMode,
  PlanStep,
  Preview,
  ReqFilter,
  ReqStatus,
  Requirement,
  Signal,
  SignalKind,
  Theme,
  View,
} from '../types'
import { REVIEW_SYSTEM, TAG_SYSTEM, buildLedger, judgeStatuses, parseReview, parseTagged, reviewPrompt, tagPrompt, turnsAsConversation } from './tagging'
import type { Complete, LedgerItem, PastPrompt, Progress, Tagged, Turn } from './tagging'
import { PLAN_TOOLS, REQ_FILTERS, failureText, filterReqs, gapOf, humanText, isSecretPath, linker, planFrom, previewUrls, trimEvents } from './work'
import type { ReqFilterName } from './work'
import { RELEASE } from './release'
import { FIND_SELF, duKb, fmtKb, treeRss, workspaceOf } from './footprint'
import type { Footprint } from './footprint'
import { EDITORS, LINUX, MAC, WINDOWS, base, firstLine, join, launchCommand, programName } from './platform'
import type { Editor, OS, Platform, Terminal } from './platform'
import {
  DEFAULT_THEME, IMPORT_SYSTEM, PRESETS, colourLines, normalizeTheme, ownThemeFile, pageParts, palette, sourceKind, themeFromReply, toneBg, toneFg,
} from './theme'
import type { Tone } from './theme'

type $T = EngineInterface

const PANE = 'ledger'
const TOOL = 'mcp__principia__ledger'
const HAIKU = 'claude-haiku-5-5'
const HUMAN = new Set(['composer', 'bridge', 'sdk'])
const TEST_RE = /\b(test|tests|jest|vitest|pytest|mix test|rspec|playwright|cypress|tsc|typecheck|lint|eslint|build|check|cargo check|go vet)\b/i

const DEFAULT_VIEW: View = {
  tab: 'reqs',
  mode: 'comment',
  refines: 'new',
  interrupt: false,
  filter: 'key',
  dark: true,
}

const reqsA = atom({ plugin: 'principia', key: 'reqs' } as const, [] as Requirement[])
const eventsA = atom({ plugin: 'principia', key: 'events' } as const, [] as ActivityEvent[])
const repliesA = atom({ plugin: 'principia', key: 'replies' } as const, [] as Reply[])
const viewA = atom({ plugin: 'principia', key: 'view' } as const, DEFAULT_VIEW)
const turnA = atom({ plugin: 'principia', key: 'turnId' } as const, '')
const inboxSeqA = atom({ plugin: 'principia', key: 'inboxSeq' } as const, 0)
const titleA = atom({ plugin: 'principia', key: 'title' } as const, '')
const themeA = atom({ plugin: 'principia', key: 'theme' } as const, DEFAULT_THEME)
const signalsA = atom({ plugin: 'principia', key: 'signals' } as const, [] as Signal[])
const planA = atom({ plugin: 'principia', key: 'plan' } as const, [] as PlanStep[])
const previewsA = atom({ plugin: 'principia', key: 'previews' } as const, [] as Preview[])
// Whether this session has ever drawn the pane: a headless run (claude -p, the SDK) never does,
// whatever its environment says, so the window can leave it out.
const drawnA = atom({ plugin: 'principia', key: 'drawn' } as const, false)
// Every turn's message and reply, so statuses can be re-judged against the whole session.
const turnsA = atom({ plugin: 'principia', key: 'turns' } as const, [] as Turn[])
// What this session costs the computer: memory held now, files left behind (see footprint.ts).
const footprintA = atom({ plugin: 'principia', key: 'footprint' } as const, undefined as Footprint | undefined)
const CONSOLIDATE_EVERY = 6

const STATUS: Record<ReqStatus, { label: string; tone: Tone }> = {
  captured: { label: 'Not started', tone: 'muted' },
  in_progress: { label: 'In progress', tone: 'active' },
  implemented: { label: 'Done, not verified', tone: 'warn' },
  verified: { label: 'Verified', tone: 'done' },
  blocked: { label: 'Blocked', tone: 'danger' },
  needs_clarification: { label: 'Needs you', tone: 'warn' },
  deferred: { label: 'Deferred', tone: 'muted' },
  revisit: { label: 'Done for now · revisit', tone: 'done' },
}

const KIND: Record<EventKind, { label: string; tone: Tone }> = {
  discovery: { label: 'Discovery', tone: 'muted' },
  plan: { label: 'Plan', tone: 'active' },
  code: { label: 'Code change', tone: 'active' },
  command: { label: 'Command', tone: 'muted' },
  test: { label: 'Test', tone: 'warn' },
  message: { label: 'Agent message', tone: 'active' },
}

const DELIVERY: Record<Delivery, string> = {
  kept: 'Comment · not sent to agent',
  queued: 'Queued · goes with your next prompt',
  received: 'Received by agent',
  acted: 'Agent finished a turn after receiving it',
  failed: 'Not delivered',
}

// Found on the machine at session start; module state is fine because
// session.start runs again on every reload.
let plat: Platform = { os: 'mac', tmp: '/tmp/principia', data: '', runner: [], editors: [] }
let storeKey = ''
let sessionId = ''
let project = ''
let sessionRoot = '' // the session's folder, for the footprint
let entry = '' // how the session was started: claude-desktop, cli, sdk-cli (headless)…
let hasEnded = false
let turnStartedAt = 0
let turnAsk = '' // the message that started the current turn, for the review
// The requirements this turn works on: the ones your message touched, the ones the agent reports
// on and the plan's current step serves. Every event and signal of the turn is linked to them.
const turnReqs = new Set<string>()
const linkReqs = (ids: string[]) => { for (const id of ids) if (/^R\d+$/.test(id)) turnReqs.add(id) }
let tmpRoot = ''
const stateFile = () => join(plat.data, `state-${sessionId}.json`)
const inboxFile = () => join(plat.data, `inbox-${sessionId}.jsonl`)
const snapOf = (ev: ActivityEvent) => join(plat.data, 'snapshots', `${ev.id}-${base(ev.file ?? '')}`)
const programArgs = (...rest: string[]) => [...plat.runner, ...rest]

const now = () => Date.now()
const hhmm = (t: number) => {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const nextId = (reqs: Requirement[]) => `R${reqs.length + 1}`
// The app lists sessions without a project folder under "This computer".
const projectName = (dir: string) => (/[\\/]scratch-workspaces[\\/]/.test(dir) ? 'This computer' : base(dir))
const uid = () => `${now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const isDone = (r: Requirement) => (r.status === 'verified' && !r.needsReverify) || r.status === 'deferred' || r.status === 'revisit'

// The terminal window reads this file; it holds nothing the session state doesn't.
async function mirror($: $T) {
  if (!sessionId) return
  try {
    const [reqs, replies, events, turnId, title, theme, view, signals, plan, previews, drawn] = await Promise.all([
      read($, reqsA), read($, repliesA), read($, eventsA), read($, turnA), read($, titleA), read($, themeA), read($, viewA),
      read($, signalsA), read($, planA), read($, previewsA), read($, drawnA),
    ])
    const turns = await read($, turnsA)
    const footprint = await read($, footprintA)
    // Work that finishes after the session has gone (a review still running when you quit) sees
    // empty state; writing that would wipe the ledger, so an empty ledger never replaces a full one.
    if (!reqs.length && !events.length) {
      const onDisk = await $.fs.read(stateFile()).then(t => JSON.parse(t) as { reqs?: unknown[]; events?: unknown[] }).catch(() => undefined)
      if (onDisk?.reqs?.length || onDisk?.events?.length) return
    }
    await $.fs.write(stateFile(), JSON.stringify({
      sessionId, project, cwd: sessionRoot, footprint, title, hasEnded, entry, drawn, turns: turns.slice(-400),
      reqs, replies, events: trimEvents(events), signals: signals.slice(-100), plan, previews,
      isWorking: Boolean(turnId) && !hasEnded, editors: plat.editors, snapDir: join(plat.data, 'snapshots'), theme, dark: view.dark, at: now(),
      transcriptsAllowed: await transcriptsAllowed($),
    }))
  } catch {
    // the window just shows the last state it read
  }
}

async function save($: $T) {
  await mirror($)
  if (!storeKey) return
  try {
    const [reqs, replies, events, signals, plan] = await Promise.all([read($, reqsA), read($, repliesA), read($, eventsA), read($, signalsA), read($, planA)])
    if (!reqs.length && !events.length) return // as in mirror: nothing to keep, and maybe state already gone
    // The store holds 4 MiB in all: 12 sessions of trimmed history fit with room to spare.
    const lean = events.slice(-80).map(ev => (ev.detail && ev.detail.length > 400 ? { ...ev, detail: `${ev.detail.slice(0, 399)}…` } : ev))
    await $.store.set(storeKey, { reqs, replies: replies.slice(-60), events: lean, signals: signals.slice(-40), plan, inboxSeq: await read($, inboxSeqA) })
    const keys = (await $.store.keys()).filter(k => k.startsWith('s:'))
    for (const k of keys.slice(0, Math.max(0, keys.length - 12))) await $.store.delete(k)
  } catch {
    // persistence is best effort; the session state still holds everything
  }
}

async function pushEvent($: $T, ev: ActivityEvent) {
  const linked = turnReqs.size && !ev.reqIds ? { ...ev, reqIds: [...turnReqs] } : ev
  await update($, eventsA, list => trimEvents([...list, linked]))
  await mirror($)
}

async function patchEvent($: $T, id: string, patch: Partial<ActivityEvent>) {
  await update($, eventsA, list => list.map(ev => (ev.id === id ? { ...ev, ...patch } : ev)))
  await mirror($)
}

async function addSignal($: $T, kind: SignalKind, text: string, link: Pick<Signal, 'eventId' | 'reqId' | 'context'> = {}) {
  const reqId = link.reqId ?? (turnReqs.size === 1 ? [...turnReqs][0] : undefined)
  await update($, signalsA, list => [...list, { id: uid(), kind, at: now(), text, ...link, reqId }].slice(-150))
  await mirror($)
}

// What the agent did in a turn, as short lines for the review.
const workOf = (events: ActivityEvent[], since: number) => events
  .filter(ev => ev.at >= since && (ev.kind === 'code' || ev.kind === 'test' || ev.kind === 'command'))
  .map(ev => `${KIND[ev.kind].label}: ${ev.title}${ev.state === 'failed' ? ' (failed)' : ev.kind === 'test' && ev.state === 'ok' ? ' (passed)' : ''}`)

async function consolidate($: $T) {
  try {
    const reqs = await read($, reqsA)
    const open = reqs.filter(r => !((r.status === 'verified' && !r.needsReverify) || r.status === 'deferred' || r.status === 'revisit'))
    if (!open.length) return
    // The whole conversation when you've allowed reading transcripts; else the turns seen live.
    const [past] = (await transcriptsAllowed($)) ? await readPast($, ['--session', sessionId]).catch(() => []) : []
    const { prompts, replies } = past?.prompts.length ? past : turnsAsConversation(await read($, turnsA))
    const items = open.map(asLedgerItem)
    if (await judgeStatuses(items, prompts, replies, haiku($))) return
    const progress = items
      .filter(it => open.find(r => r.id === it.id)?.status !== it.status)
      .map(it => ({ id: it.id, status: it.status as Progress['status'], why: it.why ?? 'judged from the session so far' }))
    if (await applyProgress($, progress, 'Judged from the session so far')) await save($)
  } catch {
    // the next consolidation tries again
  }
}

// Statuses judged by Haiku from the agent's report or the conversation. Verified, deferred and
// done-for-now are the person's or the evidence's call, so they're never moved this way.
async function applyProgress($: $T, progress: Progress[], from: string): Promise<number> {
  let moved = 0
  await update($, reqsA, (list): Requirement[] => list.map(r => {
    const p = progress.find(x => x.id === r.id)
    const settled = (r.status === 'verified' && !r.needsReverify) || r.status === 'deferred' || r.status === 'revisit'
    if (!p || settled || p.status === r.status) return r
    moved++
    return { ...renudge(r, p.status), status: p.status, evidence: [...r.evidence, { kind: 'note' as const, at: now(), text: `${from}: ${p.why}` }] }
  }))
  return moved
}

// Returns the requirements the turn worked on, as the review judged them.
async function review($: $T, answer: string, eventId: string, work: string[], ask: string): Promise<string[]> {
  try {
    const reqs = (await read($, reqsA)).filter(r => r.status !== 'deferred')
    const res = await $.model.complete({ model: HAIKU, system: REVIEW_SYSTEM, prompt: reviewPrompt(reqs, answer, work, ask), maxTokens: 2000 })
    if (!res.isAnswered) return []
    const { findings, conflicts: against, progress } = parseReview(res.text)
    await applyProgress($, progress, "Judged from the agent's report")
    const context = { ask: clip(ask, 600), did: work.slice(-8).join('\n'), output: clip(answer, 800) }
    for (const f of findings) await addSignal($, 'finding', f.text, { eventId, context })
    for (const c of against) {
      if (!reqs.some(r => r.id === c.id)) continue
      await update($, reqsA, (list): Requirement[] => list.map(r => (r.id === c.id ? { ...r, conflict: { reason: c.reason, at: now(), source: 'agent' } } : r)))
      await addSignal($, 'conflict', `The agent's work goes against ${c.id}: ${c.reason}`, { eventId, reqId: c.id, context })
    }
    await save($)
    return [...progress.map(p => p.id), ...against.map(c => c.id)]
  } catch {
    // no review this turn
    return []
  }
}

// Links what happened in a turn to the requirements it worked on, once they're all known.
async function linkTurn($: $T, since: number, until: number, ids: string[]) {
  if (!ids.length) return
  const add = (have?: string[]) => [...new Set([...(have ?? []), ...ids])]
  await update($, eventsA, list => list.map(ev => (ev.at >= since && ev.at <= until ? { ...ev, reqIds: add(ev.reqIds) } : ev)))
  if (ids.length === 1) await update($, signalsA, list => list.map(x => (x.at >= since && x.at <= until && !x.reqId ? { ...x, reqId: ids[0] } : x)))
  await mirror($)
}

// ---------- requirement tagging (Haiku) ----------

async function tag($: $T, text: string, reqs: Requirement[]): Promise<Tagged[]> {
  const lastReply = [...(await read($, eventsA))].reverse().find(ev => ev.kind === 'message')?.detail ?? ''
  const res = await $.model.complete({ model: HAIKU, system: TAG_SYSTEM, prompt: tagPrompt(reqs, text, lastReply), maxTokens: 2000 })
  return res.isAnswered ? parseTagged(res.text) : []
}

// The conflicts the last captured message raised; cleared for every message, tagged or not.
const conflicts: { id: string; reason: string }[] = []

async function capture($: $T, text: string): Promise<string[]> {
  conflicts.length = 0
  const reqs = await read($, reqsA)
  const tagged = await tag($, text, reqs)
  if (!tagged.length) return []
  const touched: string[] = []
  await update($, reqsA, list => {
    let out = [...list]
    for (const t of tagged) {
      const clash = t.conflicts ? out.find(r => r.id === t.conflicts) : undefined
      if (clash && t.conflict_reason) {
        conflicts.push({ id: clash.id, reason: t.conflict_reason })
        out = out.map(r => (r.id === clash.id ? { ...r, conflict: { reason: t.conflict_reason ?? '', at: now(), source: 'you' as const } } : r))
      }
      const target = t.refines ? out.find(r => r.id === t.refines) : undefined
      const version = { at: now(), text: t.quote || t.title, kind: target ? 'refinement' : 'original', by: 'you' } as const
      if (target && t.revisit) {
        // "Good enough for now, revisit if…": done, with your condition kept.
        out = out.map(r => (r.id === target.id ? { ...r, history: [...r.history, version], status: 'revisit', revisit: t.revisit ?? '', needsReverify: undefined } : r))
        touched.push(`${target.id} (done for now; revisit ${t.revisit}): ${t.title}`)
        continue
      }
      if (target) {
        const wasDone = target.status === 'implemented' || target.status === 'verified'
        out = out.map(r =>
          r.id === target.id
            ? { ...r, history: [...r.history, version], needsReverify: wasDone || r.needsReverify, status: wasDone ? 'in_progress' : r.status, nudgedAt: wasDone ? undefined : r.nudgedAt }
            : r,
        )
        touched.push(`${target.id} (refined): ${t.title}`)
      } else {
        const id = nextId(out)
        out = [...out, { id, title: t.title, status: 'captured', at: now(), history: [version], evidence: [] }]
        touched.push(`${id}: ${t.title}`)
      }
    }
    return out
  })
  for (const c of conflicts) await addSignal($, 'conflict', `Your message conflicts with ${c.id}: ${c.reason}`, { reqId: c.id })
  return touched
}

// ---------- activity events from tool calls ----------

function describe(e: Record<string, unknown>, when?: number): ActivityEvent | undefined {
  const tool = String(e.tool)
  const id = String(e.tool_use_id)
  const at = when ?? now()
  const s = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : '')
  switch (tool) {
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit': {
      const file = s('file_path') || s('notebook_path')
      return { id, kind: 'code', at, title: `${tool === 'Write' ? 'Wrote' : 'Edited'} ${base(file)}`, file, state: 'running' }
    }
    case 'Bash': {
      const cmd = s('command')
      const kind: EventKind = TEST_RE.test(cmd) ? 'test' : 'command'
      return { id, kind, at, title: s('description') || clip(cmd, 80), detail: cmd, state: 'running' }
    }
    case 'Read':
      return { id, kind: 'discovery', at, title: `Read ${base(s('file_path'))}`, file: s('file_path') }
    case 'Grep':
    case 'Glob':
      return { id, kind: 'discovery', at, title: `Searched “${clip(s('pattern'), 50)}”` }
    case 'WebFetch':
    case 'WebSearch':
      return { id, kind: 'discovery', at, title: clip(s('url') || s('query'), 80) }
    case 'TodoWrite': {
      const todos = Array.isArray(e.todos) ? (e.todos as { content?: string; status?: string }[]) : []
      const detail = todos.map(t => `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '›' : '·'} ${t.content ?? ''}`).join('\n')
      return { id, kind: 'plan', at, title: 'Plan updated', detail }
    }
    case 'mcp__ccd_turn__update_plan': {
      const items = Array.isArray(e.items) ? (e.items as { content?: string; status?: string }[]) : []
      const detail = items.map(t => `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '›' : '·'} ${t.content ?? ''}`).join('\n')
      return { id, kind: 'plan', at, title: 'Plan updated', detail }
    }
    case 'ExitPlanMode':
      return { id, kind: 'plan', at, title: 'Plan proposed', detail: clip(s('plan'), 1500) }
    case 'Agent':
    case 'Task':
      return { id, kind: 'plan', at, title: `Subagent: ${clip(s('description'), 60)}`, state: 'running' }
    default:
      return undefined
  }
}

async function snapshot($: $T, ev: ActivityEvent) {
  if (!ev.file || isSecretPath(ev.file)) return
  try {
    const exists = await $.fs.exists(ev.file)
    const text = exists ? String(await $.fs.read(ev.file)) : ''
    await $.fs.write(snapOf(ev), text)
  } catch {
    // no snapshot: the diff button falls back to opening the file
  }
}

async function openDiff($: $T, ev: ActivityEvent, how: string) {
  if (!ev.file) return
  // Never read or show a file that may hold secrets, not even as a diff.
  if (isSecretPath(ev.file)) return void $.ui.toast(`${base(ev.file)} may hold secrets, so Principia doesn't open its diff.`)
  const snap = snapOf(ev)
  const hasSnap = await $.fs.exists(snap).catch(() => false)
  if (how === 'terminal') {
    const term = await chosenTerminal($)
    if (!term || !plat.runner.length) return void $.ui.toast('The Principia program is not installed: run /ledger install.')
    const err = await openIn($, term, programArgs('diff', hasSnap ? snap : '', ev.file), 'Principia diff')
    if (err) await $.ui.toast(`Could not open the diff: ${err}`)
    return
  }
  const ed = plat.editors.find(x => x.name === how)
  if (!ed) return
  // Editor CLIs on Windows are .cmd scripts, which need the shell.
  const argv = hasSnap ? [ed.bin, '--diff', snap, ev.file] : [ed.bin, '-g', ev.file]
  await $.process.run(plat.os === 'windows' ? ['cmd', '/c', ...argv] : argv)
}

// ---------- the machine: OS, Node, editors, terminals ----------

async function run($: $T, argv: string[]) {
  try {
    return await $.process.run(argv, { timeoutMs: 8000 })
  } catch {
    return undefined
  }
}

// Finds a command on PATH the way the person's own shell would.
async function which($: $T, os: OS, name: string): Promise<string> {
  if (os === 'windows') {
    const r = await run($, ['where', name])
    return r?.exitCode === 0 ? firstLine(r.stdout) : ''
  }
  // A login shell first, then an interactive one: nvm and friends often live in .zshrc / .bashrc.
  const shell = (await $.env.get('SHELL')) || '/bin/zsh'
  for (const flags of ['-lc', '-ilc']) {
    const r = await run($, [shell, flags, `command -v ${name}`])
    const found = r?.exitCode === 0 ? firstLine(r.stdout.trim().split('\n').pop()) : ''
    if (found.startsWith('/')) return found
  }
  return ''
}

// The principia program (window, importer, diff): the downloaded release for this
// machine, or, when developing Principia, its source run with Bun.
async function findProgram($: $T, os: OS, data: string): Promise<string[]> {
  const arch = firstLine((await run($, os === 'windows' ? ['cmd', '/c', 'echo', '%PROCESSOR_ARCHITECTURE%'] : ['uname', '-m']))?.stdout)
  const bin = join(data, 'bin', `${RELEASE.version}-${programName(os, arch)}`)
  if (await $.fs.exists(bin).catch(() => false)) return [bin]
  const source = join($.plugin.root, 'viewer/cli.mjs')
  const bun = await which($, os, 'bun')
  if (bun && (await $.fs.exists(source).catch(() => false))) return [bun, source]
  return []
}

async function detect($: $T): Promise<Platform> {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const os: OS = isWindows ? 'windows' : firstLine((await run($, ['uname', '-s']))?.stdout) === 'Darwin' ? 'mac' : 'linux'
  tmpRoot = isWindows
    ? (await $.env.get('TEMP')) || (await $.env.get('TMP')) || 'C:/Windows/Temp'
    : (await $.env.get('TMPDIR')) || '/tmp'
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || join((await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || '', '.claude')
  const data = join(config, 'principia')
  // Ledgers kept under the old name (Praetorium, up to 0.3.8) move over once, folder and all.
  const old = join(config, 'praetorium')
  if (!(await $.fs.exists(data).catch(() => true)) && (await $.fs.exists(old).catch(() => false))) {
    await run($, isWindows ? ['cmd', '/c', 'move', '/y', old.replace(/\//g, '\\'), data.replace(/\//g, '\\')] : ['mv', old, data])
  }
  const editors: Editor[] = []
  for (const [name, cmd, macBin] of EDITORS) {
    const bin = os === 'mac' && (await $.fs.exists(macBin).catch(() => false)) ? macBin : await which($, os, cmd)
    if (bin) editors.push({ name, bin })
  }
  return { os, tmp: join(tmpRoot, 'principia'), data, runner: await findProgram($, os, data), editors }
}

async function installedTerminals($: $T): Promise<Terminal[]> {
  const found: Terminal[] = []
  if (plat.os === 'mac') {
    for (const t of MAC) if (await $.fs.exists(t.app).catch(() => false)) found.push({ id: t.id, name: t.name })
    return found
  }
  for (const t of plat.os === 'windows' ? WINDOWS : LINUX) {
    if (t.id === 'cmd' || (await which($, plat.os, t.cmd))) found.push({ id: t.id, name: t.name })
  }
  return found
}

// Opens `argv` in a new window of `term`. Resolves an error message, or '' on success.
async function openIn($: $T, term: Terminal, argv: string[], title: string): Promise<string> {
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''
  const launch = launchCommand(plat.os, term, argv, title, home)
  if (!launch) return `unknown terminal ${term.id}`
  if (launch.file) await $.fs.write(launch.file.path, launch.file.text)
  const r = await run($, launch.cmd)
  if (!r) return `could not start ${term.name}`
  return r.exitCode === 0 ? '' : r.stderr.trim() || `${term.name} exited with ${r.exitCode}`
}

// ---------- importing a theme ----------

async function readThemeSource($: $T, from: string): Promise<string> {
  if (!/^https?:\/\//i.test(from)) {
    const text = String(await $.fs.read(from))
    return /\.json$/i.test(from) ? text.slice(0, 24_000) : colourLines(text)
  }
  const page = await $.http.fetch(from)
  if (!page.ok) throw new Error(`${from} answered ${page.status}`)
  const { inline, stylesheets } = pageParts(page.text, from)
  const sheets: string[] = []
  for (const href of stylesheets) {
    const res = await $.http.fetch(href).catch(() => undefined)
    if (res?.ok) sheets.push(res.text)
  }
  return colourLines([...inline, ...sheets].join('\n'))
}

async function importTheme($: $T, from: string): Promise<Theme> {
  if (!/^https?:/i.test(from) && isSecretPath(from)) throw new Error('that file may hold secrets, so Principia will not read it')
  if (/\.json$/i.test(from) && !/^https?:/i.test(from)) {
    const own = ownThemeFile(String(await $.fs.read(from)))
    if (own) return own
  }
  const text = await readThemeSource($, from)
  if (!text.trim()) throw new Error(`found no colours in ${from}`)
  const res = await $.model.complete({ model: HAIKU, system: IMPORT_SYSTEM, prompt: `Source: ${sourceKind(from)}\n\n${text}`, maxTokens: 2000 })
  if (!res.isAnswered) throw new Error(`the model did not answer (${res.reason})`)
  return themeFromReply(res.text)
}

// ---------- delivering replies to the agent ----------

// Resolves what actually happened, and why when it failed: the ledger never claims more than that.
let lastDeliveryError = ''
async function deliver($: $T, text: string, opts: { interrupt: boolean; start: boolean }): Promise<Delivery> {
  const turnId = await read($, turnA)
  lastDeliveryError = ''
  const why = (err: unknown) => clip(err instanceof Error ? err.message : String(err), 300)
  const append = () => $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
  try {
    if (turnId && opts.interrupt) {
      await $.turn.abort({ turnId })
      // A new turn carries the instruction; where a session can't start one (headless),
      // the conversation still gets it.
      try {
        await $.prompt.submit({ text })
        return 'received'
      } catch (err) {
        // The turn is stopped; the instruction waits in the conversation for the next turn.
        await append()
        lastDeliveryError = `interrupted; ${why(err)}`
        return 'queued'
      }
    }
    if (turnId) {
      await append()
      return 'received'
    }
    if (opts.start) {
      try {
        await $.prompt.submit({ text })
        return 'received'
      } catch (err) {
        lastDeliveryError = why(err)
        return 'queued' // goes with the next prompt
      }
    }
    return 'queued'
  } catch (err) {
    lastDeliveryError = why(err)
    return 'failed'
  }
}

type ReplyOpts = { mode: ReplyMode; refines: string; interrupt: boolean }

async function sendReply($: $T, ev: ActivityEvent | undefined, text: string, view: ReplyOpts) {
  const reply: Reply = { id: uid(), eventId: ev?.id ?? '', at: now(), text, mode: view.mode, delivery: 'kept', interrupt: view.interrupt || undefined }
  const about = ev
    ? `[Ledger] The user replied to activity "${ev.title}" (${hhmm(ev.at)}${ev.file ? `, ${ev.file}` : ''})`
    : '[Ledger] The user wrote'

  if (view.mode === 'requirement') {
    let reqId = view.refines
    await update($, reqsA, (list): Requirement[] => {
      const version = { at: now(), text, kind: 'refinement', by: 'you' } as const
      const target = list.find(r => r.id === reqId)
      if (target) {
        const wasDone = target.status === 'implemented' || target.status === 'verified'
        return list.map(r =>
          r.id === reqId ? { ...r, history: [...r.history, version], needsReverify: true, status: wasDone ? 'in_progress' : r.status } : r,
        )
      }
      reqId = nextId(list)
      return [...list, { id: reqId, title: clip(text, 90), status: 'captured', at: now(), history: [{ ...version, kind: 'original' }], evidence: [] }]
    })
    reply.reqId = reqId
    reply.delivery = await deliver(
      $,
      `${about}, as a requirement (${reqId}): "${text}". Treat ${reqId} as in scope and re-verify it.`,
      { interrupt: view.interrupt, start: false },
    )
  } else if (view.mode === 'redirect') {
    reply.delivery = await deliver($, `${about}, as an instruction: ${text}`, { interrupt: view.interrupt, start: true })
  }
  if (lastDeliveryError) reply.error = lastDeliveryError

  await update($, repliesA, list => [...list, reply])
  await update($, viewA, v => ({ ...v, interrupt: false }))
  await save($)
}

async function acceptReq($: $T, id: string) {
  await update($, reqsA, (list): Requirement[] => list.map(x => x.id === id
    ? { ...x, status: 'verified', needsReverify: false, evidence: [...x.evidence, { kind: 'manual', at: now(), text: 'Checked and accepted' }] }
    : x))
  await save($)
}

async function deferReq($: $T, id: string) {
  await update($, reqsA, (list): Requirement[] => list.map(x => (x.id === id ? { ...x, status: 'deferred' } : x)))
  await save($)
}

async function askGaps($: $T): Promise<number> {
  const plan = await read($, planA)
  const open = (await read($, reqsA)).filter(r => gapOf(r, plan))
  if (open.length) {
    await deliver(
      $,
      `[Ledger] Before calling this done, close these gaps and report each with the ${TOOL} tool:\n${open.map(r => `${r.id} ${r.title}: ${gapOf(r, plan)}`).join('\n')}`,
      { interrupt: false, start: true },
    )
  }
  return open.length
}

// Done but not verified is where sessions stall: the agent says it's done, nobody runs the
// check. Once per requirement, when the session has been idle a moment after a turn, the
// agent is asked to run the test, build or check that proves each one. /ledger nudge off stops it.
const NUDGE_AFTER = 20_000

async function nudgeVerify($: $T): Promise<number> {
  if (hasEnded || (await $.store.get('nudge').catch(() => undefined)) === 'off') return 0
  if (await read($, turnA)) return 0 // a new turn has started; its own review nudges later
  const due = (await read($, reqsA)).filter(r => r.status === 'implemented' && !r.needsReverify && !r.nudgedAt)
  if (!due.length) return 0
  await update($, reqsA, list => list.map(r => (due.some(d => d.id === r.id) ? { ...r, nudgedAt: now() } : r)))
  await deliver(
    $,
    `[Ledger] Done but not verified: ${due.map(r => `${r.id} ${r.title}`).join('; ')}. ` +
      `For each, run the test, build or check that proves it and report with the ${TOOL} tool (status verified, with test_command). ` +
      'If one can only be checked by hand, say in one line what to check and leave its status as is.',
    { interrupt: false, start: true },
  )
  await save($)
  return due.length
}

// A requirement that leaves "done" is nudged again the next time it gets there.
const renudge = (r: Requirement, status: ReqStatus): Requirement => (status === 'implemented' ? r : { ...r, nudgedAt: undefined })

// ---------- the terminal window ----------

type InboxCommand =
  | { seq: number; type: 'reply'; eventId?: string; text: string; mode: ReplyMode; refines?: string; interrupt?: boolean }
  | { seq: number; type: 'accept' | 'defer' | 'resolve'; reqId: string }
  | { seq: number; type: 'detach'; reqId: string; index: number }
  | { seq: number; type: 'dismiss'; signalId: string }
  | { seq: number; type: 'gaps' }

// A conflict is settled by the person, not the agent: this clears the flag and its signals.
async function resolveConflict($: $T, id: string) {
  await update($, reqsA, (list): Requirement[] => list.map(r => (r.id === id ? { ...r, conflict: undefined } : r)))
  await update($, signalsA, list => list.map(x => (x.kind === 'conflict' && x.reqId === id ? { ...x, dismissed: true } : x)))
  await save($)
}

// A message wrongly linked as a refinement becomes its own requirement, history intact.
async function detachRefinement($: $T, id: string, index: number): Promise<string> {
  let made = ''
  await update($, reqsA, (list): Requirement[] => {
    const req = list.find(r => r.id === id)
    const moved = req?.history[index]
    if (!req || !moved || index === 0 || moved.kind !== 'refinement') return list
    made = nextId(list)
    const rest = list.map(r => (r.id === id ? { ...r, history: r.history.filter((_, i) => i !== index), needsReverify: undefined } : r))
    return [...rest, { id: made, title: clip(moved.text, 90), status: 'captured', at: moved.at, history: [{ ...moved, kind: 'original' }], evidence: [] }]
  })
  await save($)
  return made ? `Moved that message out of ${id} into its own requirement, ${made}.` : `Nothing to detach at ${id} #${index}.`
}

async function pollInbox($: $T) {
  if (!sessionId || !(await $.fs.exists(inboxFile()).catch(() => false))) return
  const last = await read($, inboxSeqA)
  const lines = String(await $.fs.read(inboxFile())).split('\n').filter(Boolean)
  const cmds: InboxCommand[] = []
  for (const line of lines) {
    try {
      const c = JSON.parse(line) as InboxCommand
      if (typeof c.seq === 'number' && c.seq > last) cmds.push(c)
    } catch {
      // a half-written line is read again next poll
    }
  }
  if (!cmds.length) return
  await update($, inboxSeqA, () => Math.max(...cmds.map(c => c.seq)))
  const events = await read($, eventsA)
  for (const c of cmds) {
    if (c.type === 'reply' && c.text.trim()) {
      const ev = events.find(x => x.id === c.eventId)
      await sendReply($, ev, c.text.trim(), { mode: c.mode, refines: c.refines ?? 'new', interrupt: Boolean(c.interrupt) })
    } else if (c.type === 'accept') {
      await acceptReq($, c.reqId)
    } else if (c.type === 'defer') {
      await deferReq($, c.reqId)
    } else if (c.type === 'resolve') {
      await resolveConflict($, c.reqId)
    } else if (c.type === 'detach') {
      await detachRefinement($, c.reqId, c.index)
    } else if (c.type === 'dismiss') {
      await update($, signalsA, list => list.map(x => (x.id === c.signalId ? { ...x, dismissed: true } : x)))
      await save($)
    } else if (c.type === 'gaps') {
      await askGaps($)
    }
  }
}

// The window shows a session as running only while this is fresh.
let beats = 0
async function heartbeat($: $T) {
  if (beats++ % 7 === 0 && sessionId && !hasEnded) await $.fs.write(join(plat.data, `alive-${sessionId}`), String(now())).catch(() => undefined)
}

async function chosenTerminal($: $T, wanted?: string): Promise<Terminal | undefined> {
  const found = await installedTerminals($)
  const pref = wanted || String((await $.store.get('terminal').catch(() => '')) ?? '')
  return found.find(t => t.id === pref.toLowerCase() || t.name.toLowerCase() === pref.toLowerCase()) ?? found[0]
}

async function openWindow($: $T, wanted: string): Promise<string> {
  if (!plat.runner.length) return installOffer()
  const found = await installedTerminals($)
  const term = await chosenTerminal($, wanted)
  if (!term) return 'No supported terminal app was found.'
  if (wanted && term.id !== wanted.toLowerCase()) {
    return `${wanted} isn't installed or isn't supported. Installed: ${found.map(t => t.id).join(', ')}.`
  }
  if (wanted) await $.store.set('terminal', term.id)
  await mirror($)
  // One window for every session: if it's open (fresh heartbeat), switch it here instead.
  const beat = Number(await $.fs.read(join(plat.data, 'viewer.alive')).catch(() => '0'))
  if (!wanted && now() - beat < 3000) {
    await $.fs.write(join(plat.data, 'viewer.focus'), sessionId)
    return 'The Principia window is already open; it now shows this session. (/ledger window <terminal> opens another.)'
  }
  const err = await openIn($, term, programArgs('view', plat.data, sessionId, await projectsDir($)), 'Principia')
  return err
    ? `Could not open ${term.name}: ${err}`
    : `Principia opened in ${term.name}.${found.length > 1 ? ` Others: ${found.filter(t => t !== term).map(t => t.id).join(', ')} (/ledger window <name>).` : ''}`
}

// ---------- moving ledgers out of the temp folder (0.2 kept them there) ----------

// Copies each ledger 0.2 left in the temp folder into the data folder, once, without
// overwriting a newer one. Temp files are left for the system to clear.
async function migrateLedgers($: $T) {
  const marker = join(plat.data, 'migrated-0.3')
  if (await $.fs.exists(marker).catch(() => true)) return
  const have = new Set((await $.fs.list(plat.data).catch(() => [])).map(f => f.name))
  for (const f of await $.fs.list(plat.tmp).catch(() => [])) {
    if (!/^state-.+\.json$/.test(f.name) || have.has(f.name)) continue
    const text = await $.fs.read(join(plat.tmp, f.name)).catch(() => '')
    if (text) await $.fs.write(join(plat.data, f.name), text).catch(() => undefined)
  }
  await $.fs.write(marker, String(now())).catch(() => undefined)
}

// Removes what 0.2 and the 0.3.0 importer left in the temp folder (ledger copies, import
// output, an old heartbeat), once. Pre-edit copies for diffs stay: they're still in use.
async function cleanTemp($: $T) {
  const marker = join(plat.data, 'cleaned-0.3.1')
  if (await $.fs.exists(marker).catch(() => true)) return
  const stale = (await $.fs.list(plat.tmp).catch(() => []))
    .map(f => f.name)
    .filter(n => /^(state|inbox|import)-.+\.jsonl?$|^import\.lock$|^viewer\.(alive|focus|select)$/.test(n))
    .map(n => join(plat.tmp, n))
  if (stale.length) {
    await run($, plat.os === 'windows' ? ['cmd', '/c', 'del', '/q', ...stale.map(f => f.replace(/\//g, '\\'))] : ['rm', '-f', ...stale])
  }
  await $.fs.write(marker, String(now())).catch(() => undefined)
}

// A window only sends to a running session, so anything already in the inbox when a session
// (re)starts was meant for an earlier run of it: never replay it.
async function skipOldCommands($: $T) {
  if ((await read($, inboxSeqA)) > 0) return
  const lines = String(await $.fs.read(inboxFile()).catch(() => '')).split('\n').filter(Boolean)
  let last = 0
  for (const line of lines) {
    try {
      last = Math.max(last, Number((JSON.parse(line) as { seq?: number }).seq) || 0)
    } catch {
      // ignore a broken line
    }
  }
  if (last) await update($, inboxSeqA, () => last)
}

// Ledgers unused for 30 days and pre-edit copies older than 7 go; so do programs of older versions.
async function prune($: $T) {
  const old: string[] = []
  for (const f of await $.fs.list(plat.data).catch(() => [])) {
    if (/^(state|inbox|alive)-/.test(f.name) && now() - f.mtimeMs > 30 * 86_400_000) old.push(join(plat.data, f.name))
  }
  for (const f of await $.fs.list(join(plat.data, 'snapshots')).catch(() => [])) {
    if (now() - f.mtimeMs > 7 * 86_400_000) old.push(join(plat.data, 'snapshots', f.name))
  }
  for (const f of await $.fs.list(join(plat.data, 'bin')).catch(() => [])) {
    if (/^\d+\.\d+\.\d+-(principia|praetorium)/.test(f.name) && !f.name.startsWith(`${RELEASE.version}-`)) old.push(join(plat.data, 'bin', f.name))
  }
  for (let i = 0; i < old.length; i += 50) {
    const batch = old.slice(i, i + 50)
    await run($, plat.os === 'windows' ? ['cmd', '/c', 'del', '/q', ...batch.map(winPath)] : ['rm', '-f', ...batch])
  }
}

const winPath = (p: string) => p.replace(/\//g, '\\')

// ---------- the principia program ----------

// The window, importer and diff run as one small program, downloaded only when asked.
function installOffer(): string {
  return 'The Principia window needs its program: one file (60 to 115 MB depending on your system) from github.com/' + RELEASE.repo +
    ' releases, checked against its SHA-256 before it runs, kept in ~/.claude/principia/bin. Nothing else is installed. Run /ledger install to download it.'
}

async function install($: $T): Promise<string> {
  const arch = firstLine((await run($, plat.os === 'windows' ? ['cmd', '/c', 'echo', '%PROCESSOR_ARCHITECTURE%'] : ['uname', '-m']))?.stdout)
  const name = programName(plat.os, arch)
  const want = RELEASE.sha256[name]
  if (!want) return `No build of Principia ${RELEASE.version} for this machine (${name}).`
  const dir = join(plat.data, 'bin')
  const bin = join(dir, `${RELEASE.version}-${name}`)
  const part = `${bin}.part`
  const url = `https://github.com/${RELEASE.repo}/releases/download/v${RELEASE.version}/${name}`
  await $.fs.write(join(dir, '.keep'), '')
  const got = await $.process.run(['curl', '-fsSL', '--retry', '2', '-o', part, url], { timeoutMs: 300_000 })
  if (got.exitCode !== 0) return `Download failed: ${got.stderr.trim() || `curl exited with ${got.exitCode}`}`
  const sum = plat.os === 'windows'
    ? await $.process.run(['certutil', '-hashfile', winPath(part), 'SHA256'])
    : await $.process.run(plat.os === 'mac' ? ['shasum', '-a', '256', part] : ['sha256sum', part])
  const have = (sum.stdout.match(/\b[0-9a-f]{64}\b/i)?.[0] ?? '').toLowerCase()
  if (have !== want) {
    await run($, plat.os === 'windows' ? ['cmd', '/c', 'del', winPath(part)] : ['rm', '-f', part])
    return `The download did not match its checksum, so it was deleted and not run (expected ${want.slice(0, 12)}…, got ${have.slice(0, 12) || 'nothing'}…).`
  }
  await run($, plat.os === 'windows' ? ['cmd', '/c', 'move', '/y', winPath(part), winPath(bin)] : ['mv', '-f', part, bin])
  if (plat.os !== 'windows') await run($, ['chmod', '+x', bin])
  const check = await run($, [bin, '--version'])
  if (!check || check.exitCode !== 0 || !check.stdout.includes(RELEASE.version)) return `Downloaded and verified, but the program would not start: ${check?.stderr.trim() || 'no output'}`
  plat = { ...plat, runner: [bin] }
  // An open window switches to the new program by itself.
  await $.fs.write(join(plat.data, 'viewer.next'), bin)
  void prune($).catch(() => undefined)
  return `Installed Principia ${RELEASE.version} (${name}, checksum verified). /ledger window opens it.`
}

// ---------- footprint: memory held now, files left behind ----------

let selfPid = 0

async function measureFootprint($: $T, files: boolean) {
  if (plat.os === 'windows' || !sessionId) return
  const prev = await read($, footprintA)
  if (!selfPid) selfPid = Number(firstLine((await run($, ['sh', '-c', FIND_SELF]))?.stdout)) || 0
  const ps = await run($, ['ps', '-axo', 'pid=,ppid=,rss='])
  const { procs, ramKb } = selfPid && ps?.stdout ? treeRss(ps.stdout, selfPid) : { procs: 0, ramKb: 0 }
  let disk = { transcriptKb: prev?.transcriptKb ?? 0, ledgerKb: prev?.ledgerKb ?? 0, workspaceKb: prev?.workspaceKb ?? 0 }
  const workspace = workspaceOf(sessionRoot)
  if (files || !prev) {
    const size = async (p: string) => duKb((await run($, ['du', '-sk', p]))?.stdout ?? '')
    // The transcript's folder is named after the session's folder, by rules of the app's own.
    const transcript = firstLine((await run($, ['sh', '-c', 'ls "$1"/*/"$2".jsonl 2>/dev/null | head -1', 'sh', await projectsDir($), sessionId]))?.stdout)
    disk = {
      transcriptKb: transcript ? await size(transcript) : 0,
      ledgerKb: await size(stateFile()),
      workspaceKb: workspace ? await size(workspace.path) : 0,
    }
  }
  await update($, footprintA, () => ({ at: now(), pid: selfPid || undefined, procs, ramKb, ...disk, workspace }))
  await mirror($)
}

// ---------- themes ----------

async function setTheme($: $T, theme: Theme) {
  await update($, themeA, () => theme)
  await $.store.set('theme', theme)
  await mirror($)
}

async function themeCommand($: $T, arg: string): Promise<string> {
  const [verb = '', ...rest] = arg.split(/\s+/).filter(Boolean)
  const presets = Object.keys(PRESETS).join(', ')
  if (!verb) {
    const t = await read($, themeA)
    return `Theme: ${t.name}. Presets: ${presets}. /ledger theme <preset>, or /ledger theme import <url | tailwind.config.js | file.css | theme.json>.`
  }
  if (verb === 'import') {
    const from = rest.join(' ')
    if (!from) return 'Give a website URL or a file path: /ledger theme import https://example.com'
    try {
      const theme = await importTheme($, from)
      await setTheme($, theme)
      return `Imported theme "${theme.name}" from ${from}. Colours too faint to read were replaced with defaults.`
    } catch (err) {
      return `Could not import a theme from ${from}: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  const preset = PRESETS[verb]
  if (!preset) return `No preset "${verb}". Presets: ${presets}.`
  await setTheme($, preset)
  return `Theme set to ${verb}.`
}

// ---------- sessions from before Principia: their transcripts ----------

// Transcripts hold everything a person typed, so nothing reads them without a yes,
// asked once in a dialog and remembered ('allowed' | 'declined').
const CONSENT_PANE = 'principia-consent'

type PastSession = {
  sessionId: string
  cwd: string
  title: string
  firstAt: number
  lastAt: number
  prompts: PastPrompt[]
  tools: Record<string, unknown>[]
  replies: { at: number; text: string }[]
}

const transcriptsAllowed = async ($: $T) => (await $.store.get('transcripts').catch(() => undefined)) === 'allowed'

async function projectsDir($: $T): Promise<string> {
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || join((await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || '', '.claude')
  return join(config, 'projects')
}

// Runs viewer/import.mjs, which streams the transcripts and keeps only what the ledger needs.
async function readPast($: $T, args: string[]): Promise<PastSession[]> {
  if (!plat.runner.length) throw new Error('the Principia program is not installed (/ledger install)')
  // The result comes back on stdout (well under its 4 MiB limit: prompts, replies and
  // tool names only), so the import leaves no file behind.
  const r = await $.process.run(programArgs('import', await projectsDir($), '-', ...args), { timeoutMs: 120_000 })
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `import exited with ${r.exitCode}`)
  if (r.isStdoutTruncated) throw new Error('the import was too large to read; try fewer days')
  return JSON.parse(r.stdout) as PastSession[]
}

// Haiku through the session's own client. A call that gets no answer (a rate limit, a timeout)
// is tried three times, a little apart; the last reason is kept for the import's report.
const haiku = ($: $T): Complete => async (system, prompt, maxTokens) => {
  let reason = ''
  for (const [i, wait] of [0, 2000, 6000].entries()) {
    if (wait) await new Promise<void>(resolve => $.clock.after(wait, () => resolve()))
    const res = await $.model.complete({ model: HAIKU, system, prompt, maxTokens })
    if (res.isAnswered) return res.text
    reason = String(res.reason ?? '')
    if (i === 2) break
  }
  return { reason: reason ? `${reason}, after 3 tries` : 'after 3 tries' }
}

const asLedgerItem = (r: Requirement): LedgerItem => ({
  id: r.id, title: r.title, status: r.status, at: r.at, quote: r.history[0]?.text ?? r.title,
  refinements: r.history.slice(1).map(h => ({ at: h.at, text: h.text })),
})

// A whole past conversation, read in order (see buildLedger): requirements with the status the
// conversation shows; tool calls become events.
async function ledgerOf($: $T, past: PastSession): Promise<{ reqs: Requirement[]; events: ActivityEvent[]; failed?: string }> {
  const built = await buildLedger(past.prompts, past.replies, haiku($))
  if (built.failed) return { reqs: [], events: [], failed: built.failed }
  const reqs: Requirement[] = built.items.map(it => ({
    id: it.id, title: it.title, status: it.status as ReqStatus, at: it.at,
    history: [{ at: it.at, text: it.quote, kind: 'original', by: 'you' }, ...it.refinements.map(r => ({ at: r.at, text: r.text, kind: 'refinement' as const, by: 'you' as const }))],
    evidence: it.status === 'captured' ? [] : [{ kind: 'note', at: now(), text: `Judged from the conversation: ${it.why ?? 'when it was read'}` }],
  }))
  const events: ActivityEvent[] = []
  for (const t of past.tools) {
    const ev = describe(t, Number(t.at) || past.lastAt)
    if (!ev) continue
    if (ev.state === 'running') ev.state = t.isError ? 'failed' : 'ok'
    events.push(ev)
  }
  for (const [i, m] of past.replies.slice(-200).entries()) {
    events.push({ id: `m-${past.sessionId}-${i}`, kind: 'message', at: m.at, title: clip(m.text.split('\n')[0] ?? '', 90), detail: m.text })
  }
  events.sort((a, b) => a.at - b.at)
  return { reqs, events: trimEvents(events) }
}

async function importSessions($: $T, days: number, again = false): Promise<string> {
  const existing: string[] = []
  for (const f of await $.fs.list(plat.data).catch(() => [])) {
    const id = /^state-(.+)\.json$/.exec(f.name)?.[1]
    if (!id) continue
    // `again` imports already-imported sessions afresh; live sessions are never overwritten.
    if (again && (await $.fs.read(join(plat.data, f.name)).then(t => (JSON.parse(t) as { imported?: boolean }).imported).catch(() => false))) continue
    existing.push(id)
  }
  // Refreshing redoes every imported session in the window, not only the newest few.
  const past = await readPast($, ['--days', String(days), '--max', again ? '40' : '12', '--skip', [...existing, sessionId].join(',')])
  const [theme, view] = await Promise.all([read($, themeA), read($, viewA)])
  let tagged = 0
  let imported = 0
  const failures: string[] = []
  // One at a time: each session is several Haiku calls, and running them side by side is what
  // gets calls refused.
  for (const s of past) {
    const { reqs, events, failed } = await ledgerOf($, s)
    if (failed) {
      failures.push(failed)
      continue
    }
    imported++
    tagged += reqs.length
    await $.fs.write(join(plat.data, `state-${s.sessionId}.json`), JSON.stringify({
      sessionId: s.sessionId, project: projectName(s.cwd), title: s.title || clip(s.prompts[0]?.text ?? '', 70),
      imported: true, hasEnded: false, isWorking: false, asks: s.prompts.map(pr => pr.at),
      reqs, replies: [], events, editors: plat.editors, snapDir: plat.tmp, theme, dark: view.dark, at: s.lastAt,
    }))
  }
  const span = `the last ${days} day${days === 1 ? '' : 's'}`
  if (!past.length) return `No sessions from ${span} left to import.`
  const done = imported ? `Imported ${imported} session${imported === 1 ? '' : 's'} from ${span} (${tagged} requirements). They show in /ledger window, read-only until reopened.` : ''
  const notDone = failures.length ? `${failures.length} session${failures.length === 1 ? '' : 's'} could not be read (${[...new Set(failures)].join('; ')}); /ledger import tries again.` : ''
  return [done, notDone].filter(Boolean).join(' ')
}

// A session reopened after Principia was installed starts from its own transcript.
async function backfillSelf($: $T) {
  if (!(await transcriptsAllowed($)) || (await read($, reqsA)).length) return
  try {
    const [past] = await readPast($, ['--session', sessionId])
    if (!past?.prompts.length) return
    const { reqs, events } = await ledgerOf($, past)
    if ((await read($, reqsA)).length) return // the person sent a prompt meanwhile; keep its ids
    await update($, reqsA, () => reqs)
    await update($, eventsA, list => trimEvents([...events, ...list]))
    if (!(await read($, titleA))) await update($, titleA, () => past.title || clip(past.prompts[0]?.text ?? '', 70))
    await save($)
  } catch {
    // no transcript yet, or it could not be read: start empty
  }
}

// The temp folder is cleared on restart, taking imported ledgers with it. Once allowed,
// each session start re-imports what's missing; a lock keeps sessions starting together
// from importing (and paying for) the same transcripts twice.
async function autoImport($: $T) {
  if (!(await transcriptsAllowed($))) return
  const lock = join(plat.data, 'import.lock')
  const last = Number(await $.fs.read(lock).catch(() => '0'))
  if (now() - last < 10 * 60_000) return
  await $.fs.write(lock, String(now()))
  await importSessions($, 2).catch(() => undefined)
}

async function importCommand($: $T, arg: string): Promise<string> {
  if (arg === 'allow') {
    await $.store.set('transcripts', 'allowed')
    void $.ui.close({ id: CONSENT_PANE }).catch(() => undefined)
    return `Allowed. ${await importSessions($, 2).catch(err => `Could not import: ${err instanceof Error ? err.message : String(err)}`)}`
  }
  if (arg === 'revoke') {
    await $.store.set('transcripts', 'declined')
    return 'Principia will not read transcripts. Sessions already imported stay in the ledger.'
  }
  if (!(await transcriptsAllowed($))) {
    await $.ui.open({ id: CONSENT_PANE, title: 'Principia', focus: true })
    return 'Principia needs your permission to read existing transcripts: answer in the dialog, or run /ledger import allow.'
  }
  const again = /\brefresh\b/.test(arg)
  const days = Math.min(30, Math.max(1, Number.parseInt(arg.replace(/\D+/g, ' '), 10) || 2))
  return importSessions($, days, again).catch(err => `Could not import: ${err instanceof Error ? err.message : String(err)}`)
}

// Re-judges this session's requirements against its whole conversation, read in order.
// A ledger kept by an earlier version was judged with less of the conversation (or not at all),
// so once per version each reopened session is read again in full, as /ledger refresh does.
async function rejudgeOnce($: $T) {
  const key = `judged:${sessionId}`
  if (entry.startsWith('sdk') || !(await transcriptsAllowed($)) || !(await read($, reqsA)).length) return
  if ((await $.store.get(key).catch(() => undefined)) === RELEASE.version) return
  const said = await refreshCommand($)
  if (said.startsWith('Could not')) return // tried again next time the session opens
  await $.store.set(key, RELEASE.version)
  if (!said.includes('already matches')) await $.ui.toast(`Principia: ${said}`)
}

async function refreshCommand($: $T): Promise<string> {
  if (!(await transcriptsAllowed($))) {
    await $.ui.open({ id: CONSENT_PANE, title: 'Principia', focus: true })
    return 'Refreshing reads this session\'s transcript, which needs your permission: answer in the dialog, or run /ledger import allow.'
  }
  const reqs = await read($, reqsA)
  if (!reqs.length) return 'No requirements to refresh yet.'
  const [past] = await readPast($, ['--session', sessionId])
  if (!past?.prompts.length) return 'Found no conversation to judge from.'
  // The whole conversation: asks the ledger is missing are added (existing ids kept), then every
  // status is judged against everything said after it.
  const built = await buildLedger(past.prompts, past.replies, haiku($), { seed: reqs.map(asLedgerItem) })
  if (built.failed) return `Could not refresh: ${built.failed}. Nothing was changed.`
  const known = new Set(reqs.map(r => r.id))
  const added: Requirement[] = built.items.filter(it => !known.has(it.id)).map(it => ({
    id: it.id, title: it.title, status: it.status as ReqStatus, at: it.at,
    history: [{ at: it.at, text: it.quote, kind: 'original' as const, by: 'you' as const }],
    evidence: it.status === 'captured' ? [] : [{ kind: 'note' as const, at: now(), text: `Judged from the conversation: ${it.why ?? ''}` }],
  }))
  const progress: Progress[] = built.items
    .filter(it => known.has(it.id) && reqs.find(r => r.id === it.id)?.status !== it.status)
    .map(it => ({ id: it.id, status: it.status as Progress['status'], why: it.why ?? 'judged from the conversation' }))
  const moved = await applyProgress($, progress, 'Judged from the conversation')
  if (added.length) await update($, reqsA, list => [...list, ...added.filter(a => !list.some(r => r.id === a.id))])
  await save($)
  const parts = [
    added.length ? `added ${added.length} requirement${added.length === 1 ? '' : 's'} the ledger had missed` : '',
    moved ? `corrected ${moved} status${moved === 1 ? '' : 'es'}` : '',
  ].filter(Boolean)
  return parts.length
    ? `Read this session's whole conversation: ${parts.join(' and ')}. Verified still needs a passing check or your acceptance (a).`
    : 'Read this session\'s whole conversation: the ledger already matches it.'
}

// ---------- the agent's ledger tool ----------

const TOOL_DESCRIPTION =
  "The user's requirements ledger (R1, R2…). Update a requirement when you start, finish, get blocked or need clarification; add one to split a requirement. " +
  '"verified" needs test_command: part of a test/build command that passed after your last edit. ' +
  'Start plan and todo items with the ids they serve, e.g. "[R2] Add search".'

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['update', 'add', 'detach'] },
    id: { type: 'string' },
    status: { type: 'string', enum: ['in_progress', 'implemented', 'verified', 'blocked', 'needs_clarification', 'revisit'] },
    test_command: { type: 'string' },
    note: { type: 'string' },
    title: { type: 'string', description: 'add: the new requirement' },
    derived_from: { type: 'string', description: 'add: id it splits' },
    index: { type: 'number', description: 'detach: history position (0 is the original ask) of a message wrongly linked as a refinement of id' },
  },
  required: ['action'],
}

async function ledgerTool($: $T, a: Record<string, unknown>): Promise<string> {
  const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '')
  if (s('action') === 'add') {
    if (!s('title')) return 'title is required for add'
    let id = ''
    await update($, reqsA, (list): Requirement[] => {
      id = nextId(list)
      const from = s('derived_from')
      return [...list, {
        id, title: s('title'), status: 'captured', at: now(), evidence: [],
        history: [{ at: now(), text: from ? `Split from ${from}: ${s('title')}` : s('title'), kind: 'original', by: 'agent' }],
      }]
    })
    await save($)
    return `Added ${id}.`
  }
  if (s('action') === 'detach') return detachRefinement($, s('id'), Number(a.index))
  const reqs = await read($, reqsA)
  const req = reqs.find(r => r.id === s('id'))
  if (!req) return `No requirement ${s('id')}. Known: ${reqs.map(r => r.id).join(', ') || 'none'}.`
  linkReqs([req.id])
  let status = (s('status') || req.status) as ReqStatus
  let reply = `${req.id} → ${STATUS[status].label}.`
  const evidence = [...req.evidence]
  if (status === 'verified') {
    const events = await read($, eventsA)
    const lastEdit = Math.max(0, ...events.filter(x => x.kind === 'code').map(x => x.at))
    // Evidence is a test, build or check command (not any command), named by a real part of it.
    const cmd = s('test_command').trim().length >= 4 ? s('test_command').trim() : ''
    const pass = cmd
      ? [...events].reverse().find(x => x.kind === 'test' && x.state === 'ok' && x.at >= lastEdit && (x.detail ?? '').includes(cmd))
      : undefined
    if (pass) {
      evidence.push({ kind: 'test', at: now(), text: pass.detail ?? pass.title, eventId: pass.id })
    } else {
      status = 'implemented'
      reply = `${req.id} recorded as done but NOT verified: no passing test, build or check command matching "${s('test_command')}" ran after the last edit. Run one, then update again.`
    }
  }
  if (status === 'revisit' && !s('note')) return `${req.id}: "revisit" needs a note saying when or why to come back to it.`
  if (s('note') && status !== 'revisit') evidence.push({ kind: 'note', at: now(), text: s('note') })
  await update($, reqsA, list =>
    list.map(r => (r.id === req.id
      ? { ...renudge(r, status), status, evidence, needsReverify: status === 'verified' ? false : r.needsReverify, revisit: status === 'revisit' ? s('note') : undefined }
      : r)),
  )
  await save($)
  return reply
}

// ---------- pane size ----------

// A pane can only ask for a width; the person's own drag on the dock wins.
const WIDE_COLUMNS = 400
const NARROW_COLUMNS = 72
const SIDE_BY_SIDE_AT = 160

async function openPane($: $T): Promise<string> {
  const width = (await $.store.get('width').catch(() => undefined)) === 'wide' ? 'wide' : 'narrow'
  await $.ui.open({ id: PANE, title: 'Principia', columns: width === 'wide' ? WIDE_COLUMNS : NARROW_COLUMNS })
  return width
}

// ---------- register ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      sessionId = await $.session.id()
      const root = await $.session.root()
      project = projectName(root)
      sessionRoot = root
      entry = (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) ?? ''
      hasEnded = false
      storeKey = `s:${sessionId}`
      const saved = (await $.store.get(storeKey)) as { reqs?: Requirement[]; replies?: Reply[]; events?: ActivityEvent[]; signals?: Signal[]; plan?: PlanStep[]; inboxSeq?: number } | undefined
      if (saved && (await read($, reqsA)).length === 0) {
        if (saved.reqs) await update($, reqsA, () => saved.reqs ?? [])
        if (saved.replies) await update($, repliesA, () => saved.replies ?? [])
        if (saved.events) await update($, eventsA, () => saved.events ?? [])
        if (saved.signals) await update($, signalsA, () => saved.signals ?? [])
        if (saved.plan) await update($, planA, () => saved.plan ?? [])
      }
      if (saved?.inboxSeq && (await read($, inboxSeqA)) < saved.inboxSeq) await update($, inboxSeqA, () => saved.inboxSeq ?? 0)
      const dark = await $.store.get('dark')
      if (typeof dark === 'boolean') await update($, viewA, v => ({ ...v, dark }))
      const theme = await $.store.get('theme')
      if (theme) await update($, themeA, () => normalizeTheme(theme))
    } catch {
      // fresh session state
    }
    plat = await detect($).catch(() => plat)
    await migrateLedgers($)
    await cleanTemp($)
    await skipOldCommands($)
    $.clock.after(3000, () => void prune($).catch(() => undefined))
    if ((await read($, reqsA)).length === 0) {
      // Nothing in session state (a fresh process, or a reload that lost it): take over this
      // session's ledger file if it has requirements: one /ledger import wrote, one an earlier
      // load mirrored, or one from 0.1, which kept it in /tmp/claude-ledger.
      type Kept = { reqs?: Requirement[]; events?: ActivityEvent[]; replies?: Reply[]; title?: string; signals?: Signal[]; plan?: PlanStep[]; turns?: Turn[] }
      let kept: Kept | undefined
      // Where 0.2 kept it (the temp folder) and 0.1 (/tmp/claude-ledger), too.
      for (const file of [stateFile(), join(plat.tmp, `state-${sessionId}.json`), `/tmp/claude-ledger/state-${sessionId}.json`]) {
        const found = await $.fs.read(file).then(t => JSON.parse(t) as Kept).catch(() => undefined)
        if (found?.reqs?.length) {
          kept = found
          break
        }
      }
      if (kept) {
        const known = new Set((await read($, eventsA)).map(ev => ev.id))
        await update($, reqsA, () => kept.reqs ?? [])
        await update($, repliesA, list => (list.length ? list : kept.replies ?? []))
        await update($, eventsA, list => trimEvents([...(kept.events ?? []).filter(ev => !known.has(ev.id)), ...list].sort((a, b) => a.at - b.at)))
        if (kept.title && !(await read($, titleA))) await update($, titleA, () => kept.title ?? '')
        if (kept.signals?.length) await update($, signalsA, list => (list.length ? list : kept.signals ?? []))
        if (kept.plan?.length) await update($, planA, list => (list.length ? list : kept.plan ?? []))
        if (kept.turns?.length) await update($, turnsA, list => (list.length ? list : kept.turns ?? []))
        await save($)
      } else {
        $.clock.after(0, () => void backfillSelf($))
      }
    }
    if ((await $.store.get('transcripts').catch(() => undefined)) === undefined) void $.ui.open({ id: CONSENT_PANE, title: 'Principia', focus: true })
    $.clock.after(5000, () => void autoImport($).catch(() => undefined))
    $.clock.after(8000, () => void rejudgeOnce($).catch(() => undefined))
    $.clock.every(700, () => {
      void pollInbox($).catch(() => undefined)
      void heartbeat($)
    })
    // Memory every half minute; the files every five, since sizing a folder costs more.
    $.clock.after(3000, () => void measureFootprint($, true).catch(() => undefined))
    $.clock.every(30_000, () => void measureFootprint($, false).catch(() => undefined))
    $.clock.every(300_000, () => void measureFootprint($, true).catch(() => undefined))
    await mirror($)
    // A session started without tools refuses this; the ledger still works without it.
    await $.tool.register({ name: 'ledger', description: TOOL_DESCRIPTION, inputSchema: TOOL_SCHEMA, isDeferred: false }).catch(() => undefined)
    await $.command.register({ name: 'ledger', description: 'Open the requirements ledger pane', argumentHint: '[window [terminal] | install | refresh | nudge on|off | theme … | import [days | refresh | allow | revoke] | wide | narrow]' })
    void openPane($)
    return next(e)
  })

  on('command.run', { command: 'ledger' }, async ($, e) => {
    const raw = e.args.trim()
    const arg = raw.toLowerCase()
    if (arg === 'window' || arg.startsWith('window ')) return { text: await openWindow($, raw.slice(6).trim()) }
    if (arg === 'install') return { text: await install($).catch(err => `Install failed: ${err instanceof Error ? err.message : String(err)}`) }
    if (arg === 'theme' || arg.startsWith('theme ')) return { text: await themeCommand($, raw.slice(5).trim()) }
    if (arg === 'import' || arg.startsWith('import ')) return { text: await importCommand($, arg.slice(6).trim()) }
    if (arg === 'nudge on' || arg === 'nudge off') {
      await $.store.set('nudge', arg.slice(6))
      return { text: arg === 'nudge off' ? 'Principia will not ask the agent to verify on its own. /ledger nudge on turns it back on; g in the window still asks once.' : 'When a session goes idle with requirements done but not verified, Principia asks the agent to verify them, once each.' }
    }
    if (arg === 'refresh') return { text: await refreshCommand($).catch(err => `Could not refresh: ${err instanceof Error ? err.message : String(err)}`) }
    if (arg === 'wide' || arg === 'narrow') await $.store.set('width', arg)
    const width = await openPane($)
    return { text: `Principia opened (${width}). /ledger window opens it in your terminal; /ledger theme changes the colours; /ledger wide or /ledger narrow resizes this pane; dragging the pane edge also works.` }
  })

  on('prompt.submit', async ($, e, next) => {
    const kind = (e as { origin?: { kind?: string } }).origin?.kind ?? ''
    // A session started from another session gets its whole task as a first message from that
    // session, with no origin of its own: you asked for it there, so it's read as yours. (A
    // headless run starts the same way, but its entry point says so and it's left alone.)
    const isBrief = !kind && !(await read($, reqsA)).length && !(await read($, turnsA)).length
    if (e.command || e.isMeta || !(HUMAN.has(kind) || isBrief) || entry.startsWith('sdk') || e.text.startsWith('[Ledger]')) return next(e)
    const text = clip(humanText(e.text), isBrief ? 12000 : 3000)
    if (!text) return next(e)
    const context = [...(e.context ?? [])]
    if (!(await read($, titleA))) await update($, titleA, () => clip(text.replace(/\s+/g, ' '), 70))
    const touched = await capture($, text)
    linkReqs(touched.map(t => /^R\d+/.exec(t)?.[0] ?? ''))
    if (touched.length) {
      context.push(`[Ledger] Captured from this message:\n${touched.join('\n')}\nReport progress with the ${TOOL} tool.`)
    }
    if (conflicts.length) {
      context.push(`[Ledger] This message conflicts with earlier requirements: ${conflicts.map(c => `${c.id} (${c.reason})`).join('; ')}. Ask the user which one wins before acting on either.`)
    }
    const queued = (await read($, repliesA)).filter(r => r.delivery === 'queued')
    if (queued.length) {
      const reqs = await read($, reqsA)
      context.push(`[Ledger] What the user sent from the ledger while you were idle:\n${queued.map(r => (r.reqId ? `${r.reqId}: ${reqs.find(x => x.id === r.reqId)?.title ?? r.text}` : `Instruction: ${r.text}`)).join('\n')}`)
      await update($, repliesA, list => list.map(r => (r.delivery === 'queued' ? { ...r, delivery: 'received' as const } : r)))
      linkReqs(queued.map(r => r.reqId ?? ''))
    }
    await save($)
    return context.length ? next({ ...e, context }) : next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: TOOL }, async ($, e) => ({ result: await ledgerTool($, e as unknown as Record<string, unknown>) }))

  on('tool.call', async ($, e, next) => {
    if (e.agentId || String(e.tool) === TOOL) return next(e)
    const ev = describe(e as unknown as Record<string, unknown>)
    if (!ev) return next(e)
    // Recording is best effort: a reload can unload this plugin mid-call, and the
    // person's tool call must never fail because of the ledger.
    try {
      if (ev.kind === 'code') await snapshot($, ev)
      await pushEvent($, ev)
    } catch {
      // not recorded
    }
    const ran = await next(e)
    try {
      const tool = String(e.tool)
      if (ev.state === 'running') await patchEvent($, ev.id, { state: ran.deny !== undefined || ran.isError === true ? 'failed' : 'ok' })
      // Failed or refused calls are signals: easy to miss in the chat, often worth acting on.
      const context = (output: string) => ({ ask: clip(turnAsk, 600), did: clip(ev.detail ?? ev.file ?? ev.title, 600), output: clip(output.trim(), 800) })
      if (ran.deny !== undefined) await addSignal($, 'blocked', failureText(tool, ran.deny), { eventId: ev.id, context: context(ran.deny) })
      else if (ran.isError === true && ev.kind !== 'discovery') await addSignal($, 'failed', failureText(tool, ran.text ?? ''), { eventId: ev.id, context: context(ran.text ?? '') })
      if (PLAN_TOOLS.has(tool)) {
        const steps = planFrom(e as unknown as Record<string, unknown>, await read($, reqsA))
        if (steps) {
          linkReqs(steps.filter(st => st.status === 'in_progress').flatMap(st => st.reqIds))
          await update($, planA, () => steps)
          await mirror($)
        }
      }
      if (tool === 'Bash' && ran.deny === undefined && ran.text) {
        const urls = previewUrls(ran.text)
        if (urls.length) {
          await update($, previewsA, list => [...list.filter(p => !urls.includes(p.url)), ...urls.map(url => ({ url, at: now(), eventId: ev.id }))].slice(-20))
          await mirror($)
        }
      }
    } catch {
      // best effort, as above
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    hasEnded = true
    await mirror($)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      turnStartedAt = now()
      turnAsk = humanText(e.text)
      await update($, turnA, () => e.turnId)
      await mirror($)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const running = await read($, turnA)
    if (running && running === e.turnId) {
      await update($, turnA, () => '')
      if (e.answer.trim()) {
        await pushEvent($, { id: `m-${e.turnId}`, kind: 'message', at: now(), title: clip(e.answer.split('\n')[0] ?? '', 90), detail: clip(e.answer, 2000) })
        // One Haiku call per turn: what the agent found that's worth acting on, and whether
        // it went against a requirement. Short answers have neither.
        const work = workOf(await read($, eventsA), turnStartedAt)
        // Every turn: the review is given every requirement, this turn's work and the reply.
        const ask = turnAsk
        const since = turnStartedAt
        const worked = [...turnReqs]
        const until = now()
        const turns = await update($, turnsA, list => [...list, { at: turnStartedAt, ask: clip(ask, 1500), answer: clip(e.answer, 3000) }].slice(-400))
        $.clock.after(0, () => void review($, e.answer, `m-${e.turnId}`, work, ask).then(async judged => {
          await linkTurn($, since, until, [...new Set([...worked, ...judged])])
          // A turn's review sees only that turn; work often finishes in a later one. So every few
          // turns, every open requirement is re-judged against the whole session so far.
          if (turns.length % CONSOLIDATE_EVERY === 0) await consolidate($)
          // Then, if the session stays idle, the agent is asked to verify what it says is done.
          $.clock.after(NUDGE_AFTER, () => void nudgeVerify($).catch(() => undefined))
        }))
      }
      await update($, repliesA, list => list.map(r => (r.delivery === 'received' ? { ...r, delivery: 'acted' as const } : r)))
      turnReqs.clear()
      await save($)
    }
    return next(e)
  })

  // ---------- the pane ----------

  on('ui.render', { component: 'Pane', requestId: CONSENT_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const p = palette(await read($, themeA), (await read($, viewA)).dark)
    const answer = async (choice: 'allowed' | 'declined') => {
      await $.store.set('transcripts', choice)
      await $.ui.close({ id: CONSENT_PANE })
      if (choice === 'allowed') {
        void backfillSelf($)
        const said = await importSessions($, 2).catch(err => `Could not import: ${err instanceof Error ? err.message : String(err)}`)
        await $.ui.toast(said)
      }
    }
    return (
      <Box flexDirection="column" padding={1} gap={1} backgroundColor={p.bg}>
        <Text color={p.text} bold>Show sessions you started before Principia?</Text>
        <Text color={p.text2}>
          Principia can read the Claude Code transcripts on this computer (~/.claude/projects) from the last 2 days, so earlier sessions appear in the ledger, and keep doing so as new sessions start. The window also reads each session's title from its transcript.
        </Text>
        <Text color={p.text2}>
          It reads your prompts, the names and file paths of the agent's tool calls, and its replies. File contents are not kept. Each session costs one Claude Haiku call to list its requirements. Nothing is written to the transcripts.
        </Text>
        <Text color={p.text3}>Change this any time with /ledger import allow or /ledger import revoke.</Text>
        <Box flexDirection="row" gap={1}>
          <Button key="consent-allow" label="Allow" variant="primary" onPress={() => answer('allowed')} />
          <Button key="consent-decline" label="Not now" onPress={() => answer('declined')} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface === "mobile") {
      const { Text } = $.ui.resolve(e)
      return <Text>Open the ledger on desktop.</Text>
    }
    const { Box, Text, Button, Input, Select, Link } = $.ui.resolve(e)
    // A drawing can't write state, so the first one records itself just after.
    if (!(await read($, drawnA))) $.clock.after(0, () => void update($, drawnA, () => true).then(() => mirror($)).catch(() => undefined))
    const [reqs, events, replies, view, signals, plan, previews, turns, footprint] = await Promise.all([
      read($, reqsA), read($, eventsA), read($, repliesA), read($, viewA), read($, signalsA), read($, planA), read($, previewsA), read($, turnsA), read($, footprintA),
    ])
    const openSignals = signals.filter(x => !x.dismissed)
    const p = palette(await read($, themeA), view.dark)
    const setView = (patch: Partial<View>) => update($, viewA, v => ({ ...v, ...patch }))
    const chip = (label: string, tone: Tone) => (
      <Text color={toneFg(p, tone)} backgroundColor={toneBg(p, tone)}> {label} </Text>
    )
    const verified = reqs.filter(r => r.status === 'verified' && !r.needsReverify).length
    const live = reqs.filter(r => r.status !== 'deferred')

    const tabs = (
      <Box flexDirection="row" gap={1} paddingBottom={1}>
        {([
          ['reqs', `Requirements ${reqs.length}`], ['signals', `Signals ${openSignals.length}`], ['activity', `Activity ${events.length}`],
          ['plan', `Plan ${plan.length}`], ['tests', 'Tests'], ['preview', `Preview ${previews.length}`], ['audit', 'Audit'],
        ] as const).map(([tab, label]) => (
          <Button key={`tab-${tab}`} label={label} plain dimColor={view.tab !== tab} onPress={() => setView({ tab })} />
        ))}
        <Button key="theme" label={view.dark ? 'Light mode' : 'Dark mode'} plain dimColor onPress={async () => { await setView({ dark: !view.dark }); await $.store.set('dark', !view.dark) }} />
      </Box>
    )

    const header = (
      <Box flexDirection="column" paddingBottom={1}>
        <Text color={p.text} bold>Principia</Text>
        <Text color={p.text2}>
          {live.length} requirements · <Text color={p.done}>{verified} verified</Text> · {live.length - verified} open
        </Text>
        {footprint && (
          <Text color={p.text3}>
            {fmtKb(footprint.ramKb)} memory in {footprint.procs} process{footprint.procs === 1 ? '' : 'es'} · {fmtKb(footprint.transcriptKb + footprint.ledgerKb + footprint.workspaceKb)} on disk, local only · M in the window for details
          </Text>
        )}
      </Box>
    )

    // ----- requirements -----
    const reqRow = (r: Requirement) => (
      <Box key={`r-${r.id}`} flexDirection="column" paddingY={0}>
        <Box flexDirection="row" gap={1}>
          <Button key={`rb-${r.id}`} label={r.id} plain onPress={() => setView({ selectedReq: view.selectedReq === r.id ? undefined : r.id })} />
          <Text color={p.text} bold={view.selectedReq === r.id} wrap="wrap">{r.title}</Text>
        </Box>
        <Box flexDirection="row" gap={1} paddingLeft={2}>
          <Text color={r.needsReverify ? p.warn : toneFg(p, STATUS[r.status].tone)}>{r.needsReverify ? 'Needs re-verification' : STATUS[r.status].label}</Text>
          {r.conflict && chip('Conflict', 'danger')}
        </Box>
        {view.selectedReq === r.id && (
          <Box flexDirection="column" paddingLeft={2} paddingY={1} borderStyle="single" borderColor={p.border}>
            {r.status === 'revisit' && r.revisit && <Text color={p.text2} wrap="wrap">Revisit {r.revisit}</Text>}
            {r.conflict && (
              <Box flexDirection="column" paddingBottom={1}>
                <Text color={p.danger} wrap="wrap">Conflict ({r.conflict.source === 'agent' ? "the agent's work" : 'a later message'}): {r.conflict.reason}</Text>
                <Button key={`res-${r.id}`} label="Resolved" onPress={() => resolveConflict($, r.id)} />
              </Box>
            )}
            {r.history.map((h, i) => (
              <Box key={`h-${i}`} flexDirection="column">
                <Text color={p.text2} wrap="wrap">
                  <Text color={p.text3}>{hhmm(h.at)} {h.kind === 'original' ? 'Asked' : 'Refined'}{h.by === 'agent' ? ' (agent)' : ''}: </Text>“{h.text}”
                </Text>
                {h.kind === 'refinement' && (
                  <Button key={`det-${r.id}-${i}`} label="Not a refinement: make it its own requirement" plain dimColor onPress={() => detachRefinement($, r.id, i)} />
                )}
              </Box>
            ))}
            {plan.filter(st => st.reqIds.includes(r.id)).map((st, i) => (
              <Text key={`ps-${i}`} color={p.text3} wrap="wrap">Plan: {st.status === 'completed' ? '✓' : st.status === 'in_progress' ? '›' : '·'} {st.text}</Text>
            ))}
            {r.evidence.length === 0 && <Text color={p.text3}>No evidence yet.</Text>}
            {r.evidence.map((ev, i) => (
              <Text key={`e-${i}`} color={ev.kind === 'test' || ev.kind === 'manual' ? p.done : p.text2}>
                {ev.kind === 'test' ? 'Passed: ' : ev.kind === 'manual' ? 'Accepted by you: ' : 'Note: '}{ev.text}
              </Text>
            ))}
            {replies.filter(x => x.reqId === r.id).map(x => (
              <Text key={`rr-${x.id}`} color={p.text2}>Your reply {hhmm(x.at)} · {DELIVERY[x.delivery]}</Text>
            ))}
            <Box flexDirection="row" gap={1} paddingTop={1}>
              <Button key={`acc-${r.id}`} label="Accept as verified" onPress={() => acceptReq($, r.id)} />
              <Button key={`def-${r.id}`} label="Defer" onPress={() => deferReq($, r.id)} />
            </Box>
          </Box>
        )}
      </Box>
    )

    const reqFilter = (view.reqFilter ?? 'all') as ReqFilterName
    const shownReqs = filterReqs(reqs, view.search ?? '', reqFilter)
    const reqsTab = (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Input key="req-search" placeholder="Search requirements" value={view.search ?? ''} submitLabel="Search"
            onInput={text => setView({ search: text })} onSubmit={text => setView({ search: text })} />
          <Select key="req-filter" label="Show" value={reqFilter} options={REQ_FILTERS} onSelect={v => setView({ reqFilter: v as ReqFilter })} />
        </Box>
        {reqs.length === 0 && <Text color={p.text3}>Requirements are tagged from your prompts by Haiku as you send them.</Text>}
        {reqs.length > 0 && shownReqs.length === 0 && <Text color={p.text3}>No requirement matches.</Text>}
        {shownReqs.map(reqRow)}
      </Box>
    )

    // ----- signals: failures, refusals, findings, conflicts -----
    const SIGNAL: Record<Signal['kind'], { label: string; tone: Tone }> = {
      failed: { label: 'Failed', tone: 'danger' },
      blocked: { label: 'Blocked', tone: 'danger' },
      finding: { label: 'Found', tone: 'warn' },
      conflict: { label: 'Conflict', tone: 'danger' },
    }
    const signalsTab = (
      <Box flexDirection="column">
        {openSignals.length === 0 && <Text color={p.text3}>Nothing to act on: failed or refused tool calls, unexpected findings and conflicting instructions show here.</Text>}
        {[...openSignals].reverse().map(sg => (
          <Box key={`sg-${sg.id}`} flexDirection="column" paddingBottom={1}>
            <Box flexDirection="row" gap={1}>
              <Text color={p.text3}>{hhmm(sg.at)}</Text>
              {chip(SIGNAL[sg.kind].label, SIGNAL[sg.kind].tone)}
              {sg.reqId && <Text color={p.text3}>{sg.reqId}</Text>}
            </Box>
            <Text color={p.text} wrap="wrap">{sg.text}</Text>
            {sg.reqId && reqs.some(r => r.id === sg.reqId) && <Text color={p.text2} wrap="wrap">{sg.reqId}: {reqs.find(r => r.id === sg.reqId)?.title}</Text>}
            {sg.context?.ask && <Text color={p.text3} wrap="wrap">You had asked: {clip(sg.context.ask, 240)}</Text>}
            {sg.context?.did && <Text color={p.text3} wrap="wrap">{sg.kind === 'finding' || sg.kind === 'conflict' ? 'Agent did' : 'Ran'}: {clip(sg.context.did, 200)}</Text>}
            {sg.context?.output && <Text color={p.text3} wrap="wrap">{sg.kind === 'finding' || sg.kind === 'conflict' ? 'Agent said' : 'Came back'}: {clip(sg.context.output, 300)}</Text>}
            <Box flexDirection="row" gap={1}>
              {sg.eventId && events.some(x => x.id === sg.eventId) && (
                <Button key={`sgr-${sg.id}`} label="Reply" plain onPress={() => setView({ tab: 'activity', selectedEvent: sg.eventId })} />
              )}
              <Button key={`sgq-${sg.id}`} label="Make it a requirement" plain
                onPress={() => sendReply($, events.find(x => x.id === sg.eventId), sg.text, { mode: 'requirement', refines: 'new', interrupt: false })} />
              <Button key={`sgd-${sg.id}`} label="Dismiss" plain dimColor
                onPress={() => update($, signalsA, list => list.map(x => (x.id === sg.id ? { ...x, dismissed: true } : x))).then(() => save($))} />
            </Box>
          </Box>
        ))}
      </Box>
    )

    // ----- plan, tests, previews -----
    const unplanned = plan.length ? reqs.filter(r => !isDone(r) && !plan.some(st => st.reqIds.includes(r.id))) : []
    const planTab = (
      <Box flexDirection="column">
        {plan.length === 0 && <Text color={p.text3}>No plan yet: the agent's todo list or plan shows here, each step linked to the requirements it serves.</Text>}
        {plan.map((st, i) => (
          <Box key={`pl-${i}`} flexDirection="column">
            <Text color={st.status === 'completed' ? p.text3 : p.text} wrap="wrap">
              <Text color={st.status === 'in_progress' ? p.active : st.status === 'completed' ? p.done : p.text3}>{st.status === 'completed' ? '✓ ' : st.status === 'in_progress' ? '› ' : '· '}</Text>
              {st.text}
            </Text>
            <Text color={st.reqIds.length ? p.text3 : p.warn}>  {st.reqIds.length ? st.reqIds.join(', ') : 'serves no requirement'}</Text>
          </Box>
        ))}
        {unplanned.length > 0 && (
          <Box flexDirection="column" paddingTop={1}>
            <Text color={p.warn} bold>Not in the plan</Text>
            {unplanned.map(r => <Text key={`up-${r.id}`} color={p.text2} wrap="wrap">{r.id} {r.title}</Text>)}
          </Box>
        )}
      </Box>
    )
    const testRuns = [...events].reverse().filter(x => x.kind === 'test')
    const testsTab = (
      <Box flexDirection="column">
        {testRuns.length === 0 && <Text color={p.text3}>No test, build or check runs yet.</Text>}
        {testRuns.map(t => {
          const backs = reqs.filter(r => r.evidence.some(ev => ev.eventId === t.id)).map(r => r.id)
          return (
            <Box key={`tr-${t.id}`} flexDirection="column" paddingBottom={1}>
              <Box flexDirection="row" gap={1}>
                <Text color={p.text3}>{hhmm(t.at)}</Text>
                {chip(t.state === 'ok' ? 'Passed' : t.state === 'failed' ? 'Failed' : 'Running', t.state === 'ok' ? 'done' : t.state === 'failed' ? 'danger' : 'active')}
                {backs.length > 0 && <Text color={p.text3}>evidence for {backs.join(', ')}</Text>}
              </Box>
              <Text color={p.text2} wrap="wrap">{t.detail ?? t.title}</Text>
            </Box>
          )
        })}
      </Box>
    )
    const previewTab = (
      <Box flexDirection="column">
        {previews.length === 0 && <Text color={p.text3}>No previews yet: local dev servers and preview links that commands print show here.</Text>}
        {[...previews].reverse().map(pv => (
          <Box key={`pv-${pv.url}`} flexDirection="row" gap={1}>
            <Text color={p.text3}>{hhmm(pv.at)}</Text>
            <Link href={pv.url} label={pv.url} />
          </Box>
        ))}
      </Box>
    )

    // ----- activity -----
    // An open requirement narrows the activity to its own.
    const forReq = view.selectedReq
    const linkOf = linker(reqs, turns.map(t => t.at))
    const shown = events.filter(ev => {
      if (forReq && !linkOf(ev).includes(forReq)) return false
      const f: Filter = view.filter
      if (f === 'all') return true
      if (f === 'code') return ev.kind === 'code'
      if (f === 'tests') return ev.kind === 'test'
      if (f === 'messages') return ev.kind === 'message'
      return ev.kind !== 'discovery' && ev.kind !== 'command'
    })
    const room = Math.max(6, (e.viewport?.rows ?? 40) - 24)
    const selected = events.find(ev => ev.id === view.selectedEvent)

    const composer = selected && (
      <Box flexDirection="column" paddingTop={1} paddingX={1} borderStyle="round" borderColor={p.active}>
        <Text color={p.text3}>Replying to</Text>
        <Text color={p.text}>
          {chip(KIND[selected.kind].label, KIND[selected.kind].tone)} {hhmm(selected.at)} · {selected.title}
        </Text>
        {selected.detail && <Text color={p.text2}>{clip(selected.detail, 600)}</Text>}
        {selected.file && (
          <Box flexDirection="row" gap={1} paddingY={1}>
            <Text color={p.text3}>{base(selected.file)}</Text>
            {selected.kind === 'code' && plat.editors.map(ed => (
              <Button key={`ed-${ed.name}`} label={`Diff in ${ed.name}`} onPress={() => openDiff($, selected, ed.name)} />
            ))}
            {selected.kind === 'code' && <Button key="ed-term" label="Diff in Terminal" onPress={() => openDiff($, selected, 'terminal')} />}
          </Box>
        )}
        {replies.filter(r => r.eventId === selected.id).map(r => (
          <Text key={`th-${r.id}`} color={p.text2}>
            <Text color={p.text3}>You {hhmm(r.at)}: </Text>{r.text} <Text color={r.delivery === 'failed' ? p.danger : p.text3}>({DELIVERY[r.delivery]}{r.error ? `: ${r.error}` : ''})</Text>
          </Text>
        ))}
        <Select
          key="mode"
          label="Reply as"
          value={view.mode}
          options={[
            { value: 'comment', label: 'Comment only (agent does not see it)' },
            { value: 'requirement', label: 'Add or refine a requirement' },
            { value: 'redirect', label: 'Instruction to the agent' },
          ]}
          onSelect={v => setView({ mode: v as ReplyMode })}
        />
        {view.mode === 'requirement' && (
          <Select
            key="refines"
            label="Requirement"
            value={view.refines}
            options={[{ value: 'new', label: 'New requirement' }, ...reqs.map(r => ({ value: r.id, label: `Refines ${r.id}: ${clip(r.title, 50)}` }))]}
            onSelect={v => setView({ refines: v })}
          />
        )}
        {view.mode !== 'comment' && (
          <Button key="interrupt" label={`${view.interrupt ? '[x]' : '[ ]'} Interrupt the agent first`} plain onPress={() => setView({ interrupt: !view.interrupt })} />
        )}
        <Input key="reply" placeholder="Reply to this activity…" submitLabel="Send" onSubmit={text => (text.trim() ? sendReply($, selected, text.trim(), view) : undefined)} />
      </Box>
    )

    const activityTab = (
      <Box flexDirection="column">
        {forReq && (
          <Box flexDirection="row" gap={1}>
            <Text color={p.text2} bold>For {forReq}</Text>
            <Button key="act-all" label="All activity" plain dimColor onPress={() => setView({ selectedReq: undefined })} />
          </Box>
        )}
        <Select
          key="filter"
          label="Show"
          value={view.filter}
          options={[
            { value: 'key', label: 'Key events' },
            { value: 'all', label: 'Everything' },
            { value: 'code', label: 'Code changes' },
            { value: 'tests', label: 'Tests' },
            { value: 'messages', label: 'Agent messages' },
          ]}
          onSelect={v => setView({ filter: v as Filter })}
        />
        {shown.length === 0 && <Text color={p.text3}>No activity yet.</Text>}
        {shown.slice(-room).reverse().map(ev => {
          const k = KIND[ev.kind]
          const n = replies.filter(r => r.eventId === ev.id).length
          const isSel = ev.id === view.selectedEvent
          return (
            <Box key={`evr-${ev.id}`} flexDirection="row" gap={1}>
              <Text color={p.text3}>{hhmm(ev.at)}</Text>
              <Text color={isSel ? p.active : toneFg(p, k.tone)} bold={isSel}>{k.label}</Text>
              <Button key={`ev-${ev.id}`} label={clip(ev.title, 70)} plain onPress={() => setView({ selectedEvent: isSel ? undefined : ev.id })} />
              {ev.state === 'failed' && <Text color={p.danger}>failed</Text>}
              {ev.state === 'running' && <Text color={p.active}>running</Text>}
              {n > 0 && <Text color={p.text3}>· {n} repl{n === 1 ? 'y' : 'ies'}</Text>}
            </Box>
          )
        })}
        {composer}
      </Box>
    )

    // ----- audit -----
    const gap = (r: Requirement) => gapOf(r, plan)
    const open = live.filter(r => gap(r))
    const auditTab = (
      <Box flexDirection="column">
        <Text color={p.text}>
          Accounted for: {live.filter(r => r.status !== 'captured').length}/{live.length} · Verified: <Text color={p.done}>{verified}/{live.length}</Text>
        </Text>
        <Text color={p.text3}>The agent saying something is done does not count. Verified needs a passing check or your acceptance.</Text>
        <Box flexDirection="column" paddingY={1}>
          {reqs.map(r => (
            <Text key={`a-${r.id}`} color={p.text}>
              {chip(r.needsReverify ? 'Re-verify' : STATUS[r.status].label, r.needsReverify ? 'warn' : STATUS[r.status].tone)} <Text color={p.text3}>{r.id}</Text> {r.title}
              {gap(r) && <Text color={r.conflict ? p.danger : p.text3}> · {gap(r)}</Text>}
            </Text>
          ))}
        </Box>
        {live.some(r => r.status === 'revisit') && (
          <Box flexDirection="column" paddingBottom={1}>
            <Text color={p.text2} bold>To revisit</Text>
            {live.filter(r => r.status === 'revisit').map(r => <Text key={`rv-${r.id}`} color={p.text3} wrap="wrap">{r.id} {r.title}: {r.revisit}</Text>)}
          </Box>
        )}
        {open.length > 0 && (
          <Button
            key="close-gaps"
            variant="primary"
            onPress={async () => {
              await askGaps($)
              await $.ui.toast('Sent the open requirements to the agent.')
            }}
            label={`Ask agent to close ${open.length} gap${open.length === 1 ? '' : 's'}`}
          />
        )}
      </Box>
    )

    const cols = e.props.bodyColumns
    if (cols >= SIDE_BY_SIDE_AT) {
      // Wide: the mockup's layout, requirements | activity + reply | audit.
      const heading = (text: string) => <Text color={p.text2} bold>{text}</Text>
      const column = (key: string, width: number, title: string, body: RenderChildren) => (
        <Box key={key} flexDirection="column" width={width} paddingX={1} borderStyle="single" borderColor={p.border}>
          {heading(title)}
          {body}
        </Box>
      )
      const inner = cols - 4
      const side = Math.max(34, Math.floor(inner * 0.28))
      return (
        <Box flexDirection="column" padding={1} backgroundColor={p.bg}>
          <Box flexDirection="row" justifyContent="space-between">
            {header}
            <Button key="theme" label={view.dark ? 'Light mode' : 'Dark mode'} plain dimColor onPress={async () => { await setView({ dark: !view.dark }); await $.store.set('dark', !view.dark) }} />
          </Box>
          <Box flexDirection="row" gap={1}>
            {column('col-reqs', side, `Requirements (${reqs.length})`, reqsTab)}
            {column('col-activity', inner - side * 3 - 3, `Activity (${shown.length})`, activityTab)}
            {column('col-signals', side, `Signals (${openSignals.length})`, signalsTab)}
            {column('col-audit', side, 'Completion audit', <Box flexDirection="column">{auditTab}{planTab}</Box>)}
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" padding={1} backgroundColor={p.bg}>
        {header}
        {tabs}
        {{ reqs: reqsTab, signals: signalsTab, activity: activityTab, plan: planTab, tests: testsTab, preview: previewTab, audit: auditTab }[view.tab]}
      </Box>
    )
  })
}
