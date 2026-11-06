import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

export interface BoundaryFinding {
  file: string;
  reason: string;
}

/** 引擎特征：一旦出现在小程序目录，说明 GPL 覆盖代码被下沉到端侧。 */
const ENGINE_SIGNATURES = [
  'ciede2000',
  'srgbToLinear',
  'linearToSrgb',
  'downscaleEdgeAware',
  'cropToSubject',
  'matchColor',
  'applyDithering',
  'limitPaletteWithKeyColors',
  'CompiledBeadColor',
  'pindo-engine',
  'GNU GENERAL PUBLIC LICENSE',
];

const FORBIDDEN_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

/**
 * ADR-0001 的 CI 检查：小程序产物不得包含任何来自云端的引擎源码或编译产物。
 */
export async function scanMiniProgram(root: string): Promise<BoundaryFinding[]> {
  const findings: BoundaryFinding[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'vendor') {
          findings.push({ file: full, reason: `禁止的目录：${entry.name}` });
          continue;
        }
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;

      const extension = extname(entry.name).toLowerCase();
      if (FORBIDDEN_EXTENSIONS.has(extension)) {
        findings.push({ file: full, reason: `小程序内不得出现 TypeScript 源文件（${extension}）` });
        continue;
      }

      const text = await readFile(full, 'utf8').catch(() => '');
      for (const signature of ENGINE_SIGNATURES) {
        if (text.includes(signature)) findings.push({ file: full, reason: `出现引擎特征：${signature}` });
      }
      if (/require\s*\(\s*['"][^'"]*server[^'"]*['"]\s*\)|from\s+['"][^'"]*server[^'"]*['"]/.test(text)) {
        findings.push({ file: full, reason: '引用了服务端代码' });
      }
    }
  }

  await walk(root);
  return findings;
}
