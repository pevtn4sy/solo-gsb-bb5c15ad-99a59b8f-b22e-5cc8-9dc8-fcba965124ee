export interface EdgeLike {
  fromId: string;
  toId: string;
}

/**
 * 沿有向边方向，BFS 寻找 start → goal 的一条路径。
 * 返回包含两端点的节点 id 数组；不可达时返回 null。
 */
export function findPath(edges: EdgeLike[], start: string, goal: string): string[] | null {
  if (start === goal) return [start];
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const list = adj.get(e.fromId);
    if (list) list.push(e.toId);
    else adj.set(e.fromId, [e.toId]);
  }
  const prev = new Map<string, string | null>([[start, null]]);
  const queue: string[] = [start];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const nxt of adj.get(cur) ?? []) {
      if (prev.has(nxt)) continue;
      prev.set(nxt, cur);
      if (nxt === goal) {
        const path = [goal];
        let p = prev.get(goal)!;
        while (p !== null) {
          path.unshift(p);
          p = prev.get(p)!;
        }
        return path;
      }
      queue.push(nxt);
    }
  }
  return null;
}

/**
 * 传递约简（约束瘦身）：找出所有冗余边。
 * 边 from → to 冗余 ⇔ 在忽略该边自身后，仍存在从 from 到 to 的路径
 * （即删除它不会改变任何节点间的可达关系）。
 * 每条冗余边附带一条最短替代路径（节点 id 序列，含起终点；BFS 保证边数最少）。
 * 按边的下标排除自身，即使图中存在重复边也不会误判。
 */
export interface RedundantEdgeInfo<T extends EdgeLike> {
  edge: T;
  /** 最短替代路径：从 edge.fromId 到 edge.toId 的节点 id 序列 */
  path: string[];
}

export function findRedundantEdges<T extends EdgeLike>(edges: T[]): Array<RedundantEdgeInfo<T>> {
  const out: Array<RedundantEdgeInfo<T>> = [];
  for (let i = 0; i < edges.length; i++) {
    const rest = edges.filter((_, j) => j !== i);
    const path = findPath(rest, edges[i].fromId, edges[i].toId);
    if (path) out.push({ edge: edges[i], path });
  }
  return out;
}

/**
 * 批量瘦身计划：按给定 id 顺序逐条检查——
 * 仅当该边在「当前剩余边集」中仍然冗余（忽略自身后仍有 from → to 路径）时才移除，
 * 否则跳过。冗余边可能相互依存（A→B 的替代路径恰好经过 A→C），
 * 逐条复核保证每次移除都不改变图的传递闭包，从而保持全部可达关系不变。
 */
export function planPrune<T extends EdgeLike & { id: number }>(
  edges: T[],
  ids: number[],
): { remove: T[]; skipped: number[] } {
  const remaining = [...edges];
  const remove: T[] = [];
  const skipped: number[] = [];
  const seen = new Set<number>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const idx = remaining.findIndex((e) => e.id === id);
    if (idx === -1) {
      skipped.push(id);
      continue;
    }
    const edge = remaining[idx];
    const rest = remaining.filter((_, j) => j !== idx);
    if (findPath(rest, edge.fromId, edge.toId)) {
      remove.push(edge);
      remaining.splice(idx, 1);
    } else {
      skipped.push(id);
    }
  }
  return { remove, skipped };
}

/**
 * 校验「新增一条 fromId → toId 的边」是否会成环。
 * 若成环，返回完整闭环节点序列 [fromId, toId, …, fromId]
 * （首条为待保存的新边，其余为图中已有边）；否则返回 null。
 */
export function cycleAfterAdding(edges: EdgeLike[], newEdge: EdgeLike): string[] | null {
  if (newEdge.fromId === newEdge.toId) return [newEdge.fromId, newEdge.fromId];
  const back = findPath(edges, newEdge.toId, newEdge.fromId);
  if (!back) return null;
  return [newEdge.fromId, ...back];
}

/**
 * Kahn 拓扑排序 + 最长路径分层：level(n) = max(level(前置)) + 1。
 * 返回每个节点的层级（0 起）；若图中有环则返回 null。
 */
export function topoLevels(ids: string[], edges: EdgeLike[]): Record<string, number> | null {
  const indeg = new Map<string, number>();
  const level = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const id of ids) {
    indeg.set(id, 0);
    level.set(id, 0);
    adj.set(id, []);
  }
  for (const e of edges) {
    if (!indeg.has(e.fromId) || !indeg.has(e.toId)) continue;
    indeg.set(e.toId, indeg.get(e.toId)! + 1);
    adj.get(e.fromId)!.push(e.toId);
  }
  const queue = ids.filter((id) => indeg.get(id) === 0);
  let visited = 0;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    visited++;
    for (const nxt of adj.get(cur)!) {
      level.set(nxt, Math.max(level.get(nxt)!, level.get(cur)! + 1));
      indeg.set(nxt, indeg.get(nxt)! - 1);
      if (indeg.get(nxt) === 0) queue.push(nxt);
    }
  }
  if (visited !== ids.length) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of level) out[k] = v;
  return out;
}

