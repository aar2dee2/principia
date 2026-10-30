// The ledger in its own terminal window, for every Claude Code session running Principia.
// Run by the principia program (cli.mjs): reads each session's state-<id>.json from the
// data folder and sends what you do back through that session's inbox-<id>.jsonl.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

import { DEFAULT_THEME, palette } from '../hooks/theme.ts'
import { REQ_FILTERS, filterReqs, gapOf, isSecretPath, isVerified, linker } from '../hooks/work.ts'
import { LIFETIME, fmtKb } from '../hooks/footprint.ts'

const G = globalThis.PRINCIPIA ?? { args: process.argv.slice(2), self: [process.execPath, process.argv[1]], isCompiled: false }
const HOME = os.homedir()
const dir = G.args[0] || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'), 'principia')
const projectsDir = G.args[2] || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'), 'projects')
let cur = G.args[1] ?? ''

const isWindows = process.platform === 'win32'
const ALIVE = path.join(dir, 'viewer.alive') // the mod opens no second window while this is fresh
const FOCUS = path.join(dir, 'viewer.focus') // a session the mod asks this window to show
const PREFS = path.join(dir, 'viewer.prefs.json')
const RELOAD = 75
const LIVE_MS = 20_000
const MONTH = 30 * 24 * 3600 * 1000

// ---------- supervisor: restart the window when its program changes ----------

const NEXT = path.join(dir, 'viewer.next') // a newly installed program the window should move to

if (!process.env.PRINCIPIA_VIEWER_CHILD) {
  let select = cur
  let self = G.self
  for (;;) {
    const r = spawnSync(self[0], [...self.slice(1), 'view', dir, select, projectsDir], {
      stdio: 'inherit', env: { ...process.env, PRINCIPIA_VIEWER_CHILD: '1' },
    })
    if (r.status !== RELOAD) process.exit(r.status ?? 0)
    try { select = fs.readFileSync(path.join(dir, 'viewer.select'), 'utf8').trim() } catch { /* keep */ }
    try {
      const next = fs.readFileSync(NEXT, 'utf8').trim()
      if (next && fs.existsSync(next) && G.isCompiled) self = [next]
    } catch { /* stay on this program */ }
  }
}

// ---------- state ----------

const sessions = new Map() // id -> { state, mtime }
const titles = new Map() // id -> { title, mtime } from Claude Code's own transcript
let transcriptOf = new Map() // id -> transcript path
let prefs = { dark: undefined, showSessions: true, showAudit: true, showHeadless: false }
try { prefs = { ...prefs, ...JSON.parse(fs.readFileSync(PREFS, 'utf8')) } } catch { /* defaults */ }
const savePrefs = () => { try { fs.writeFileSync(PREFS, JSON.stringify(prefs)) } catch { /* next time */ } }

const EMPTY = { reqs: [], events: [], replies: [], signals: [], plan: [], previews: [], editors: [], isWorking: false, title: '', project: '' }
let S = EMPTY
let focus = 'reqs' // sessions | reqs | signals | middle
let middle = 'activity' // activity | plan | tests | preview | signals | footprint
let showAll = false
let allActivity = false // A: every event, not only the requirement in view's
let search = ''
let reqFilter = 'all'
const sel = { reqs: 0, signals: 0, activity: 0, plan: 0, tests: 0, preview: 0, footprint: 0 }
let compose = null // { mode, text, interrupt, eventId, refines } | { mode: 'search', text }
let flash = ''
// Commands are ordered by time across windows: the session keeps only ones newer than the last.
let seq = 0
const nextSeq = () => (seq = Math.max(seq + 1, Date.now() * 1000))

// ---------- helpers ----------

const out = process.stdout
const now = () => Date.now()
const hhmm = t => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
const inboxFile = () => path.join(dir, `inbox-${cur}.jsonl`)
const aliveAt = id => { try { return fs.statSync(path.join(dir, `alive-${id}`)).mtimeMs } catch { return 0 } }
const isLive = st => !st.imported && !st.hasEnded && now() - aliveAt(st.sessionId) < LIVE_MS
// Headless: started by the SDK, or never drew the pane (claude -p run from inside another session inherits its entry).
const isHeadless = st => /^sdk/.test(st.entry ?? '') || st.drawn === false
// Sessions without a project folder (named scratch-…, or imported by 0.2) sit under "This computer", as in the app.
const projectOf = st => (/^scratch-\d{4}-\d{2}-\d{2}-/.test(st.project ?? '') ? 'This computer' : st.project || 'Other')
const nameOf = st => titles.get(st.sessionId)?.title || st.title || 'No prompt yet'

// One theme and one mode for the whole window: the newest session's theme, your own light/dark.
function theme() {
  let newest
  for (const { state } of sessions.values()) if (state.theme && (!newest || state.at > newest.at)) newest = state
  return newest?.theme ?? DEFAULT_THEME
}
const isDark = () => prefs.dark ?? true
let P = palette(DEFAULT_THEME, true)
const tone = (t, dim) => (t === 'muted' ? (dim ? P.mutedDim : P.text3) : P[dim ? `${t}Dim` : t])

// Full colour where the terminal has it; the nearest of 256 elsewhere (Apple Terminal, older consoles).
const TRUECOLOR = /truecolor|24bit/i.test(process.env.COLORTERM ?? '') ||
  ['iTerm.app', 'WezTerm', 'ghostty', 'vscode', 'WarpTerminal'].includes(process.env.TERM_PROGRAM ?? '') ||
  Boolean(process.env.WT_SESSION || process.env.KITTY_WINDOW_ID)
const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
function to256(hex) {
  const [r, g, b] = rgb(hex)
  const level = c => (c < 48 ? 0 : c < 115 ? 1 : Math.floor((c - 35) / 40))
  const steps = [0, 95, 135, 175, 215, 255]
  const greyIdx = 232 + Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)))
  const dist = (x, y, z) => (r - x) ** 2 + (g - y) ** 2 + (b - z) ** 2
  const gv = 8 + 10 * (greyIdx - 232)
  return dist(...[level(r), level(g), level(b)].map(l => steps[l])) <= dist(gv, gv, gv) ? 16 + 36 * level(r) + 6 * level(g) + level(b) : greyIdx
}
const fgCode = hex => (TRUECOLOR ? `\x1b[38;2;${rgb(hex).join(';')}m` : `\x1b[38;5;${to256(hex)}m`)
const bgCode = hex => (TRUECOLOR ? `\x1b[48;2;${rgb(hex).join(';')}m` : `\x1b[48;5;${to256(hex)}m`)

