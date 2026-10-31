// The standalone principia program published with this version: written by scripts/build.ts
// when a release is cut, and checked against before anything downloaded is run.
export const RELEASE: { version: string; repo: string; sha256: Record<string, string> } = {
  version: '0.5.3',
  repo: 'aar2dee2/principia',
  sha256: {
    "principia-darwin-arm64": "961d9a6ff6e3b6af323f7957ede4f53ba00e722775750b2759c0389e1fc99b77",
    "principia-darwin-x64": "297505f90f88ca37f47559f6d72b381dcd8b5176f0961beb94b8a7b328cc602a",
    "principia-linux-x64": "a035b0b58b2377684e96ce05c2864219756a2e4cecefc42c00dce6a4e6d424d9",
    "principia-linux-arm64": "f0817ec590272e9932f10031804c4fe7e61d9ab96ee36804d5887d97a091bd32",
    "principia-windows-x64.exe": "c11d1a74655002cdff567666ff00d36232fa6cf57ccf0ca0671b4f7f6657dd8a"
  },
}
