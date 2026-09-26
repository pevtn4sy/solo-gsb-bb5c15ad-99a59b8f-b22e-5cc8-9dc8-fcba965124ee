import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cycleAfterAdding,
  findCycle,
  findPath,
  findRedundantEdges,
  mergeConflict,
  planMergeEdges,
  planPrune,
  queryOrder,
  stableTopoOrder,
  topoLevels,
} from '../src/graph';

test('合法连线：不成环时返回 null', () => {
  const edges = [{ fromId: 'a', toId: 'b' }];
  assert.equal(cycleAfterAdding(edges, { fromId: 'b', toId: 'c' }), null);
});

test('成环连线：返回完整闭环节点序列', () => {
  const edges = [
    { fromId: 'a', toId: 'b' },
    { fromId: 'b', toId: 'c' },
  ];
  // 新增 c → a 将构成 a → b → c → a
  assert.deepEqual(cycleAfterAdding(edges, { fromId: 'c', toId: 'a' }), ['c', 'a', 'b', 'c']);
});

test('自环立即被拒绝', () => {
  assert.deepEqual(cycleAfterAdding([], { fromId: 'a', toId: 'a' }), ['a', 'a']);
});

test('findPath：沿边方向找到路径', () => {
  const edges = [
    { fromId: 'a', toId: 'b' },
    { fromId: 'b', toId: 'c' },
    { fromId: 'a', toId: 'c' },
  ];
  assert.deepEqual(findPath(edges, 'a', 'c'), ['a', 'c']);
  assert.equal(findPath(edges, 'c', 'a'), null);
});

test('topoLevels：按最长路径分层', () => {
  const levels = topoLevels(
    ['a', 'b', 'c', 'd'],
    [
      { fromId: 'a', toId: 'b' },
      { fromId: 'b', toId: 'c' },
      { fromId: 'a', toId: 'c' },
      { fromId: 'c', toId: 'd' },
    ],
  );
  assert.deepEqual(levels, { a: 0, b: 1, c: 2, d: 3 });
});

test('topoLevels：有环时返回 null', () => {
  const levels = topoLevels(
    ['a', 'b'],
    [
      { fromId: 'a', toId: 'b' },
      { fromId: 'b', toId: 'a' },
    ],
  );
  assert.equal(levels, null);
});

test('findCycle：在已有图中定位闭环', () => {
  const cycle = findCycle(
    ['a', 'b', 'c', 'd'],
    [
      { fromId: 'a', toId: 'b' },
      { fromId: 'b', toId: 'c' },
      { fromId: 'c', toId: 'a' },
      { fromId: 'c', toId: 'd' },
    ],
  );
  assert.ok(cycle);
  assert.equal(cycle![0], cycle![cycle!.length - 1]);
  assert.equal(cycle!.length, 4);
});

test('findCycle：无环返回 null', () => {
  const cycle = findCycle(
    ['a', 'b'],
    [{ fromId: 'a', toId: 'b' }],
  );
  assert.equal(cycle, null);
});

/* ---------- 传递约简（约束瘦身） ---------- */

test('findRedundantEdges：三角结构中的直达边冗余，并给出最短替代路径', () => {
  const edges = [
    { fromId: 'a', toId: 'b' },
    { fromId: 'b', toId: 'c' },
    { fromId: 'a', toId: 'c' },
  ];
  const redundant = findRedundantEdges(edges);
  assert.equal(redundant.length, 1);
  assert.deepEqual(redundant[0].edge, { fromId: 'a', toId: 'c' });
  assert.deepEqual(redundant[0].path, ['a', 'b', 'c']);
});

test('findRedundantEdges：链式结构没有冗余边', () => {
  const edges = [
    { fromId: 'a', toId: 'b' },
    { fromId: 'b', toId: 'c' },
  ];
  assert.deepEqual(findRedundantEdges(edges), []);
});

test('findRedundantEdges：菱形结构中替代路径取最短（边数最少）', () => {
  const edges = [
    { fromId: 'a', toId: 'b' },
    { fromId: 'b', toId: 'c' },
    { fromId: 'c', toId: 'd' },
    { fromId: 'a', toId: 'e' },
    { fromId: 'e', toId: 'd' },
    { fromId: 'a', toId: 'd' },
  ];
  const redundant = findRedundantEdges(edges);
  assert.equal(redundant.length, 1);
  assert.deepEqual(redundant[0].edge, { fromId: 'a', toId: 'd' });
  // a→e→d（2 条边）比 a→b→c→d（3 条边）更短
  assert.deepEqual(redundant[0].path, ['a', 'e', 'd']);
});

