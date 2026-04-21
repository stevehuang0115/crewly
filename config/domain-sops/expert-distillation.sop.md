# SOP: Expert Mindset Distillation (名人思维蒸馏)

**Version:** 1.0.0
**Owner:** Product Team (Mia)
**Scope:** Crewly Pro Core Methodology

## 1. 目标 (Objective)
本 SOP 旨在标准化「专家思维蒸馏」流程，将非结构化的名人/专家素材转化为 Crewly 可用的结构化 `Expert Profile` (MD + JSON)，从而为 Agent 提供高质量的思维注入。

## 2. 输入 (Inputs)
- **Primary Source:** 专家著作 (PDF/EPUB)、公开访谈录音或转录稿 (Markdown/TXT)。
- **Secondary Source:** 媒体分析文章、维基百科、YouTube 视频转录。
- **Tools:** 
  - Teacher Model: Claude 3.5 Sonnet (首选) 或 GPT-4o。
  - Crewly Distiller CLI: `crewly-pro distill`。

## 3. 流程阶段 (Phases)

### Phase 1: 素材清洗 (Data Preprocessing)
- **任务:** 过滤掉无关信息（广告、日常寒暄、重复片段）。
- **标准:** 仅保留包含「决策逻辑」、「价值观」、「行业洞察」和「语言风格」的核心文本。
- **输出:** 清洗后的文本文件 (`raw_distill_input.txt`)。

### Phase 2: 专家特征提取 (Mindset Extraction)
- **任务:** 使用 Teacher Model 执行蒸馏提示词 (Distillation Prompt)。
- **Prompt:**
  ```markdown
  # SYSTEM PROMPT: Expert Mindset Distiller
  你是一名顶级的「思维建模专家」。你的目标是分析提供的专家素材，提取其底层的「思维软件」。
  
  ## 提取维度:
  1. **Mental Models (思维模型):** 专家常用的核心框架（如第一性原理、二八定律）。
  2. **Decision Logic (决策逻辑):** 专家如何权衡风险、处理权衡、评估长短期利益。
  3. **Industry Insights (行业洞察):** 专家对特定领域的独特「反直觉」见解。
  4. **Communication Style (沟通风格):** 语气词、标志性短语、论证逻辑结构。

  ## 约束:
  - 必须使用分析性的、冷静的第三方视角描述，而非模仿其语气说话。
  - 提取的思维模型必须具有「可操作性」，即 Agent 可以在执行任务时引用。
  ```
- **输出:** 专家思维草稿 (`{expert-id}-draft.md`)。

### Phase 3: 格式化与 JSON 元数据生成 (Synthesis)
- **任务:** 将草稿整理为标准 Markdown 格式，并生成元数据 JSON。
- **JSON 规范:** 参考 `config/experts/EXAMPLE.json`。
- **MD 规范:** 参考 `config/experts/EXAMPLE.md`。

### Phase 4: OSS/Pro 边界处理 (Security & Packaging)
- **任务:** 根据分发渠道进行打包。
- **OSS:**
  - 仅包含 MD 文件。
  - 存储于 `config/experts/`。
- **Pro:**
  - 包含 MD + JSON。
  - 包含预设的 `intensity` 值。
  - 存储于 `crewly-pro/data/experts/`。
  - 必须通过 `LicenseValidator` 检查。

### Phase 5: 质量审核 (Quality Gates)
- **Round 1 (Self):** 蒸馏者检查逻辑是否自洽。
- **Round 2 (Peer):** 另一名 PM 或专家审核提取的模型是否抓住了本质。
- **Round 3 (Test):** 将 Profile 注入 Agent，进行 3 个标准任务的 Prompt 压力测试。

## 4. 交付物 (Outputs)
- `config/experts/{id}.md`
- `crewly-pro/data/experts/{id}.json` (Pro Only)

## 5. 质量指标 (KPIs)
- **Accuracy:** 蒸馏模型能准确预测专家在 80% 常见商业场景下的决策倾向。
- **Utility:** Agent 使用该模板后，在特定领域的专业评分提升 ≥ 20%。
