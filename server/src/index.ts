import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { db, getEdges, getEvidence } from './db';
import { cycleAfterAdding, findCycle, findRedundantEdges, planPrune, queryOrder, topoLevels } from './graph';
import { resetWithSample, seedIfEmpty } from './seed';
import type { Evidence, GraphState, OrderQueryResult, OrderWitness, PruneResult, RedundancyReport } from './types';

const app = express();
app.use(express.json({ limit: '5mb' }));

/* ---------- 状态组装 ---------- */

function buildState(): GraphState {
  const evidence = getEvidence();
  const edges = getEdges();
  const levels = topoLevels(evidence.map((e) => e.id), edges) ?? {};
  const levelCount = Object.values(levels).reduce((m, l) => Math.max(m, l + 1), 0);
  return { evidence, edges, levels, levelCount };
}

/* ---------- 输入校验 ---------- */

interface EvidenceInput {
  title: string;
  description: string;
  source: string;
  occurredAt: string | null;
}

function cleanString(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function parseEvidenceInput(body: unknown): { ok: true; value: EvidenceInput } | { ok: false; message: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const title = cleanString(b.title, 200);
  if (!title) return { ok: false, message: '标题不能为空' };
  let occurredAt: string | null = null;
  if (typeof b.occurredAt === 'string' && b.occurredAt.trim()) {
    const t = b.occurredAt.trim();
    if (Number.isNaN(Date.parse(t))) return { ok: false, message: '发生时间格式无效' };
    occurredAt = t;
  }
  return {
    ok: true,
    value: {
      title,
      description: cleanString(b.description, 2000),
      source: cleanString(b.source, 200),
      occurredAt,
    },
  };
}

/* ---------- 证据卡片 ---------- */

app.get('/api/state', (_req, res) => {
  res.json(buildState());
});

app.post('/api/evidence', (req, res) => {
  const parsed = parseEvidenceInput(req.body);
  if (!parsed.ok) return res.status(400).json({ message: parsed.message });
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO evidence (id, title, description, source, occurred_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(crypto.randomUUID(), parsed.value.title, parsed.value.description, parsed.value.source, parsed.value.occurredAt, now, now);
  res.status(201).json(buildState());
});

app.put('/api/evidence/:id', (req, res) => {
  const parsed = parseEvidenceInput(req.body);
  if (!parsed.ok) return res.status(400).json({ message: parsed.message });
  const r = db
    .prepare('UPDATE evidence SET title = ?, description = ?, source = ?, occurred_at = ?, updated_at = ? WHERE id = ?')
    .run(parsed.value.title, parsed.value.description, parsed.value.source, parsed.value.occurredAt, new Date().toISOString(), req.params.id);
  if (r.changes === 0) return res.status(404).json({ message: '证据卡片不存在' });
  res.json(buildState());
});

app.delete('/api/evidence/:id', (req, res) => {
  const r = db.prepare('DELETE FROM evidence WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ message: '证据卡片不存在' });
  res.json(buildState());
});

/* ---------- 「必须早于」连线 ---------- */

app.post('/api/edges', (req, res) => {
  const { fromId, toId } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof fromId !== 'string' || typeof toId !== 'string') {
    return res.status(400).json({ message: 'fromId 与 toId 均为必填' });
  }
  const ids = new Set(getEvidence().map((e) => e.id));
  if (!ids.has(fromId) || !ids.has(toId)) {
    return res.status(404).json({ message: '证据卡片不存在，请刷新后重试' });
  }
  const edges = getEdges();
  if (edges.some((e) => e.fromId === fromId && e.toId === toId)) {
    return res.status(409).json({ message: '该连线已存在' });
  }
  const cycle = cycleAfterAdding(edges, { fromId, toId });
  if (cycle) {
    return res.status(409).json({ message: '该连线会形成循环依赖，已拒绝保存', cycle });
  }
  db.prepare('INSERT INTO edges (from_id, to_id, created_at) VALUES (?, ?, ?)').run(fromId, toId, new Date().toISOString());
  res.status(201).json(buildState());
});

app.delete('/api/edges/:id', (req, res) => {
  const r = db.prepare('DELETE FROM edges WHERE id = ?').run(Number(req.params.id));
  if (r.changes === 0) return res.status(404).json({ message: '连线不存在' });
  res.json(buildState());
});

/* ---------- 约束瘦身（传递约简） ---------- */

app.get('/api/redundancy', (_req, res) => {
  const redundant = findRedundantEdges(getEdges()).map(({ edge, path }) => ({
    edgeId: edge.id,
    fromId: edge.fromId,
    toId: edge.toId,
    path,
  }));
  const report: RedundancyReport = { redundant };
  res.json(report);
});

app.post('/api/edges/prune', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const raw = body.edgeIds;
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'number' || !Number.isInteger(x))) {
    return res.status(400).json({ message: 'edgeIds 必须为整数数组' });
  }
  const ids = raw as number[];
  // 单个事务：在事务内重新分析「当前仍冗余」的连线并删除，
  // 逐条复核保证每次删除都不改变可达关系（传递闭包不变）
  let plan: { remove: Array<{ id: number }>; skipped: number[] } = { remove: [], skipped: [] };
  const tx = db.transaction(() => {
    plan = planPrune(getEdges(), ids);
    const del = db.prepare('DELETE FROM edges WHERE id = ?');
    for (const e of plan.remove) del.run(e.id);
  });
  tx();
  const result: PruneResult = { ...buildState(), pruned: plan.remove.map((e) => e.id), skipped: plan.skipped };
  res.json(result);
});

/* ---------- 顺序确定性查询 ---------- */

