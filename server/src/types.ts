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

export interface Candidate {
  /** 候选策略标识；工单 01 只有「保主体细节」一张。 */
  id: 'detail';
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
