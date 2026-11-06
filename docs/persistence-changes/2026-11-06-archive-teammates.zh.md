---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-06-archive-teammates

[English](2026-11-06-archive-teammates.md) | 中文

## 概述

为持久化 Team 成员生命周期增加 archived，并保留不可变成员身份。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-archive-teammates
baseline: false
changes:
  - root: "event:team/member"
    previous: "2026-09-11-initial"
    after: "d4ad0a54d4e25bee3022571b82cc697f63c1ce55d6c5e02de897354e902c7023"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新读取器继续接受已有 provisioning、active 和 failed 成员事件。旧读取器通过严格 phase 解码器拒绝 archived，并让 Team 投影失败，不会误解为 active。team/member 判别值和事件版本不变；投影缓存版本 5 从日志重建旧 checkpoint。Session header 版本不变。

<a id="verification"></a>
## 验证

限定范围的 Team 服务、投影、持久化、工具、选模和客户端测试通过（168 项）。变异检查拒绝破坏名额、恢复、权限、任务释放、列表、schema、投影配置、默认折叠、导航和在岗计数的实现。

<a id="dev-note"></a>
## 开发备注

无。