test('findRedundantEdges：多条冗余边各自给出替代路径', () => {
  const edges = [
    { fromId: 'a', toId: 'b' },
    { fromId: 'b', toId: 'c' },
    { fromId: 'a', toId: 'c' },
    { fromId: 'c', toId: 'd' },
    { fromId: 'a', toId: 'd' },
  ];
  const redundant = findRedundantEdges(edges);
  assert.deepEqual(
    redundant.map((r) => `${r.edge.fromId}->${r.edge.toId}`).sort(),
    ['a->c', 'a->d'],
  );
  const ad = redundant.find((r) => r.edge.toId === 'd')!;
  assert.deepEqual(ad.path, ['a', 'c', 'd']);
});

test('planPrune：逐条复核，跳过当前并不冗余的连线', () => {
  // a→b 冗余（替代路径 a→c→b）；a→c 从不冗余（忽略自身后 a 到不了 c）
  const edges = [
    { id: 1, fromId: 'a', toId: 'b' },
    { id: 2, fromId: 'a', toId: 'c' },
    { id: 3, fromId: 'c', toId: 'b' },
  ];
  const plan = planPrune(edges, [1, 2]);
  assert.deepEqual(plan.remove.map((e) => e.id), [1]);
  assert.deepEqual(plan.skipped, [2]);
});

test('planPrune：DAG 上所有冗余边无论请求顺序都会被移除（传递约简唯一）', () => {
  const edges = [
    { id: 1, fromId: 'a', toId: 'b' },
    { id: 2, fromId: 'b', toId: 'c' },
    { id: 3, fromId: 'a', toId: 'c' },
    { id: 4, fromId: 'c', toId: 'd' },
    { id: 5, fromId: 'a', toId: 'd' },
  ];
  for (const ids of [[3, 5], [5, 3], [1, 2, 3, 4, 5]]) {
    const plan = planPrune(edges, ids);
    assert.deepEqual(plan.remove.map((e) => e.id).sort(), [3, 5]);
  }
});

test('planPrune：独立冗余边可全部移除，未知 id 被跳过', () => {
  const edges = [
    { id: 1, fromId: 'a', toId: 'b' },
    { id: 2, fromId: 'b', toId: 'c' },
    { id: 3, fromId: 'a', toId: 'c' },
    { id: 4, fromId: 'x', toId: 'y' },
    { id: 5, fromId: 'y', toId: 'z' },
    { id: 6, fromId: 'x', toId: 'z' },
  ];
  const plan = planPrune(edges, [3, 6, 999, 3]);
  assert.deepEqual(plan.remove.map((e) => e.id), [3, 6]);
  assert.deepEqual(plan.skipped, [999]);
});

test('planPrune：移除后各节点间可达关系保持不变', () => {
  const edges = [
    { id: 1, fromId: 'a', toId: 'b' },
    { id: 2, fromId: 'b', toId: 'c' },
    { id: 3, fromId: 'a', toId: 'c' },
    { id: 4, fromId: 'c', toId: 'd' },
    { id: 5, fromId: 'a', toId: 'd' },
  ];
  const reachableBefore = (from: string, to: string) => findPath(edges, from, to) !== null;
  const { remove } = planPrune(edges, [1, 2, 3, 4, 5]);
  const remaining = edges.filter((e) => !remove.includes(e));
  for (const from of ['a', 'b', 'c', 'd']) {
    for (const to of ['a', 'b', 'c', 'd']) {
      assert.equal(findPath(remaining, from, to) !== null, reachableBefore(from, to), `${from}⇝${to} 可达性应保持不变`);
    }
  }
});

/* ---------- 顺序确定性查询 ---------- */

const nodesOf = (ids: string[]) => ids.map((id, i) => ({ id, createdAt: `2026-01-0${i + 1}T00:00:00.000Z` }));

test('stableTopoOrder：并列节点按创建时间、再按 id 稳定排序', () => {
  const nodes = [
    { id: 'b', createdAt: '2026-01-02T00:00:00.000Z' },
    { id: 'a', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'c', createdAt: '2026-01-01T00:00:00.000Z' },
  ];
  // 无边：完全按 (createdAt, id) 排序；a 与 c 创建时间相同，按 id 决出
  assert.deepEqual(stableTopoOrder(nodes, []), ['a', 'c', 'b']);
});

test('stableTopoOrder：遵守约束且结果确定', () => {
  const nodes = nodesOf(['x', 'y', 'z']);
  const edges = [{ fromId: 'z', toId: 'x' }];
  // z 必须先于 x；y 无约束，按创建时间排最前
  assert.deepEqual(stableTopoOrder(nodes, edges), ['y', 'z', 'x']);
});

