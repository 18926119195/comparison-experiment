# comparison-experiment 入库指南

[一分钟定位](#一分钟定位) · [沿聊天时间线看灵感](#沿聊天时间线看灵感) · [从代码反查来由](#从代码反查来由) · [走读与维护记录](#走读与维护记录)

## 一分钟定位

这是 HotpotQA 的 Recall → Reasoning 对比实验。Recall 从名词与关系编号构成的拓扑链截取材料，Reasoning 复用同一轮消息并返回答案。试验关注拓扑截取和 DeepSeek 前缀缓存的表现。代码基线为 [main 的 d24c425](https://github.com/18926119195/comparison-experiment/commit/d24c42536ce9a49640aa91ec52c30987a93ec8fd)，其后 [6856035](https://github.com/18926119195/comparison-experiment/commit/68560359089ac1d7b8de536a5dce69df4276cc7c) 增补入库文档。

先开 [主入口 ablation.js](./ablation.js) 和 [一条逐题实验记录](./output/single-cache-wait30/recall-hotpot_4241/summary.json)。前者说明怎么运行，后者把所用材料、答案、模型和实际用量落到同一道题。

## 沿聊天时间线看灵感

**如何读状态。** 已实现表示在所列版本找到与灵感相符的代码路径。部分实现表示已有其中一段。未实现表示已查的入口尚无对应实现。证据不足时标待确认。归档与设计文稿按资料本身的状态描述。

已核查基线文件树、Git 提交历史和议题。未找到所有者与 AI 的原始开发聊天。下表按可证实的实验目录时间与提交顺序组织。无独立运行时间的条目归在首次入库快照下，实验工件中的模型输入输出是运行记录。

| 编号与日期／顺序 | 原始来源或代证 | 当时的想法 | 在代码基线上的状态 | 代码与结果证据 |
| --- | --- | --- | --- | --- |
| <a name="idea-i01"></a>I01 · 2026-10-06 · 归档名 10:21、10:29 | 实验工件代证。[首批](./output/recall-2026-10-06T10-21-50/recall-summary.json)、[次批](./output/recall-2026-10-06T10-29-01/recall-summary.json) | 先由 Recall 截出相关拓扑片段，再让 Reasoning 用该片段作答。 | **已落地**。两批各 4 题，均留有阶段用量。 | [两阶段分派](./ablation.js#L1179)、[一题的解析结果](./output/recall-2026-10-06T10-21-50/recall-hotpot_1304/recall-parsed.json) |
| <a name="idea-i02"></a>I02 · 2026-10-06 · 首次快照 | 提交与 README 代证。[d24c425](https://github.com/18926119195/comparison-experiment/commit/d24c42536ce9a49640aa91ec52c30987a93ec8fd)、[运行示例](./README.md) | Phase C+ 把 Recall 原消息和回复接入 Reasoning 请求，形成可复用前缀。 | **已落地**。Reasoning 在 Recall 模式重放消息，另两模式保留各自调用路径。 | [多轮消息拼接](./ablation.js#L918)、[逐题 Reasoning 输入](./output/single-cache-wait30/recall-hotpot_4241/reasoning-input.txt) |
| <a name="idea-i03"></a>I03 · 2026-10-06 · 首次快照 | 实验工件代证。[single-cache-wait](./output/single-cache-wait/recall-summary.json)、[single-cache-wait30](./output/single-cache-wait30/recall-summary.json) | 在两阶段之间等待 30 秒，让缓存建立后再发 Reasoning。 | **部分落地**。等待开关和用量记录俱在。两份 hotpot_4241 记录的 Reasoning 命中量为 0 与 5,760，第二份 Recall 已命中 5,760。初始缓存状态未固定，等待造成的独立变化无法核验。 | [等待逻辑](./ablation.js#L1207)、[带等待的逐题 usage](./output/single-cache-wait30/recall-hotpot_4241/summary.json) |
| <a name="idea-i04"></a>I04 · 2026-10-06 · 首次快照 | README 与实验工件代证。[关键结论](./README.md)、[test-150 归档](./output/test-150/recall-hotpot_4596/summary.json)、[test-2879 归档](./output/test-2879/recall-hotpot_2879/summary.json) | 用同题缓存命中率展示 Phase C+ 的实际表现。 | **部分落地**。README 所引 hotpot_4596 两阶段命中均为 0。它给出的 Reasoning 41.8% 和 Recall 95.9% 可从 hotpot_2879 的 usage 复算。 | [用量汇总](./ablation.js#L1123)；hotpot_2879 的分子／分母为 4,096／9,806 和 4,224／4,405。 |
| <a name="idea-i05"></a>I05 · 2026-10-06 · 首次快照 | 脚本与归档代证。[ablation.js](./ablation.js)、[一次四题汇总](./output/recall-2026-10-06T10-29-01/recall-summary.json) | 给不同实验模式保留可比较的答案评分。 | **部分落地**。脚本分别有 `exactMatches` 和自定义 `averageScore`；控制台的 EM 标签显示的是后者。 | [答案评分](./ablation.js#L716)、[分数与日志汇总](./ablation.js#L1123) |

## 从代码反查来由

| 想找哪部分 | 从文件回到意图 |
| --- | --- |
| 语料包、问题、名词符号的来路 | [语料包](./data/hotpotqa/docuverse-corpus.json)、[问题集](./data/hotpotqa/questions.json)、[名词索引](./final-noun-index.json) 进入 [I01](#idea-i01)。需追索引构建可再读 [语料转换](./convert-docuverse.py) 与 [S₀ 预处理](./preprocess-only-s0.js)。 |
| Recall 怎么决定哪些材料进入下一窗 | [逐题分派](./ablation.js#L1179) 和 [recall-parsed.json](./output/recall-2026-10-06T10-21-50/recall-hotpot_1304/recall-parsed.json) 对应 [I01](#idea-i01)。 |
| 两轮消息如何连起来、等待在哪里发生 | [callReasoningLLM](./ablation.js#L918) 回查 [I02](#idea-i02)，[Recall 完成后的等待](./ablation.js#L1207) 回查 [I03](#idea-i03)。 |
| 缓存或分数数字出自哪里 | [逐题输出目录](./output/) 回查 [I03](#idea-i03)、[I04](#idea-i04)，[答案评分](./ablation.js#L716) 回查 [I05](#idea-i05)。 |

## 走读与维护记录

- **五分钟读一题。** 从 [hotpot_4241 汇总](./output/single-cache-wait30/recall-hotpot_4241/summary.json) 找到相同目录中的 [符号表](./output/single-cache-wait30/recall-hotpot_4241/symbol-table.json)、[Recall 解析](./output/single-cache-wait30/recall-hotpot_4241/recall-parsed.json) 和 [Reasoning 输入](./output/single-cache-wait30/recall-hotpot_4241/reasoning-input.txt)。沿符号找一段原文，再回到 [I02](#idea-i02) 和 [I03](#idea-i03) 区分提示内容与缓存用量。
- **看到 EM 时。** 对照 [I05](#idea-i05) 同时读 `averageScore` 与 `exactMatches / total`，可解释二者差多少。
- 2026-11-19 依据基线重读上述 JSON，两个 JS 入口通过 Node 24 语法检查。当前状态以历史用量和代码为依据，未重新调用外部模型。日后新增原始协作记录时，按日期补入对应编号并保留旧工件链接。

**指南如何更新。** 以仓库和版本划定范围，从聊天提取原始目标，再用代码与产物校正对当时决策的理解。新证据出现时，回到原编号修订记录。这种读法借鉴了钱学森的系统工程和工程控制论。 [《组织管理的技术——系统工程》](https://doi.org/10.13255/j.cnki.jusst.2011.06.020) · [《工程控制论》](https://openlibrary.org/books/OL49218199M/Engineering_cybernetics)
