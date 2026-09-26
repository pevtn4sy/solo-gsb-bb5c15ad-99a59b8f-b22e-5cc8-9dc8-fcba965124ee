import type { Conflict } from '../App';

interface ConflictBannerProps {
  conflict: Conflict;
  titleOf: (id: string) => string;
  onClose: () => void;
}

export default function ConflictBanner({ conflict, titleOf, onClose }: ConflictBannerProps) {
  const chain = conflict.cycle.map(titleOf).join(' → ');
  return (
    <div className="toast conflict" role="alert">
      <div>
        <strong>⚠ 已拒绝保存：{conflict.message}</strong>
        <div className="conflict-chain">
          冲突闭环：<b>{chain}</b>
        </div>
        <div className="muted">「必须早于」关系不能构成环，否则时间线无法成立。闭环中的卡片与连线已标红。</div>
      </div>
      <button className="toast-close" onClick={onClose} aria-label="关闭">
        ×
      </button>
    </div>
  );
}