app.get('/api/order-query', (req, res) => {
  const { a, b } = req.query;
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) {
    return res.status(400).json({ message: 'a 与 b 两个证据 id 均为必填' });
  }
  if (a === b) {
    return res.status(400).json({ message: '请选择两张不同的证据卡片' });
  }
  const evidence = getEvidence();
  const ids = new Set(evidence.map((e) => e.id));
  if (!ids.has(a) || !ids.has(b)) {
    return res.status(404).json({ message: '证据卡片不存在，请刷新后重试' });
  }
  const edges = getEdges();
  const outcome = queryOrder(
    evidence.map((e) => ({ id: e.id, createdAt: e.createdAt })),
    edges,
    a,
    b,
  );
  if (!outcome) {
    return res.status(409).json({ message: '当前约束图存在环，无法判定顺序' });
  }
  // 未约束时：为每个见证方向计算附加约束后的拓扑层级，供前端临时预览画布布局
  let witnesses: OrderQueryResult['witnesses'] = null;
  if (outcome.witnesses) {
    const allIds = evidence.map((e) => e.id);
    const buildWitness = (firstId: string, secondId: string, order: string[]): OrderWitness => {
      const levels = topoLevels(allIds, [...edges, { fromId: firstId, toId: secondId }]) ?? {};
      return {
        firstId,
        secondId,
        order,
        levels,
        levelCount: Object.values(levels).reduce((m, l) => Math.max(m, l + 1), 0),
      };
    };
    witnesses = {
      aFirst: buildWitness(a, b, outcome.witnesses.aFirst),
      bFirst: buildWitness(b, a, outcome.witnesses.bFirst),
    };
  }
  const result: OrderQueryResult = { aId: a, bId: b, relation: outcome.relation, path: outcome.path, witnesses };
  res.json(result);
});

/* ---------- 导入 / 导出 / 示例 ---------- */

app.get('/api/export', (_req, res) => {
  const snapshot = {
    app: 'evidence-chain-orchestrator',
    version: 1,
    exportedAt: new Date().toISOString(),
    evidence: getEvidence(),
    edges: getEdges().map((e) => ({ from: e.fromId, to: e.toId })),
  };
  res.setHeader('Content-Disposition', 'attachment; filename="evidence-snapshot.json"');
  res.json(snapshot);
});

app.post('/api/import', (req, res) => {
  const body = req.body as { evidence?: unknown; edges?: unknown };
  if (!Array.isArray(body?.evidence) || !Array.isArray(body?.edges)) {
    return res.status(400).json({ message: '快照格式错误：需要 evidence 与 edges 数组' });
  }
  if (body.evidence.length > 2000 || body.edges.length > 10000) {
    return res.status(400).json({ message: '快照过大，已拒绝导入' });
  }

  const now = new Date().toISOString();
  const items: Evidence[] = [];
  const seen = new Set<string>();
  for (const raw of body.evidence as Array<Record<string, unknown>>) {
    const parsed = parseEvidenceInput(raw);
    if (!parsed.ok) return res.status(400).json({ message: `证据「${cleanString(raw?.title, 50) || '?'}」：${parsed.message}` });
    const id = typeof raw?.id === 'string' && raw.id ? raw.id.slice(0, 64) : crypto.randomUUID();
    if (seen.has(id)) return res.status(400).json({ message: `证据 id 重复：${id}` });
    seen.add(id);
    items.push({
      id,
      ...parsed.value,
      createdAt: typeof raw?.createdAt === 'string' ? raw.createdAt : now,
      updatedAt: now,
    });
  }

  const edges: Array<{ fromId: string; toId: string }> = [];
  const edgeSeen = new Set<string>();
  for (const raw of body.edges as Array<Record<string, unknown>>) {
    const fromId = raw?.from ?? raw?.fromId;
    const toId = raw?.to ?? raw?.toId;
    if (typeof fromId !== 'string' || typeof toId !== 'string' || !seen.has(fromId) || !seen.has(toId)) {
      return res.status(400).json({ message: '存在指向未知证据的连线，快照已拒绝' });
    }
    const key = `${fromId}->${toId}`;
    if (edgeSeen.has(key)) continue;
    edgeSeen.add(key);
    edges.push({ fromId, toId });
  }

  const cycle = findCycle(items.map((i) => i.id), edges);
  if (cycle) {
    return res.status(422).json({ message: '导入被拒绝：快照中存在循环依赖', cycle });
  }

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM edges').run();
    db.prepare('DELETE FROM evidence').run();
    const insE = db.prepare(
      'INSERT INTO evidence (id, title, description, source, occurred_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const it of items) insE.run(it.id, it.title, it.description, it.source, it.occurredAt, it.createdAt, it.updatedAt);
    const insX = db.prepare('INSERT INTO edges (from_id, to_id, created_at) VALUES (?, ?, ?)');
    for (const e of edges) insX.run(e.fromId, e.toId, now);
  });
  tx();
  res.json(buildState());
});

app.post('/api/seed', (_req, res) => {
  resetWithSample();
  res.json(buildState());
});

/* ---------- 静态资源与 SPA 回退 ---------- */

const CLIENT_DIST = process.env.CLIENT_DIST ?? path.join(__dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res.status(200).send('客户端尚未构建：请先运行 npm run build，或使用 npm run dev 启动开发模式。');
  });
}

app.use('/api', (_req, res) => res.status(404).json({ message: '接口不存在' }));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err && typeof err === 'object' && (err as { type?: string }).type === 'entity.parse.failed') {
    return res.status(400).json({ message: '请求体不是合法 JSON' });
  }
  console.error(err);
  res.status(500).json({ message: '服务器内部错误' });
});

/* ---------- 启动 ---------- */

seedIfEmpty();

const PORT = Number(process.env.PORT ?? 8080);
app.listen(PORT, () => {
  console.log(`[evidence-chain] 服务已启动: http://localhost:${PORT}`);
});
