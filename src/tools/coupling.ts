import type { GraphStore } from '../store/graph-store.js'
import { buildModuleGraph } from '../graph/module-graph.js'
import { couplingMetrics, type CouplingMetrics } from '../graph/algorithms.js'
import { truncate, type Truncation } from './envelope.js'

export interface CouplingOptions {
  limit: number
}

export interface ModulePair {
  from: string
  to: string
  /** Distinct file-to-file dependencies crossing this module boundary. */
  weight: number
}

export interface CouplingResult {
  modules: CouplingMetrics[]
  totalModules: number
  heaviestPairs: ModulePair[]
  totalPairs: number
  truncatedModules?: Truncation
  truncatedPairs?: Truncation
}

export function getCoupling(store: GraphStore, options: CouplingOptions): CouplingResult {
  const graph = buildModuleGraph(store)
  const metrics = couplingMetrics(graph)

  metrics.sort((a, b) =>
    (b.afferent + b.efferent) - (a.afferent + a.efferent) || a.module.localeCompare(b.module))

  const pairs: ModulePair[] = []
  for (const [from, targets] of graph.out) {
    for (const [to, weight] of targets) pairs.push({ from, to, weight })
  }
  pairs.sort((a, b) =>
    b.weight - a.weight || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))

  const moduleSlice = truncate(metrics, options.limit)
  const pairSlice = truncate(pairs, options.limit)

  return {
    modules: moduleSlice.items,
    totalModules: metrics.length,
    heaviestPairs: pairSlice.items,
    totalPairs: pairs.length,
    truncatedModules: moduleSlice.truncated,
    truncatedPairs: pairSlice.truncated,
  }
}
