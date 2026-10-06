// ===== 配置 =====
import path from 'path';
import fs from 'fs';

// ===== 命令行参数解析 =====
const args = process.argv.slice(2);
const cliArgs = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const key = args[i].slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      cliArgs[key] = next;
      i++;
    } else {
      cliArgs[key] = true;
    }
  }
}

const CONFIG = {
  // 模式：baseline, recall, random
  MODE: cliArgs.mode || process.env.MODE || 'recall',
  // 各自独立的 API key
  API_KEY: cliArgs['api-key'] || process.env.API_KEY || 'sk-6c192794390d4a33b9528b110d58dceb',
  API_URL: cliArgs['api-url'] || process.env.API_URL || 'https://api.deepseek.com/chat/completions',
  // 各自独立的输出目录
  // 默认带上时间戳后缀（YYYY-MM-DDTHH-mm-ss），避免不同运行互相覆盖
  // 用户可通过 --output 或 OUTPUT 环境变量显式指定路径来关闭时间戳
  _runTimestamp: new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19),
  OUTPUT_DIR: cliArgs['output'] || process.env.OUTPUT
      || `./output/${cliArgs.mode || process.env.MODE || 'recall'}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`,
  LIMIT: Number(cliArgs.limit || process.env.LIMIT || 10),
  // 题目起始偏移（0-indexed）。例如 OFFSET=296 LIMIT=4 会跑第 297~300 题
  OFFSET: Number(cliArgs.offset || process.env.OFFSET || 0),
  CONCURRENCY: Number(cliArgs.concurrency || process.env.CONCURRENCY || 5),
  MODEL: cliArgs.model || process.env.MODEL || 'deepseek-flash',
  ENABLE_THINKING: cliArgs['enable-thinking'] !== undefined ? cliArgs['enable-thinking'] === 'true' : false,
  // 拆分：Recall 和 Reasoning 各自独立控制 thinking
  // 默认 Recall 不需要 thinking（剪切截断任务简单），Reasoning 需要 thinking（跨片段推理）
  ENABLE_THINKING_RECALL: cliArgs['enable-thinking-recall'] !== undefined
    ? cliArgs['enable-thinking-recall'] === 'true'
    : (cliArgs['enable-thinking'] !== undefined ? cliArgs['enable-thinking'] === 'true' : false),
  ENABLE_THINKING_REASONING: cliArgs['enable-thinking-reasoning'] !== undefined
    ? cliArgs['enable-thinking-reasoning'] === 'true'
    : (cliArgs['enable-thinking'] !== undefined ? cliArgs['enable-thinking'] === 'true' : true),
  MAX_TOKENS: Number(cliArgs['max-tokens'] || process.env.MAX_TOKENS || 384000),
  QUESTION_ID: cliArgs['question-id'] || process.env.QUESTION_ID || null,
  // Phase C+ 同次 run cache 命中关键参数：
  // DeepSeek 的 cache unit 建好后需要约 30 秒才能被同 session 内下一次调用命中。
  // 实测 5 秒不够，30 秒 OK（recall mode reasoning cache hit ~68.7%）。
  // 可通过 --cache-wait-ms 或 CACHE_WAIT_MS 调整（设 0 则不等待）。
  CACHE_WAIT_MS: Number(cliArgs['cache-wait-ms'] || process.env.CACHE_WAIT_MS || 30000),
};

// ===== Prompt 模板 =====

// 系统提示词（关于拓扑链的解释）
const TOPOLOGY_SYSTEM_HINT = `注意：你看到的拓扑链不是原文，而是符号化后的序列：
- ⟦N⟧ 代表实体名词
- ⟨A⟩、⟨B⟩ 等代表非实体关系（动词、连接词、修饰语等），仅表示"这里存在某种关系"

你的任务：根据问题，判断哪些实体之间的关系可能是回答所需的，并输出拓扑排序结果。`;

/**
 * Recall LLM Prompt: 从拓扑链中剪切一段截断
 *
 * 核心变化：
 * - Recall LLM 只能看到符号拓扑链（含占位符 ⟨A⟩、⟨B⟩），但看不到占位符背后的原文
 * - Recall LLM 的任务是"剪切"一段连续截断，而不是排序或重排
 * - Reasoning LLM 阶段才把占位符 ⟨A⟩、⟨B⟩ 替换为精确的非名词原文
 *
 * Prompt 结构：
 * 候选实体表：
 * ⟦1⟧ = [名词1]
 * ⟦2⟧ = [名词2]
 * ...
 *
 * 问题：
 * [问题]
 *
 * 拓扑链（符号化表示，占位符 ⟨A⟩、⟨B⟩ 等代表非名词内容，原文不可见）：
 * [拓扑链片段]
 *
 * 任务：从拓扑链中剪切一段你认为回答问题所需的连续截断
 * 约束：只能输出连续的符号序列，不能编造、不能跳选、不能重排
 *
 * 输出格式：
 * 输出拓扑链截断，例如：⟦1⟧⟨A⟩⟦2⟧
 */
function buildRecallPrompt(question, symbolTable, topologyChain, nonNounPlaceholders, chunkByKey) {
  // Phase 改造（方案 C）：共享部分（材料+拓扑链+问题）提到 system role，
  // 与 Reasoning 共享同一段 system 内容以命中 DeepSeek prompt cache。
  // 本函数仅用于日志合成（保存为单串），实际调用通过 callDeepSeekAPI 用 system+user 双消息发送。
  const shared = buildSharedContext(question, symbolTable, topologyChain);
  const task = buildRecallTask();
  return shared + '\n\n' + task;
}

/**
 * 共享上下文（system role 内容）。
 * Recall 和 Reasoning 在同一题里调用时，这一段必须字节级完全一致，才能命中 cache。
 */
function buildSharedContext(question, symbolTable, topologyChain) {
  const lines = [];

  // 0. 系统提示词（拓扑链解释）
  lines.push(TOPOLOGY_SYSTEM_HINT);

  // 1. 材料
  lines.push('');
  lines.push('材料：');
  for (const [noun, idx] of symbolTable) {
    lines.push(`⟦${idx}⟧ = ${noun}`);
  }

  // 2. 拓扑链（符号化表示，占位符 ⟨A⟩、⟨B⟩ 等代表非名词内容，原文不可见）
  lines.push('');
  lines.push('拓扑链（符号化表示，占位符 ⟨A⟩、⟨B⟩ 等代表非名词内容，原文不可见）：');

  // 按 chunk 聚合节点，拼接成一条链
  const allChainParts = [];
  const sortedChunkKeys = [...new Set(topologyChain.map(n => n.chunkKey))].sort();
  for (const chunkKey of sortedChunkKeys) {
    const chunkNodes = topologyChain.filter(n => n.chunkKey === chunkKey);
    chunkNodes.sort((a, b) => a.start - b.start);
    for (const node of chunkNodes) {
      if (node.type === 'noun') {
        allChainParts.push(node.symbol);
      } else if (node.type === 'relation') {
        allChainParts.push(node.placeholder);
      }
    }
  }
  lines.push(allChainParts.join(''));

  // 3. 问题
  lines.push('');
  lines.push('问题：');
  lines.push(question);

  return lines.join('\n');
}

