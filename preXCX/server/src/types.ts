import type { AdvancedSettings } from './advanced-settings';
import type { StyleId } from './style';

export const SIZE_TIERS = ['small', 'medium', 'large'] as const;

export type SizeTier = (typeof SIZE_TIERS)[number];

export interface CandidateColor {
  code: string;
  name: string;
  hex: string;
}

export interface CandidateUsage {
  code: string;
  count: number;
}

/** 材料包清单的一行：按色号核对用量并换算整包数。 */
export interface CandidateMaterial {
  code: string;
  name: string;
  hex: string;
  count: number;
  /** 按每包 1000 颗换算的整包数。 */
  packages: number;
}

/** 三候选策略：保主体细节 / 保色彩层次 / 保少色号，顺序固定。 */
export type CandidateId = 'detail' | 'color' | 'few';

/** 候选顺序的唯一来源，生成与埋点校验共用。 */
export const CANDIDATE_IDS: readonly CandidateId[] = ['detail', 'color', 'few'];

export interface Candidate {
  id: CandidateId;
  width: number;
  height: number;
  /** 拼板数，按 29 格一块板换算。 */
  boardCount: number;
  /** 色号矩阵，行优先。 */
  grid: string[][];
  usage: CandidateUsage[];
  /** 本图纸用到的色号及其颜色信息，供端侧渲染。 */
  colors: CandidateColor[];
  /** 材料包清单，顺序与 usage 一致。 */
  materials: CandidateMaterial[];
}

export type TaskStatus = 'queued' | 'processing' | 'completed' | 'failed';

export type TaskFailureCode =
  | 'image-unsupported'
  | 'image-too-large'
  | 'style-failed'
  | 'style-blocked'
  | 'internal';

export interface TaskFailure {
  code: TaskFailureCode;
  /** 面向用户的中文提示，客户端直接展示。 */
  message: string;
}

export interface TaskView {
  taskId: string;
  status: TaskStatus;
  candidates?: Candidate[];
  failure?: TaskFailure;
  /** 登录用户生成完成后的保存结果；未登录或保存失败时不存在。 */
  savedPattern?: SavedPattern;
  /** 本次生成实际应用的高级设置，用于客户端明确反馈。 */
  settings?: AdvancedSettings;
  /** 本次生成实际使用的风格；非原图表示经过了风格转换。 */
  style?: StyleId;
  /** 展示名，供客户端直接回显。 */
  styleLabel?: string;
}

/** 「我的图纸」保存结果；evictedCount 用于提示用户旧图已被清理。 */
export interface SavedPattern {
  id: string;
  evictedCount: number;
}

/** 列表页摘要，不含逐格色号矩阵。 */
export interface PatternSummary {
  id: string;
  taskId: string;
  candidateId: CandidateId;
  width: number;
  height: number;
  boardCount: number;
  colorCodeCount: number;
  /** 首次保存时间，ISO 字符串。 */
  createdAt: string;
}
