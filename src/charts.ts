// Static charts for REPORT.md: horizontal bars as self-contained SVG. GitHub shows them as images, so there is no
// script and no hover: every bar carries its value as a label, and the tables of results.md hold the same numbers.
// The colors follow the viewer's light or dark scheme.

export interface Bar {
  label: string
  /** the bar's length, a share between 0 and 1 */
  value: number
  /** the label at the bar's end */
  text: string
}

export interface BarChart {
  title: string
  subtitle: string[]
  groups: { heading: string; bars: Bar[] }[]
  /** a vertical reference line at a share, with its label */
  reference?: { value: number; label: string }
}

const WIDTH = 720
const LEFT = 176
const PLOT = 400
const ROW = 28
const THICK = 14
const TICKS = [0, 0.25, 0.5, 0.75, 1]

const STYLE = `<style>
text { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 13px; }
.surface { fill: #fcfcfb; } .primary { fill: #0b0b0b; } .secondary { fill: #52514e; } .muted { fill: #898781; }
.grid { stroke: #e1e0d9; } .axis { stroke: #c3c2b7; } .reference { stroke: #52514e; } .bar { fill: #2a78d6; }
.title { font-size: 15px; font-weight: 600; } .heading { font-weight: 600; } .tick { font-variant-numeric: tabular-nums; }
@media (prefers-color-scheme: dark) {
.surface { fill: #1a1a19; } .primary { fill: #f0efec; } .secondary { fill: #c3c2b7; }
.grid { stroke: #2c2c2a; } .axis { stroke: #383835; } .reference { stroke: #c3c2b7; } .bar { fill: #3987e5; }
}
</style>`

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const n = (x: number) => String(Math.round(x * 10) / 10)

/** A bar growing from the baseline at x, square there, with a 4px rounded end. */
function barPath(x: number, y: number, w: number): string {
  const r = Math.min(4, w / 2)
  return `M${n(x)} ${n(y)}H${n(x + w - r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + w)} ${n(y + r)}V${n(y + THICK - r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + w - r)} ${n(y + THICK)}H${n(x)}Z`
}

export function barChart(c: BarChart): string {
  const body: string[] = []
  let y = 24
  body.push(`<text class="primary title" x="16" y="${y}">${esc(c.title)}</text>`)
  for (const line of c.subtitle) body.push(`<text class="secondary" x="16" y="${(y += 20)}">${esc(line)}</text>`)
  y += c.reference ? 34 : 18
  const plotTop = y
  const marks: string[] = []
  for (const g of c.groups) {
    if (g.heading) {
      marks.push(`<text class="secondary heading" x="16" y="${y + 16}">${esc(g.heading)}</text>`)
      y += 24
    }
    for (const b of g.bars) {
      const w = Math.max(0, Math.min(1, b.value)) * PLOT
      const top = y + (ROW - THICK) / 2
      const mid = n(top + THICK / 2 + 4.5)
      marks.push(`<text class="primary" x="${LEFT - 12}" y="${mid}" text-anchor="end">${esc(b.label)}</text>`)
      if (w > 0) marks.push(`<path class="bar" d="${barPath(LEFT, top, w)}"><title>${esc(`${b.label}: ${b.text}`)}</title></path>`)
      marks.push(`<text class="secondary" x="${n(LEFT + w + 8)}" y="${mid}">${esc(b.text)}</text>`)
      y += ROW
    }
    y += 6
  }
  const plotBottom = y
  const grid = TICKS.map((t) => {
    const x = n(LEFT + t * PLOT)
    return `<line class="${t === 0 ? 'axis' : 'grid'}" x1="${x}" x2="${x}" y1="${plotTop}" y2="${plotBottom}" stroke-width="1"/><text class="muted tick" x="${x}" y="${plotBottom + 18}" text-anchor="middle">${Math.round(t * 100)}%</text>`
  })
  if (c.reference) {
    const x = n(LEFT + c.reference.value * PLOT)
    grid.push(`<line class="reference" x1="${x}" x2="${x}" y1="${plotTop - 10}" y2="${plotBottom}" stroke-width="1"/><text class="secondary" x="${x}" y="${plotTop - 16}" text-anchor="middle">${esc(c.reference.label)}</text>`)
  }
  const height = plotBottom + 32
  const aria = [c.title, ...c.groups.flatMap((g) => g.bars.map((b) => `${b.label}: ${b.text}`))].join('; ')
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="${esc(aria)}">`,
    STYLE,
    `<rect class="surface" width="${WIDTH}" height="${height}" rx="8"/>`,
    ...grid,
    ...body,
    ...marks,
    '</svg>',
    '',
  ].join('\n')
}
