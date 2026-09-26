import { useCallback, useEffect, useRef, useState } from 'react';
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
}

export default function App() {
  const [state, setState] = useState<GraphState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const [editing, setEditing] = useState<Evidence | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
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
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleApiError = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.payload.cycle) {
      setConflict({ cycle: e.payload.cycle, message: e.payload.message ?? e.message });
      setError(null);
    } else {
      setError(e instanceof Error ? e.message : '操作失败');
    }
  }, []);

  /** 执行一次会改变图状态的操作；成功后清除冲突高亮与连线模式 */
  const run = useCallback(
    async (fn: () => Promise<GraphState>) => {
      setBusy(true);
      try {
        setState(await fn());
        setConflict(null);
        setLinkFrom(null);
        setError(null);
      } catch (e) {
        handleApiError(e);
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
              onStartLink={setLinkFrom}
              onCancelLink={() => setLinkFrom(null)}
              onConnect={connect}
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
