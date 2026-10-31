// The standalone principia program published with this version: written by scripts/build.ts
// when a release is cut, and checked against before anything downloaded is run.
export const RELEASE: { version: string; repo: string; sha256: Record<string, string> } = {
  version: '0.5.5',
  repo: 'aar2dee2/principia',
  sha256: {
    "principia-darwin-arm64": "3367df79b6fa50903672b97b687a8027db51096e7cefb40e40b4ff1fa0d6ef09",
    "principia-darwin-x64": "ecf9a7a86c1dcde2f624f3ad728db4cae42411da0f2b8f87f3e65ffca927666f",
    "principia-linux-x64": "ffcce20b862900a1c1ba3832a36e451e36e930a550b1995305646ef70bde4c0a",
    "principia-linux-arm64": "d2e993247a48af04575aecbca97a408c84b6e2e2b943af155d83af19717d45ef",
    "principia-windows-x64.exe": "94004674e848c7450daccdd6fdecc1e1f314ca275ecae5d5e299cd310d8ac1c0"
  },
}
