import { describe, expect, test } from 'claude-code/testing'

import type { Requirement } from '../types'
import { filterReqs, findCheck, gapOf, humanText, linkStep, linker, planFrom, previewUrls, trimEvents } from '../hooks/work'
import { parseReview, parseTagged } from '../hooks/tagging'
import { duKb, fmtKb, treeRss, workspaceOf } from '../hooks/footprint'

const req = (id: string, title: string, extra: Partial<Requirement> = {}): Requirement => ({
  id, title, status: 'captured', at: 1, history: [{ at: 1, text: title, kind: 'original', by: 'you' }], evidence: [], ...extra,
})
const REQS = [
  req('R1', 'Wrap text in the requirements column'),
  req('R2', 'Store data outside the temp folder', { status: 'verified' }),
  req('R3', 'Add search and filters for requirements', { conflict: { reason: 'later message asks to drop search', at: 2, source: 'you' } }),
  req('R4', 'Explain tmp sessions', { history: [{ at: 1, text: 'x', kind: 'original', by: 'agent' }] }),
]

describe('plans', () => {
  test('a step names its requirements, or is matched by title', async () => {
    expect(linkStep('[R1, R3] Rework the columns', REQS)).toEqual(['R1', 'R3'])
    expect(linkStep('Add search box and filters for requirements list', REQS)).toEqual(['R3'])
    expect(linkStep('Refactor the build script', REQS)).toEqual([])
  })
  test('TodoWrite and the desktop plan tool both become steps', async () => {
    const a = planFrom({ todos: [{ content: '[R1] wrap', status: 'in_progress' }] }, REQS)
    const b = planFrom({ items: [{ content: 'Store data outside the temp folder', status: 'completed' }] }, REQS)
    expect(a?.[0]).toEqual({ text: '[R1] wrap', status: 'in_progress', reqIds: ['R1'] })
    expect(b?.[0]?.reqIds).toEqual(['R2'])
  })
  test('requirements the plan leaves out are a gap', async () => {
    const plan = [{ text: 'x', status: 'pending' as const, reqIds: ['R1'] }]
    expect(gapOf(REQS[3]!, plan)).toBe("Not in the agent's plan")
    expect(gapOf(REQS[2]!, plan)).toContain('Conflicting instruction')
    expect(gapOf(REQS[1]!, plan)).toBe('')
  })
})

describe('signals and previews', () => {
  test('preview links come from command output', async () => {
    const out = '  ➜  Local:   http://localhost:5173/\n  Network: http://0.0.0.0:3000.\nDeployed to https://app-git-main.vercel.app ok'
    expect(previewUrls(out)).toEqual(['http://localhost:5173/', 'http://localhost:3000', 'https://app-git-main.vercel.app'])
  })
  test('a review keeps findings and conflicts, and survives a bad reply', async () => {
    const r = parseReview('{"findings":[{"text":"The cache is shared across users"}],"conflicts":[{"id":"R2","reason":"wrote to /tmp"}]}')
    expect(r.findings.length).toBe(1)
    expect(r.conflicts[0]?.id).toBe('R2')
    expect(parseReview('not json')).toEqual({ findings: [], conflicts: [], progress: [] })
  })
  test('the tagger can flag a conflict', async () => {
    const t = parseTagged('{"items":[{"title":"Remove search","quote":"drop search","refines":null,"conflicts":"R3","conflict_reason":"R3 adds search"}]}')
    expect(t[0]?.conflicts).toBe('R3')
  })
})

describe('requirement search and filters', () => {
  test('search reads ids, titles and your words', async () => {
    expect(filterReqs(REQS, 'temp', 'all').map(r => r.id)).toEqual(['R2'])
    expect(filterReqs(REQS, 'r4', 'all').map(r => r.id)).toEqual(['R4'])
  })
  test('filters', async () => {
    expect(filterReqs(REQS, '', 'verified').map(r => r.id)).toEqual(['R2'])
    expect(filterReqs(REQS, '', 'conflicts').map(r => r.id)).toEqual(['R3'])
    expect(filterReqs(REQS, '', 'agents').map(r => r.id)).toEqual(['R4'])
    expect(filterReqs(REQS, '', 'open').map(r => r.id)).toEqual(['R1', 'R3', 'R4'])
  })
})

import { isSecretPath } from '../hooks/work'
import { launchCommand } from '../hooks/platform'

