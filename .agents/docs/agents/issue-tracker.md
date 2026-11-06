# Issue tracker: Local Markdown

本仓库的规格与工单以 Markdown 文件形式存放，不使用远端 tracker。

## 约定

- 一个特性一个目录：`.scratch/<feature-slug>/`
- 规格：`.scratch/<feature-slug>/spec.md`
- 工单：一单一文件，`.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 编号，绝不合成为单个 tickets 文件
- 分诊状态写在各工单文件靠上的 `Status:` 行（取值见 `triage-labels.md`）
- 评论与对话历史追加到文件末尾的 `## Comments` 标题下

## 当技能要求「发布到 issue tracker」

在 `.scratch/<feature-slug>/` 下新建文件，必要时创建目录。

## 当技能要求「取出相关工单」

直接读取被引用的文件。用户通常会直接给路径或工单编号。

## Wayfinding 操作

供 `wayfinder` 使用。**地图**是一份文件，每个工单对应一个子文件。

- **地图**：`.scratch/<effort>/map.md`（含 Notes / Decisions-so-far / Fog 正文）。
- **子工单**：`.scratch/<effort>/issues/NN-<slug>.md`，从 `01` 编号，问题写在正文。`Type:` 行记录工单类型（`research`/`prototype`/`grilling`/`task`）；`Status:` 行记录 `claimed`/`resolved`。
- **阻塞**：靠上的 `Blocked by: NN, NN` 行。所列文件全部 `resolved` 时才算解锁。
- **前沿**：扫描 `.scratch/<effort>/issues/` 中未关闭、未被阻塞、未被认领的文件；编号最小者优先。
- **认领**：动手前先写 `Status: claimed` 并保存。
- **解决**：在 `## Answer` 标题下追加答案，写 `Status: resolved`，再把上下文指针（要点 + 链接）追加到 `map.md` 的 Decisions-so-far。
