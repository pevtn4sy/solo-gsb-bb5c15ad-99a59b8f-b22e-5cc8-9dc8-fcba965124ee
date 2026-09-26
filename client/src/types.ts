export interface Evidence {
  id: string;
  title: string;
  description: string;
  source: string;
  occurredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Edge {
  id: number;
  fromId: string;
  toId: string;
  createdAt: string;
}

export interface GraphState {
  evidence: Evidence[];
  edges: Edge[];
  levels: Record<string, number>;
  levelCount: number;
}

/** 一条冗余连线及其最短替代路径（传递约简分析结果） */
export interface RedundantEdge {
  edgeId: number;
  fromId: string;
  toId: string;
  /** 忽略该连线后，从 fromId 到 toId 的一条最短替代路径（节点 id 序列，含起终点） */
  path: string[];
}

/** 批量瘦身结果：最新全量状态 + 实际移除 / 被跳过的连线 id */
export interface PruneResult extends GraphState {
  pruned: number[];
  skipped: number[];
}

export interface EvidenceFormValues {
  title: string;
  description: string;
  source: string;
  occurredAt: string | null;
}

/** 顺序确定性查询的判定结论 */
export type OrderRelation = 'a-before-b' | 'b-before-a' | 'unconstrained';

/** 一个方向的见证布局：附加「firstId 必须早于 secondId」约束后的合法拓扑 */
export interface OrderWitness {
  firstId: string;
  secondId: string;
  /** 合法拓扑序（并列节点按创建时间、再按 id 稳定排序） */
  order: string[];
  /** 附加见证约束后的拓扑层级（仅用于临时预览画布布局） */
  levels: Record<string, number>;
  levelCount: number;
}

/** 顺序确定性查询结果 */
export interface OrderQueryResult {
  aId: string;
  bId: string;
  relation: OrderRelation;
  /** relation 为 a-before-b / b-before-a 时：从先到后的一条最短约束路径（含两端点） */
  path: string[] | null;
  /** relation 为 unconstrained 时：双向见证 */
  witnesses: { aFirst: OrderWitness; bFirst: OrderWitness } | null;
}