test('stableTopoOrder：附加见证边后仍满足全部约束；附加边成环时返回 null', () => {
  const nodes = nodesOf(['a', 'b']);
  const order = stableTopoOrder(nodes, [], { fromId: 'b', toId: 'a' })!;
  assert.ok(order.indexOf('b') < order.indexOf('a'));
  // 已有 a→b 时再附加 b→a 构成环
  assert.equal(stableTopoOrder(nodes, [{ fromId: 'a', toId: 'b' }], { fromId: 'b', toId: 'a' }), null);
});

test('queryOrder：A 必须早于 B，返回最短约束路径', () => {
  const nodes = nodesOf(['a', 'b', 'c']);
  const edges = [
    { fromId: 'a', toId: 'b' },
    { fromId: 'b', toId: 'c' },
    { fromId: 'a', toId: 'c' },
  ];
  const r = queryOrder(nodes, edges, 'a', 'c')!;
  assert.equal(r.relation, 'a-before-b');
  assert.deepEqual(r.path, ['a', 'c']); // 最短路径为直达边
  assert.equal(r.witnesses, null);
});

test('queryOrder：B 必须早于 A（反向可达）', () => {
  const nodes = nodesOf(['a', 'b']);
  const edges = [{ fromId: 'b', toId: 'a' }];
  const r = queryOrder(nodes, edges, 'a', 'b')!;
  assert.equal(r.relation, 'b-before-a');
  assert.deepEqual(r.path, ['b', 'a']);
  assert.equal(r.witnesses, null);
});

test('queryOrder：顺序未被约束时给出双向见证拓扑序', () => {
  const nodes = nodesOf(['a', 'b', 'c', 'd']);
  const edges = [
    { fromId: 'a', toId: 'c' },
    { fromId: 'b', toId: 'd' },
  ];
  const r = queryOrder(nodes, edges, 'a', 'b')!;
  assert.equal(r.relation, 'unconstrained');
  assert.equal(r.path, null);
  const { aFirst, bFirst } = r.witnesses!;
  const assertTopoOrder = (order: string[], extra: { fromId: string; toId: string }) => {
    assert.deepEqual([...order].sort(), ['a', 'b', 'c', 'd']);
    const pos = new Map(order.map((id, i) => [id, i]));
    for (const e of [...edges, extra]) {
      assert.ok(pos.get(e.fromId)! < pos.get(e.toId)!, `${e.fromId} 应排在 ${e.toId} 之前`);
    }
  };
  assertTopoOrder(aFirst, { fromId: 'a', toId: 'b' });
  assertTopoOrder(bFirst, { fromId: 'b', toId: 'a' });
  // 并列节点按创建时间稳定排序：a 创建最早且初始就绪，排在首位
  assert.equal(aFirst[0], 'a');
  assert.equal(bFirst[0], 'b');
});

test('queryOrder：同一卡片返回 null', () => {
  assert.equal(queryOrder(nodesOf(['a']), [], 'a', 'a'), null);
});

/* ---------- 重复证据合并 ---------- */

test('mergeConflict：无关节点合并无冲突', () => {
  const edges = [
    { fromId: 'a', toId: 'b' },
    { fromId: 'c', toId: 'd' },
  ];
  assert.equal(mergeConflict(edges, 'a', 'c'), null);
  assert.equal(mergeConflict(edges, 'd', 'b'), null);
});

test('mergeConflict：直接约束改接成自环，返回 self-loop 与两端点', () => {
  const edges = [{ fromId: 's', toId: 't' }];
  assert.deepEqual(mergeConflict(edges, 's', 't'), { kind: 'self-loop', path: ['s', 't'] });
  assert.deepEqual(mergeConflict(edges, 't', 's'), { kind: 'self-loop', path: ['s', 't'] });
});

test('mergeConflict：源可达保留（无直连），改接后成环，返回 cycle 路径', () => {
  // s → x → t：s 可达 t。改接入边会让 t 沿路径回到 s 再指向 t，形成闭环
  const edges = [
    { fromId: 's', toId: 'x' },
    { fromId: 'x', toId: 't' },
  ];
  const c = mergeConflict(edges, 's', 't')!;
  assert.equal(c.kind, 'cycle');
  assert.deepEqual(c.path, ['s', 'x', 't']);
});

test('mergeConflict：保留可达源（无直连），改接入边成环，返回反方向 cycle 路径', () => {
  const edges = [
    { fromId: 't', toId: 'x' },
    { fromId: 'x', toId: 's' },
  ];
  const c = mergeConflict(edges, 's', 't')!;
  assert.equal(c.kind, 'cycle');
  assert.deepEqual(c.path, ['t', 'x', 's']);
});

