# 规范 query 分析诊断

[English](README.md) | 中文

本显式运行的诊断比较历史 caller 算法与当前公开 `readSurface`、`traceEvent`。它不设置 CI 阈值，不访问真实 Harness 会话、profile 或 Host。

## 复现

需要 Node 24+、冻结依赖，以及本地 Git history 中脚本固定的 baseline 修订。在仓库根目录运行：

```sh
pnpm exec tsx packages/session-query/session-query/tests/query-analysis.perf.ts
```

[脚本](../query-analysis.perf.ts) 从 Git 提取固定历史修订的 tracing 实现，保留未改变的 `SessionCorpus.load` caller，并通过本 checkout 的 source paths 打包两种实现。编译、decorator 转换、模块启动、fixture（测试前置数据）构建与预热均不计时。每个样本在新的 plain Node 进程中以 `--expose-gc` 运行；worker 不打包构建依赖。两种 caller 使用相同的当前 core fold 实现；比较隔离历史 caller 与当前分析所有权，而不是重建完整历史 core。生成的 runtime、原始样本及合成持久化文件都位于包内被忽略的 `tmp/`，每个 worker 完成后删除其 fixture 文件。

## 负载与指标

fixture 包含 500 个完整活动：普通 user/assistant 消息、约 4 KiB 工具结果、引用诊断事件的 pruner replacement、带 source 引用的普通 append，以及每 25 个活动一次的 checkpoint。checkpoint 限制当前 surface 大小，原日志则持续增长。trace 目标是首个原工具结果，并追踪其 replacement chain。合成只读 provider 完整读取并 JSON 解析文件，再执行 `validateStoredEvents`；当前 cold query 还执行正常 Session 恢复。provider metadata 始终使用一个固定 revision。本记录量测 owner 的冷读取，不代表 OS page cache 冷状态、历史 migration、压缩 JSONL 或真实后端延迟。

每个阶段及操作分别取五个独立初始化的计时样本，交替执行 baseline/current。小型独立 owner 在量测前预热两种算法并检查输出一致。首次 cold 与首次 live 阶段计时一次 query。cold 重复与 live 静止阶段先 prime owner，再计时 40 次 query；live 持续 append 先 prime owner，再计时 40 组 producer append/query，包含 producer 成本。

- wall time 与进程 CPU time 不包含 profiler 或 clone 计数插桩。
- `retainedAddedBytes` 是 query 后 GC heap 减去 prime 前 GC heap，保留原始 fixture 与 owner，query 输出仅保留最后一份。`primedRetainedBytes` 标识重复 query 前已保留的状态。live append 还保留其新提交日志。
- `netHeapBeforeGcBytes` 是最终强制 GC 前的净 heap 增长，不是总分配量或峰值。
- 首样本的独立 pass 使用 V8 heap sampling，以 32 KiB 间隔估计分配字节，包含 minor/major GC 已回收对象。这是统计分配代理，不是精确分配计数。
- 另一个独立 pass 包装 `structuredClone`，计数来源事件与最终事件复制。JSON UTF-8 字节描述被复制输入的 payload 大小，不代表 V8 分配大小。最终响应字节包括 metadata 与 trace 数组。

## 记录结果

环境：Node v24.19.0，Linux 6.18.40.1-microsoft-standard-WSL2，x64，AMD Ryzen 7 7840HS，16 logical CPUs，13.50 GiB RAM。初始持久化 fixture 为 5,520 events / 3,515,252 JSON 字节；live owner 增加一条相同 seed boundary。采样期间没有同时运行 build 或测试命令。这是本机未隔离的工作站量测。

计时是每 query（或每 append/query 组合）的中位数，各取五个样本。CPU 是跨线程的进程 CPU，可能大于 wall time。

| 阶段 | query | wall ms baseline / current | CPU ms baseline / current |
| --- | --- | ---: | ---: |
| cold-first | surface | 95.38 / 84.92 | 144.06 / 142.93 |
| cold-first | trace | 94.45 / 84.72 | 140.68 / 149.28 |
| cold-repeat | surface | 63.95 / 0.13 | 71.09 / 0.41 |
| cold-repeat | trace | 56.16 / 0.10 | 63.34 / 0.31 |
| live-first | surface | 38.68 / 13.32 | 58.61 / 36.68 |
| live-first | trace | 42.90 / 14.76 | 66.17 / 37.83 |
| live-append | surface | 37.82 / 1.15 | 41.34 / 1.70 |
| live-append | trace | 36.49 / 0.66 | 40.01 / 1.17 |
| live-static | surface | 33.72 / 0.12 | 37.33 / 0.31 |
| live-static | trace | 35.74 / 0.08 | 39.60 / 0.27 |

