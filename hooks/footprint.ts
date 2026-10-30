// What a session costs this computer: the memory its processes hold right now, and the files
// it leaves behind (its transcript, its ledger, a folder of its own), each with how long it
// stays and that it lives here only. Pure helpers; the hook measures, the window shows.

export type Footprint = {
  at: number
  // The session's own process and everything it started (shells, servers, subagents).
  pid?: number
  procs: number
  ramKb: number
  // Bytes on disk, by what the file is.
  transcriptKb: number
  ledgerKb: number
  workspaceKb: number
  // A folder that exists only for this session: the app's scratch folder, or a git worktree.
  workspace?: { path: string; kind: 'scratch' | 'worktree' }
}

// `ps -axo pid=,ppid=,rss=` → the resident memory (KB) of `root` and every descendant.
export function treeRss(ps: string, root: number): { procs: number; ramKb: number } {
  const kids = new Map<number, { pid: number; rss: number }[]>()
  for (const line of ps.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)/.exec(line)
    if (!m) continue
    const [, pid, ppid, rss] = m.map(Number) as [unknown, number, number, number]
    kids.set(ppid, [...(kids.get(ppid) ?? []), { pid, rss }])
  }
  const own = (pid: number) => [...kids.values()].flat().find(p => p.pid === pid)?.rss ?? 0
  let procs = 0
  let ramKb = 0
  const seen = new Set<number>()
  const stack = [root]
  while (stack.length) {
    const pid = stack.pop() as number
    if (seen.has(pid)) continue
    seen.add(pid)
    procs++
    ramKb += own(pid)
    for (const k of kids.get(pid) ?? []) stack.push(k.pid)
  }
  return { procs: procs - 1 + (own(root) ? 1 : 0), ramKb }
}

// A session's root folder that is the session's own, not your project.
export function workspaceOf(root: string): Footprint['workspace'] | undefined {
  if (/[\\/]scratch-workspaces[\\/]/.test(root)) return { path: root, kind: 'scratch' }
  if (/[\\/]\.claude[\\/]worktrees[\\/]/.test(root)) return { path: root, kind: 'worktree' }
  return undefined
}

// `du -sk` output → KB.
export const duKb = (out: string) => Number(/^\s*(\d+)/.exec(out)?.[1] ?? 0)

export function fmtKb(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`
  if (kb >= 1024) return `${Math.round(kb / 1024)} MB`
  return `${kb} KB`
}

// How long each kind of file stays, in a line.
export const LIFETIME = {
  transcript: (days: number) => `kept by Claude Code for ${days} days after the session's last use, then deleted`,
  ledger: 'kept by Principia for 30 days after the session\'s last use, then deleted',
  scratch: 'the app\'s folder for this session: removed when you delete the session',
  worktree: 'a git worktree: stays until it is removed (its branch keeps the commits)',
} as const

// The shell that finds the Claude Code process this hook runs in: walks up from the shell's
// parent to the first claude (or node/bun, on other installs) process.
export const FIND_SELF = 'p=$PPID; while [ "$p" -gt 1 ]; do c=$(ps -o comm= -p "$p" 2>/dev/null | tr -d " "); case "$c" in *claude*|node|bun|*node*) echo "$p"; exit 0;; esac; p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d " "); [ -z "$p" ] && exit 1; done; exit 1'