/**
 * Recall 任务部分（user role 内容）。
 * 只含 Recall LLM 自己专属的指令，材料/链/问题已在 system 里。
 */
function buildRecallTask() {
  const lines = [];
  lines.push('任务：从拓扑链中选取多个你认为回答问题所需的截断片段。');
  lines.push('');
  lines.push('约束：');
  lines.push('- 每个截断必须是拓扑链中连续的符号序列');
  lines.push('- 多个截断必须按拓扑链中的原始顺序排列（不允许交叉）');
  lines.push('- 不能编造不存在的符号');
  lines.push('- 不能跳过中间的符号（保持相对顺序）');
  lines.push('- 不能重排符号顺序');
  lines.push('- 只选择能够帮助你解决问题的截断，宁缺毋滥');
  lines.push('');
  lines.push('输出格式：');
  lines.push('输出多个拓扑链截断片段，用 | 分隔，例如：⟦1⟧⟨A⟩⟦2⟧ | ⟦3⟩⟨B⟩⟦5⟩');
  lines.push('');
  lines.push('现在只输出符号序列（多个片段用 | 分隔）：');
  return lines.join('\n');
}

/**
 * Reasoning LLM Prompt: 多路径推理
 *
 * Prompt 结构：
 * 材料：
 * ⟦1⟧ = [名词1]
 * ⟦2⟧ = [名词2]
 * ...
 *
 * 拓扑链（符号化表示，占位符 ⟨A⟩、⟨B⟩ 等代表非名词内容，原文不可见）：
 * [拓扑链片段]
 *
 * 问题：
 * [问题]
 *
 * 占位符映射：
 * ⟨A⟩ = [原文]
 * ⟨B⟩ = [原文]
 * ...
 *
 * 要求：
 */
function buildReasoningPrompt(question, symbolTable, topologyChain, nonNounPlaceholders, chunkByKey) {
  // Phase 改造（方案 C）：共享部分（材料+拓扑链+问题）提到 system role。
  // 注意：日志合成时用传入的 topologyChain（可能是截断链），实际 API 调用时传入完整链 baseTopologyChain。
  const shared = buildSharedContext(question, symbolTable, topologyChain);
  const task = buildReasoningTask(topologyChain, nonNounPlaceholders, chunkByKey);
  return shared + '\n\n' + task;
}

/**
 * Reasoning 任务部分（user role 内容）。
 * @param {Array} truncatedTopologyChain - Recall 返回的截断节点数组（在 user 里复述一次截断子链）
 * @param {Map} nonNounPlaceholders - 占位符映射（已经按 usedRelIds 过滤过）
 * @param {Map} chunkByKey - chunk key -> {text} 映射，用于查占位符原文
 */
function buildReasoningTask(truncatedTopologyChain, nonNounPlaceholders, chunkByKey) {
  const lines = [];

  // 0. Recall 截断子链（在 user 里复述一次，方便 Reasoning LLM 直接拿到目标片段）
  lines.push('Recall 截断：');
  if (truncatedTopologyChain && truncatedTopologyChain.length > 0) {
    const allChainParts = [];
    const sortedChunkKeys = [...new Set(truncatedTopologyChain.map(n => n.chunkKey))].sort();
    for (const chunkKey of sortedChunkKeys) {
      const chunkNodes = truncatedTopologyChain.filter(n => n.chunkKey === chunkKey);
      chunkNodes.sort((a, b) => a.start - b.start);
      for (const node of chunkNodes) {
        if (node.type === 'noun') {
          allChainParts.push(node.symbol);
        } else if (node.type === 'relation') {
          allChainParts.push(node.placeholder);
        }
      }
    }
    lines.push(allChainParts.join(''));
  } else {
    lines.push('（无截断）');
  }

  // 1. 占位符映射：将 ⟨A⟩、⟨B⟩ 等映射回原文
  lines.push('');
  lines.push('占位符映射：');
  if (nonNounPlaceholders && nonNounPlaceholders.size > 0) {
    for (const [relId, mapping] of nonNounPlaceholders) {
      const entry = chunkByKey.get(mapping.chunkKey);
      const text = entry ? entry.text.slice(mapping.start, mapping.end) : '';
      lines.push(`${mapping.placeholder} = ${text}`);
    }
  } else {
    lines.push('（无占位符）');
  }

  // 2. 推理要求
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('要求：输出2-4条独立推理路径，每条路径包含多个步骤，每步可引用一个或多个材料⟦N⟧。');
  lines.push('');
  lines.push('格式：');
  lines.push('');
  lines.push('# 路径一：[标题]');
  lines.push('');
  lines.push('步骤1：使用⟦X⟧，提取...');
  lines.push('步骤2：综合⟦Y⟧⟦Z⟧，对比...');
  lines.push('');
  lines.push('结论：[此路径结论]');
  lines.push('');
  lines.push('（继续路径二、三...）');
  lines.push('');
  lines.push('**引用规范**：');
  lines.push('- 单个材料：使用⟦N⟧，提取...，判断...');
  lines.push('- 多个材料：综合⟦N⟧⟦M⟧，对比/交叉验证/综合提取...');
  lines.push('');
  lines.push('**推理策略**：');
  lines.push('- 对比论证：对比不同材料中的矛盾或差异');
  lines.push('- 交叉验证：从多个材料中找到互相支撑的证据');
  lines.push('- 综合支撑：从多处提取一致的特征或模式');

  return lines.join('\n');
}

// ===== 辅助函数 =====

/**
 * 构建名词符号映射（去重）
 */
function buildNounSymbolMap(nouns) {
  const nounSet = new Set();
  const uniqueNouns = [];
  
  for (const noun of nouns) {
    if (!nounSet.has(noun.surface)) {
      nounSet.add(noun.surface);
      uniqueNouns.push(noun);
    }
  }
  
  const symbolMap = new Map();
  uniqueNouns.forEach((noun, idx) => {
    symbolMap.set(noun.surface, idx + 1);
  });
  
  return symbolMap;
}

/**
 * 构建拓扑链
 * @param {Array} nounPositions - 名词位置信息 [{surface, start, end, chunkKey}]
 * @param {Map} symbolMap - 符号映射
 * @param {Map} nonNounPlaceholders - 非名词内容占位符映射（外部传入）
 * @returns {Array} 拓扑链节点
 */