保留与 GC 前 heap 是整个量测 batch 的中位数，**不是每 query 数值**；抽样分配量是一次独立 pass 的每 query 估计。KiB = 1,024 bytes。小幅负保留增量属于 GC/heap 噪声。

| 阶段 | query | 保留 KiB baseline / current | GC 前净 heap KiB baseline / current | 抽样分配 KiB/query baseline / current |
| --- | --- | ---: | ---: | ---: |
| cold-first | surface | -20.20 / 5024.75 | 6088.27 / 13387.19 | 33084.64 / 32143.97 |
| cold-first | trace | -10.53 / 5049.70 | 6561.96 / 13380.91 | 33690.48 / 30368.94 |
| cold-repeat | surface | 167.44 / 5112.48 | 47614.34 / 1552.67 | 31414.56 / 42.21 |
| cold-repeat | trace | 175.97 / 5070.45 | 47625.46 / 1033.91 | 31897.61 / 26.60 |
| live-first | surface | 14.22 / 931.35 | 14565.03 / 6135.51 | 14938.05 / 6337.31 |
| live-first | trace | 14.42 / 929.66 | 14929.32 / 6122.92 | 15297.41 / 6567.26 |
| live-append | surface | 621.20 / 1518.20 | 41841.00 / 882.36 | 14354.68 / 388.87 |
| live-append | trace | 534.00 / 1432.08 | 55430.00 / 9044.98 | 14412.12 / 201.30 |
| live-static | surface | 86.25 / 980.20 | 46307.41 / 1248.17 | 13291.32 / 28.13 |
| live-static | trace | 75.02 / 978.08 | 39601.13 / 686.88 | 13838.69 / 18.93 |

当前重复 cold owner 在 prime 后已保留 5,018–5,042 KiB。当前 live owner 在静止/append 量测开始前已保留 920–938 KiB。表格包括这些状态；append 在两侧都增加日志数据与分析边。

下表是整个量测 batch 的实际 structuredClone 次数。surface 与 trace 的来源事件复制量相同，两种算法的最终 surface 复制次数/字节相同。trace 不复制事件 payload，但仍新建 metadata/关系数组：静止 trace 每响应 415 JSON 字节，40 次 append trace 共 16,680 字节。其它 clone 次数见原始结果，包括 header 与 producer payload。

| 阶段 | query 次数 | baseline 来源复制次数 / JSON 字节 | current 来源复制次数 | 两种算法的最终 surface 复制次数 / JSON 字节 |
| --- | ---: | ---: | ---: | ---: |
| cold-first | 1 | 5,520 / 3,509,731 | 0 | 1 / 1,350 |
| cold-repeat | 40 | 220,800 / 140,389,240 | 0 | 40 / 54,000 |
| live-first | 1 | 5,521 / 3,509,800 | 0 | 1 / 1,350 |
| live-append | 40 | 229,876 / 146,131,460 | 0 | 1,720 / 871,740 |
| live-static | 40 | 220,840 / 140,392,000 | 0 | 40 / 54,000 |

最终 surface 响应 JSON 总字节：首次读取 1,508，重复/静止 batch 为 60,320，append batch 为 879,740。这是序列化响应体积，不是 heap 大小。每次运行的原始 JSON 报告保存机器 metadata、全部 100 个计时样本及独立诊断；命令会打印其路径。

## 解释

重复/静止 query 避免同一 cut 的完整日志工作；持续 append 的 producer-plus-query CPU 也从 surface 41.34 降至 1.70 ms、trace 40.01 降至 1.17 ms。这些 append 数值不能分离 query 成本。

首次 cold 仍需完整读取、解析、校验、fold 与恢复日志。当前首次 cold 的 surface CPU 接近 baseline，trace CPU 更高。wall 范围重叠：surface 为 89.81–144.04 对 70.58–166.17 ms；trace 为 86.88–123.52 对 70.10–118.82 ms。本记录不支持首次 cold 提速的结论。

复用以约 5 MiB 的 cold owner 或 0.9 MiB 的 live owner 保留状态，换取避免重复 payload 复制与解释。本 checkpoint 负载结束时只有一个 surface event；较大、未 checkpoint 的 surface 仍按最终事件体积支付复制成本。trace 仍分配最终 metadata 与关系数组。这些量测不构成部署保证。
