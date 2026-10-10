# SOP: Expert Mindset Distillation

**Version:** 1.0.0
**Owner:** Product Team (Mia)
**Scope:** Crewly Pro Core Methodology

## 1. Objective
This SOP standardizes the "expert mindset distillation" process: turning unstructured material from famous people and experts into a structured `Expert Profile` (MD + JSON) that Crewly can use, so Agents get high-quality mindset injection.

## 2. Inputs
- **Primary Source:** the expert's books (PDF/EPUB), public interview recordings or transcripts (Markdown/TXT).
- **Secondary Source:** media analysis articles, Wikipedia, YouTube video transcripts.
- **Tools:** 
  - Teacher Model: Claude 3.5 Sonnet (preferred) or GPT-4o.
  - Crewly Distiller CLI: `crewly-pro distill`.

## 3. Phases

### Phase 1: Data Preprocessing
- **Task:** filter out irrelevant material (ads, small talk, repeated passages).
- **Standard:** keep only the core text that contains "decision logic", "values", "industry insights" and "language style".
- **Output:** the cleaned text file (`raw_distill_input.txt`).

### Phase 2: Mindset Extraction
- **Task:** run the Distillation Prompt with the Teacher Model.
- **Prompt:**
  ```markdown
  # SYSTEM PROMPT: Expert Mindset Distiller
  You are a top-tier "mindset modeling expert". Your goal is to analyze the provided expert material and extract the underlying "thinking software".
  
  ## Dimensions to extract:
  1. **Mental Models:** the core frameworks the expert uses often (e.g. first principles, the 80/20 rule).
  2. **Decision Logic:** how the expert weighs risk, handles trade-offs, and evaluates short- vs long-term benefit.
  3. **Industry Insights:** the expert's distinctive "counter-intuitive" views on a specific field.
  4. **Communication Style:** filler words, signature phrases, the structure of their argumentation.

  ## Constraints:
  - Describe from an analytical, calm third-person perspective; do not imitate their tone of voice.
  - The extracted mental models must be "actionable", i.e. an Agent can cite them while executing tasks.
  ```
- **Output:** the expert mindset draft (`{expert-id}-draft.md`).

### Phase 3: Formatting and JSON Metadata (Synthesis)
- **Task:** turn the draft into standard Markdown and generate the metadata JSON.
- **JSON spec:** see `config/experts/EXAMPLE.json`.
- **MD spec:** see `config/experts/EXAMPLE.md`.

### Phase 4: OSS/Pro Boundary (Security & Packaging)
- **Task:** package according to the distribution channel.
- **OSS:**
  - MD file only.
  - Stored in `config/experts/`.
- **Pro:**
  - MD + JSON.
  - Includes a preset `intensity` value.
  - Stored in `crewly-pro/data/experts/`.
  - Must pass the `LicenseValidator` check.

### Phase 5: Quality Gates
- **Round 1 (Self):** the distiller checks that the logic is self-consistent.
- **Round 2 (Peer):** another PM or expert reviews whether the extracted models capture the essence.
- **Round 3 (Test):** inject the Profile into an Agent and run a prompt stress test on 3 standard tasks.

## 4. Outputs
- `config/experts/{id}.md`
- `crewly-pro/data/experts/{id}.json` (Pro Only)

## 5. KPIs
- **Accuracy:** the distilled model accurately predicts the expert's decision tendencies in 80% of common business scenarios.
- **Utility:** after an Agent uses the template, its professional rating in the specific domain improves by ≥ 20%.
