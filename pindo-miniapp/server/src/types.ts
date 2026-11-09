export type PaletteTier = 'basic' | 'advanced';

export interface CandidateColor {
  code: string;
  name: string;
  hex: string;
}

export interface CandidateUsage {
  code: string;
  count: number;
}

/** 三候选策略：保主体细节 / 保色彩层次 / 保少色号，顺序固定。 */
export type CandidateId = 'detail' | 'color' | 'few';

/** 候选顺序的唯一来源，生成与埋点校验共用。 */
export const CANDIDATE_IDS: readonly CandidateId[] = ['detail', 'color', 'few'];

export interface Candidate {
  id: CandidateId;
  width: number;
  height: number;
  paletteTier: PaletteTier;
  /** 色号矩阵，行优先。 */
  grid: string[][];
  usage: CandidateUsage[];
  /** 本图纸用到的色号及其颜色信息，供端侧渲染。 */
  colors: CandidateColor[];
}

export type TaskStatus = 'queued' | 'processing' | 'completed' | 'failed';

export type TaskFailureCode = 'image-unsupported' | 'image-too-large' | 'internal';

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
}