const STATUS = {
  captured: ['Not started', 'muted'], in_progress: ['In progress', 'active'], implemented: ['Done, not verified', 'warn'],
  verified: ['Verified', 'done'], blocked: ['Blocked', 'danger'], needs_clarification: ['Needs you', 'warn'], deferred: ['Deferred', 'muted'],
  revisit: ['Done for now · revisit', 'done'],
}
const KIND = { discovery: ['Discovery', 'muted'], plan: ['Plan', 'active'], code: ['Code change', 'active'], command: ['Command', 'muted'], test: ['Test', 'warn'], message: ['Agent', 'active'] }
const SIGNAL = { failed: ['Failed', 'danger'], blocked: ['Blocked', 'danger'], finding: ['Found', 'warn'], conflict: ['Conflict', 'danger'] }
const DELIVERY = { kept: 'comment, not sent', queued: 'queued for your next prompt', received: 'received by agent', acted: 'agent finished a turn after it', failed: 'not delivered' }
const MODES = { comment: 'Comment (agent does not see it)', requirement: 'New requirement', refine: 'Refine', redirect: 'Instruction to the agent' }

// A line is a list of segments: [text, fg, bg?, bold?]
const seg = (text, fg, bg, bold) => [String(text), fg, bg, bold]
const chip = (label, t) => seg(` ${label} `, tone(t), tone(t, true))
const key = k => seg(k, P.active, undefined, true)

function paint(line, w, rowBg) {
  let left = w
  let str = ''
  for (const [text, fg, bg, bold] of line) {
    if (left <= 0) break
    const chars = [...text.replace(/[\n\r\t]/g, ' ')]
    const part = chars.length > left ? `${chars.slice(0, Math.max(0, left - 1)).join('')}…` : chars.join('')
    left -= [...part].length
    str += `${fgCode(fg ?? P.text)}${bgCode(bg ?? rowBg)}${bold ? '\x1b[1m' : ''}${part}\x1b[22m`
  }
  return `${str}${bgCode(rowBg)}${' '.repeat(Math.max(0, left))}`
}

function wrapText(text, w) {
  const lines = []
  for (const para of String(text).split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/)) {
      if (line && [...`${line} ${word}`].length > w) { lines.push(line); line = word } else line = line ? `${line} ${word}` : word
      while ([...line].length > w) { lines.push([...line].slice(0, w).join('')); line = [...line].slice(w).join('') }
    }
    lines.push(line)
  }
  return lines
}
const wrap = (text, w, fg, indent = '') => wrapText(text, Math.max(8, w - indent.length)).map(l => [seg(indent + l, fg)])

// ---------- sessions: names, liveness, grouping ----------

function indexTranscripts() {
  const map = new Map()
  try {
    for (const p of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!p.isDirectory()) continue
      for (const f of fs.readdirSync(path.join(projectsDir, p.name))) if (f.endsWith('.jsonl')) map.set(f.slice(0, -6), path.join(projectsDir, p.name, f))
    }
  } catch { /* no transcripts folder */ }
  transcriptOf = map
}

// The session's name as Claude Code shows it: its latest custom title, read from the transcript's tail.
function refreshTitles() {
  // Transcripts are read only once you've allowed it (the consent dialog); until then, first prompts.
  const allowed = [...sessions.values()].some(x => x.state.transcriptsAllowed)
  if (!allowed) return
  for (const id of sessions.keys()) {
    const file = transcriptOf.get(id)
    if (!file) continue
    try {
      const st = fs.statSync(file)
      if (titles.get(id)?.mtime === st.mtimeMs) continue
      const size = Math.min(st.size, 512 * 1024)
      const buf = Buffer.alloc(size)
      const fd = fs.openSync(file, 'r')
      fs.readSync(fd, buf, 0, size, st.size - size)
      fs.closeSync(fd)
      let title = titles.get(id)?.title ?? ''
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line.includes('"custom-title"')) continue
        try { title = JSON.parse(line).customTitle || title } catch { /* partial first line */ }
      }
      titles.set(id, { title, mtime: st.mtimeMs })
    } catch { /* unreadable: keep the first prompt */ }
  }
}

// One order for drawing the list and for [ and ]: projects, then sessions within each,
// most recently active first. It is worked out again only when a session appears or goes
// (or headless sessions are shown or hidden), so it holds still while you move through it.
let order = []
let orderKey = ''
function sessionList() {
  const shown = [...sessions.values()]
    .map(x => x.state)
    .filter(st => now() - (st.at ?? 0) < MONTH && (prefs.showHeadless || !isHeadless(st)))
  const key = shown.map(st => st.sessionId).sort().join(',')
  if (key !== orderKey) {
    orderKey = key
    const groups = new Map()
    for (const st of [...shown].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))) {
      groups.set(projectOf(st), [...(groups.get(projectOf(st)) ?? []), st.sessionId])
    }
    order = [...groups.values()].flat()
  }
  const byId = new Map(shown.map(st => [st.sessionId, st]))
  return order.map(id => byId.get(id)).filter(Boolean)
}

// ---------- columns ----------

function sessionLines(w) {
  const list = sessionList()
  const lines = [[seg(`SESSIONS  ${list.length}`, P.text2, undefined, true)], []]
  // Consecutive runs of one project, in the same order [ and ] move through.
  const groups = []
  for (const st of list) {
    const last = groups[groups.length - 1]
    if (last && last[0] === projectOf(st)) last[1].push(st)
    else groups.push([projectOf(st), [st]])
  }
  for (const [project, group] of groups) {
    lines.push([seg(project, P.text3)])
    for (const st of group) {
      const isCur = st.sessionId === cur
      const live = isLive(st)
      const L = st.reqs.filter(r => r.status !== 'deferred')
      const v = L.filter(isVerified).length
      const signals = (st.signals ?? []).filter(x => !x.dismissed).length
      const dot = st.isWorking && live ? seg('● ', P.active) : live ? seg('○ ', P.done) : st.imported ? seg('◌ ', P.text3) : seg('· ', P.text3)
      const rows = wrapText(nameOf(st), w - 2).slice(0, 2)
      rows.forEach((row, i) => lines.push({ sel: isCur, line: [i ? seg('  ') : dot, seg(row, live || isCur ? P.text : P.text3, undefined, isCur)] }))
      lines.push({ sel: isCur, line: [seg('  '), seg(`${v}/${L.length} verified`, v === L.length && L.length ? P.done : P.text3),
        ...(signals ? [seg(` · ${signals} signal${signals === 1 ? '' : 's'}`, P.warn)] : []),
        ...(live ? [] : [seg(st.imported ? ' · imported' : ' · not running', P.text3)])] })
    }
    lines.push([])
  }
  if (!list.length) lines.push(...wrap('No sessions are running Principia yet.', w, P.text3))
  return lines
}

