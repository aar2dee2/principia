// The standalone principia program published with this version: written by scripts/build.ts
// when a release is cut, and checked against before anything downloaded is run.
export const RELEASE: { version: string; repo: string; sha256: Record<string, string> } = {
  version: '0.5.0',
  repo: 'aar2dee2/principia',
  sha256: {
    "principia-darwin-arm64": "8d1ca77f7504361b510ab453c9a9ee342e7ba847010618ab74362ff3c108df32",
    "principia-darwin-x64": "c8bfcb92b93470f315361df553adf7ecc07edabf528dde4983ffff490a30674d",
    "principia-linux-x64": "ae5d4fd8ec484c2cc7acd83d32c7d6b3c19d3fcb1ab54d8638b74d6730e8a15c",
    "principia-linux-arm64": "1cb6176d4c24322adeda339cdc3339f747959c287cedc4af8c24b211f5f0035e",
    "principia-windows-x64.exe": "eda790859bd996fecef8cade1d2a43fa9cc5bfe1cc441268676d107437311c14"
  },
}
