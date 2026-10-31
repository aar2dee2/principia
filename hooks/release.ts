// The standalone principia program published with this version: written by scripts/build.ts
// when a release is cut, and checked against before anything downloaded is run.
export const RELEASE: { version: string; repo: string; sha256: Record<string, string> } = {
  version: '0.5.2',
  repo: 'aar2dee2/principia',
  sha256: {
    "principia-darwin-arm64": "aea6af2162809b140df32ff1e9b141fa3fa9cc1aec849b548be6400cf5acf6d9",
    "principia-darwin-x64": "2c7016ef47dae58bd6d3ca69921dcf89e9c1603422c18e6f768d8ce92638413a",
    "principia-linux-x64": "c6b07b92e80e2b264e334c753aa4d4e7b4b3308779b887aca9fb418430240d8a",
    "principia-linux-arm64": "844543a84b5fe970d29f13347538706142551616dffd8aea7df5b9f7353cfef1",
    "principia-windows-x64.exe": "f95516bab167c21d035f09ca3563eecef0835cce164056624b4e788237598faf"
  },
}
