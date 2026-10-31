// The standalone principia program published with this version: written by scripts/build.ts
// when a release is cut, and checked against before anything downloaded is run.
export const RELEASE: { version: string; repo: string; sha256: Record<string, string> } = {
  version: '0.5.4',
  repo: 'aar2dee2/principia',
  sha256: {
    "principia-darwin-arm64": "b456333c00e01a6037d33f06718e54504fd33d0c9881e66d1bdc83a004cbd94e",
    "principia-darwin-x64": "bd778f7ceb0e311646ade4367bf337463276781173a4223893398cad9b4ebfc2",
    "principia-linux-x64": "e0fc12fe39f4efb0025d2285f30a42f3531fe0e5bc78c267e20deb2e662d8c06",
    "principia-linux-arm64": "bd68aed63efcd966e28889f9b9c348d93f41ad9669c88be82177693d1ffd69d8",
    "principia-windows-x64.exe": "0e20542ad232fd2c0181ead5d10648c97b1c8022ab2374fec1c4f922aac7a360"
  },
}
