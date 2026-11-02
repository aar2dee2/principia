// The principia program: the ledger window, the transcript importer and the diff view.
// Built into one standalone file per platform with `bun build --compile` (scripts/build.ts),
// so nothing else needs installing; while developing, `bun viewer/cli.mjs …` runs the source.
//
//   principia view <data dir> [session id] [projects dir]
//   principia import <projects dir> <out.json> [--days N] [--max N] [--skip ids] [--session id]
//   principia diff <snapshot or ''> <file>

const [cmd, ...args] = process.argv.slice(2)

// How to start this same program again (the window restarts itself on update).
const script = process.argv[1] ?? ''
const isCompiled = script.startsWith('/$bunfs') || script.startsWith('B:\\~BUN') || !/\.(m?js|ts)$/.test(script)
globalThis.PRINCIPIA = { args, self: isCompiled ? [process.execPath] : [process.execPath, script], isCompiled }

if (cmd === 'view') {
  await import('./ledger-view.mjs')
} else if (cmd === 'import') {
  process.argv = [process.argv[0], 'import', ...args]
  await import('./import.mjs')
} else if (cmd === 'diff') {
  const { showDiff } = await import('./diff.mjs')
  showDiff(args[0] ?? '', args[1] ?? '')
  process.exit(0)
} else if (cmd === '--version' || cmd === 'version') {
  // Set by scripts/build.ts from plugin.json; "dev" when run from source.
  console.log(`principia ${typeof PRINCIPIA_VERSION === 'string' ? PRINCIPIA_VERSION : 'dev'}`)
} else {
  console.error('usage: principia view <data dir> [session] [projects dir] | import … | diff <snapshot> <file>')
  process.exit(2)
}
