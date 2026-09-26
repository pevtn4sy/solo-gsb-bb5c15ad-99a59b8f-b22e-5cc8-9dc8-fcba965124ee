import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from './api';
import Board from './components/Board';
import CardForm from './components/CardForm';
import ConflictBanner from './components/ConflictBanner';
import OrderQueryPanel from './components/OrderQueryPanel';
import PrunePanel from './components/PrunePanel';
import TimelinePanel from './components/TimelinePanel';
import type { Evidence, EvidenceFormValues, GraphState, OrderWitness, RedundantEdge } from './types';

export interface Conflict {
  cycle: string[];
  message: string;
  /** merge：重复证据合并被拒绝（cycle 为源卡与保留卡之间现存的冲突路径） */
  kind?: 'edge' | 'merge';
  selfLoop?: boolean;
}

/** 合并模式下的两张已选卡片 */
interface MergeSel {
  sourceId: string | null;
  targetId: string | null;
}

export default function App() {
  const [state, setState] = useState<GraphState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const [editing, setEditing] = useState<Evidence | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [mergeSel, setMergeSel] = useState<MergeSel | null>(null);
  const [redundant, setRedundant] = useState<RedundantEdge[]>([]);
  const [pruneFocus, setPruneFocus] = useState<RedundantEdge | null>(null);
  /** 顺序查询：画布上高亮的依据路径 / 正在预览的见证布局 */
  const [orderPath, setOrderPath] = useState<string[] | null>(null);
  const [orderPreview, setOrderPreview] = useState<OrderWitness | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .state()
      .then(setState)
      .catch(() => setError('无法连接服务器，请确认后端已启动'));
  }, []);

  /* 图状态每次变化后重新做传递约简分析，并取消可能已失效的瘦身高亮与顺序查询高亮/预览 */
  useEffect(() => {
    if (!state) return;
    setPruneFocus(null);
    setOrderPath(null);
    setOrderPreview(null);
    let alive = true;
    api
      .redundancy()
      .then((r) => {
        if (alive) setRedundant(r.redundant);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [state]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setLinkFrom(null);
        setEditing(null);
        setOrderPath(null);
        setOrderPreview(null);
        setMergeSel(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleApiError = useCallback((e: unknown, kind: Conflict['kind'] = 'edge') => {
    if (e instanceof ApiError && e.payload.cycle) {
      setConflict({
        cycle: e.payload.cycle,
        message: e.payload.message ?? e.message,
        kind,
        selfLoop: e.payload.selfLoop,
      });
      setError(null);
    } else {
      setError(e instanceof Error ? e.message : '操作失败');
    }
  }, []);

  /** 执行一次会改变图状态的操作；成功后清除冲突高亮、连线与合并模式 */
  const run = useCallback(
    async (fn: () => Promise<GraphState>, conflictKind: Conflict['kind'] = 'edge') => {
      setBusy(true);
      try {
        setState(await fn());
        setConflict(null);
        setLinkFrom(null);
        setMergeSel(null);
        setError(null);
      } catch (e) {
        handleApiError(e, conflictKind);
      } finally {
        setBusy(false);
      }
    },
    [handleApiError],
  );

  const connect = useCallback((fromId: string, toId: string) => run(() => api.createEdge(fromId, toId)), [run]);

  const submitCard = useCallback(
    async (values: EvidenceFormValues) => {
      if (editing === null) return;
      setBusy(true);
      try {
        setState(editing === 'new' ? await api.createEvidence(values) : await api.updateEvidence(editing.id, values));
        setEditing(null);
        setConflict(null);
        setError(null);
      } catch (e) {
        handleApiError(e);
      } finally {
        setBusy(false);
      }
    },
    [editing, handleApiError],
  );

  const deleteCard = useCallback(
    (ev: Evidence) => {
      if (!window.confirm(`删除证据「${ev.title}」？相关连线将一并删除。`)) return;
      void run(() => api.deleteEvidence(ev.id));
    },
    [run],
  );

  const deleteEdge = useCallback(
    (id: number) => {
      if (!window.confirm('删除这条「必须早于」连线？')) return;
      void run(() => api.deleteEdge(id));
    },
    [run],
  );

  const onImportFile = useCallback(
    async (file: File) => {
      let payload: unknown;
      try {
        payload = JSON.parse(await file.text());
      } catch {
        setError('导入失败：文件不是合法 JSON');
        return;
      }
      if (!window.confirm('导入将覆盖当前全部证据与连线，确定继续？')) return;
      await run(() => api.importSnapshot(payload));
    },
    [run],
  );

  const loadSample = useCallback(() => {
    if (!window.confirm('载入示例将覆盖当前全部数据，确定继续？')) return;
    void run(() => api.seed());
  }, [run]);

  /* 确认后批量移除：服务端在单个事务中复核并删除当前仍冗余的连线 */
  const pruneAll = useCallback(() => {
    if (redundant.length === 0) return;
    if (
      !window.confirm(
        `将移除 ${redundant.length} 条冗余连线。移除后所有证据间的先后可达关系保持不变，确定继续？`,
      )
    ) {
      return;
    }
    void run(() => api.pruneEdges(redundant.map((r) => r.edgeId)));
  }, [redundant, run]);

  /* ---------- 重复证据合并 ---------- */

  /** 点击卡片上的「合并」：进入合并模式并把该卡设为源卡（再次点击同一卡则退出） */
  const startMerge = useCallback(
    (sourceId: string) => {
      setConflict(null);
      setError(null);
      setLinkFrom(null);
      setMergeSel((cur) => (cur?.sourceId === sourceId && cur.targetId === null ? null : { sourceId, targetId: null }));
    },
    [],
  );

  /** 合并模式下点击画布卡片：依次选择源卡、保留卡；再次点击已选角色可取消 */
  const pickMerge = useCallback((id: string) => {
    setConflict(null);
    setMergeSel((cur) => {
      if (!cur) return cur;
      if (cur.sourceId === id) return { sourceId: null, targetId: cur.targetId };
      if (cur.targetId === id) return { sourceId: cur.sourceId, targetId: null };
      if (cur.sourceId === null) return { sourceId: id, targetId: cur.targetId };
      if (cur.targetId === null) return { sourceId: cur.sourceId, targetId: id };
      return cur;
    });
  }, []);

  const swapMerge = useCallback(() => {
    setMergeSel((cur) => (cur ? { sourceId: cur.targetId, targetId: cur.sourceId } : cur));
  }, []);

  /** 预览改接影响：模拟「源卡端点改接到保留卡 + 重复连线只留一条」后的连线集合 */
  const mergePreview = useMemo(() => {
    if (!state || !mergeSel?.sourceId || !mergeSel.targetId) return null;
    const s = mergeSel.sourceId;
    const t = mergeSel.targetId;
    const seen = new Set<string>();
    let rewired = 0;
    let duplicates = 0;
    for (const e of state.edges) {
      const touches = e.fromId === s || e.toId === s;
      const f = e.fromId === s ? t : e.fromId;
      const g = e.toId === s ? t : e.toId;
      const key = `${f}->${g}`;
      if (seen.has(key)) {
        if (touches) duplicates++;
        continue;
      }
      seen.add(key);
      if (touches) rewired++;
    }
    return { rewired, duplicates };
  }, [state, mergeSel]);

  const confirmMerge = useCallback(() => {
    if (!mergeSel?.sourceId || !mergeSel.targetId) return;
    const { sourceId, targetId } = mergeSel;
    const src = state?.evidence.find((e) => e.id === sourceId);
    const keep = state?.evidence.find((e) => e.id === targetId);
    if (!src || !keep) return;
    const dupNote = mergePreview && mergePreview.duplicates > 0 ? `其中 ${mergePreview.duplicates} 条重复连线将只保留一条。` : '';
    if (
      !window.confirm(
        `将把源卡片「${src.title}」合并进保留卡片「${keep.title}」：\n\n` +
          `· 源卡片的全部入边 / 出边（${mergePreview?.rewired ?? 0} 条）将改接到保留卡片；${dupNote}\n` +
          `· 合并完成后删除源卡片；\n` +
          `· 保留卡片的标题、来源、发生时间和描述保持不变。\n\n` +
          `确定合并？`,
      )
    ) {
      return;
    }
    void run(() => api.mergeEvidence(sourceId, targetId), 'merge');
  }, [mergeSel, state, mergePreview, run]);

  const titleOf = useCallback(
    (id: string) => state?.evidence.find((e) => e.id === id)?.title ?? id.slice(0, 8),
    [state],
  );

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">⛓</span>
          <div>
            <h1>事故证据链编排器</h1>
            <p>用「必须早于」约束编排证据，自动推演可解释时间线</p>
          </div>
        </div>
        <div className="toolbar">
          <button className="btn primary" onClick={() => setEditing('new')} disabled={busy}>
            ＋ 新增证据
          </button>
          <button className="btn" onClick={() => fileRef.current?.click()} disabled={busy}>
            导入 JSON
          </button>
          <a className="btn" href="/api/export" download="evidence-snapshot.json">
            导出 JSON
          </a>
          <button className="btn" onClick={loadSample} disabled={busy}>
            载入示例
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onImportFile(f);
              e.target.value = '';
            }}
          />
        </div>
      </header>

      {error && (
        <div className="toast error" role="alert">
          <span>⚠ {error}</span>
          <button className="toast-close" onClick={() => setError(null)} aria-label="关闭">
            ×
          </button>
        </div>
      )}

      {conflict && <ConflictBanner conflict={conflict} titleOf={titleOf} onClose={() => setConflict(null)} />}

      {mergeSel && state && (
        <div className="merge-banner">
          <div className="merge-banner-main">
            <strong>重复证据合并</strong>
            <span className="merge-row">
              {mergeSel.sourceId ? (
                <>
                  ① 源卡片（合并后删除）：<b className="ms">{titleOf(mergeSel.sourceId)}</b>
                </>
              ) : (
                <span className="muted">① 点击一张卡片作为源卡片（将被合并删除）</span>
              )}
            </span>
            <span className="merge-row">
              {mergeSel.targetId ? (
                <>
                  ② 保留卡片（标题 / 来源 / 时间 / 描述不变）：<b className="mt">{titleOf(mergeSel.targetId)}</b>
                </>
              ) : (
                <span className="muted">② 点击另一张卡片作为保留卡片</span>
              )}
            </span>
            {mergeSel.sourceId && mergeSel.targetId && mergePreview && (
              <span className="muted">
                将把源卡片的 {mergePreview.rewired} 条入 / 出边改接到保留卡片
                {mergePreview.duplicates > 0 ? `，${mergePreview.duplicates} 条重复连线只保留一条` : ''}，随后删除源卡片。
              </span>
            )}
          </div>
          <div className="merge-banner-actions">
            <button type="button" className="btn" onClick={swapMerge} disabled={!mergeSel.sourceId || !mergeSel.targetId || busy} title="交换源卡片与保留卡片">
              ⇄ 对调
            </button>
            <button type="button" className="btn" onClick={() => setMergeSel(null)} disabled={busy}>
              取消
            </button>
            <button type="button" className="btn danger-solid" onClick={confirmMerge} disabled={busy || !mergeSel.sourceId || !mergeSel.targetId}>
              确认合并
            </button>
          </div>
        </div>
      )}

      {state && (
        <PrunePanel
          redundant={redundant}
          focus={pruneFocus}
          busy={busy}
          titleOf={titleOf}
          onFocus={setPruneFocus}
          onPruneAll={pruneAll}
        />
      )}

      {state && (
        <OrderQueryPanel
          state={state}
          highlightPath={orderPath}
          preview={orderPreview}
          titleOf={titleOf}
          onHighlightPath={setOrderPath}
          onPreview={setOrderPreview}
        />
      )}

      {orderPreview && (
        <div className="preview-banner">
          <span>
            正在预览见证布局：假设「{titleOf(orderPreview.firstId)}」<b>必须早于</b>「{titleOf(orderPreview.secondId)}」
            （青色虚线为临时见证约束，仅前端预览，不会写入数据库，Esc 退出）
          </span>
          <button className="btn small" onClick={() => setOrderPreview(null)}>
            退出预览
          </button>
        </div>
      )}

      {linkFrom && state && (
        <div className="link-hint">
          连线模式：点击另一张卡片，使「{titleOf(linkFrom)}」<b>必须早于</b>它（Esc 取消）
        </div>
      )}

      <main className="main">
        {state ? (
          <>
            <Board
              state={state}
              conflict={conflict}
              linkFrom={linkFrom}
              pruneFocus={pruneFocus}
              orderPath={orderPath}
              preview={orderPreview}
              mergeSel={mergeSel}
              onStartLink={setLinkFrom}
              onCancelLink={() => setLinkFrom(null)}
              onConnect={connect}
              onMergeStart={startMerge}
              onMergeCancel={() => setMergeSel(null)}
              onMergePick={pickMerge}
              onEdit={setEditing}
              onDelete={deleteCard}
              onDeleteEdge={deleteEdge}
            />
            <TimelinePanel state={state} />
          </>
        ) : (
          <div className="loading">加载中…</div>
        )}
      </main>

      {editing !== null && (
        <CardForm
          initial={editing === 'new' ? null : editing}
          busy={busy}
          onSubmit={submitCard}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
