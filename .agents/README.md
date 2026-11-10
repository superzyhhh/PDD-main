# 工程技能组使用指南（skills/）

> 给 agent 的入口文档：**先读本文件定位技能，再只读那一个 `SKILL.md`**。不要一次性通读全部技能，也不要预先加载参考文档。

## 1. 这是什么

`skills/` 是一组 **Markdown 形式的技能**（指令 + 参考知识），不是可执行代码。一个技能 = `skills/<name>/SKILL.md`（含 `name` / `description` frontmatter）+ 可选同目录参考文档。

本仓库已完成初始化，**通常不需要再运行 `setup-matt-pocock-skills`**：

- `AGENTS.md` 记录了 issue tracker、分诊标签、领域文档三条配置
- `docs/agents/issue-tracker.md`：本地 Markdown tracker（`.scratch/`）
- `docs/agents/triage-labels.md`：五个分诊标签
- `docs/agents/domain.md`：`CONTEXT.md` + `docs/adr/` 的消费规则

## 2. 调用约定

本仓库的技能**没有注册为平台技能**，所以“调用”= 用 Read 打开对应文件并照做：

| 用户说法 | 实际操作 |
| --- | --- |
| 输入 `/tdd`、`/triage`，或“用 /xxx” | Read `skills/<name>/SKILL.md` |
| SKILL.md 里写“调用 `/yyy`” | Read `skills/yyy/SKILL.md` |
| 任务命中某技能的触发场景 | 读该技能的 `SKILL.md`（仅限下表的“可自主触发”） |
| 需要参考文档 | 只读该 `SKILL.md` 里指向的那一个文件 |

两类技能，区别在是否需要用户点名：

- **可自主触发**（frontmatter 无 `disable-model-invocation`）：`grilling`、`tdd`、`code-review`、`codebase-design`、`domain-modeling`。命中触发场景可直接读。
- **仅显式调用**（`disable-model-invocation: true`）：`wayfinder`、`grill-with-docs`、`to-spec`、`to-tickets`、`triage`、`implement`、`improve-codebase-architecture`、`setup-matt-pocock-skills`、`writing-great-skills`。用户没点名时不要自行启动，可以在回复里建议。

典型加载流程（以“把需求落成工单”为例）：

```
1. 读 skills/README.md（本文件）→ 定位到 to-tickets
2. Read skills/to-tickets/SKILL.md
3. 需要 tracker 约定 → Read docs/agents/issue-tracker.md
4. 需要领域词汇 → Read CONTEXT.md（及该领域的 docs/adr/*.md）
5. 不读 setup 模板，不读其他技能
```

## 3. 速查：现在要做什么 → 用哪个技能

| 场景 | 技能 | 产出 / 落点 |
| --- | --- | --- |
| 想法太大，看不清怎么走到目的地 | `wayfinder` | `.scratch/<effort>/map.md` + 决策工单 |
| 把方案拷问到清楚，并顺手沉淀文档 | `grill-with-docs`（= `grilling` + `domain-modeling`） | `CONTEXT.md`、新 ADR |
| 只想受压提问，不写文档 | `grilling` | 无文件，按轮问答 |
| 对话已聊清楚，要落成规格 | `to-spec` | `.scratch/<feature>/spec.md` |
| 规格拆成可独立交付的小工单 | `to-tickets` | `.scratch/<feature>/issues/NN-*.md` |
| 按 spec / 工单写代码 | `implement`（内含 `tdd`，收尾 `code-review`） | 代码 + 测试 + 提交 |
| 测试先行做功能或修 bug | `tdd` | 测试与最小实现 |
| 审分支 / PR / 在途改动 | `code-review` | Standards + Spec 双轴报告 |
| 找架构改进点（浅模块变深模块） | `improve-codebase-architecture` | 临时目录中的 HTML 报告 |
| 设计模块接口、决定 seam 放哪 | `codebase-design` | 只提供词汇与原则 |
| 维护 `CONTEXT.md` / ADR | `domain-modeling` | `CONTEXT.md`、`docs/adr/` |
| 收件箱 issue 分类、写 agent brief | `triage` | 标签 + brief；`.out-of-scope/` |
| 写或改技能本身 | `writing-great-skills` | 技能文件 |
| 更换 tracker / 重启配置 | `setup-matt-pocock-skills` | `docs/agents/*`（一次性） |

## 4. 标准流水线

```
wayfinder（只做规划，不做交付）
  └─→ grill-with-docs（grilling + domain-modeling）→ 更新 CONTEXT.md / ADR
       └─→ to-spec → .scratch/<feature>/spec.md
            └─→ to-tickets → .scratch/<feature>/issues/NN-*.md
                 └─→ implement（内含 tdd，收尾 code-review）→ 提交到当前分支

分诊旁路：triage → ready-for-agent + agent brief → implement
架构旁路：improve-codebase-architecture → 选中候选 → grilling → 决策 → 回到 to-tickets
```

## 5. 本仓库的落点约定

| 位置 | 作用 |  |
| --- | --- | --- |
| `CONTEXT.md` | 领域术语表（唯一语言来源） |      |
| `docs/adr/NNNN-*.md` | 架构决策记录 |      |
| `docs/agents/*.md` | tracker / 标签 / 领域文档规则 |  |
| `.scratch/<feature>/spec.md` | 规格 |      |
| `.scratch/<feature>/issues/NN-<slug>.md` | 工单，一工单一文件，按依赖顺序编号 |      |
| `.scratch/<effort>/map.md` | wayfinder 的地图 |  |
| `.out-of-scope/<concept>.md` | 被拒需求的沉淀 |  |

```

```
