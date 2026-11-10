# Context Map

## Contexts

- [拼豆图纸生成小程序（完整版）](./CONTEXT.md) — 含生成式 AI 风格与会员权益的能力全集，代码在 `pindo-miniapp`
- [无广告免费版](../preXCX/CONTEXT.md) — 当前唯一对外运行的版本，代码在 `preXCX`

## Relationships

- 免费版从完整版 fork（见 [ADR 0005](../preXCX/docs/adr/0005-free-version-as-standalone-line.md)）。两者共享同一份领域语言，但免费版只收录其运行所需的词：不含高级风格、291 进阶色卡档与会员权益词。
- 代码关系：`preXCX` 为主线，`pindo-miniapp` 为完整版参照，互不同步。