const shownReqs = () => filterReqs(S.reqs, search, reqFilter)
const openSignals = () => (S.signals ?? []).filter(x => !x.dismissed).slice().reverse()
// The requirement in view: the one selected in the requirements column, wherever focus is.
const reqInView = () => shownReqs()[sel.reqs]
// Which requirements each event was for: its own links, else worked out from when you asked.
let linkOf = linker([])
const forReq = () => (allActivity ? undefined : reqInView())
const shownEvents = () => {
  const r = forReq()
  return [...S.events].filter(e => (!r || linkOf(e).includes(r.id)) && (showAll || r || (e.kind !== 'discovery' && e.kind !== 'command'))).reverse()
}
const testRuns = () => [...S.events].filter(e => e.kind === 'test').reverse()
const previews = () => [...(S.previews ?? [])].reverse()

// ---------- footprint: memory held, files left ----------

const sizeKb = file => { try { return Math.round(fs.statSync(file).size / 1024) } catch { return 0 } }
// How long Claude Code keeps transcripts (its cleanupPeriodDays setting; 30 by default), and
// whether Time Machine has a backup, each checked now and then.
let keepDays = 30
let backup = { checked: 0, latest: '' }
function checkBackup() {
  try { keepDays = Number(JSON.parse(fs.readFileSync(path.join(path.dirname(dir), 'settings.json'), 'utf8')).cleanupPeriodDays) || 30 } catch { /* default */ }
  if (process.platform !== 'darwin') return
  try {
    const r = spawn('tmutil', ['latestbackup'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let outText = ''
    r.stdout.on('data', d => { outText += d })
    r.on('close', code => { backup = { checked: now(), latest: code === 0 ? outText.trim().split('/').pop() ?? '' : '' } })
  } catch { backup = { checked: now(), latest: '' } }
}
// Every session, with what it costs: live ones report their memory and folder themselves.
function footList() {
  return sessionList().map(st => {
    const f = st.footprint ?? {}
    const live = isLive(st)
    const transcriptKb = sizeKb(transcriptOf.get(st.sessionId) ?? '') || f.transcriptKb || 0
    const ledgerKb = sizeKb(path.join(dir, `state-${st.sessionId}.json`))
    const workspaceKb = f.workspace ? f.workspaceKb || 0 : 0
    return { st, live, ramKb: live ? f.ramKb || 0 : 0, procs: live ? f.procs || 0 : 0, transcriptKb, ledgerKb, workspaceKb, workspace: f.workspace, diskKb: transcriptKb + ledgerKb + workspaceKb }
  }).sort((a, b) => (b.ramKb + b.diskKb) - (a.ramKb + a.diskKb))
}

function reqLines(w) {
  const reqs = shownReqs()
  const filterLabel = REQ_FILTERS.find(f => f.value === reqFilter)?.label ?? 'All'
  const lines = [[seg(`REQUIREMENTS  ${reqs.length}${reqs.length !== S.reqs.length ? `/${S.reqs.length}` : ''}`, P.text2, undefined, true),
    seg(`  ${filterLabel}${search ? ` · “${search}”` : ''}`, P.text3)], []]
  if (!S.reqs.length) lines.push(...wrap('Tagged from your prompts by Haiku as you send them.', w, P.text3))
  else if (!reqs.length) lines.push(...wrap('No requirement matches. / to search, F to change the filter.', w, P.text3))
  reqs.forEach((r, i) => {
    const [label, t] = r.needsReverify ? ['Re-verify', 'warn'] : STATUS[r.status]
    const isSel = focus === 'reqs' && i === sel.reqs
    const head = `${r.id} `
    wrapText(r.title, w - 2 - head.length).forEach((row, j) => lines.push({ sel: isSel, line: [j ? seg('  ' + ' '.repeat(head.length)) : seg(isSel ? '› ' : '  ', P.active), ...(j ? [] : [seg(head, P.text3)]), seg(row, P.text, undefined, isSel)] }))
    lines.push({ sel: isSel, line: [seg('  ' + ' '.repeat(head.length)), seg(label, tone(t)), ...(r.conflict ? [seg('  '), chip('Conflict', 'danger')] : [])] })
  })
  return lines
}

function signalLines(w, heading = true) {
  const list = openSignals()
  const lines = heading ? [[seg(`SIGNALS  ${list.length}`, P.text2, undefined, true), seg('  failed · blocked · found · conflict', P.text3)], []] : []
  if (!list.length) lines.push(...wrap('Nothing to act on. Failed or refused tool calls, unexpected findings and conflicting instructions show here.', w, P.text3))
  list.forEach((x, i) => {
    const [label, t] = SIGNAL[x.kind] ?? ['Signal', 'muted']
    const isSel = (focus === 'signals' || (focus === 'middle' && middle === 'signals')) && i === sel.signals
    lines.push({ sel: isSel, line: [seg(isSel ? '› ' : '  ', P.active), seg(`${hhmm(x.at)} `, P.text3), chip(label, t), ...(x.reqId ? [seg(` ${x.reqId}`, P.text3)] : [])] })
    for (const row of wrapText(x.text, w - 4).slice(0, 4)) lines.push({ sel: isSel, line: [seg('    '), seg(row, P.text)] })
  })
  return lines
}

function middleLines(w, withSignals) {
  const tabs = [['activity', `1 Activity ${shownEvents().length}`], ['plan', `2 Plan ${S.plan?.length ?? 0}`], ['tests', `3 Tests ${testRuns().length}`],
    ['preview', `4 Preview ${S.previews?.length ?? 0}`], ...(withSignals ? [['signals', `5 Signals ${openSignals().length}`]] : []), ...(middle === 'footprint' ? [['footprint', 'M Footprint']] : [])]
  const lines = [tabs.flatMap(([id, label]) => [seg(` ${label} `, middle === id ? P.text : P.text3, middle === id ? P.surface2 : undefined, middle === id), seg(' ')]), []]
  const isSel = (list, i) => focus === 'middle' && i === sel[list]
  if (middle === 'signals') return [...lines, ...signalLines(w, false)]
  if (middle === 'activity') {
    const evs = shownEvents()
    const r = forReq()
    if (r) lines.push([seg(`for ${r.id}`, P.text2, undefined, true), seg('  A all activity', P.text3)])
    else lines.push([seg(`all activity · ${showAll ? 'everything' : 'key events'}`, P.text3), seg(`  ${reqInView() ? `A only ${reqInView().id}  ` : ''}v to switch`, P.text3)])
    if (!evs.length) lines.push(...wrap(r ? `No activity for ${r.id} yet. Work on it shows here as the agent does it. A shows everything.` : 'No activity yet.', w, P.text3))
    evs.forEach((ev, i) => {
      const [label, t] = KIND[ev.kind] ?? ['Event', 'muted']
      const n = S.replies.filter(r => r.eventId === ev.id).length
      lines.push({ sel: isSel('activity', i), line: [seg(isSel('activity', i) ? '› ' : '  ', P.active), seg(`${hhmm(ev.at)} `, P.text3), seg(`${label} `, tone(t)),
        seg(ev.title, P.text, undefined, isSel('activity', i)),
        ...(ev.state === 'failed' ? [seg('  failed', P.danger)] : ev.state === 'running' ? [seg('  running', P.active)] : []),
        ...(n ? [seg(`  · ${n} repl${n === 1 ? 'y' : 'ies'}`, P.text3)] : [])] })
    })
  } else if (middle === 'plan') {
    const plan = S.plan ?? []
    if (!plan.length) lines.push(...wrap("No plan yet. The agent's todo list shows here, each step linked to the requirements it serves.", w, P.text3))
    plan.forEach((st, i) => {
      const mark = st.status === 'completed' ? seg('✓ ', P.done) : st.status === 'in_progress' ? seg('› ', P.active) : seg('· ', P.text3)
      wrapText(st.text, w - 4).forEach((row, j) => lines.push({ sel: isSel('plan', i), line: [j ? seg('  ') : mark, seg(row, st.status === 'completed' ? P.text3 : P.text)] }))
      lines.push({ sel: isSel('plan', i), line: [seg('  '), seg(st.reqIds.length ? st.reqIds.join(', ') : 'serves no requirement', st.reqIds.length ? P.text3 : P.warn)] })
    })
    const unplanned = plan.length ? S.reqs.filter(r => !isVerified(r) && r.status !== 'deferred' && !plan.some(st => st.reqIds.includes(r.id))) : []
    if (unplanned.length) {
      lines.push([], [seg('NOT IN THE PLAN', P.warn, undefined, true)])
      for (const r of unplanned) lines.push(...wrap(`${r.id} ${r.title}`, w, P.text2))
    }
  } else if (middle === 'tests') {
    const runs = testRuns()
    if (!runs.length) lines.push([seg('No test, build or check runs yet.', P.text3)])
    runs.forEach((t, i) => {
      const backs = S.reqs.filter(r => r.evidence.some(e => e.eventId === t.id)).map(r => r.id)
      lines.push({ sel: isSel('tests', i), line: [seg(`${hhmm(t.at)} `, P.text3),
        chip(t.state === 'ok' ? 'Passed' : t.state === 'failed' ? 'Failed' : 'Running', t.state === 'ok' ? 'done' : t.state === 'failed' ? 'danger' : 'active'),
        ...(backs.length ? [seg(` evidence for ${backs.join(', ')}`, P.text3)] : [])] })
      for (const row of wrapText(t.detail ?? t.title, w - 2).slice(0, 2)) lines.push({ sel: isSel('tests', i), line: [seg('  '), seg(row, P.text2)] })
    })
  } else if (middle === 'footprint') {
    const list = footList()
    const ram = list.reduce((n, x) => n + x.ramKb, 0), disk = list.reduce((n, x) => n + x.diskKb, 0)
    lines.push([seg('Memory ', P.text3), seg(fmtKb(ram), P.text, undefined, true), seg(' · on disk ', P.text3), seg(fmtKb(disk), P.text, undefined, true), seg(' · this computer only', P.text3)])
    lines.push([])
    const cw = 9
    lines.push([seg(' '.repeat(w - cw * 3 - 2)), seg('memory'.padStart(cw), P.text3), seg('on disk'.padStart(cw), P.text3), seg('folder'.padStart(cw), P.text3)])
    list.forEach((x, i) => {
      const name = [...`${x.live ? (x.st.isWorking ? '● ' : '○ ') : '· '}${nameOf(x.st)}`].slice(0, w - cw * 3 - 3).join('')
      lines.push({ sel: isSel('footprint', i), line: [seg(name.padEnd(w - cw * 3 - 2), x.live ? P.text : P.text3),
        seg((x.live ? fmtKb(x.ramKb) : '–').padStart(cw), x.live ? P.active : P.text3), seg(fmtKb(x.diskKb).padStart(cw), P.text),
        seg((x.workspace ? fmtKb(x.workspaceKb) : '–').padStart(cw), x.workspace ? P.warn : P.text3)] })
    })
    lines.push([], ...wrap(`Transcripts (~/.claude/projects) are ${LIFETIME.transcript(keepDays)}. Ledgers (~/.claude/principia) are ${LIFETIME.ledger}. A folder is the session's own: ${LIFETIME.scratch}, or ${LIFETIME.worktree}.`, w, P.text3))
    lines.push([], ...wrap(backup.latest ? `Time Machine's last backup: ${backup.latest}. Nothing here is synced anywhere else.` : backup.checked ? 'No Time Machine backup found: these files exist on this computer only.' : 'Checking for a Time Machine backup…', w, backup.latest ? P.text3 : P.warn))
  } else if (middle === 'preview') {
    const list = previews()
    if (!list.length) lines.push(...wrap('No previews yet. Local dev servers and preview links that commands print show here. Enter opens one.', w, P.text3))
    list.forEach((pv, i) => lines.push({ sel: isSel('preview', i), line: [seg(isSel('preview', i) ? '› ' : '  ', P.active), seg(`${hhmm(pv.at)} `, P.text3), seg(pv.url, P.active)] }))
  }
  return lines
}

function eventDetail(ev, w) {
  const lines = []
  const [label, t] = KIND[ev.kind] ?? ['Event', 'muted']
  lines.push([chip(label, t), seg(`  ${hhmm(ev.at)}`, P.text3)], ...wrap(ev.title, w, P.text))
  if (ev.file) lines.push([seg(ev.file, P.text3)])
  if (linkOf(ev).length) lines.push([seg(`For ${linkOf(ev).join(', ')}`, P.text3)])
  if (ev.detail) lines.push([], ...wrap(ev.detail, w, P.text2).slice(0, 14))
  const thread = S.replies.filter(r => r.eventId === ev.id)
  if (thread.length) lines.push([])
  for (const r of thread) {
    lines.push([seg(`You ${hhmm(r.at)}`, P.text3), seg(`  ${DELIVERY[r.delivery]}${r.error ? `: ${r.error}` : ''}`, r.delivery === 'failed' ? P.danger : r.delivery === 'kept' ? P.text3 : P.active)])
    lines.push(...wrap(r.text, w, P.text2, '  '))
  }
  lines.push([], [key('c'), seg(' comment  ', P.text3), key('n'), seg(' new requirement  ', P.text3), key('i'), seg(' instruct agent', P.text3)])
  if (ev.kind === 'code' && ev.file) lines.push([...(S.editors[0] ? [key('o'), seg(` diff in ${S.editors[0].name}  `, P.text3)] : []), key('t'), seg(' diff here', P.text3)])
  return lines
}

// What was going on when a signal was raised, so it reads on its own.
function signalContext(sig, w) {
  const lines = []
  const ev = S.events.find(e => e.id === sig.eventId)
  const ids = [...new Set([sig.reqId, ...(ev ? linkOf(ev) : [])].filter(Boolean))]
  const part = (label, text, fg, max) => { if (text?.trim()) lines.push([seg(label, P.text3)], ...wrap(text.trim(), w, fg, '  ').slice(0, max), []) }
  for (const id of ids) { const r = S.reqs.find(x => x.id === id); if (r) part(`Requirement ${r.id}`, r.title, P.text, 3) }
  const c = sig.context ?? {}
  part('You had asked', c.ask, P.text2, 5)
  part(sig.kind === 'finding' || sig.kind === 'conflict' ? 'What the agent did' : ev ? `What it ran (${(KIND[ev.kind] ?? ['Event'])[0].toLowerCase()})` : 'What it ran', c.did ?? ev?.detail ?? ev?.title, P.text2, 6)
  part(sig.kind === 'finding' || sig.kind === 'conflict' ? 'What the agent said' : 'What came back', c.output, P.text2, 8)
  if (!sig.context && !ids.length) lines.push(...wrap('Raised before signals kept their context (0.3.6). Enter goes to the event it came from.', w, P.text3), [])
  return lines
}

function detailLines(w) {
  const lines = []
  const sig = openSignals()[sel.signals]
  if (focus === 'middle' && middle === 'footprint') {
    const x = footList()[sel.footprint]
    if (!x) return lines
    const f = x.st.footprint ?? {}
    lines.push(...wrap(nameOf(x.st), w, P.text), [seg(`${projectOf(x.st)} · ${x.live ? (x.st.isWorking ? 'working' : 'idle') : x.st.imported ? 'imported' : 'not running'}`, P.text3)], [])
    if (x.live) lines.push([seg('Memory now', P.text3)], ...wrap(`${fmtKb(x.ramKb)} across ${x.procs} process${x.procs === 1 ? '' : 'es'}: the session itself and whatever it started (shells, servers, subagents). Freed when the session stops.`, w, P.text2, '  '), [])
    else lines.push([seg('Memory now', P.text3)], ...wrap('Nothing: the session is not running.', w, P.text2, '  '), [])
    lines.push([seg('Files it leaves', P.text3)])
    lines.push(...wrap(`Transcript ${fmtKb(x.transcriptKb)}: ${LIFETIME.transcript(keepDays)}.`, w, P.text2, '  '))
    if (transcriptOf.get(x.st.sessionId)) lines.push(...wrap(transcriptOf.get(x.st.sessionId).replace(HOME, '~'), w, P.text3, '    '))
    lines.push(...wrap(`Ledger ${fmtKb(x.ledgerKb)}: ${LIFETIME.ledger}.`, w, P.text2, '  '))
    if (x.workspace) lines.push(...wrap(`Folder ${fmtKb(x.workspaceKb)}: ${LIFETIME[x.workspace.kind]}.`, w, P.text2, '  '), ...wrap(x.workspace.path.replace(HOME, '~'), w, P.text3, '    '))
    else lines.push(...wrap('No folder of its own: it works in your project, which is yours to keep.', w, P.text2, '  '))
    lines.push([], ...wrap(backup.latest ? `Backed up by Time Machine as of ${backup.latest}; not synced anywhere else.` : 'On this computer only: not backed up, not synced.', w, backup.latest ? P.text2 : P.warn))
    if (f.at) lines.push([], [seg(`measured ${hhmm(f.at)}`, P.text3)])
    return lines
  }
  if (focus === 'reqs') {
    const r = shownReqs()[sel.reqs]
    if (r) {
      const [label, t] = r.needsReverify ? ['Needs re-verification', 'warn'] : STATUS[r.status]
      lines.push(...wrap(r.title, w, P.text), [seg(`${r.id}  `, P.text3), chip(label, t)], [])
      if (r.status === 'revisit' && r.revisit) lines.push(...wrap(`Revisit ${r.revisit}`, w, P.text2), [])
      if (r.conflict) lines.push(...wrap(`Conflict (${r.conflict.source === 'agent' ? "the agent's work" : 'a later message'}): ${r.conflict.reason}`, w, P.danger), [key('x'), seg(' mark resolved', P.text3)], [])
      for (const h of r.history) {
        lines.push([seg(`${hhmm(h.at)} ${h.kind === 'original' ? 'Asked' : 'Refined'}${h.by === 'agent' ? ' (agent)' : ''}`, P.text3)])
        lines.push(...wrap(`“${h.text}”`, w, P.text2, '  '))
      }
      const steps = (S.plan ?? []).filter(st => st.reqIds.includes(r.id))
      if (steps.length) lines.push([], [seg('In the plan', P.text3)], ...steps.flatMap(st => wrap(`${st.status === 'completed' ? '✓' : st.status === 'in_progress' ? '›' : '·'} ${st.text}`, w, P.text2, '  ')))
      lines.push([])
      if (!r.evidence.length) lines.push([seg('No evidence yet.', P.text3)])
      for (const e of r.evidence) lines.push(...wrap(`${e.kind === 'test' ? 'Passed: ' : e.kind === 'manual' ? 'Accepted by you: ' : 'Note: '}${e.text}`, w, e.kind === 'test' || e.kind === 'manual' ? P.done : P.text2))
      lines.push([], [key('a'), seg(' accept  ', P.text3), key('d'), seg(' defer  ', P.text3), key('f'), seg(' refine', P.text3)])
    }
  } else if ((focus === 'signals' || (focus === 'middle' && middle === 'signals')) && sig) {
    const [label, t] = SIGNAL[sig.kind] ?? ['Signal', 'muted']
    lines.push([chip(label, t), seg(`  ${hhmm(sig.at)}${sig.reqId ? `  ${sig.reqId}` : ''}`, P.text3)], ...wrap(sig.text, w, P.text), [])
    lines.push(...signalContext(sig, w))
    lines.push([key('enter'), seg(' go to the event  ', P.text3), key('n'), seg(' make it a requirement  ', P.text3), key('x'), seg(' dismiss', P.text3)])
  } else if (focus === 'middle') {
    const ev = middle === 'activity' ? shownEvents()[sel.activity] : middle === 'tests' ? testRuns()[sel.tests] : undefined
    if (ev) lines.push(...eventDetail(ev, w))
    if (middle === 'preview' && previews()[sel.preview]) lines.push(...wrap(previews()[sel.preview].url, w, P.active), [key('enter'), seg(' open in your browser', P.text3)])
    if (middle === 'plan' && S.plan?.[sel.plan]) {
      const st = S.plan[sel.plan]
      lines.push(...wrap(st.text, w, P.text), [])
      for (const id of st.reqIds) { const r = S.reqs.find(x => x.id === id); if (r) lines.push(...wrap(`${r.id} ${r.title}`, w, P.text2)) }
    }
  }
  if (!prefs.showAudit) return lines.length ? lines : wrap('Completion audit hidden. C shows it.', w, P.text3)
  const L = S.reqs.filter(r => r.status !== 'deferred')
  const verified = L.filter(isVerified).length
  const gaps = L.filter(r => gapOf(r, S.plan ?? []))
  lines.push([], [seg('COMPLETION AUDIT', P.text2, undefined, true)])
  lines.push([seg(`Accounted ${L.filter(r => r.status !== 'captured').length}/${L.length}`, P.text), seg('   '), seg(`Verified ${verified}/${L.length}`, P.done)])
  lines.push(...wrap("The agent saying it's done doesn't count: verified needs a passing check or your acceptance.", w, P.text3))
  for (const r of gaps) lines.push(...wrap(`${r.id} ${gapOf(r, S.plan ?? [])}`, w, r.conflict ? P.danger : P.warn))
  if (gaps.length) lines.push([key('g'), seg(` ask agent to close ${gaps.length} gap${gaps.length === 1 ? '' : 's'}`, P.text3)])
  const later = L.filter(r => r.status === 'revisit')
  if (later.length) lines.push([], [seg('TO REVISIT', P.text2, undefined, true)], ...later.flatMap(r => wrap(`${r.id} ${r.revisit ?? ''}`, w, P.text3)))
  return lines
}

function column(lines, h) {
  const selAt = lines.findIndex(l => l && l.sel)
  const start = selAt >= h - 2 ? selAt - h + 4 : 0
  return lines.slice(Math.max(0, start), Math.max(0, start) + h).map(l => (Array.isArray(l) ? { line: l } : l))
}

function layout(W) {
  const gutter = 3
  const cols = []
  const withSessions = prefs.showSessions && W >= 120
  let rest = W
  if (withSessions) { cols.push(['sessions', 28]); rest -= 28 + gutter }
  if (rest >= 170) {
    const wr = Math.floor((rest - gutter * 3) * 0.27), ws = Math.floor((rest - gutter * 3) * 0.21), wm = Math.floor((rest - gutter * 3) * 0.27)
    cols.push(['reqs', wr], ['middle', wm], ['signals', ws], ['detail', rest - gutter * 3 - wr - ws - wm])
  } else if (rest >= 100) {
    const wr = Math.floor((rest - gutter * 2) * 0.32), wm = Math.floor((rest - gutter * 2) * 0.36)
    cols.push(['reqs', wr], ['middle', wm], ['detail', rest - gutter * 2 - wr - wm])
  } else {
    cols.push(['stack', rest])
  }
  return cols
}

function render() {
  P = palette(theme(), isDark())
  const W = out.columns || 120
  const H = out.rows || 40
  const L = S.reqs.filter(r => r.status !== 'deferred')
  const verified = L.filter(isVerified).length
  const st = sessions.get(cur)?.state
  const state = !st ? seg('no session', P.text3) : st.imported ? seg('imported · read-only until reopened', P.warn)
    : !isLive(st) ? seg('not running · nothing can be sent', P.warn) : st.isWorking ? seg('● working', P.active) : seg('○ idle', P.done)
  const rows = [{ line: [seg(' Principia - Your Claude Code Dashboard ', P.text, undefined, true), seg('  '), seg(` ${st ? `${projectOf(st)} · ${nameOf(st)}` : ''}`, P.text2), seg('   '), state,
    seg(`   ${L.length} requirements · `, P.text3), seg(`${verified} verified`, P.done)] }, { line: [] }]
  const cols = layout(W)
  const hasSignalsCol = cols.some(([c]) => c === 'signals')
  if (!hasSignalsCol && focus === 'signals') { focus = 'middle'; middle = 'signals' }
  if (hasSignalsCol && middle === 'signals') middle = 'activity'
  const bodyH = H - 5
  const drawn = cols.map(([c, w]) => {
    const lines = c === 'sessions' ? sessionLines(w) : c === 'reqs' ? reqLines(w) : c === 'signals' ? signalLines(w) : c === 'middle' ? middleLines(w, !hasSignalsCol)
      : c === 'detail' ? detailLines(w) : [...(focus === 'reqs' ? reqLines(w) : middleLines(w, true)), [], ...detailLines(w)]
    return [column(lines, bodyH), w]
  })
  for (let y = 0; y < bodyH; y++) {
    rows.push({ raw: drawn.map(([lines, w]) => { const l = lines[y]; return paint(l ? l.line : [], w, l && l.sel ? P.surface2 : P.bg) }).join(paint([], 3, P.bg)) })
  }
  let footer
  if (compose?.mode === 'search') {
    footer = [chip('Search requirements', 'active'), seg('  › ', P.active), seg(compose.text + '▏', P.text), seg('   enter apply · esc clear', P.text3)]
  } else if (compose) {
    footer = [seg(`to ${st ? nameOf(st).slice(0, 40) : '?'}  `, P.text3), chip(MODES[compose.mode] + (compose.mode === 'refine' ? ` ${compose.refines}` : ''), compose.mode === 'comment' ? 'muted' : 'active'),
      ...(compose.mode === 'comment' ? [] : [seg('  '), compose.interrupt ? chip('interrupt first', 'danger') : seg('ctrl-t interrupt first', P.text3)]),
      seg('  › ', P.active), seg(compose.text + '▏', P.text)]
  } else {
    footer = [seg(flash || 'tab column · ↑↓ move · [ ] session · S sessions · C audit · A all activity · M footprint · / search · F filter · 1-5 tabs · x resolve/dismiss · l light/dark · h headless · q quit', flash ? P.active : P.text3)]
  }
  rows.push({ line: [] }, { line: [seg('─'.repeat(W), P.border)] }, { line: footer })
  out.write('\x1b[H' + rows.map(r => r.raw ?? paint(r.line, W, P.bg)).join('\r\n') + '\x1b[0m')
}

// ---------- state in, commands out ----------

function scan() {
  let changed = false
  let names = []
  try { names = fs.readdirSync(dir).filter(n => /^state-.+\.json$/.test(n)) } catch { /* nothing yet */ }
  for (const name of names) {
    const file = path.join(dir, name)
    try {
      const mtime = fs.statSync(file).mtimeMs
      const id = name.slice(6, -5)
      if (sessions.get(id)?.mtime === mtime) continue
      sessions.set(id, { mtime, state: { ...EMPTY, sessionId: id, ...JSON.parse(fs.readFileSync(file, 'utf8')) } })
      changed = true
    } catch { /* half-written: next scan */ }
  }
  if (!cur || !sessions.has(cur)) { const first = sessionList()[0]; if (first) { cur = first.sessionId; changed = true } }
  if (changed) load()
}

function switchSession(step) {
  const list = sessionList()
  if (!list.length) return
  const i = Math.max(0, list.findIndex(st => st.sessionId === cur))
  cur = list[(i + step + list.length) % list.length].sessionId
  for (const k of Object.keys(sel)) sel[k] = 0
  load()
}

function clampSel() {
  const max = { reqs: shownReqs().length, signals: openSignals().length, activity: shownEvents().length, plan: S.plan?.length ?? 0, tests: testRuns().length, preview: previews().length, footprint: sessionList().length }
  for (const k of Object.keys(sel)) sel[k] = Math.max(0, Math.min(sel[k], (max[k] ?? 1) - 1))
}

function load() {
  S = sessions.get(cur)?.state ?? EMPTY
  linkOf = linker(S.reqs, S.asks ?? (S.turns ?? []).map(t => t.at))
  clampSel()
  render()
}

function say(text, ms = 3500) {
  flash = text
  setTimeout(() => { if (flash === text) { flash = ''; render() } }, ms)
  render()
}

// Only a running session reads its inbox; anything else would sit unread.
function canSend() {
  const st = sessions.get(cur)?.state
  if (!st) return false
  if (st.imported) { say('This session was imported from its transcript. Reopen it in Claude Code to reply or instruct.'); return false }
  if (!isLive(st)) { say('This session is not running, so nothing can reach it. Reopen it in Claude Code first.'); return false }
  return true
}

function send(cmd, note) {
  if (!cur || !canSend()) return
  fs.appendFileSync(inboxFile(), JSON.stringify({ seq: nextSeq(), ...cmd }) + '\n')
  say(note)
}

function openUrl(url) {
  const [cmd, args] = isWindows ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
  say(`Opened ${url}`)
}

function openDiff(ev, here) {
  // Never read or show a file that may hold secrets, not even as a diff.
  if (isSecretPath(ev.file)) return say(`${path.basename(ev.file)} may hold secrets, so Principia doesn't open its diff.`)
  const snap = path.join(S.snapDir ?? os.tmpdir(), `${ev.id}-${path.basename(ev.file)}`)
  const hasSnap = fs.existsSync(snap)
  if (!here) {
    const ed = S.editors[0]
    if (!ed) return say('No editor found (Cursor, VS Code or Windsurf).')
    spawn(ed.bin, hasSnap ? ['--diff', snap, ev.file] : ['-g', ev.file], { detached: true, stdio: 'ignore', shell: isWindows }).unref()
    return say(`Opened in ${ed.name}`)
  }
  out.write('\x1b[?1049l\x1b[?25h')
  process.stdin.setRawMode(false)
  import('./diff.mjs').then(({ showDiff }) => {
    showDiff(hasSnap ? snap : '', ev.file)
    process.stdin.setRawMode(true)
    out.write('\x1b[?1049h\x1b[?25l')
    render()
  })
}

// ---------- keys ----------

const focusOrder = () => layout(out.columns || 120).map(([c]) => c).filter(c => ['sessions', 'reqs', 'signals', 'middle'].includes(c)).concat(layout(out.columns || 120).some(([c]) => c === 'stack') ? ['reqs', 'middle'] : [])

function onKey(k) {
  if (compose?.mode === 'search') {
    if (k === '\x1b') { search = ''; compose = null } else if (k === '\r') compose = null
    else if (k === '\x7f') compose.text = [...compose.text].slice(0, -1).join('')
    else if (!k.startsWith('\x1b')) compose.text += k.replace(/[\x00-\x1f]/g, '')
    if (compose) search = compose.text
    sel.reqs = 0
    return render()
  }
  if (compose) {
    if (k === '\x1b') compose = null
    else if (k === '\r') {
      const text = compose.text.trim()
      if (text) {
        const mode = compose.mode === 'refine' || compose.mode === 'requirement' ? 'requirement' : compose.mode
        send({ type: 'reply', eventId: compose.eventId, text, mode, refines: compose.refines ?? 'new', interrupt: compose.interrupt },
          mode === 'comment' ? 'Comment saved' : 'Sent to the session')
      }
      compose = null
    } else if (k === '\x7f') compose.text = [...compose.text].slice(0, -1).join('')
    else if (k === '\x14') compose.interrupt = !compose.interrupt
    else if (k === '\x15') compose.text = ''
    else if (!k.startsWith('\x1b')) compose.text += k.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f]/g, '')
    return render()
  }
  const req = shownReqs()[sel.reqs]
  const inSignals = focus === 'signals' || (focus === 'middle' && middle === 'signals')
  const sig = inSignals ? openSignals()[sel.signals] : undefined
  const ev = focus === 'middle' && middle === 'activity' ? shownEvents()[sel.activity] : focus === 'middle' && middle === 'tests' ? testRuns()[sel.tests]
    : sig ? S.events.find(e => e.id === sig.eventId) : undefined
  const listOf = () => (focus === 'reqs' ? 'reqs' : inSignals ? 'signals' : focus === 'middle' ? middle : null)
  const order = focusOrder()
  switch (k) {
    case 'q': case '\x03': return quit()
    case '\t': case '\x1b[C': focus = order[(order.indexOf(focus) + 1) % order.length] ?? 'reqs'; break
    case '\x1b[D': focus = order[(order.indexOf(focus) - 1 + order.length) % order.length] ?? 'reqs'; break
    case '[': return switchSession(-1)
    case ']': return switchSession(1)
    case '\x1b[A': case 'k': if (focus === 'sessions') return switchSession(-1); if (listOf()) sel[listOf()] = Math.max(0, sel[listOf()] - 1); if (focus === 'reqs') sel.activity = 0; break
    case '\x1b[B': case 'j': if (focus === 'sessions') return switchSession(1); if (listOf()) { sel[listOf()]++; clampSel() } if (focus === 'reqs') sel.activity = 0; break
    case '1': middle = 'activity'; focus = 'middle'; break
    case '2': middle = 'plan'; focus = 'middle'; break
    case '3': middle = 'tests'; focus = 'middle'; break
    case '4': middle = 'preview'; focus = 'middle'; break
    case '5': if (order.includes('signals')) focus = 'signals'; else { middle = 'signals'; focus = 'middle' } break
    case 'S': prefs.showSessions = !prefs.showSessions; savePrefs(); if (focus === 'sessions') focus = 'reqs'; break
    case 'C': prefs.showAudit = !prefs.showAudit; savePrefs(); say(prefs.showAudit ? 'Completion audit shown' : 'Completion audit hidden · C brings it back'); return
    case 'A': allActivity = !allActivity; sel.activity = 0; break
    case 'M': middle = 'footprint'; focus = 'middle'; checkBackup(); break
    case 'h': prefs.showHeadless = !prefs.showHeadless; savePrefs(); say(prefs.showHeadless ? 'Showing headless (claude -p) sessions' : 'Hiding headless sessions'); return
    case 'l': prefs.dark = !isDark(); savePrefs(); break
    case 'v': showAll = !showAll; sel.activity = 0; break
    case '/': focus = 'reqs'; compose = { mode: 'search', text: search }; break
    case 'F': { const i = REQ_FILTERS.findIndex(f => f.value === reqFilter); reqFilter = REQ_FILTERS[(i + 1) % REQ_FILTERS.length].value; sel.reqs = 0; break }
    case 'g': return send({ type: 'gaps' }, 'Asked the agent to close the gaps')
    case 'a': if (focus === 'reqs' && req) return send({ type: 'accept', reqId: req.id }, `${req.id} accepted as verified`); break
    case 'd': if (focus === 'reqs' && req) return send({ type: 'defer', reqId: req.id }, `${req.id} deferred`); break
    case 'x':
      if (focus === 'reqs' && req?.conflict) return send({ type: 'resolve', reqId: req.id }, `${req.id} conflict marked resolved`)
      if (sig) return send({ type: 'dismiss', signalId: sig.id }, 'Signal dismissed')
      break
    case 'f': if (req && canSend()) compose = { mode: 'refine', text: '', interrupt: false, refines: req.id }; break
    case '\r':
      if (sig && sig.eventId && S.events.some(e => e.id === sig.eventId)) { middle = 'activity'; showAll = true; allActivity = true; focus = 'middle'; sel.activity = shownEvents().findIndex(e => e.id === sig.eventId); break }
      if (focus === 'middle' && middle === 'preview' && previews()[sel.preview]) return openUrl(previews()[sel.preview].url)
      if (ev && canSend()) compose = { mode: 'comment', text: '', interrupt: false, eventId: ev.id }
      break
    case 'c': if (ev && canSend()) compose = { mode: 'comment', text: '', interrupt: false, eventId: ev.id }; break
    case 'n':
      if (sig) return send({ type: 'reply', eventId: sig.eventId, text: sig.text, mode: 'requirement', refines: 'new' }, 'Made it a requirement')
      if (canSend()) compose = { mode: 'requirement', text: '', interrupt: false, eventId: ev?.id }
      break
    case 'i': if (canSend()) compose = { mode: 'redirect', text: '', interrupt: false, eventId: ev?.id }; break
    case 'o': if (ev?.kind === 'code' && ev.file) return openDiff(ev, false); break
    case 't': if (ev?.kind === 'code' && ev.file) return openDiff(ev, true); break
  }
  render()
}

