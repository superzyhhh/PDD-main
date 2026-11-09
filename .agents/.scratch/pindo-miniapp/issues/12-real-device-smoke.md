# 12 — 真机冒烟（待解决）

**What to verify:** 在真实微信设备上跑通「选图上传 → 云端抠图/减色/色号映射 → 29×29 图纸预览」整条链路，确认 canvas 渲染、错误提示与重试在真机可用。

**Blocked by:** 02–11（功能开发完成后统一测试）；外部条件见下

**Status:** needs-info（暂时挂起，不做实现，等条件齐备后一次性执行）

## 当前阻塞

- 本机未安装微信开发者工具，agent 无法安装/登录（需用户本人操作）。
- `project.config.json` 中仍是 `touristappid`，游客态无法扫码真机调试，需真实小程序 AppID。
- 真机要求手机与电脑同一局域网，且能访问 `http://10.15.0.79:3000`。

## 已就绪

- [x] [config.js](file:///d:/PDD/pindo-miniapp/miniprogram/utils/config.js) 的 `BASE_URL` 已指向 `http://10.15.0.79:3000`
- [x] 服务端在 3000 端口运行，`/healthz` 返回 `{"ok":true}`，局域网可达
- [x] 服务端侧端到端冒烟已完成：熊猫 333ms/19 色、狐狸 297ms/53 色，841 颗且全部在 221 档，预览见 `d:/PDD/pindo-smoke/`

## 执行前置步骤

1. 将真实小程序 AppID 写入 `d:/PDD/pindo-miniapp/miniprogram/project.config.json` 的 `appid`
2. 微信开发者工具导入 `d:/PDD/pindo-miniapp/miniprogram`，勾选「不校验合法域名、web-view、TLS 版本以及 HTTPS 证书」
3. 手机与电脑同网段；必要时管理员放行 3000 端口：
   `New-NetFirewallRule -DisplayName "pindo-dev" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow`
4. 开发者工具「真机调试」扫码

## 冒烟清单

- [ ] 冷启动静默登录成功，未出现登录阻断
- [ ] 选图上传后 30s 内出现 29×29 预览，格网、色块、色号标注可辨认
- [ ] 所有色号都在 MARD 221 档内
- [ ] 非图片/超大图片返回可读原因，不暴露技术错误码
- [ ] 断网或超时（30s）后出现重试入口，重试复用同一任务、不重复生成
- [ ] 命中内容安全时提示「换张图」，服务端有 `content_blocked` audit 记录
- [ ] iOS 上不出现虚拟商品购买入口（当前版本无购买入口，确认无违规引导）

## 重点观察

- 白底白色主体（如熊猫）边缘会被抖动打散成中间灰，需结合工单 02「保少色号」候选一起判断
- 真机 DPR 下 canvas 上 10px 色号文字是否清晰、是否需放大格尺寸
- 弱网下 800ms 轮询与 30s 超时的交互提示是否明显

## 记录模板

| 项 | 填写 |
| --- | --- |
| 设备型号 / 系统 | |
| 微信版本 | |
| 网络（同网段 / 热点） | |
| 用例与结果 | |
| 问题截图 | |

完成后回填工单 [01](file:///d:/PDD/.agents/.scratch/pindo-miniapp/issues/01-upload-to-first-pattern.md) 中「canvas 观感待真机冒烟」一项。
