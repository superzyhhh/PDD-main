import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { scanMiniProgram } from '../src/boundary-scan';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

describe('GPL 边界检查', () => {
  it('真实小程序目录不含任何引擎源码或编译产物', async () => {
    const findings = await scanMiniProgram(resolve(process.cwd(), 'miniprogram'));
    expect(findings).toEqual([]);
  });

  it('能识别被拷入小程序目录的引擎代码', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pindo-boundary-'));
    tempDirs.push(dir);
    await mkdir(join(dir, 'pages'));
    await writeFile(join(dir, 'pages', 'fake.js'), 'function ciede2000(a, b) { return 0; }\n');
    await writeFile(join(dir, 'compiled.ts'), 'export const x = 1;\n');

    const findings = await scanMiniProgram(dir);
    expect(findings).toHaveLength(2);
    expect(findings.some((item) => item.reason.includes('ciede2000'))).toBe(true);
    expect(findings.some((item) => item.reason.includes('.ts'))).toBe(true);
  });
});
