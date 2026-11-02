// The standalone principia program published with this version: written by scripts/build.ts
// when a release is cut, and checked against before anything downloaded is run.
export const RELEASE: { version: string; repo: string; sha256: Record<string, string> } = {
  version: '0.7.0',
  repo: 'aar2dee2/principia',
  sha256: {
    "principia-darwin-arm64": "4ff20d8effd4e687edbbf4aa6fd8f816317eb6bab7a57532d3021852ad20526f",
    "principia-darwin-x64": "f51e637a09b5855e3782c612b97cc613c411e6febd30b9ac0aa4e6754fb51e3a",
    "principia-linux-x64": "61f57759198c08b1355fd9c34702550d86d38726c46ce6a84e0d6e4f07e73d47",
    "principia-linux-arm64": "8dd487afff1fc0febad6e438e0c88e609aa5dbf48413e24ca9eebdeb0a2126f7",
    "principia-windows-x64.exe": "2d4e044a0efe0218525d5de167f881687eaed6a3c6bd3785b8cb715de6b35b5f"
  },
}
