import type { Conflict } from '../App';

interface ConflictBannerProps {
  conflict: Conflict;
  titleOf: (id: string) => string;
  onClose: () => void;
}

export default function ConflictBanner({ conflict, titleOf, onClose }: ConflictBannerProps) {
  const isMerge = conflict.kind === 'merge';
  const chain = conflict.cycle.map(titleOf).join(' → ');
  return (
    <div className="toast conflict" role="alert">
      <div>
        <strong>⚠ 已拒绝{isMerge ? '合并' : '保存'}：{conflict.message}</strong>
        {isMerge && conflict.selfLoop ? (
          <div className="conflict-chain">
            冲突连线：<b>{chain}</b>（两张卡片之间已存在直接「必须早于」连线，合并后会变成卡片指向自己的自环）
          </div>
        ) : (
          <div className="conflict-chain">
            {isMerge ? '冲突路径' : '冲突闭环'}：<b>{chain}</b>
          </div>
        )}
        <div className="muted">
          {isMerge
            ? '合并会把两张卡片视为同一张，该路径首尾将重合为环，时间线无法成立。路径上的卡片与连线已标红，请先删除相关连线或改选卡片。'
            : '「必须早于」关系不能构成环，否则时间线无法成立。闭环中的卡片与连线已标红。'}
        </div>
      </div>
      <button className="toast-close" onClick={onClose} aria-label="关闭">
        ×
      </button>
    </div>
  );
}