describe('safety', () => {
  test('files that may hold secrets are never copied', async () => {
    for (const f of ['/app/.env', '/app/.env.local', 'C:\\app\\.npmrc', '/home/a/.ssh/id_ed25519', '/k/server.pem', '/k/tls.key', '/app/credentials.json', '/app/secrets.yaml'])
      expect(isSecretPath(f)).toBe(true)
    for (const f of ['/app/src/env.ts', '/app/keyboard.tsx', '/app/README.md', '/app/environment.md'])
      expect(isSecretPath(f)).toBe(false)
  })
  test('Windows runs the program directly, with an unquoted one-word title', async () => {
    const l = launchCommand('windows', { id: 'cmd', name: 'Command Prompt' }, ['C:/Users/A B/principia.exe', 'view', 'C:/Users/A B/.claude/principia'], 'Principia', 'C:/Users/A B')
    expect(l?.cmd).toEqual(['cmd', '/c', 'start', 'Principia', 'C:/Users/A B/principia.exe', 'view', 'C:/Users/A B/.claude/principia'])
  })
})

describe('env files', () => {
  test('every common env-file name counts as secret', async () => {
    for (const f of ['.env', '.env.local', '.env.production', '.env.development.local', '/repo/apps/web/.env.test', 'C:\\repo\\.env'])
      expect(isSecretPath(f)).toBe(true)
  })
})

describe('done for now, to revisit', () => {
  test('counts as accounted for, not a gap, and has its own filter', async () => {
    const r = req('R9', 'Run audits twice a week', { status: 'revisit', revisit: 'if contributor activity grows' })
    expect(gapOf(r, [])).toBe('')
    expect(filterReqs([...REQS, r], '', 'revisit').map(x => x.id)).toEqual(['R9'])
    expect(filterReqs([...REQS, r], '', 'open').map(x => x.id)).not.toContain('R9')
  })
  test('the tagger can mark a requirement to revisit', async () => {
    const t = parseTagged('{"items":[{"title":"Keep audits twice a week for now","quote":"twice a week is okay for now","refines":"R44","conflicts":null,"revisit":"if contributor activity grows"}]}')
    expect(t[0]?.revisit).toBe('if contributor activity grows')
  })
})


describe('judged progress', () => {
  test('a review moves statuses, but never to verified', async () => {
    const r = parseReview('{"findings":[],"conflicts":[],"progress":[{"id":"R1","status":"implemented","why":"tests pass"},{"id":"R2","status":"verified","why":"x"},{"id":"R3","status":"in_progress","why":"started"}]}')
    expect(r.progress.map(p => `${p.id}:${p.status}`)).toEqual(['R1:implemented', 'R3:in_progress'])
  })
})

describe('activity per requirement', () => {
  test('events are placed in the turn of your latest message before them', async () => {
    const ask = (at: number, text: string) => ({ at, text, kind: 'original' as const, by: 'you' as const })
    const reqs = [
      req('R1', 'Add search', { history: [ask(100, 'add search')] }),
      req('R2', 'Add filters', { history: [ask(100, 'and filters'), { at: 300, text: 'filters by date too', kind: 'refinement', by: 'you' }] }),
      req('R3', 'Dark mode', { history: [ask(500, 'dark mode')] }),
    ]
    const ev = (at: number, reqIds?: string[]) => ({ id: String(at), kind: 'code' as const, at, title: 'x', ...(reqIds ? { reqIds } : {}) })
    const link = linker(reqs, [100, 250, 300, 500])
    expect(link(ev(50))).toEqual([])
    expect(link(ev(150))).toEqual(['R1', 'R2'])
    // 250 was a message that asked nothing new ("go ahead"): its turn carries on with the last ask.
    expect(link(ev(260))).toEqual(['R1', 'R2'])
    expect(link(ev(350))).toEqual(['R2'])
    expect(link(ev(600))).toEqual(['R3'])
    // Requirements from one message are saved milliseconds apart; they're still one turn.
    const split = linker([req('R7', 'a', { history: [ask(1000, 'a')] }), req('R8', 'b', { history: [ask(1004, 'b')] })])
    expect(split(ev(2000))).toEqual(['R7', 'R8'])
    // Events that carry their own links keep them.
    expect(link(ev(600, ['R1']))).toEqual(['R1'])
  })
})

describe('how much activity is kept', () => {
  test('old events are kept lean rather than dropped', () => {
    const ev = (i: number) => ({ id: String(i), kind: 'command' as const, at: i, title: `t${i}`, detail: 'x'.repeat(500), diff: 'd' })
    const list = Array.from({ length: 30 }, (_, i) => ev(i))
    const kept = trimEvents(list, 20, 5)
    expect(kept.map(e => e.id)).toEqual(list.slice(-20).map(e => e.id))
    expect(kept[0].detail?.length).toBe(160)
    expect('diff' in kept[0]).toBe(false)
    expect(kept.at(-1)?.detail?.length).toBe(500)
    expect(kept.at(-1)?.diff).toBe('d')
    // Within the full window nothing changes, and the same array comes back.
    const small = list.slice(0, 5)
    expect(trimEvents(small, 20, 5)).toBe(small)
  })
})

