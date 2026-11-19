# comparison-experiment 入库指南

本库用 HotpotQA 检查两阶段 Recall → Reasoning 的拓扑截取、材料溯源和 DeepSeek 前缀缓存。审计基线为 [main 的 d24c425](https://github.com/18926119195/comparison-experiment/commit/d24c42536ce9a49640aa91ec52c30987a93ec8fd)。仓内只有一次 Git 快照提交，议题列表为空，文件和历史中未找到独立的人机聊天原文。逐题的模型输入、模型输出及 usage 是可回查的实验记录。表中的目录时间按归档命名取用。

## 第一次进入

1. 看 [README.md](./README.md) 了解实验意图，然后从 [ablation.js](./ablation.js) 的 `main`、`processQuestion`、`callReasoningLLM` 跟一题。输入是问题、Docuverse 语料和逐题名词索引，输出是答案、符号映射、缓存用量和聚合指标。
2. 数据入口用 [语料包](./data/hotpotqa/docuverse-corpus.json)、[问题集](./data/hotpotqa/questions.json) 和 [名词索引](./final-noun-index.json)。[convert-docuverse.py](./convert-docuverse.py)、[preprocess-only-s0.js](./preprocess-only-s0.js) 和 [spacy-server.py](./spacy-server.py) 用于重建输入。仓内检出的实验产物集中在 [output/](./output/)。
3. 在 Node 24 上已离线通过 `node --check ablation.js` 和 `node --check preprocess-only-s0.js`，并读回下列逐题 JSON。外部 API 运行需要完成凭据配置审查，且 `DOCUVERSE_PATH` 必须显式指向语料包。为新运行指定独立 `OUTPUT` 路径，保留历史记录。

## 意图、实现和证据

| 时间与目标 | 当前状态 | 证据 |
|---|---|---|
| 10 月 6 日 10:21 和 10:29 批次，观察 Recall 选择拓扑片段后再推理 | 已有两阶段执行和归档。两批各 4 题，保存的两阶段缓存命中均为 0。 | [10:21 批次](./output/recall-2026-10-06T10-21-50/recall-summary.json)、[10:29 批次](./output/recall-2026-10-06T10-29-01/recall-summary.json) |
| 10 月 6 日，Phase C+ 复用 Recall 对话前缀 | 已实现。Reasoning 重放 Recall 的消息与回复，按 `CACHE_WAIT_MS` 等待后再追加推理任务。两次 `hotpot_4241` 归档的 Reasoning 命中分别为 0 和 5,760/8,381。后一次 Recall 也已命中 5,760，缓存初始状态未被控制。 | [流水线](./ablation.js#L918)、[single-cache-wait](./output/single-cache-wait/recall-hotpot_4241/summary.json)、[single-cache-wait30](./output/single-cache-wait30/recall-hotpot_4241/summary.json) |
| 10 月 6 日，复核 README 给出的 41.8% / 95.9% | 引用定位需修正。README 指向 `hotpot_4596`，该文件两段命中为 0。41.8% Reasoning 和 95.9% Recall 可在 `hotpot_2879` 的 usage 中复算。 | [hotpot_4596](./output/test-150/recall-hotpot_4596/summary.json)、[hotpot_2879](./output/test-2879/recall-hotpot_2879/summary.json) |
| 建立可解释的策略比较 | 有 `recall`、`baseline`、`random` 路径和逐题落盘。受控对照、随机种子和指标口径待补。当前控制台把 `averageScore` 显示为 EM，独立字段 `exactMatches` 才可按题数换算。 | [打分](./ablation.js#L716)、[聚合与打印](./ablation.js#L1123)、[三模式入口](./ablation.js#L1179) |

## 下一轮实验闭环

1. **先验收单题观测。** 固定 commit、题 ID、模型、thinking 模式、提示版本和并发 1。保持共用前缀可比较，记录 Recall 和 Reasoning 的实际消息哈希、耗时、usage、解析是否有效以及文件归档路径。交给 harness 协作者复算，建议试验门槛为 100% 调用带用量或明确错误状态，符号映射可往返一一对应。
2. **控制扰动。** 对同一批题随机安排 0 秒和 30 秒两种处理条件，用可标识的前缀隔离不同重复，记录跨次缓存热度。保留同一配置的重复样本，汇总代价、缓存命中率、端到端延迟、答案 EM 和失败率。检验 `CACHE_WAIT_MS=0` 确实生效，显式保留失败或超时题。
3. **人工决策与复验。** 由评估负责人和项目所有者在实验前约定样本量、准确率容忍度和延迟预算。建议用成对的命中量和延迟变化及置信区间做首轮判断。先核对用量缺失、缓存热度和答案抽取偏差，再决定是否接受等待策略。修正后按同一批题和预先登记的规则复跑，更新 README 的证据链接。

## 方法依据

本指南把总体设计落实为边界、目标和任务接口，把工程控制中的反馈落实为观测、判据和纠偏。维护者用原始协作记录、代码和固定样本共同核验定性判断与量化结果，据此决定下一轮行动。[《工程控制论》](https://openlibrary.org/books/OL49218199M/Engineering_cybernetics) · [《组织管理的技术——系统工程》](https://doi.org/10.13255/j.cnki.jusst.2011.06.020) · [《一个科学新领域——开放的复杂巨系统及其方法论》](https://cnki.istiz.org.cn/kcms/detail/detail.aspx?dbcode=CPFD&dbname=cpfd1999&filename=ZGXC199008001001)