function buildTopologyChain(nounPositions, symbolMap, nonNounPlaceholders, chunkByKey) {
  const nodes = [];
  let relCounter = 0;
  
  // 排序
  const sorted = [...nounPositions].sort((a, b) => {
    if (a.chunkKey !== b.chunkKey) return a.chunkKey.localeCompare(b.chunkKey);
    return a.start - b.start;
  });
  
  // 遍历每个 chunk
  const chunks = {};
  for (const pos of sorted) {
    if (!chunks[pos.chunkKey]) chunks[pos.chunkKey] = [];
    chunks[pos.chunkKey].push(pos);
  }
  
  // 处理每个 chunk
  for (const [chunkKey, positions] of Object.entries(chunks)) {
    positions.sort((a, b) => a.start - b.start);
    
    // 获取 chunk 原文长度
    const chunkEntry = chunkByKey.get(chunkKey);
    const chunkTextLen = chunkEntry ? chunkEntry.text.length : 0;
    
    // 1. 头部非名词内容（chunk 开头 → 第一个名词之前）
    if (positions.length > 0 && positions[0].start > 0) {
      const headId = `rel_${relCounter++}`;
      const headPlaceholder = `⟨${String.fromCharCode(65 + (relCounter - 1))}⟩`;
      nonNounPlaceholders.set(headId, {
        placeholder: headPlaceholder,
        chunkKey,
        start: 0,
        end: positions[0].start,
      });
      nodes.push({
        type: 'relation',
        relId: headId,
        placeholder: headPlaceholder,
        start: 0,
        end: positions[0].start,
        chunkKey,
        isHead: true,  // 标记为头部
      });
    }
    
    for (let i = 0; i < positions.length; i++) {
      const pos = positions[i];
      
      // 添加实体节点
      nodes.push({
        type: 'noun',
        surface: pos.surface,
        symbol: `⟦${symbolMap.get(pos.surface)}⟧`,
        symbolIdx: symbolMap.get(pos.surface),
        start: pos.start,
        end: pos.end,
        chunkKey: pos.chunkKey,
      });
      
      // 如果不是最后一个，添加中间非名词内容占位符
      if (i < positions.length - 1) {
        const relId = `rel_${relCounter++}`;
        const placeholder = `⟨${String.fromCharCode(65 + (relCounter - 1))}⟩`;
        nonNounPlaceholders.set(relId, {
          placeholder,
          chunkKey,
          start: pos.end,
          end: positions[i + 1].start,
        });
        
        nodes.push({
          type: 'relation',
          relId,
          placeholder,
          start: pos.end,
          end: positions[i + 1].start,
          chunkKey,
        });
      }
    }
    
    // 2. 尾部非名词内容（最后一个名词之后 → chunk 结尾）
    if (positions.length > 0 && positions[positions.length - 1].end < chunkTextLen) {
      const tailId = `rel_${relCounter++}`;
      const tailPlaceholder = `⟨${String.fromCharCode(65 + (relCounter - 1))}⟩`;
      nonNounPlaceholders.set(tailId, {
        placeholder: tailPlaceholder,
        chunkKey,
        start: positions[positions.length - 1].end,
        end: chunkTextLen,
      });
      nodes.push({
        type: 'relation',
        relId: tailId,
        placeholder: tailPlaceholder,
        start: positions[positions.length - 1].end,
        end: chunkTextLen,
        chunkKey,
        isTail: true,  // 标记为尾部
      });
    }
  }
  
  return nodes;
}

/**
 * 解析 Recall LLM 的输出，获取拓扑链截断区间
 *
 * Recall LLM 输出的是拓扑链截断（如 ⟦1⟧⟨A⟩⟦2⟧），
 * 我们需要将其解析为节点在拓扑链中的索引区间 [startIdx, endIdx)
 *
 * 返回：
 * - nodes: 截断中的节点数组（按原顺序）
 * - valid: 解析是否成功
 */
function parseTopologyTruncation(output, topologyChain, nonNounPlaceholders) {
  // 支持多种分隔符：| 、、；；
  const segments = output.split(/[|、、；；]/).map(s => s.trim()).filter(s => s.length > 0);
  
  if (segments.length === 0) {
    return { nodes: null, valid: false };
  }

  // 提取拓扑链符号序列的正则
  const pattern = /⟦(\d+)⟧|⟨([^⟩]+)⟩/g;

  // 构建名词符号索引到拓扑链节点的映射
  const nounSymbolIdxToNode = new Map();
  for (const node of topologyChain) {
    if (node.type === 'noun' && node.symbolIdx !== undefined) {
      nounSymbolIdxToNode.set(node.symbolIdx, node);
    }
  }

  // 直接从占位符获取位置信息，按 (chunkKey, start) 排序
  // 构建 placeholder -> relId 的映射
  const placeholderToRelId = new Map();
  for (const [relId, mapping] of nonNounPlaceholders) {
    placeholderToRelId.set(mapping.placeholder, relId);
  }

  // 收集所有占位符及其位置，按原始拓扑链顺序排序
  const placeholderWithPosition = [];

  for (const segment of segments) {
    let match;
    pattern.lastIndex = 0;
    
    while ((match = pattern.exec(segment)) !== null) {
      if (match[2]) {
        // 非名词占位符，如 ⟨A⟩
        const placeholder = `⟨${match[2]}⟩`;
        const relId = placeholderToRelId.get(placeholder);
        
        if (relId) {
          const mapping = nonNounPlaceholders.get(relId);
          placeholderWithPosition.push({
            relId,
            placeholder,
            chunkKey: mapping.chunkKey,
            start: mapping.start,
            end: mapping.end,
          });
        }
      }
    }
  }

  // 按 (chunkKey, start) 排序（与拓扑链原始顺序一致）
  placeholderWithPosition.sort((a, b) => {
    if (a.chunkKey !== b.chunkKey) {
      return a.chunkKey.localeCompare(b.chunkKey);
    }
    return a.start - b.start;
  });

  // 提取排序后的 relId 列表
  const usedRelIds = placeholderWithPosition.map(p => p.relId);

  // 构建截断节点序列：按原始拓扑链顺序的占位符节点
  const relationNodeMap = new Map();
  for (const node of topologyChain) {
    if (node.type === 'relation' && node.relId) {
      relationNodeMap.set(node.relId, node);
    }
  }

  // 按拓扑链原始顺序构建节点（名词 + 排序后的占位符）
  const truncatedNodes = [];
  let relIdx = 0;

  for (const node of topologyChain) {
    if (node.type === 'noun') {
      truncatedNodes.push(node);
    } else if (node.type === 'relation' && node.relId) {
      // 只有在 recall 输出中出现过的占位符才加入
      if (usedRelIds.includes(node.relId)) {
        truncatedNodes.push(node);
        relIdx++;
      }
    }
  }

  // 验证：至少有一个占位符
  const valid = usedRelIds.length > 0;

  return {
    nodes: truncatedNodes,
    usedRelIds,
    valid,
  };
}

/**
 * 从截断节点中提取所有 relId（不只是显式出现的占位符，还包括 truncatedNodes 中出现的 relation）
 * 用于确保 reasoning prompt 包含所有在 truncatedNodes 中出现的 relation 的占位符映射
 */
function extractAllRelIdsFromTruncatedNodes(truncatedNodes) {
  const allRelIds = new Set();
  for (const node of truncatedNodes) {
    if (node.type === 'relation' && node.relId) {
      allRelIds.add(node.relId);
    }
  }
  return [...allRelIds];
}