/**
 * 确定性拓扑排序（Kahn）：就绪集中的并列节点统一按创建时间、再按 id 稳定排序，
 * 保证同一输入永远得到同一结果。可附加一条额外约束边（用于生成见证拓扑序）；
 * 图（含附加边）有环时返回 null。
 */
export interface OrderableNode {
  id: string;
  createdAt: string;
}

export function stableTopoOrder(nodes: OrderableNode[], edges: EdgeLike[], extraEdge: EdgeLike | null = null): string[] | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const cmp = (x: string, y: string): number => {
    const a = byId.get(x)!;
    const b = byId.get(y)!;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return 0;
  };
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    indeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  const all = extraEdge ? [...edges, extraEdge] : edges;
  for (const e of all) {
    if (!indeg.has(e.fromId) || !indeg.has(e.toId)) continue;
    indeg.set(e.toId, indeg.get(e.toId)! + 1);
    adj.get(e.fromId)!.push(e.toId);
  }
  // 就绪集始终按 (createdAt, id) 升序，保证结果确定
  const ready = nodes
    .filter((n) => indeg.get(n.id) === 0)
    .map((n) => n.id)
    .sort(cmp);
  const order: string[] = [];
  while (ready.length > 0) {
    const cur = ready.shift()!;
    order.push(cur);
    for (const nxt of adj.get(cur)!) {
      const d = indeg.get(nxt)! - 1;
      indeg.set(nxt, d);
      if (d === 0) {
        let pos = ready.length;
        while (pos > 0 && cmp(ready[pos - 1], nxt) > 0) pos--;
        ready.splice(pos, 0, nxt);
      }
    }
  }
  return order.length === nodes.length ? order : null;
}

/**
 * 顺序确定性查询：判定两张卡片的先后顺序是否已被约束确定。
 * - A 可达 B：A 必须早于 B，返回 A → B 的一条最短约束路径；
 * - B 可达 A：B 必须早于 A，返回 B → A 的一条最短约束路径；
 * - 互相不可达：顺序未被约束，分别附加见证方向边（A→B 与 B→A），
 *   生成两个合法拓扑序作为双向见证。
 * aId === bId 或图（含见证边）有环时返回 null。
 */
export type OrderRelation = 'a-before-b' | 'b-before-a' | 'unconstrained';

export interface OrderQueryOutcome {
  relation: OrderRelation;
  /** relation 为 a-before-b / b-before-a 时：从先到后的一条最短约束路径（含两端点） */
  path: string[] | null;
  /** relation 为 unconstrained 时：双向见证拓扑序（aFirst 中 a 在 b 前，bFirst 反之） */
  witnesses: { aFirst: string[]; bFirst: string[] } | null;
}

export function queryOrder(nodes: OrderableNode[], edges: EdgeLike[], aId: string, bId: string): OrderQueryOutcome | null {
  if (aId === bId) return null;
  const pathAB = findPath(edges, aId, bId);
  if (pathAB) return { relation: 'a-before-b', path: pathAB, witnesses: null };
  const pathBA = findPath(edges, bId, aId);
  if (pathBA) return { relation: 'b-before-a', path: pathBA, witnesses: null };
  const aFirst = stableTopoOrder(nodes, edges, { fromId: aId, toId: bId });
  const bFirst = stableTopoOrder(nodes, edges, { fromId: bId, toId: aId });
  if (!aFirst || !bFirst) return null;
  return { relation: 'unconstrained', path: null, witnesses: { aFirst, bFirst } };
}

/**
 * 在已有图中寻找一个环（用于导入快照校验）。
 * 返回闭环节点序列 [n, …, n]；无环返回 null。
 */
export function findCycle(ids: string[], edges: EdgeLike[]): string[] | null {
  const adj = new Map<string, string[]>();
  for (const id of ids) adj.set(id, []);
  for (const e of edges) {
    if (adj.has(e.fromId) && adj.has(e.toId)) adj.get(e.fromId)!.push(e.toId);
  }
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(ids.map((id) => [id, WHITE]));
  const parent = new Map<string, string | null>();

  for (const root of ids) {
    if (color.get(root) !== WHITE) continue;
    color.set(root, GRAY);
    parent.set(root, null);
    const stack: Array<[string, Iterator<string>]> = [[root, (adj.get(root) ?? [])[Symbol.iterator]()]];
    while (stack.length > 0) {
      const [node, it] = stack[stack.length - 1];
      const next = it.next();
      if (next.done) {
        color.set(node, BLACK);
        stack.pop();
        continue;
      }
      const n = next.value as string;
      if (color.get(n) === GRAY) {
        // 发现回边 node → n：沿父链回溯出完整闭环 n → … → node → n
        const cycle = [n];
        let cur: string = node;
        while (cur !== n) {
          cycle.unshift(cur);
          cur = parent.get(cur)!;
        }
        cycle.unshift(n);
        return cycle;
      }
      if (color.get(n) === WHITE) {
        color.set(n, GRAY);
        parent.set(n, node);
        stack.push([n, (adj.get(n) ?? [])[Symbol.iterator]()]);
      }
    }
  }
  return null;
}
