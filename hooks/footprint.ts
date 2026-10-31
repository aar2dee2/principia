// What a session costs this computer: the memory its processes hold right now, and the files
// it leaves behind (its transcript, its ledger, a folder of its own, the project files it
// changed, its temp folder, what its commands downloaded), each with how long it stays and
// that it lives here only. Pure helpers; the hook measures, the window shows.

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
  // Files in your project this session wrote or changed: Edit and Write calls, and files its
  // shell commands named as what they write to (> file, tee, sed -i).
  editedKb?: number
  editedFiles?: number
  // Changes in the project not yet committed, whichever session made them (git status).
  uncommittedKb?: number
  uncommittedFiles?: number
  // The app's temp folder for this session (its scratchpad).
  scratchKb?: number
  scratch?: string
  // What the session's commands downloaded or cloned (curl -o, wget -O, git clone, gh …).
  fetchedKb?: number
  fetched?: Sized[]
  // Shared by every session on the project: what git ignores in the project folder. Each item
  // is dependencies or build output (node_modules, .venv, dist…: an install or build makes them
  // again) or data the project's own commands wrote (job output, model files: nothing remakes it).
  sharedKb?: number
  sharedDataKb?: number
  shared?: Sized[]
  // Package caches shared by everything on this computer, which installs fill.
  cacheKb?: number
  caches?: Sized[]
}

export type Sized = { path: string; kb: number; role?: 'deps' | 'data' }

const DEPS_NAMES = new Set([...['node_modules', '.venv', 'venv', 'dist', 'build', 'target', '.next', '.nuxt', '.turbo', 'coverage', '__pycache__', '.pytest_cache', 'Pods', 'vendor', '.gradle'],
  'deps', '_build', '.gstack', '.mypy_cache', '.ruff_cache', '.cache', '.parcel-cache', '.eggs', 'bower_components', '.terraform', 'DerivedData', '.build', '.tox', '.svelte-kit', 'out', '.angular'])

// Whether ignored content is remade by an install or build, or is data only its maker has.
export const roleOf = (p: string): 'deps' | 'data' => {
  const name = p.replace(/\/+$/, '').split('/').pop() ?? ''
  return DEPS_NAMES.has(name) || /\.egg-info$/.test(name) ? 'deps' : 'data'
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
  // Other agents' worktrees sessions are opened in: Conductor's, Cursor's.
  if (/[\\/]conductor[\\/]workspaces[\\/]/.test(root) || /[\\/]\.cursor[\\/]worktrees[\\/]/.test(root)) return { path: root, kind: 'worktree' }
  return undefined
}

// `du -sk` output → KB.
export const duKb = (out: string) => Number(/^\s*(\d+)/.exec(out)?.[1] ?? 0)

