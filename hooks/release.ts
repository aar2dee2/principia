// The standalone principia program published with this version: written by scripts/build.ts
// when a release is cut, and checked against before anything downloaded is run.
export const RELEASE: { version: string; repo: string; sha256: Record<string, string> } = {
  version: '0.5.1',
  repo: 'aar2dee2/principia',
  sha256: {
    "principia-darwin-arm64": "265f8849970cf8bcd02a318127a027a865c169de8bf9cace8c4f128486f73b7a",
    "principia-darwin-x64": "01ef39096087af6801ec19ddb4eebb1b99a7d91d9452e2d5c689839b189768c5",
    "principia-linux-x64": "55f8f3bff362724ede89476eb58445da6deabe0ef8651794fde87f27fb18ad65",
    "principia-linux-arm64": "6630b34b9c188f1355b357787ecf198e5132b77e5fd23b00cd489ba835030e6a",
    "principia-windows-x64.exe": "cd9e9170f5b8cdbd44f2d5b6bbf4f4fcaf13a2315b9f59545ef6da94e0f10a13"
  },
}