/**
 * 构建带关系映射的拓扑链字符串
 * 格式：先列所有链，再统一映射（提高缓存命中率）
 * 
 * 示例：
 * 拓扑链1：⟦1⟧⟨A⟩⟦5⟧⟨B⟩⟦12⟧⟦3⟧
 * 拓扑链2：⟦2⟧⟨C⟩⟦7⟧⟨D⟩⟦10⟧⟦5⟧
 * 拓扑链3：⟦3⟧⟨E⟩⟦8⟧⟨F⟩⟦11⟧⟦4⟧
 * 
 * 关系映射：
 * ⟨A⟩ = 是红色的
 * ⟨B⟩ = 在树上
 * ⟨C⟩ = 是蓝色的
 * ...
 */
function buildTopologyWithRelations(topologyChains, relationMappings) {
  const lines = [];
  
  // 1. 先列出所有拓扑链
  if (Array.isArray(topologyChains)) {
    topologyChains.forEach((chain, idx) => {
      const parts = [];
      for (const node of chain) {
        if (node.type === 'noun') {
          parts.push(node.symbol);
        } else if (node.type === 'relation') {
          parts.push(node.placeholder);
        }
      }
      lines.push(`拓扑链${idx + 1}：${parts.join('')}`);
    });
  } else {
    // 单个链的兼容处理
    const parts = [];
    for (const node of topologyChains) {
      if (node.type === 'noun') {
        parts.push(node.symbol);
      } else if (node.type === 'relation') {
        parts.push(node.placeholder);
      }
    }
    lines.push(`拓扑链：${parts.join('')}`);
  }
  
  // 2. 空行分隔
  lines.push('');
  
  // 3. 统一关系映射
  lines.push('关系映射：');
  for (const [relId, mapping] of relationMappings) {
    lines.push(`${mapping.placeholder} = [原文]`);
  }
  
  return lines.join('\n');
}

/**
 * 回填拓扑链：按 chunk 聚簇，符号连排后接上整块原文
 * 拓扑链：⟦1⟧⟦2⟧⟦3⟧⟦4⟧
 * 回填后：⟦1⟧⟦2⟧⟦3⟧是红色的在树上⟦4⟧
 *
 * 注意：原文按 chunk 整块追加，所以仅调整符号顺序不会改变最终文本。
 * 这个函数用于 baseline / random 模式。
 */
function buildFilledContext(topologyChain, chunkByKey) {
  const parts = [];

  for (let i = 0; i < topologyChain.length; i++) {
    const node = topologyChain[i];
    const entry = chunkByKey.get(node.chunkKey);
    if (!entry) continue;

    const chunkText = entry.text;

    // 添加符号
    parts.push(node.symbol);

    // 添加符号后面的原文（直到下一个符号或 chunk 边界）
    let nextEnd = null;

    // 找同一 chunk 中的下一个节点
    for (let j = i + 1; j < topologyChain.length; j++) {
      if (topologyChain[j].chunkKey === node.chunkKey) {
        nextEnd = topologyChain[j].end;
        break;
      }
    }

    if (nextEnd !== null && nextEnd > node.end) {
      // 同一 chunk 中有下一个节点，提取之间的文本
      const between = chunkText.slice(node.end, nextEnd);
      parts.push(between);
    } else if (nextEnd === null && node.end < chunkText.length) {
      // 这是 chunk 中最后一个节点，提取到末尾
      const suffix = chunkText.slice(node.end);
      parts.push(suffix);
    }
  }

  return parts.join('');
}

/**
 * 根据拓扑链截断节点精确拼接上下文
 *
 * 与 buildFilledContext 的区别：
 * - buildFilledContext: 遍历拓扑链，节点之间追加 chunk 原文窗口
 * - buildContextFromTruncation: 遍历截断后的节点，每个关系节点直接用精确的 start/end 位置提取原文
 *
 * 关键：节点本身已经有精确的 start/end 位置（名词在 chunk 中的位置，关系在名词之间的位置）
 * 我们直接用这些位置来提取非名词的原文片段
 */
function buildContextFromTruncation(truncatedNodes, chunkByKey) {
  const parts = [];

  for (const node of truncatedNodes) {
    const entry = chunkByKey.get(node.chunkKey);
    if (!entry) continue;

    const chunkText = entry.text;

    if (node.type === 'noun') {
      // 名词节点：输出符号
      parts.push(node.symbol);
    } else if (node.type === 'relation') {
      // 关系节点：用精确的 start/end 位置提取原文
      const start = node.start;
      const end = node.end;
      if (end > start) {
        const text = chunkText.slice(start, end);
        parts.push(text);
      }
    }
  }

  return parts.join('');
}

/**
 * 打乱拓扑链顺序（消融实验）
 */
