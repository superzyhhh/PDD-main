import { randomUUID } from 'node:crypto';
import type { Candidate, CandidateId } from './types';

/** 内存中保留的分享记录上限；超出后淘汰最早的分享。 */
export const MAX_SHARES = 500;

/** 原生分享入口：右上角菜单或页面按钮。 */
export const SHARE_SOURCES = ['menu', 'button'] as const;
export type ShareSource = (typeof SHARE_SOURCES)[number];

export interface ShareInput {
  taskId: string;
  candidateId: CandidateId;
  source: ShareSource;
  /** 创建分享时复制候选快照，接收者只看这一张，也不受原图纸删除影响。 */
  candidate: Candidate;
  openId?: string;
}

export interface ShareRecord extends ShareInput {
  id: string;
  createdAt: number;
  openCount: number;
}

/** 分享记录只用于统计与公开查看；不保存原图或生成参数。 */
export class ShareStore {
  private readonly records: ShareRecord[] = [];

  create(input: ShareInput): ShareRecord {
    const record: ShareRecord = {
      ...input,
      // 快照必须与任务表隔离，避免后续任务更新改到已分享的图纸。
      candidate: structuredClone(input.candidate),
      id: randomUUID(),
      createdAt: Date.now(),
      openCount: 0,
    };
    this.records.push(record);
    while (this.records.length > MAX_SHARES) this.records.shift();
    return record;
  }

  get(id: string): ShareRecord | undefined {
    return this.records.find((record) => record.id === id);
  }

  /** 打开分享页时计数；同一个链接重复打开都算一次（按打开次数统计，不去重）。 */
  openAndCount(id: string): ShareRecord | undefined {
    const record = this.get(id);
    if (record) record.openCount += 1;
    return record;
  }

  list(limit: number): ShareRecord[] {
    return this.records.slice(-limit).reverse();
  }

  get total(): number {
    return this.records.length;
  }
}