function quit(code = 0) {
  out.write('\x1b[0m\x1b[?25h\x1b[?1049l')
  if (code === RELOAD) { try { fs.writeFileSync(path.join(dir, 'viewer.select'), cur) } catch { /* starts on the newest */ } }
  else { try { fs.rmSync(ALIVE, { force: true }) } catch { /* expires */ } }
  process.exit(code)
}

// Heartbeat; a switch asked for by /ledger window (anything newer than this window).
let focusSeen = now()
function heartbeat() {
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(ALIVE, String(now()))
    const st = fs.statSync(FOCUS, { throwIfNoEntry: false })
    if (st && st.mtimeMs > focusSeen) {
      focusSeen = st.mtimeMs
      const id = fs.readFileSync(FOCUS, 'utf8').trim()
      if (id && id !== cur) { cur = id; for (const k of Object.keys(sel)) sel[k] = 0; load(); say('Switched to the session that ran /ledger window') }
    }
  } catch { /* next beat */ }
}

// Files of sessions untouched for a month are dropped.
function prune() {
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/^(state|inbox|alive|import)-/.test(f)) continue
      const p = path.join(dir, f)
      if (now() - fs.statSync(p).mtimeMs > MONTH) fs.rmSync(p, { force: true })
    }
  } catch { /* next start */ }
}