function shuffleTopologyChain(chain) {
  const shuffled = [...chain];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * 加载 Docuverse 数据
 */
function loadDocuverse(docuversePath) {
  const data = JSON.parse(fs.readFileSync(docuversePath, 'utf-8'));
  const chunkByKey = new Map();
  
  // 处理扁平格式（每个元素是 chunk）
  if (Array.isArray(data) && data.length > 0 && !data[0].chunks) {
    for (const chunk of data) {
      chunkByKey.set(chunk.chunkKey, {
        text: chunk.text,
        docId: chunk.questionId,
        title: chunk.title,
      });
    }
    return { data, chunkByKey };
  }
  
  // 处理 doc.chunks 格式
  for (const doc of data) {
    for (const chunk of doc.chunks) {
      chunkByKey.set(chunk.chunkKey, {
        text: chunk.text,
        docId: doc.docId,
        chunkIndex: chunk.chunkIndex,
      });
    }
  }
  
  return { data, chunkByKey };
}

/**
 * 评估答案
 */
function evaluateAnswer(predicted, expected) {
  const normPred = predicted.toLowerCase().trim().replace(/[.。!！?？]+$/, '');
  const normExp = expected.toLowerCase().trim().replace(/[.。!！?？]+$/, '');
  
  if (normPred === normExp) return 1;
  if (normExp.includes(normPred) || normPred.includes(normExp)) return 0.8;
  
  const predWords = new Set(normPred.split(/\s+/));
  const expWords = new Set(normExp.split(/\s+/));
  let matchCount = 0;
  for (const w of expWords) {
    if (predWords.has(w) || normPred.includes(w)) matchCount++;
  }
  return matchCount / expWords.size;
}

// ===== LLM 调用 =====

async function callRecallLLM(question, symbolTable, topologyChain, nonNounPlaceholders, chunkByKey) {
  const prompt = buildRecallPrompt(question, symbolTable, topologyChain, nonNounPlaceholders, chunkByKey);
  const enableThinking = CONFIG.ENABLE_THINKING_RECALL;
  let thisRecallLog = null; // 用于后续统一写入完整日志

  console.log(`[Recall] 发送请求到 LLM (thinking=${enableThinking})...`);

  try {
    const sharedContent = buildSharedContext(question, symbolTable, topologyChain);
    const taskContent = buildRecallTask();
    const { content: response, usage } = await callDeepSeekAPI([
      { role: 'system', content: sharedContent },
      { role: 'user', content: taskContent }
    ], CONFIG.MODEL, enableThinking);
    // 解析拓扑链截断
    const { nodes: truncatedNodes, usedRelIds, valid } = parseTopologyTruncation(response || '', topologyChain, nonNounPlaceholders);

    if (!valid || !truncatedNodes) {
      console.log('[Recall] 输出无法解析，回退到原始顺序:', (response || '').slice(0, 120));
    }

    // 每题完整日志（不截断）
    const questionId = null; // 暂时用 null，后续在 runAblation 中传入
    // 旧的 append 方式仍然保留，方便汇总查看
    const trace = {
      question,
      enableThinking,
      usage,
      promptLength: prompt.length,
      promptHead: prompt.slice(0, 1200),
      promptTail: prompt.length > 1200 ? prompt.slice(-600) : '',
      rawResponse: (response || '').slice(0, 1000),
      truncatedNodes: truncatedNodes ? truncatedNodes.map(n => ({
        type: n.type,
        symbol: n.symbol,
        placeholder: n.placeholder,
        symbolIdx: n.symbolIdx,
      })) : null,
      usedRelIds,
      valid,
    };
    fs.appendFileSync(path.join(CONFIG.OUTPUT_DIR, 'recall-raw.log'),
      `\n===== ${question} =====\n${JSON.stringify(trace, null, 2)}\n`);
    // 完整 prompt 单独存一份，便于逐字核对
    fs.writeFileSync(path.join(CONFIG.OUTPUT_DIR, `recall-prompt-${question.replace(/[^\w]/g, '_').slice(0, 40)}.txt`), prompt, 'utf-8');

    // 新的完整日志（在 runAblation 中调用）
    // 保存到 thisRecallLog 以便 runAblation 统一写入
    thisRecallLog = {
      prompt,
      rawResponse: response || '',
      parsed: {
        truncatedNodes: truncatedNodes ? truncatedNodes.map(n => ({
          type: n.type,
          symbol: n.symbol,
          placeholder: n.placeholder,
          symbolIdx: n.symbolIdx,
        })) : null,
        usedRelIds,
        valid,
      },
      symbolTable,
      enableThinking,
      usage,
    };

    return {
      truncatedNodes, usedRelIds, valid,
      recallLog: thisRecallLog,
      // Phase C+：把 Recall 这次调用的 messages 数组传给 Reasoning，
      // 这样 Reasoning 用多轮对话形式调用，命中 system+user+assistant 这个 cache 单元。
      recallMessages: [
        { role: 'system', content: sharedContent },
        { role: 'user', content: taskContent }
      ],
      recallResponse: response || '',
    };
  } catch (err) {
    console.error('[Recall] API 调用失败:', err.message);
    thisRecallLog = { prompt, rawResponse: 'ERROR: ' + err.message, parsed: null, symbolTable, enableThinking, usage: null };
    return {
      truncatedNodes: null, usedRelIds: [], valid: false,
      recallLog: thisRecallLog,
      recallMessages: [
        { role: 'system', content: buildSharedContext(question, symbolTable, topologyChain) },
        { role: 'user', content: buildRecallTask() }
      ],
      recallResponse: 'ERROR: ' + err.message,
    };
  }
}

// 让 _currentRecallLog 可被 runAblation 访问
let _currentRecallLog = null;
// Phase C+：缓存 Recall 的 messages 和 response，给 Reasoning 多轮对话用
let _currentRecallMessages = null;
let _currentRecallResponse = '';

/**
 * 调用 DeepSeek 官方 API
 * @param {Array} messages - 消息列表
 * @param {string} model - 模型名
 * @param {boolean} enableThinking - 是否启用 thinking（由调用方决定，Recall 默认 false，Reasoning 默认 true）
 * @returns {{content: string, usage: object|null}} content 为 LLM 输出文本，usage 为 token 用量统计
 */
async function callDeepSeekAPI(messages, model = CONFIG.MODEL, enableThinking = false) {
  const requestBody = {
    model,
    messages,
    max_tokens: CONFIG.MAX_TOKENS,
    // DeepSeek 官方：思维链默认开启，用 thinking.type=disabled 关闭
    thinking: { type: enableThinking ? 'enabled' : 'disabled' },
  };

  if (enableThinking) {
    requestBody.reasoning_effort = 'high';
  }

  const response = await fetch(CONFIG.API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CONFIG.API_KEY}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error: ${response.status} ${response.statusText} - ${text}`);
  }

  const data = await response.json();
  let content = data.choices?.[0]?.message?.content || '';
  if (!content) {
    throw new Error('API 返回空 content: ' + JSON.stringify(data).slice(0, 300));
  }

  // 兜底：若仍返回思维链标签，剔除
  if (content.includes('<thinking>')) {
    content = content.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();
  }

  // 提取 token 用量（DeepSeek 返回的字段：prompt_tokens / completion_tokens / total_tokens / prompt_cache_hit_tokens / prompt_cache_miss_tokens）
  const usage = data.usage || null;

  return { content, usage };
}

// ===== 每题完整日志系统 =====
// 每个问题一个目录，存储完整的输入输出，不截断任何内容
function getQuestionDir(questionId, mode) {
  const baseDir = path.join(CONFIG.OUTPUT_DIR, `${mode}-${questionId}`);
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }
  return baseDir;
}

function saveRecallLog(questionId, mode, metadata) {
  const dir = getQuestionDir(questionId, mode);
  // 完整 recall 输入（prompt）
  fs.writeFileSync(path.join(dir, 'recall-input.txt'), metadata.prompt, 'utf-8');
  // 完整 recall 输出（原始响应）
  fs.writeFileSync(path.join(dir, 'recall-output.txt'), metadata.rawResponse || '', 'utf-8');
  // 解析后的截断节点（完整）
  fs.writeFileSync(path.join(dir, 'recall-parsed.json'), JSON.stringify(metadata.parsed, null, 2), 'utf-8');
  // 符号表
  fs.writeFileSync(path.join(dir, 'symbol-table.json'), JSON.stringify(metadata.symbolTable, null, 2), 'utf-8');
}

function saveReasoningLog(questionId, mode, metadata) {
  const dir = getQuestionDir(questionId, mode);
  // 完整 reasoning 输入（prompt）
  fs.writeFileSync(path.join(dir, 'reasoning-input.txt'), metadata.prompt, 'utf-8');
  // 完整 reasoning 输出（答案）
  fs.writeFileSync(path.join(dir, 'reasoning-output.txt'), metadata.answer || '', 'utf-8');
}

function saveQuestionSummary(questionId, mode, summaryData) {
  const dir = getQuestionDir(questionId, mode);
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summaryData, null, 2), 'utf-8');
}

async function callReasoningLLM(question, symbolTable, baseTopologyChain, truncatedTopologyChain, nonNounPlaceholders, chunkByKey, mode = 'unknown', recallMessages = null, recallResponse = '') {
  // Phase C+ 改造：把 Recall 的 messages + 响应塞进这次调用，形成多轮对话。
  // DeepSeek 的 cache 单元位于 end-of-user-input 和 end-of-model-output。
  // Recall 那次调用结束后，[system, recallUser, recallAssistant] 成为一个 cache 单元，
  // 这次 Reasoning 的多轮消息前缀正好等于这个单元，全部命中。
  const prompt = buildReasoningPrompt(question, symbolTable, truncatedTopologyChain, nonNounPlaceholders, chunkByKey);
  const sharedContent = buildSharedContext(question, symbolTable, baseTopologyChain);
  const taskContent = buildReasoningTask(truncatedTopologyChain, nonNounPlaceholders, chunkByKey);
  const enableThinking = CONFIG.ENABLE_THINKING_REASONING;
  let thisReasoningLog = null;

  console.log(`[Reasoning] 发送请求到 LLM (thinking=${enableThinking})...`);

  // 构造多轮 messages：
  // - recall 模式：[system, recallUser, recallAssistant, reasoningUser]，命中 Recall 调用留下的 [system, user, assistant] 单元
  // - random/baseline 模式（没有 Recall 调用）：退回 [system, reasoningUser]，与之前方案 C 一致
  const multiTurnMessages = recallMessages
    ? [
        ...recallMessages,
        { role: 'assistant', content: recallResponse },
        { role: 'user', content: taskContent }
      ]
    : [
        { role: 'system', content: sharedContent },
        { role: 'user', content: taskContent }
      ];

  try {
    const { content: answer, usage } = await callDeepSeekAPI(multiTurnMessages, CONFIG.MODEL, enableThinking);
    console.log('[Reasoning] 收到回答，长度:', answer?.length || 0);

    // 记录 prompt 和回答，便于核对送进推理 LLM 的到底是什么
    const trace = {
      question,
      mode,
      enableThinking,
      usage,
      promptLength: prompt.length,
      promptHead: prompt.slice(0, 1500),
      promptTail: prompt.length > 1500 ? prompt.slice(-800) : '',
      answer: (answer || '').slice(0, 1500),
      multiTurnTurnCount: multiTurnMessages.length,
    };
    fs.appendFileSync(path.join(CONFIG.OUTPUT_DIR, 'reasoning-raw.log'),
      `\n===== [${mode}] ${question} =====\n${JSON.stringify(trace, null, 2)}\n`);
    // 完整 prompt 单独存一份，便于逐字核对
    const safeQ = question.replace(/[^\w]/g, '_').slice(0, 40);
    fs.writeFileSync(path.join(CONFIG.OUTPUT_DIR, `reasoning-prompt-${mode}-${safeQ}.txt`), prompt, 'utf-8');

    // 保存到 thisReasoningLog 以便 runAblation 统一写入
    thisReasoningLog = { prompt, answer: answer || 'NO_RESPONSE', enableThinking, usage };

    return { answer: answer || 'NO_RESPONSE', reasoningLog: thisReasoningLog };
  } catch (err) {
    console.error('[Reasoning] API 调用失败:', err.message);
    thisReasoningLog = { prompt, answer: 'ERROR: ' + err.message, enableThinking, usage: null };
    return { answer: 'ERROR: ' + err.message, reasoningLog: thisReasoningLog };
  }
}

// 让 thisReasoningLog 可被 runAblation 访问
let _currentReasoningLog = null;

// ===== 实验模式 =====

/**
 * 消融实验：对比不同召回模式
 * - baseline: 原始拓扑链
 * - recall: LLM 预测拓扑排序
 * - random: 随机打乱拓扑链
 */
/**
 * 为单个问题构建符号表与基础拓扑链（每题用自己的名词索引）
 * @param {Map} chunkByKey - chunk key -> {text} 映射，用于从原文反查名词位置
 */
function buildQuestionContext(q, nounIndexRaw, chunkByKey) {
  const byQuestion = nounIndexRaw.question_indexes;
  const entry = byQuestion ? byQuestion[q.id] : null;

  let nounIndex;
  if (entry) {
    // 使用预处理保存的精确位置，不再重新正则匹配
    nounIndex = entry.nouns
      .filter(n => n.surface && Array.isArray(n.positions) && n.positions.length > 0)
      .flatMap(n => {
        // 同一个名词可能在多个位置出现，每个位置都作为一个独立条目
        return n.positions.map(pos => ({
          surface: n.surface,
          start: pos.start,
          end: pos.end,
          chunkKey: pos.chunkKey,
          page: pos.page || 0,
        }));
      });
  } else {
    nounIndex = [];
  }

  // 名词标准化：用于符号表去重
  const normalizeNoun = (s) => s ? s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim() : s;

  // 构建符号表（使用标准化名词去重）
  // 标准化后相同的名词被视为同一实体，只分配一个符号
  const symbolTable = new Map();
  const normalizedToAllOriginals = new Map();  // 标准化名 -> 所有原始 surface 变体
  const normalizedToFirstOriginal = new Map(); // 标准化名 -> 第一个原始 surface（用于展示）
  let idx = 1;
  for (const noun of nounIndex) {
    const normalized = normalizeNoun(noun.surface);
    if (!symbolTable.has(normalized)) {
      symbolTable.set(normalized, idx++);
      normalizedToFirstOriginal.set(normalized, noun.surface);
      normalizedToAllOriginals.set(normalized, [noun.surface]);
    } else {
      // 收集所有变体，方便用户审查
      const variants = normalizedToAllOriginals.get(normalized);
      if (!variants.includes(noun.surface)) {
        variants.push(noun.surface);
      }
    }
  }

  // 构建基础拓扑链（使用标准化名词）
  const nounPositions = nounIndex.map(n => ({
    surface: normalizeNoun(n.surface),
    start: n.start,
    end: n.end,
    chunkKey: n.chunkKey,
    originalSurface: n.surface,  // 保留原始 surface 用于精确定位
  }));

  const nonNounPlaceholders = new Map();
  const baseTopologyChain = buildTopologyChain(nounPositions, symbolTable, nonNounPlaceholders, chunkByKey);

  // 构建展示用的符号表（用原始名词展示给 LLM）
  const displaySymbolTable = new Map();
  for (const [normalized, idx] of symbolTable) {
    displaySymbolTable.set(normalizedToFirstOriginal.get(normalized), idx);
  }

  // 构建审查用的符号表（包含所有原始变体）
  const auditSymbolTable = new Map();
  for (const [normalized, idx] of symbolTable) {
    auditSymbolTable.set(idx, {
      normalized,
      firstOriginal: normalizedToFirstOriginal.get(normalized),
      allVariants: normalizedToAllOriginals.get(normalized),
    });
  }

  return { 
    symbolTable: displaySymbolTable, 
    auditSymbolTable,  // 供审查用，包含所有变体
    baseTopologyChain, 
    nonNounPlaceholders, 
    nounCount: nounIndex.length 
  };
}

/**
 * 带并发限制的 map
 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runner() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

/**
 * 消融实验：对比不同召回模式
 * - baseline: 原始拓扑链
 * - recall: LLM 预测拓扑排序
 * - random: 随机打乱拓扑链
 */
async function runAblation(mode, questions, nounIndexRaw, chunkByKey) {
  // 确保输出目录存在（API 调用过程中也需要写日志）
  fs.mkdirSync(CONFIG.OUTPUT_DIR, { recursive: true });

  console.log(`\n========== ${mode.toUpperCase()} 模式 (${questions.length} 题) ==========`);

  let done = 0;
  const results = await mapWithConcurrency(questions, CONFIG.CONCURRENCY, async (q) => {
    try {
      return await processQuestion(q, mode, nounIndexRaw, chunkByKey);
    } catch (err) {
      console.error(`[${mode}] ${q.id} 失败:`, err.message);
      return { qid: q.id, question: q.question.slice(0, 100), expectedAnswer: q.answer,
               predictedAnswer: 'ERROR: ' + err.message, recallMode: mode, intervalsCount: 0, score: 0 };
    } finally {
      done++;
      console.log(`[${mode}] 进度 ${done}/${questions.length}`);
    }
  });

  const total = results.length;
  const exactMatches = results.filter(r => r.score === 1).length;
  const scoreSum = results.reduce((s, r) => s + r.score, 0);
  const avgScore = scoreSum / total;

  // 聚合 Recall / Reasoning 的 token 与缓存命中
  const aggregateUsage = (key) => {
    let promptTokens = 0, completionTokens = 0, totalTokens = 0;
    let cacheHitTokens = 0, cacheMissTokens = 0;
    let callsWithUsage = 0;
    for (const r of results) {
      const u = r[key];
      if (u) {
        callsWithUsage++;
        promptTokens += u.prompt_tokens || 0;
        completionTokens += u.completion_tokens || 0;
        totalTokens += u.total_tokens || 0;
        cacheHitTokens += u.prompt_cache_hit_tokens || 0;
        cacheMissTokens += u.prompt_cache_miss_tokens || 0;
      }
    }
    return {
      callsWithUsage,
      promptTokens,
      completionTokens,
      totalTokens,
      cacheHitTokens,
      cacheMissTokens,
      cacheHitRate: promptTokens > 0 ? +(cacheHitTokens / promptTokens).toFixed(4) : 0,
    };
  };

  const summary = {
    mode,
    total,
    exactMatches,
    averageScore: avgScore,
    recallUsage: aggregateUsage('recallUsage'),
    reasoningUsage: aggregateUsage('reasoningUsage'),
    config: {
      MODEL: CONFIG.MODEL,
      recallThinking: CONFIG.ENABLE_THINKING_RECALL,
      reasoningThinking: CONFIG.ENABLE_THINKING_REASONING,
    },
  };

  fs.mkdirSync(CONFIG.OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(CONFIG.OUTPUT_DIR, `${mode}-summary.json`), JSON.stringify(summary, null, 2), 'utf-8');
  fs.writeFileSync(path.join(CONFIG.OUTPUT_DIR, `${mode}-details.json`), JSON.stringify(results, null, 2), 'utf-8');

  console.log(`\n结果: EM=${(avgScore*100).toFixed(1)}% (${exactMatches}/${total})`);
  console.log(`Recall tokens: total=${summary.recallUsage.totalTokens}, cache_hit=${summary.recallUsage.cacheHitTokens} (${(summary.recallUsage.cacheHitRate*100).toFixed(1)}%)`);
  console.log(`Reasoning tokens: total=${summary.reasoningUsage.totalTokens}, cache_hit=${summary.reasoningUsage.cacheHitTokens} (${(summary.reasoningUsage.cacheHitRate*100).toFixed(1)}%)`);

  return summary;
}

async function processQuestion(q, mode, nounIndexRaw, chunkByKey) {
  const { symbolTable, baseTopologyChain, nonNounPlaceholders, nounCount } = buildQuestionContext(q, nounIndexRaw, chunkByKey);

  // 重置每题日志状态
  _currentRecallLog = null;
  _currentReasoningLog = null;
  _currentRecallMessages = null;
  _currentRecallResponse = '';

  let topologyChain = baseTopologyChain;
  let recallTruncation = null;
  let recallValid = false;
  let usedRelIds = [];
  let recallMode = false;

  if (mode === 'random') {
    // random 模式下拓扑链保持原始顺序，但占位符顺序打乱
    topologyChain = baseTopologyChain;
    // 收集所有 relId 并打乱顺序
    const allRelIds = topologyChain
      .filter(n => n.type === 'relation')
      .map(n => n.relId);
    // Fisher-Yates 打乱
    for (let i = allRelIds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [allRelIds[i], allRelIds[j]] = [allRelIds[j], allRelIds[i]];
    }
    usedRelIds = allRelIds;
  } else if (mode === 'recall' && symbolTable.size > 0) {
    // 让 LLM 从拓扑链中剪切一段截断
    recallMode = true;
    const recall = await callRecallLLM(q.question, symbolTable, baseTopologyChain, nonNounPlaceholders, chunkByKey);
    recallTruncation = recall.truncatedNodes;
    recallValid = recall.valid;
    // 从 truncatedNodes 中提取所有出现的 relId（而不只是 recall 输出中显式出现的占位符）
    // 这样可以确保 reasoning prompt 包含所有 truncatedNodes 中 relation 节点的占位符映射
    usedRelIds = extractAllRelIdsFromTruncatedNodes(recallTruncation || []);
    _currentRecallLog = recall.recallLog; // 捕获完整日志
    // Phase C+：缓存 Recall 的 messages 和 response，给 Reasoning 多轮对话用
    _currentRecallMessages = recall.recallMessages;
    _currentRecallResponse = recall.recallResponse;
    if (recallValid && recallTruncation) {
      topologyChain = recallTruncation;
    }

    // Phase C+ 关键：等 cache unit 持久化完毕，再发起 Reasoning 调用。
    // DeepSeek 文档："Cache construction takes seconds"，刚返回的 cache 单元在几秒内可能查不到。
    // 同次 run 里紧接的 Reasoning 不等就 hit 不到，于是用 setTimeout 让出事件循环，等够再继续。
    if (CONFIG.CACHE_WAIT_MS > 0) {
      console.log(`[Recall] 等待 ${CONFIG.CACHE_WAIT_MS}ms 让 cache unit 持久化...`);
      await new Promise(resolve => setTimeout(resolve, CONFIG.CACHE_WAIT_MS));
    }
  }

  // 构建占位符映射：只包含拓扑链中使用的占位符
  const reasoningNonNounPlaceholders = new Map();
  if (usedRelIds.length > 0) {
    for (const [relId, mapping] of nonNounPlaceholders) {
      if (usedRelIds.includes(relId)) {
        reasoningNonNounPlaceholders.set(relId, mapping);
      }
    }
  } else {
    // 兜底：保留完整的占位符映射
    reasoningNonNounPlaceholders = nonNounPlaceholders;
  }

  // Reasoning: 生成答案
  // Phase C+：用多轮对话形式调用，把 Recall 的 messages+response 塞进去，让 cache 命中 system+user1+assistant1 那个单元。
  // 共享 system 内容用完整链 baseTopologyChain（保证与 Recall 的 system 一字不差），
  // truncatedTopologyChain（即当前 topologyChain，可能是截断链）放进 user。
  const { answer: predictedAnswer, reasoningLog } = await callReasoningLLM(
    q.question, symbolTable, baseTopologyChain, topologyChain, reasoningNonNounPlaceholders, chunkByKey, mode,
    _currentRecallMessages, _currentRecallResponse
  );
  _currentReasoningLog = reasoningLog;

  // ===== 保存每题完整日志 =====
  // 构建 reasoning prompt 以便保存（因为 buildReasoningPrompt 在 callReasoningLLM 内部调用，需要重新构建）
  const reasoningPrompt = buildReasoningPrompt(q.question, symbolTable, topologyChain, reasoningNonNounPlaceholders, chunkByKey);

  // 保存 recall 日志（如果存在）
  if (_currentRecallLog) {
    saveRecallLog(q.id, mode, {
      ..._currentRecallLog,
      question: q.question,
    });
  } else {
    // baseline/random 模式：保存完整的符号表和基础拓扑链
    saveRecallLog(q.id, mode, {
      prompt: buildRecallPrompt(q.question, symbolTable, baseTopologyChain, nonNounPlaceholders, chunkByKey),
      rawResponse: '[no-recall-mode]',
      parsed: {
        truncatedNodes: baseTopologyChain.map(n => ({
          type: n.type,
          symbol: n.symbol,
          placeholder: n.placeholder,
          symbolIdx: n.symbolIdx,
        })),
        usedRelIds: [],
        valid: true,
      },
      symbolTable,
      question: q.question,
      enableThinking: CONFIG.ENABLE_THINKING_RECALL,
      usage: null,
    });
  }

  // 保存 reasoning 完整日志
  saveReasoningLog(q.id, mode, {
    prompt: reasoningPrompt,
    answer: predictedAnswer,
  });

  // 评估
  const score = evaluateAnswer(predictedAnswer, q.answer);

  // 汇总本次调用的 token 用量
  const recallUsage = _currentRecallLog?.usage || null;
  const reasoningUsage = _currentReasoningLog?.usage || null;

  // 保存问题摘要
  saveQuestionSummary(q.id, mode, {
    qid: q.id,
    question: q.question,
    expectedAnswer: q.answer,
    predictedAnswer,
    recallMode: mode,
    recallValid,
    recallTruncation: (recallTruncation || []).slice(0, 12).map(n => n.symbol || n.placeholder).join(''),
    nounCount,
    score,
    config: {
      MODEL: CONFIG.MODEL,
      recallThinking: CONFIG.ENABLE_THINKING_RECALL,
      reasoningThinking: CONFIG.ENABLE_THINKING_REASONING,
    },
    // ===== Token / 缓存命中统计 =====
    recallUsage,
    reasoningUsage,
  });

  return {
    qid: q.id,
    question: q.question.slice(0, 100),
    expectedAnswer: q.answer,
    predictedAnswer,
    recallMode: mode,
    recallValid,
    recallTruncation: (topologyChain || []).slice(0, 12).map(n => n.symbol || n.placeholder).join(''),
    nounCount,
    score,
    recallUsage,
    reasoningUsage,
  };
}

// ===== 主入口 =====

async function main() {
  console.log('开始消融实验...');
  console.log('配置:', JSON.stringify(CONFIG, null, 2));
  
  // 加载数据
  const DOCUVERSE_PATH = process.env.DOCUVERSE_PATH;
  const NOUN_INDEX_PATH = process.env.NOUN_INDEX_PATH || 'final-noun-index.json';
  const QUESTIONS_PATH = process.env.QUESTIONS_PATH || 'data/hotpotqa/questions.json';
  
  if (!DOCUVERSE_PATH) {
    console.error('请设置 DOCUVERSE_PATH 环境变量');
    process.exit(1);
  }
  
  // 加载名词索引
  const nounIndexRaw = JSON.parse(fs.readFileSync(NOUN_INDEX_PATH, 'utf-8'));

  // 加载问题
  const allQuestions = JSON.parse(fs.readFileSync(QUESTIONS_PATH, 'utf-8'));

  // 只保留有名词索引的问题
  const available = nounIndexRaw.question_indexes
    ? new Set(Object.keys(nounIndexRaw.question_indexes))
    : null;

  const questions = (available
    ? allQuestions.filter(q => available.has(q.id))
    : allQuestions
  ).filter(q => CONFIG.QUESTION_ID ? q.id === CONFIG.QUESTION_ID : true)
   .slice(CONFIG.OFFSET, CONFIG.OFFSET + CONFIG.LIMIT);

  console.log(`[DEBUG] available.size=${available ? available.size : 'N/A'}, afterFilter=${(available ? allQuestions.filter(q => available.has(q.id)) : allQuestions).length}, OFFSET=${CONFIG.OFFSET}, LIMIT=${CONFIG.LIMIT}, sliceLen=${(available ? allQuestions.filter(q => available.has(q.id)) : allQuestions).slice(CONFIG.OFFSET, CONFIG.OFFSET + CONFIG.LIMIT).length}`);

  console.log(`共 ${allQuestions.length} 题，可用 ${available ? available.size : allQuestions.length} 题，本次跑 ${questions.length} 题 (offset=${CONFIG.OFFSET}, limit=${CONFIG.LIMIT})`);
  console.log(`题目: ${questions.map(q => q.id).join(', ')}`);

  // 构建 chunk 映射
  const { chunkByKey } = loadDocuverse(DOCUVERSE_PATH);

  // 打印本次运行配置
  console.log('\n========== 运行配置 ==========');
  console.log(`Mode: ${CONFIG.MODE}`);
  console.log(`API: ${CONFIG.API_URL}`);
  console.log(`Model: ${CONFIG.MODEL}`);
  console.log(`API_KEY: ${CONFIG.API_KEY.slice(0, 8)}...`);
  console.log(`Output: ${CONFIG.OUTPUT_DIR}`);
  console.log(`Run Timestamp: ${CONFIG._runTimestamp}`);
  console.log(`Limit: ${CONFIG.LIMIT}`);
  console.log(`Offset: ${CONFIG.OFFSET}`);
  console.log(`Concurrency: ${CONFIG.CONCURRENCY}`);
  console.log(`Thinking (Recall): ${CONFIG.ENABLE_THINKING_RECALL}`);
  console.log(`Thinking (Reasoning): ${CONFIG.ENABLE_THINKING_REASONING}`);
  console.log(`Question ID: ${CONFIG.QUESTION_ID || 'all'}`);
  console.log('==============================\n');

  // 运行实验
  const summaries = {};
  summaries[CONFIG.MODE] = await runAblation(CONFIG.MODE, questions, nounIndexRaw, chunkByKey);

  // 对比结果
  console.log('\n========== 实验对比 ==========');
  for (const [mode, summary] of Object.entries(summaries)) {
    console.log(`${mode}: EM=${(summary.averageScore*100).toFixed(1)}% (${summary.exactMatches}/${summary.total})`);
  }
}

// 运行
main().catch(console.error);
