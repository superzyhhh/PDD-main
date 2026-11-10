import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Node fetch（undici）按规范拒绝连接的端口。Windows 的动态端口范围可能从 1024 起，
 * listen(0) 有概率撞上这些端口，导致测试偶发 `fetch failed: bad port`。
 */
const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103,
  104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513,
  514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
  1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);

/** 在回环地址上监听随机端口，跳过 fetch 明确禁用的端口，避免测试偶发 `bad port`。 */
export async function listenOnRandomPort(server: Server): Promise<void> {
  for (;;) {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const { port } = server.address() as AddressInfo;
    if (!FETCH_BLOCKED_PORTS.has(port)) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