describe('your words', () => {
  test('reminders around a message are cut out; command wrappers are nothing', () => {
    expect(humanText('<system-reminder>\nLinked sessions now: a = b (idle)\n</system-reminder>\nResearch AI in Formula 1')).toBe('Research AI in Formula 1')
    expect(humanText('Fix it <system-reminder>x</system-reminder> please')).toBe('Fix it  please')
    expect(humanText('<local-command-caveat>ran</local-command-caveat><command-name>/ledger</command-name>')).toBe('')
    expect(humanText('  plain  ')).toBe('plain')
  })
})

describe('footprint', () => {
  test('memory is summed over the session process and everything it started', () => {
    const ps = ' 100   1 50000\n 200 100 1000\n 300 200 2000\n 400   1 9999\n 500 100 0\n'
    expect(treeRss(ps, 100)).toEqual({ procs: 4, ramKb: 53000 })
    expect(treeRss(ps, 999)).toEqual({ procs: 0, ramKb: 0 })
  })
  test("a session's own folder is the app's scratch folder or a worktree, never your project", () => {
    expect(workspaceOf('/Users/a/Library/Application Support/Claude/scratch-workspaces/x/y/scratch-1')?.kind).toBe('scratch')
    expect(workspaceOf('/Users/a/Projects/app/.claude/worktrees/fix-1')?.kind).toBe('worktree')
    expect(workspaceOf('/Users/a/Projects/app')).toBeUndefined()
    expect(duKb('123456\t/some/path\n')).toBe(123456)
    expect([fmtKb(512), fmtKb(2048), fmtKb(3 * 1024 * 1024)]).toEqual(['512 KB', '2 MB', '3.0 GB'])
  })
})

describe('findCheck', () => {
  const ev = (id: string, kind: 'code' | 'test' | 'command', at: number, detail: string, state: 'ok' | 'failed' | 'running' = 'ok') =>
    ({ id, kind, at, title: detail.slice(0, 40), detail, state })
  const edit = ev('e1', 'code', 1000, 'Edited reel.py')
  const FFPROBE = 'ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 jobs/2026-10-30_161335_reelA/versions/v1/reel.mp4'

  test('any shell command that passed after the last edit counts, not only test-looking ones', () => {
    const got = findCheck([edit, ev('b1', 'command', 2000, FFPROBE)], 'ffprobe -v error')
    expect('pass' in got && got.pass.id).toBe('b1')
  })
  test('a part of a compound command or pipe matches', () => {
    const got = findCheck([edit, ev('b1', 'command', 2000, './reel stop; pgrep -fl "reels.cli watch" || echo watcher stopped')], 'pgrep -fl "reels.cli watch"')
    expect('pass' in got).toBe(true)
    const piped = findCheck([edit, ev('b2', 'command', 2000, 'git log --all --oneline | grep "Word-anchored"')], 'git log --all --oneline | grep "Word-anchored"')
    expect('pass' in piped).toBe(true)
  })
  test('whitespace differences do not matter', () => {
    const got = findCheck([edit, ev('b1', 'test', 2000, 'python  -m unittest\n  tests')], 'python -m unittest tests')
    expect('pass' in got).toBe(true)
  })
  test('an older event whose command was clipped still matches on its kept prefix', () => {
    const clipped = trimEvents([ev('b1', 'command', 2000, FFPROBE), ...Array.from({ length: 3 }, (_, i) => ev(`x${i}`, 'command', 3000 + i, 'ls'))], 10, 2)
    const got = findCheck([edit, ...clipped], FFPROBE)
    expect('pass' in got).toBe(true)
  })
  test('the refusal says what failed', () => {
    const never = findCheck([edit], 'ffprobe -v error')
    expect('why' in never && never.why).toContain('no shell command containing')
    const failed = findCheck([edit, ev('b1', 'command', 2000, FFPROBE, 'failed')], 'ffprobe')
    expect('why' in failed && failed.why).toContain('failed')
    const stale = findCheck([ev('b1', 'command', 500, FFPROBE), edit], 'ffprobe')
    expect('why' in stale && stale.why).toContain('before your last edit')
    expect('why' in stale && stale.why).toContain('Edited reel.py')
    const running = findCheck([edit, ev('b1', 'command', 2000, FFPROBE, 'running')], 'ffprobe')
    expect('why' in running && running.why).toContain('still running')
    const short = findCheck([edit, ev('b1', 'command', 2000, FFPROBE)], 'ls')
    expect('why' in short && short.why).toContain('at least 4')
  })
  test('a passing run before a later edit does not count, one after it does', () => {
    const got = findCheck([ev('b0', 'test', 500, 'bun test', 'ok'), edit, ev('b1', 'test', 1500, 'bun test', 'ok')], 'bun test')
    expect('pass' in got && got.pass.id).toBe('b1')
  })
})