// Restart when the program changes: the binary itself, or the source while developing.
const watched = G.isCompiled
  ? [process.execPath, NEXT]
  : ['ledger-view.mjs', 'cli.mjs', 'diff.mjs', '../hooks/work.ts', '../hooks/theme.ts'].map(f => fileURLToPath(new URL(f, import.meta.url)))
for (const f of watched) fs.watchFile(f, { interval: 1000 }, (a, b) => { if (a.mtimeMs !== b.mtimeMs && a.mtimeMs > 0) quit(RELOAD) })

prune()
indexTranscripts()
setInterval(heartbeat, 1000)
heartbeat()
setInterval(scan, 500)
setInterval(() => { indexTranscripts(); refreshTitles(); render() }, 15_000)
checkBackup()
setInterval(checkBackup, 600_000)
setInterval(render, 5000) // liveness changes with time alone

out.write('\x1b[?1049h\x1b[?25l')
process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', data => {
  const keys = compose ? (data.startsWith('\x1b[') ? [data] : data.length > 1 && !data.includes('\r') ? [data] : [...data]) : data.match(/\x1b\[[A-D]|[\s\S]/g) ?? []
  for (const k of keys) onKey(k)
})
out.on('resize', render)
process.on('SIGTERM', () => quit())
scan()
refreshTitles()
render()
