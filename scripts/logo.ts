// Draws docs/logo.svg: an isometric principia (courtyard, colonnaded wings, gate, basilica).
//
//   bun scripts/logo.ts docs/logo.svg
//
// Isometric mark of a legionary principia: courtyard, colonnaded wings, gate block, basilica.
import fs from 'node:fs'
const C = Math.cos(Math.PI / 6), S = 0.5
const P = (x, y, z = 0) => [(x - y) * C, (x + y) * S - z]
const poly = (pts, fill, extra = '') => `<polygon points="${pts.map(p => P(...p).map(v => v.toFixed(2)).join(',')).join(' ')}" fill="${fill}"${extra}/>`

// palette
const ROOF = '#c9743a', ROOF_SHADE = '#a85a2a', WALL = '#efe8dc', WALL_SHADE = '#cfc4b3', SAND = '#e3c89c', STONE = '#d8d2c6', OPEN = '#6e5a46'

const out = []
// Box with a gable roof. ridge 'x' runs along x; 'y' along y. h = eave height, r = ridge rise.
function gable(x0, y0, x1, y1, h, r, ridge, open) {
  // walls: +x face and +y face are visible
  out.push(poly([[x1, y0, 0], [x1, y1, 0], [x1, y1, h], [x1, y0, h]], WALL_SHADE))
  out.push(poly([[x0, y1, 0], [x1, y1, 0], [x1, y1, h], [x0, y1, h]], WALL))
  if (ridge === 'y') {
    const xm = (x0 + x1) / 2
    out.push(poly([[x0, y0, h], [xm, y0, h + r], [xm, y1, h + r], [x0, y1, h]], ROOF_SHADE)) // far slope
    out.push(poly([[xm, y0, h + r], [x1, y0, h], [x1, y1, h], [xm, y1, h + r]], ROOF)) // near slope
    out.push(poly([[x0, y1, h], [xm, y1, h + r], [x1, y1, h]], WALL)) // gable end facing viewer
  } else {
    const ym = (y0 + y1) / 2
    out.push(poly([[x0, y0, h], [x1, y0, h], [x1, ym, h + r], [x0, ym, h + r]], ROOF_SHADE))
    out.push(poly([[x0, ym, h + r], [x1, ym, h + r], [x1, y1, h], [x0, y1, h]], ROOF))
    out.push(poly([[x1, y0, h], [x1, ym, h + r], [x1, y1, h]], WALL_SHADE)) // gable end on +x
  }
  if (open) for (const o of open) out.push(poly(o, OPEN))
}

// plan, in metres-ish: courtyard 10 wide (x), 16 long (y). Viewer looks from +x,+y (front-right).
const W = 10, L = 16, WING = 1.8
// ground slab
out.push(poly([[-1, -1, 0], [W + 1, -1, 0], [W + 1, L + 1, 0], [-1, L + 1, 0]], STONE))
out.push(poly([[0, 0, 0], [W, 0, 0], [W, L, 0], [0, L, 0]], SAND))
// basilica at the far end (y near 0): tall cross hall, ridge along x
gable(-1, -3.2, W + 1, -0.2, 3.4, 1.3, 'x')
// porch onto the courtyard
gable(W / 2 - 1.3, -0.2, W / 2 + 1.3, 1.2, 2.2, 0.8, 'y', [[[W / 2 - 0.5, 1.2, 0], [W / 2 + 0.5, 1.2, 0], [W / 2 + 0.5, 1.2, 1.5], [W / 2 - 0.5, 1.2, 1.5]]])
// left wing (x near 0), far from viewer: drawn before the right wing
gable(-1, -0.2, -1 + WING, L, 1.5, 0.6, 'y')
// gate block at the near end (y = L), ridge along x, with an arch
gable(-1, L, W + 1, L + 2.2, 2.3, 0.9, 'x', [[[W / 2 - 0.8, L + 2.2, 0], [W / 2 + 0.8, L + 2.2, 0], [W / 2 + 0.8, L + 2.2, 1.6], [W / 2 - 0.8, L + 2.2, 1.6]]])
// right wing (x near W), nearest the viewer
gable(W + 1 - WING, -0.2, W + 1, L, 1.5, 0.6, 'y')

// bounds
const all = out.join('\n').match(/-?\d+\.\d+/g).map(Number)
const xs = all.filter((_, i) => i % 2 === 0), ys = all.filter((_, i) => i % 2 === 1)
const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
const pad = 1.2, w = maxX - minX + pad * 2, h = maxY - minY + pad * 2, side = Math.max(w, h)
const ox = minX - pad - (side - w) / 2, oy = minY - pad - (side - h) / 2
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${ox.toFixed(2)} ${oy.toFixed(2)} ${side.toFixed(2)} ${side.toFixed(2)}" width="512" height="512">
<title>Principia</title>
${out.join('\n')}
</svg>
`
fs.writeFileSync(process.argv[2], svg)
