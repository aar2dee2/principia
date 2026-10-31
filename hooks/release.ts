// The standalone principia program published with this version: written by scripts/build.ts
// when a release is cut, and checked against before anything downloaded is run.
export const RELEASE: { version: string; repo: string; sha256: Record<string, string> } = {
  version: '0.6.0',
  repo: 'aar2dee2/principia',
  sha256: {
    "principia-darwin-arm64": "0e79378ccd47550cc093f9050f5710c1a969f4ba80dd08d55d5d1395e1a9ed4c",
    "principia-darwin-x64": "f6d16ac5ae2f05b5b10cd7eabc67c1c26c28b1232c587ecb2d661dd9a1b6523d",
    "principia-linux-x64": "2f0d9b817a291378630acd4f14c8b7f0fbbbb066cb22046f691436183288f034",
    "principia-linux-arm64": "69c5f63e4f3e2b8465e43a54749c0710e4d7fb30bfb49c6da0048a637cff0283",
    "principia-windows-x64.exe": "c080b5ac80a4b787af3c0dd322c6fbf69ed5e5a5b32d5913b653f787aa4d5468"
  },
}
