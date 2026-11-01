// The standalone principia program published with this version: written by scripts/build.ts
// when a release is cut, and checked against before anything downloaded is run.
export const RELEASE: { version: string; repo: string; sha256: Record<string, string> } = {
  version: '0.6.1',
  repo: 'aar2dee2/principia',
  sha256: {
    "principia-darwin-arm64": "e4939b03d500eb56766de4fea1453c79129365323a8f58dbe767270206d0ffcc",
    "principia-darwin-x64": "34a8802764dff394a1f39614439a78de18a26e0eb4d7efad94efcb2dd2df8b1e",
    "principia-linux-x64": "cb3b6687d5b03384458fb95634edba00ec17fdf16e04c53b8069a61d2ef0cdc8",
    "principia-linux-arm64": "5f754dc055bc803241cdcdbd7cc238115c7b484c89d1b33b95f787d4c9daba98",
    "principia-windows-x64.exe": "9153405488219ee9730b2ec8b497f2e000e16167543b3ecd39622db86cfdf4aa"
  },
}