// `du -sk a b c` output → one entry per path that exists, largest first.
export function duLines(out: string): Sized[] {
  return out.split('\n')
    .map(l => /^\s*(\d+)\s+(.+?)\s*$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map(m => ({ kb: Number(m[1]), path: m[2] }))
    .sort((a, b) => b.kb - a.kb)
}

export const sumKb = (list: Sized[]) => list.reduce((n, x) => n + x.kb, 0)

const unquote = (t: string) => t.replace(/^(["'])(.*)\1$/, '$2')
const resolve = (t: string, cwd: string, home: string) => {
  const p = unquote(t)
  if (p.startsWith('~/')) return `${home}${p.slice(1)}`
  return p.startsWith('/') ? p : `${cwd.replace(/\/$/, '')}/${p.replace(/^\.\//, '')}`
}
const ARG = String.raw`("[^"]+"|'[^']+'|[^\s;&|]+)`

// The files and folders the session's shell commands downloaded or cloned onto this disk,
// where the command named them: curl -o / --output, wget -O, git clone [dir], gh repo clone,
// gh release download -D. A download to a name curl or wget picked itself is not seen.
export function fetchedPaths(commands: string[], cwd: string, home = ''): string[] {
  const out = new Set<string>()
  for (const cmd of commands) {
    for (const m of cmd.matchAll(new RegExp(String.raw`\bcurl\b[^;&|]*?\s(?:-[a-zA-Z]*o|--output)[ =]${ARG}`, 'g'))) out.add(resolve(m[1] as string, cwd, home))
    for (const m of cmd.matchAll(new RegExp(String.raw`\bwget\b[^;&|]*?\s(?:-O|--output-document)[ =]${ARG}`, 'g'))) out.add(resolve(m[1] as string, cwd, home))
    for (const m of cmd.matchAll(new RegExp(String.raw`\bgh\s+release\s+download\b[^;&|]*?\s(?:-D|--dir)[ =]${ARG}`, 'g'))) out.add(resolve(m[1] as string, cwd, home))
    for (const m of cmd.matchAll(/\b(?:git|gh\s+repo)\s+clone\b([^;&|]*)/g)) {
      // Flags that take a value (--depth 1, -b main) are dropped with it.
      const tokens = (m[1] as string).trim().split(/\s+/).filter(Boolean)
      const words = tokens.filter((w, i) => !w.startsWith('-') && !/^(-b|--branch|--depth|-o|--origin|-c|--config|--reference|-j|--jobs|--separate-git-dir|-u|--upload-pack|--template)$/.test(tokens[i - 1] ?? ''))
      const url = words[0]
      if (!url) continue
      const dir = words[1] ?? url.replace(/\/+$/, '').split(/[/:]/).pop()?.replace(/\.git$/, '') ?? ''
      if (dir) out.add(resolve(dir, cwd, home))
    }
  }
  return [...out].filter(p => p !== '/dev/null' && !p.endsWith('/dev/null'))
}

// Files the session's shell commands wrote to, where the command named them: a redirection
// (> file, >> file), tee, or sed -i's file. Edits made inside a script's own code (a Python
// heredoc writing a file) are not seen; git status in the project catches those.
export function writtenPaths(commands: string[], cwd: string, home = ''): string[] {
  const out = new Set<string>()
  for (const cmd of commands) {
    for (const m of cmd.matchAll(new RegExp(String.raw`(?:^|[^<>&\d])>{1,2}\s*${ARG}`, 'g'))) out.add(resolve(m[1] as string, cwd, home))
    for (const m of cmd.matchAll(new RegExp(String.raw`\btee\s+(?:-a\s+)?${ARG}`, 'g'))) out.add(resolve(m[1] as string, cwd, home))
    for (const m of cmd.matchAll(/\bsed\s+-i\b([^;&|]*)/g)) {
      const words = (m[1] as string).trim().split(/\s+/).filter(Boolean)
      const file = words[words.length - 1]
      if (file && words.length >= 2) out.add(resolve(file, cwd, home))
    }
  }
  return [...out].filter(p => !/\/dev\/(null|stderr|stdout)$/.test(p) && !/\/\d$/.test(p))
}

// `git status --porcelain` output → the changed paths in root.
export function changedPaths(gitOut: string, root: string, max = 200): string[] {
  return gitOut.split('\n').filter(l => l.length > 3)
    .map(l => l.slice(3).trim().split(' -> ').pop() as string)
    .map(l => l.replace(/^"(.*)"$/, '$1'))
    .slice(0, max).map(l => `${root.replace(/\/$/, '')}/${l.replace(/\/$/, '')}`)
}

// Folders an install or build fills, when the project is not a git repository (which lists
// what it ignores itself).
export const SHARED_NAMES = ['node_modules', '.venv', 'venv', 'dist', 'build', 'target', '.next', '.nuxt', '.turbo', 'coverage', '__pycache__', '.pytest_cache', 'Pods', 'vendor', '.gradle']

// `git ls-files --others --ignored --exclude-standard --directory` output → paths in root,
// leaving out the OS's own litter.
export function ignoredPaths(gitOut: string, root: string, max = 60): string[] {
  const out: string[] = []
  for (const l of gitOut.split('\n').map(l => l.trim())) {
    if (!l || /(^|\/)\.DS_Store$/.test(l)) continue
    // A file inside a listed folder is already counted with the folder.
    if (out.some(d => l.startsWith(`${d}/`))) continue
    out.push(l.replace(/\/$/, ''))
  }
  return out.slice(0, max).map(l => `${root.replace(/\/$/, '')}/${l}`)
}

// Where installs leave what they download, for the whole computer.
export const cacheDirs = (home: string, os: 'mac' | 'linux' | 'windows', extra: string[] = []): string[] => [
  `${home}/.bun/install/cache`, `${home}/.npm/_cacache`, `${home}/.cache/pip`, `${home}/.cache/uv`, `${home}/.cargo/registry`,
  `${home}/.m2/repository`, `${home}/.cache/huggingface`, `${home}/.cache/torch`, `${home}/.cache/ms-playwright`, `${home}/.gstack/chromium-profile`, `${home}/.claude/plugins/cache`,
  ...(os === 'mac' ? [`${home}/Library/Caches/pip`, `${home}/Library/Caches/uv`, `${home}/Library/Caches/Homebrew`, `${home}/Library/Caches/pypoetry`, `${home}/Library/Caches/ms-playwright`] : []),
  ...extra,
]

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
  edited: 'files of your project the session changed: yours to keep, commit or discard with git',
  uncommitted: 'changes in the project not yet committed, by any session: commit them or git takes them back',
  scratchpad: 'the app\'s temp folder for this session: cleared when the system clears its temp files',
  fetched: 'downloaded or cloned by a command the session ran: stays until you delete it',
  shared: 'dependencies and build output in the project, shared by every session on it: an install or build makes them again',
  data: 'written in the project by its own commands and ignored by git, so nothing remakes it: yours to judge before deleting',
  cache: 'package, model and browser caches shared by everything on this computer: the next install or download refills them',
} as const

// The shell that finds the Claude Code process this hook runs in: walks up from the shell's
// parent to the first claude (or node/bun, on other installs) process.
export const FIND_SELF = 'p=$PPID; while [ "$p" -gt 1 ]; do c=$(ps -o comm= -p "$p" 2>/dev/null | tr -d " "); case "$c" in *claude*|node|bun|*node*) echo "$p"; exit 0;; esac; p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d " "); [ -z "$p" ] && exit 1; done; exit 1'