test('planMergeEdges：全部入边、出边改接到保留卡', () => {
  const edges = [
    { id: 1, fromId: 'a', toId: 's' },
    { id: 2, fromId: 's', toId: 'b' },
    { id: 3, fromId: 'x', toId: 'y' },
  ];
  const plan = planMergeEdges(edges, 's', 't');
  assert.deepEqual(plan.deleteIds, []);
  assert.deepEqual(plan.rewire, [
    { id: 1, fromId: 'a', toId: 't' },
    { id: 2, fromId: 't', toId: 'b' },
  ]);
});

test('planMergeEdges：重复连线只留保留卡侧一条，删除源侧重复边', () => {
  const edges = [
    { id: 1, fromId: 'a', toId: 's' }, // 改接为 a→t
    { id: 2, fromId: 'a', toId: 't' }, // 已存在 a→t：边 1 重复，删除
    { id: 3, fromId: 's', toId: 'b' }, // 改接为 t→b
    { id: 4, fromId: 't', toId: 'b' }, // 已存在 t→b：边 3 重复，删除
    { id: 5, fromId: 's', toId: 'c' }, // 无重复：改接为 t→c
  ];
  const plan = planMergeEdges(edges, 's', 't');
  assert.deepEqual(plan.deleteIds.sort(), [1, 3]);
  assert.deepEqual(plan.rewire, [{ id: 5, fromId: 't', toId: 'c' }]);
});

test('planMergeEdges：与源卡无关的连线原样保留', () => {
  const edges = [
    { id: 1, fromId: 'a', toId: 's' },
    { id: 2, fromId: 's', toId: 'b' },
    { id: 3, fromId: 'x', toId: 'y' },
    { id: 4, fromId: 't', toId: 'z' },
  ];
  const plan = planMergeEdges(edges, 's', 't');
  assert.deepEqual(plan.deleteIds, []);
  assert.deepEqual(plan.rewire.map((e) => e.id).sort(), [1, 2]);
});

test('合并改接（去重后）不产生环，剩余图仍然无环', () => {
  // 可合并的场景：s 与 t 互不达
  const edges = [
    { id: 1, fromId: 'a', toId: 's' },
    { id: 2, fromId: 's', toId: 'b' },
    { id: 3, fromId: 'c', toId: 't' },
  ];
  assert.equal(mergeConflict(edges, 's', 't'), null);
  const plan = planMergeEdges(edges, 's', 't');
  const remaining = edges
    .filter((e) => !plan.deleteIds.includes(e.id))
    .map((e) => {
      const m = plan.rewire.find((r) => r.id === e.id);
      return m ? { fromId: m.fromId, toId: m.toId } : { fromId: e.fromId, toId: e.toId };
    })
    .filter((e) => e.fromId !== 's' && e.toId !== 's');
  const ids = ['a', 'b', 'c', 't'];
  assert.notEqual(topoLevels(ids, remaining), null);
});

test('事务模拟：任意可合并场景执行计划后无重复连线、无自环、无环', () => {
  // 较复杂场景：s 同时有多个入边/出边，部分与保留卡侧重复
  const edges = [
    { id: 1, fromId: 'a', toId: 's' },
    { id: 2, fromId: 'b', toId: 's' },
    { id: 3, fromId: 'a', toId: 't' }, // a→t 已存在 => 边 1 改接后重复
    { id: 4, fromId: 's', toId: 'c' },
    { id: 5, fromId: 't', toId: 'd' },
    { id: 6, fromId: 's', toId: 'd' }, // t→d 已存在 => 边 6 重复
    { id: 7, fromId: 'x', toId: 'y' }, // 完全无关
  ];
  assert.equal(mergeConflict(edges, 's', 't'), null);
  const plan = planMergeEdges(edges, 's', 't');
  const finalEdges = edges
    .filter((e) => !plan.deleteIds.includes(e.id))
    .map((e) => plan.rewire.find((r) => r.id === e.id) ?? e)
    .filter((e) => e.fromId !== 's' && e.toId !== 's');

  // 无自环
  assert.ok(finalEdges.every((e) => e.fromId !== e.toId));
  // 无重复 (from, to) 对（对应 edges 表 UNIQUE(from_id, to_id)）
  const keys = finalEdges.map((e) => `${e.fromId}->${e.toId}`);
  assert.equal(new Set(keys).size, keys.length);
  // 无环
  assert.equal(findCycle(['a', 'b', 'c', 'd', 'x', 'y', 't'], finalEdges), null);
  // 保留卡继承了去重后的邻接：a→t 仅一条，t→c、t→d 各一条
  assert.deepEqual(
    keys.sort(),
    ['a->t', 'b->t', 't->c', 't->d', 'x->y'],
  );
});
