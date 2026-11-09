import { randomUUID } from 'node:crypto';
import { DEFAULT_ADVANCED_SETTINGS, type AdvancedSettings } from './advanced-settings';
import type {
  Candidate,
  PaletteTier,
  SavedPattern,
  SizeTier,
  TaskFailure,
  TaskFailureCode,
  TaskStatus,
  TaskView,
} from './types';

interface TaskRecord {
  id: string;
  contentKey: string;
  openId?: string;
  status: TaskStatus;
  candidates?: Candidate[];
  failure?: TaskFailure;
  savedPattern?: SavedPattern;
  sizeTier?: SizeTier;
  paletteTier?: PaletteTier;
  settings?: AdvancedSettings;
  createdAt: number;
}

/** 创建任务时一并保存的生成参数，便于回显与失败样本留档。 */
export interface TaskMeta {
  sizeTier: SizeTier;
  paletteTier: PaletteTier;
  settings: AdvancedSettings;
}

const MAX_TASKS = 200;

/** 进程内任务表 + 按内容寻址的复用缓存；同一张图同一组参数只算一次。 */
export class TaskStore {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly byContent = new Map<string, string>();

  create(contentKey: string, openId?: string, meta?: TaskMeta): TaskRecord {
    const record: TaskRecord = {
      id: randomUUID(),
      contentKey,
      openId,
      status: 'queued',
      sizeTier: meta?.sizeTier,
      paletteTier: meta?.paletteTier,
      settings: meta?.settings,
      createdAt: Date.now(),
    };
    this.tasks.set(record.id, record);
    this.byContent.set(contentKey, record.id);
    this.evictIfNeeded();
    return record;
  }

  /** 已有结果或正在处理的同内容任务可直接复用；失败任务不复用，允许重试。 */
  findReusable(contentKey: string): TaskRecord | undefined {
    const id = this.byContent.get(contentKey);
    if (!id) return undefined;
    const record = this.tasks.get(id);
    if (!record || record.status === 'failed') return undefined;
    return record;
  }

  /** 任务归属的 openId；用于校验埋点调用方与任务所有者一致。 */
  ownerOf(id: string): string | undefined {
    return this.tasks.get(id)?.openId;
  }

  setSavedPattern(id: string, saved: SavedPattern): void {
    const record = this.tasks.get(id);
    if (record) record.savedPattern = saved;
  }

  /** 任务创建时的生成参数与结果快照；用于失败样本留档。 */
  taskMeta(id: string): (TaskMeta & { openId?: string; status: TaskStatus; candidates?: Candidate[] }) | undefined {
    const record = this.tasks.get(id);
    if (!record) return undefined;
    return {
      openId: record.openId,
      status: record.status,
      sizeTier: record.sizeTier ?? 'small',
      paletteTier: record.paletteTier ?? 'basic',
      settings: record.settings ?? DEFAULT_ADVANCED_SETTINGS,
      candidates: record.candidates,
    };
  }

  markProcessing(id: string): void {
    const record = this.tasks.get(id);
    if (record && record.status === 'queued') record.status = 'processing';
  }

  complete(id: string, candidates: Candidate[]): void {
    const record = this.tasks.get(id);
    if (!record) return;
    record.status = 'completed';
    record.candidates = candidates;
  }

  fail(id: string, code: TaskFailureCode, message: string): void {
    const record = this.tasks.get(id);
    if (!record) return;
    record.status = 'failed';
    record.failure = { code, message };
  }

  toView(id: string): TaskView | undefined {
    const record = this.tasks.get(id);
    if (!record) return undefined;
    const view: TaskView = { taskId: record.id, status: record.status };
    if (record.candidates) view.candidates = record.candidates;
    if (record.failure) view.failure = record.failure;
    if (record.savedPattern) view.savedPattern = record.savedPattern;
    if (record.settings) view.settings = record.settings;
    return view;
  }

  private evictIfNeeded(): void {
    if (this.tasks.size <= MAX_TASKS) return;
    const oldest = [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!oldest) return;
    this.tasks.delete(oldest.id);
    if (this.byContent.get(oldest.contentKey) === oldest.id) this.byContent.delete(oldest.contentKey);
  }
}
