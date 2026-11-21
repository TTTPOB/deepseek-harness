# Canonical query analysis diagnostics

English | [中文](README.zh.md)

This opt-in diagnostic compares the historical caller algorithm with current public `readSurface` and `traceEvent`. It sets no CI thresholds and accesses no real Harness sessions, profiles, or Host.

## Reproduce

Requires Node 24+, frozen dependencies, and the script-pinned baseline revision in local Git history. Run from the repository root:

```sh
pnpm exec tsx packages/session-query/session-query/tests/query-analysis.perf.ts
```

The [script](../query-analysis.perf.ts) extracts the pinned historical tracing implementation from Git, retains the unchanged `SessionCorpus.load` caller, and bundles both implementations against this checkout's source paths. Compilation, decorator transformation, module startup, fixture construction, and warm-up are outside the timed segment. Each sample runs in a fresh plain Node process with `--expose-gc`; build dependencies are external to the worker. Both callers use the same current core folding implementation; the comparison isolates historical caller versus current analysis ownership, not a complete historical-core rebuild. Generated runtime, raw samples, and synthetic persistence files live under the package's ignored `tmp/`; fixture files are removed after each worker completes.

## Workload and measurements

The fixture contains 500 complete activities with ordinary user and assistant messages, approximately 4 KiB tool results, pruner replacements citing diagnostic events, ordinary source-citing appends, and checkpoints every 25 activities. Checkpoints bound the current surface while the raw log continues growing. The trace targets the first original tool result and follows its replacement chain. A synthetic read-only provider reads and JSON-parses the complete file, then uses `validateStoredEvents`; the current cold query additionally performs its normal Session restoration. Provider metadata has one fixed revision. This measures owner-cold reads, not cold OS page caches, historical migrations, compressed JSONL, or actual backend latency.

Each phase and operation has five independently initialized timing samples, alternating baseline/current order. Small independent owners warm both algorithms and check equal output before sampling. First cold and first live phases time one query. Repeated cold and static live phases prime the owner, then time 40 queries; continuous live append primes the owner, then times 40 producer-append/query pairs, including producer cost.

- Wall time and process CPU time exclude profiling and clone instrumentation.
- `retainedAddedBytes` measures GC-after-query heap minus GC-before-prime heap, with the original fixture and owner retained, and only the last query output kept alive. `primedRetainedBytes` identifies state already retained before repeated queries. Live append also retains its newly committed log.
- `netHeapBeforeGcBytes` is net heap growth before the final forced GC, not total allocation or a peak.
- A separate first-sample pass estimates allocated bytes with V8 heap sampling at a 32 KiB interval, including objects collected by minor and major GC. This is a statistical allocation proxy, not exact allocation accounting.
- Another separate pass wraps `structuredClone`, counting source-event and final-event copies. JSON UTF-8 bytes describe copied input payload size, not V8 allocation size. Final response bytes include metadata and trace arrays.

## Recorded results

Recorded on Node v24.19.0, Linux 6.18.40.1-microsoft-standard-WSL2, x64, AMD Ryzen 7 7840HS, 16 logical CPUs, 13.50 GiB RAM. The initial persisted fixture is 5,520 events / 3,515,252 JSON bytes; live owners add one identical seed boundary. No competing build or test command ran during sampling. This is a local, non-isolated workstation measurement.

Timing values are medians per query (or per append/query pair), from five samples each. CPU is process CPU across threads, so it can exceed wall time.

| Phase | Query | Wall ms baseline / current | CPU ms baseline / current |
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

Retained and pre-GC heap values are medians for the entire measured batch, **not per-query values**; the allocation estimate is per query from one separate sampled pass. KiB = 1,024 bytes. Small negative retained deltas are GC/heap noise.

| Phase | Query | Retained KiB baseline / current | Net pre-GC heap KiB baseline / current | Sampled allocation KiB/query baseline / current |
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

For reused current cold owners, 5,018–5,042 KiB was already retained by the prime. Current live owners retained 920–938 KiB after priming, before static/append measurements. The table includes this retained state; append adds log data and analysis edges on both sides.

The actual structuredClone counts below cover the whole measured batch. Source-event copies apply equally to surface and trace queries. Final surface counts/bytes match both algorithms. Trace queries make no event-payload clones, but still return newly built metadata/relationship arrays: 415 JSON bytes per static trace, or 16,680 bytes across 40 appended traces. Other clone calls are recorded in raw results and include headers and producer payloads.

| Phase | Queries | Baseline source copies / JSON bytes | Current source copies | Final surface copies / JSON bytes, both algorithms |
| --- | ---: | ---: | ---: | ---: |
| cold-first | 1 | 5,520 / 3,509,731 | 0 | 1 / 1,350 |
| cold-repeat | 40 | 220,800 / 140,389,240 | 0 | 40 / 54,000 |
| live-first | 1 | 5,521 / 3,509,800 | 0 | 1 / 1,350 |
| live-append | 40 | 229,876 / 146,131,460 | 0 | 1,720 / 871,740 |
| live-static | 40 | 220,840 / 140,392,000 | 0 | 40 / 54,000 |

Final surface response JSON totals are 1,508 bytes for first reads, 60,320 for repeated/static batches, and 879,740 for the append batch. These are serialized response volumes, not heap sizes. The run's raw JSON report saves machine metadata, all 100 timing samples, and separate diagnostics; the command prints its path.

## Interpretation

Repeated/static queries avoid whole-log work at the same cut; continuous append also reduces measured producer-plus-query CPU from 41.34 to 1.70 ms for surface and 40.01 to 1.17 ms for trace. These append figures do not isolate query cost.

First cold reads still read, parse, validate, fold, and restore a complete log. Current first-cold CPU is comparable for surface and higher for trace. Wall ranges overlap: surface 89.81–144.04 versus 70.58–166.17 ms; trace 86.88–123.52 versus 70.10–118.82 ms. This run does not establish a first-cold speedup.

Reuse trades roughly 5 MiB of cold-owner or 0.9 MiB of live-owner retained state for avoiding repeated payload copies and interpretation. This checkpointed workload ends with one surface event; larger uncheckpointed surfaces still pay proportionally for final event copies. Trace queries still allocate final metadata and relationship arrays. These measurements are not deployment guarantees.
