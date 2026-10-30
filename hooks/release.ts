// The standalone principia program published with this version: written by scripts/build.ts
// when a release is cut, and checked against before anything downloaded is run.
export const RELEASE: { version: string; repo: string; sha256: Record<string, string> } = {
  version: '0.4.3',
  repo: 'aar2dee2/principia',
  sha256: {
    "principia-darwin-arm64": "794fb076310d99d9ab5309111fc7acc58cad677390766f63c92647a6ae10c7d5",
    "principia-darwin-x64": "b100e41e7c82b6354e7dbed8e10f4c79ba05726717610e12225f15f6a349e1cb",
    "principia-linux-x64": "e7b705505bbf37e404631bd16b06d50ef3367ac52fe9e3eaa02935b12a87f70d",
    "principia-linux-arm64": "24afd1d6e5169f5c07e2e606c34f3e2edff30abaecad13a02273d96957dcdc12",
    "principia-windows-x64.exe": "b473eba8ae0147ba811a135ff30f7fbb2ddbda6e89fa1d8360824694327e1736"
  },
}
