import boundaryModule from '../dist/boundary-scan.js';
import { resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'miniprogram');
const findings = await boundaryModule.scanMiniProgram(root);

if (findings.length > 0) {
  console.error('GPL 边界检查失败：小程序目录内发现引擎源码或编译产物');
  for (const finding of findings) console.error(`- ${finding.file}: ${finding.reason}`);
  process.exit(1);
}

console.log(`GPL 边界检查通过：${root} 内未发现引擎源码或编译产物`);
