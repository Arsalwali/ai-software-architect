import type { ModuleGraph } from './module-graph.js'

/**
 * Tarjan's strongly-connected components, iteratively.
 *
 * Iterative rather than recursive on purpose: a recursive version overflows
 * the call stack on a deep import chain, which is exactly the situation on
 * the large repositories where cycle detection is worth having. Components
 * come back with their members sorted. A component of size one is only a
 * cycle if the node has an edge to itself — the caller must check that.
 */
export function stronglyConnectedComponents(
  nodes: string[],
  successors: (node: string) => Iterable<string>,
): string[][] {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const components: string[][] = []
  let counter = 0

  for (const root of nodes) {
    if (index.has(root)) continue

    const work: Array<{ node: string; iter: Iterator<string> }> = []
    index.set(root, counter)
    low.set(root, counter)
    counter += 1
    stack.push(root)
    onStack.add(root)
    work.push({ node: root, iter: successors(root)[Symbol.iterator]() })

    while (work.length > 0) {
      const frame = work[work.length - 1]
      const step = frame.iter.next()

      if (!step.done) {
        const next = step.value
        if (!index.has(next)) {
          index.set(next, counter)
          low.set(next, counter)
          counter += 1
          stack.push(next)
          onStack.add(next)
          work.push({ node: next, iter: successors(next)[Symbol.iterator]() })
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(next)!))
        }
        continue
      }

      work.pop()
      if (work.length > 0) {
        const parent = work[work.length - 1].node
        low.set(parent, Math.min(low.get(parent)!, low.get(frame.node)!))
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = []
        for (;;) {
          const member = stack.pop()!
          onStack.delete(member)
          component.push(member)
          if (member === frame.node) break
        }
        components.push(component.sort())
      }
    }
  }

  return components
}

export interface CouplingMetrics {
  module: string
  /** Distinct modules that depend on this one. */
  afferent: number
  /** Distinct modules this one depends on. */
  efferent: number
  /** Ce over (Ca + Ce). Zero when the module has no coupling in either direction. */
  instability: number
  files: number
}

export function couplingMetrics(graph: ModuleGraph): CouplingMetrics[] {
  return graph.modules.map(module => {
    const efferent = graph.out.get(module)?.size ?? 0
    const afferent = graph.in.get(module)?.size ?? 0
    const total = afferent + efferent
    return {
      module,
      afferent,
      efferent,
      // A module nothing depends on and which depends on nothing is not
      // "maximally unstable" — it is uninvolved. Report 0, not NaN.
      instability: total === 0 ? 0 : Number((efferent / total).toFixed(4)),
      files: graph.filesByModule.get(module)?.length ?? 0,
    }
  })
}
