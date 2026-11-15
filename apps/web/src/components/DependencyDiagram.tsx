import { useEffect, useState } from 'react'
import type { RepositoryAnalysis } from '@archguard/contracts'

type Edge = RepositoryAnalysis['dependencies'][number]
type Mermaid = typeof import('mermaid')['default']

let renderer: Promise<Mermaid> | undefined
let renderSequence = 0

function loadRenderer() {
  renderer ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: true,
      maxTextSize: 150_000,
      theme: 'base',
      themeVariables: {
        darkMode: true,
        background: '#121212',
        primaryColor: '#2d2c2a',
        primaryTextColor: '#f3f1ed',
        primaryBorderColor: '#a49a92',
        lineColor: '#b7b4af',
        edgeLabelBackground: '#252423',
        fontFamily: 'Consolas, Microsoft YaHei, monospace',
      },
      flowchart: { curve: 'linear', useMaxWidth: false },
      suppressErrorRendering: true,
    })
    return mermaid
  })
  return renderer
}

function fileLabel(path: string): string {
  const characters = [...path]
  const label = characters.length > 120
    ? characters.slice(0, 54).join('') + '…' + characters.slice(-65).join('')
    : path
  // File names are data, so only letters and ordinary path separators enter the grammar as-is.
  return label.replace(/[^\p{L}\p{M}\p{N} /._-]/gu, (character) => `#${character.codePointAt(0)};`)
}

function toFlowchart(edges: readonly Edge[], issue: boolean): string {
  const nodes = new Map<string, string>()
  const arrows = new Map<string, string>()
  function id(file: string) {
    const existing = nodes.get(file)
    if (existing) return existing
    const generated = `file${nodes.size}`
    nodes.set(file, generated)
    return generated
  }
  for (const edge of edges) {
    const from = id(edge.from)
    const to = id(edge.to)
    const pair = `${from}:${to}`
    if (arrows.has(pair)) continue
    const line = issue && Number.isSafeInteger(edge.line) && edge.line > 0 ? `|L${edge.line}|` : ''
    arrows.set(pair, `${from} -->${line} ${to}`)
  }
  return [
    'flowchart LR',
    ...Array.from(nodes, ([file, key]) => `${key}["${fileLabel(file)}"]`),
    ...arrows.values(),
    ...(issue ? [
      'classDef evidence fill:#382421,stroke:#cf463a,stroke-width:2px,color:#f3f1ed',
      `class ${[...nodes.values()].join(',')} evidence`,
      'linkStyle default stroke:#ff5848,stroke-width:2px',
    ] : []),
  ].join('\n')
}

const edgeLimit = 50

export function DependencyDiagram({ edges, label, issue = false }: {
  edges: readonly Edge[]
  label: string
  issue?: boolean
}) {
  const source = edges.length ? toFlowchart(edges.slice(0, edgeLimit), issue) : ''
  const [rendered, setRendered] = useState<{ source: string; url: string | null }>()
  const current = rendered?.source === source ? rendered : undefined

  useEffect(() => {
    setRendered(undefined)
    if (!source) return
    let active = true
    let imageUrl: string | undefined
    const timer = window.setTimeout(async () => {
      try {
        const mermaid = await loadRenderer()
        if (!active) return
        const { svg } = await mermaid.render(`dependency-diagram-${++renderSequence}`, source)
        if (!active) return
        // Display the SVG as an image, isolated from the surrounding document.
        imageUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
        setRendered({ source, url: imageUrl })
      } catch {
        if (active) setRendered({ source, url: null })
      }
    }, 100)
    return () => {
      active = false
      window.clearTimeout(timer)
      if (imageUrl) URL.revokeObjectURL(imageUrl)
    }
  }, [source])

  if (!source) return null
  return (
    <figure className="dependency-diagram">
      <figcaption>{label}{edges.length > edgeLimit && `（前 ${edgeLimit} 条）`}</figcaption>
      {current?.url ? (
        <div className="diagram-viewport" role="region" tabIndex={0} aria-label={label}>
          <img src={current.url} alt={label} />
        </div>
      ) : current ? (
        <p className="error" role="status">依赖图渲染失败</p>
      ) : (
        <p className="muted" role="status">正在渲染依赖图…</p>
      )}
    </figure>
  )
}
