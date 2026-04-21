# Content Production Pipeline SOP

This SOP defines the standard process for end-to-end automation of social media content production, from trend analysis to final distribution, optimized for e-commerce and social media teams using Crewly.

## Scope
This procedure covers all recurring content creation tasks within the Crewly environment, including ideation, copywriting, visual asset production, quality assurance, and publishing handoff to Steve.

## Procedures

### Phase 1: Ideation
*   **Objective**: Identify high-converting hooks and content topics based on real-time market trends.
*   **Inputs**: Market trend data, brand pillars, previous post performance metrics.
*   **Outputs**: Content calendar entries with validated hooks and selected topics.
*   **Responsible Roles**: Content Strategist, Marketing Lead.
*   **Crewly Tools**: `trend-monitor` (for cross-platform trend scraping), `remote-browser` (for deep-dive research).
*   **Quality Gates**: Trend relevance score > 0.8; alignment with at least one core brand pillar.
*   **Estimated Duration**: 24 hours.

### Phase 2: Briefing & Drafting
*   **Objective**: Translate ideas into detailed creative briefs and high-quality captions.
*   **Inputs**: Selected hook and topic from Phase 1.
*   **Outputs**: 600+ word captions, visual direction briefs, and platform-specific drafts.
*   **Responsible Roles**: AI Copywriter (Content Writer), Brand Assistant.
*   **Crewly Tools**: `content-writer` (for initial drafts), `content-repurposer` (for cross-platform optimization).
*   **Quality Gates**: Brand voice match verification; keyword density check; hook-to-body transition flow.
*   **Estimated Duration**: 48 hours.

### Phase 3: Visual Production
*   **Objective**: Generate high-impact visual assets (images, videos, or Remotion templates).
*   **Inputs**: Visual direction brief from Phase 2.
*   **Outputs**: Ready-to-post image/video files (MP4, PNG, or JPG).
*   **Responsible Roles**: Visual Artist Agent, Video Production Agent.
*   **Crewly Tools**: `remotion-video` (for motion graphics), `nano-banana-image` (for AI image generation).
*   **Quality Gates**: Resolution (min 1080p); aspect ratio check (9:16 or 4:5); brand color palette adherence.
*   **Estimated Duration**: 72 hours.

### Phase 4: Review & Approval
*   **Objective**: Final quality check and human-in-the-loop (HITL) sign-off.
*   **Inputs**: Draft assets and captions from Phases 2 & 3.
*   **Outputs**: Approved content package ready for distribution.
*   **Responsible Roles**: Quality Auditor (QA), Human Marketing Manager.
*   **Crewly Tools**: `submit-for-approval` (Slack Block Kit integration), `screenshot-compare` (for visual parity check).
*   **Quality Gates**: Zero typos; asset-caption synchronization; final human approval via Slack.
*   **Estimated Duration**: 24 hours.

### Phase 5: Publishing Handoff (HUMAN-ONLY)
*   **Objective**: Package approved content and deliver to Steve for manual publishing on all platforms.
*   **Inputs**: Approved content package from Phase 4.
*   **Outputs**: Publishing-ready package delivered to Steve via Slack, with all text, visuals, and platform-specific formatting.
*   **Responsible Roles**: Marketing Lead (prepares handoff package), **Steve (publishes — ONLY Steve may publish)**.
*   **Crewly Tools**: `reply-slack` (to deliver content package to Steve), `content-calendar` (for scheduling recommendations).
*   **Quality Gates**: All assets attached; platform-specific formatting verified; Steve confirms receipt.
*   **Estimated Duration**: Dependent on Steve's availability.
*   **⚠️ CRITICAL RULE**: Agents must NEVER publish content directly to any platform (X, LinkedIn, XHS, or any other). No exceptions. All publishing is done manually by Steve. Agents who attempt to publish directly are violating this SOP.

## Success Metrics
- **Throughput**: 5+ high-quality posts per week per platform.
- **Engagement**: Average engagement rate > 3% within first 48 hours.
- **Efficiency**: < 10% rejection rate from Human Marketing Manager.
- **Brand Consistency**: 95%+ brand voice alignment score via AI auditor.

## Constraints (V1)
- **ALL content publishing on ALL platforms must be done manually by Steve. Agents are NEVER allowed to publish directly — no exceptions.** This applies to X/Twitter, LinkedIn, XHS, Instagram, TikTok, and any other platform.
- Agents may only: create content, format it, and deliver the final package to Steve via Slack.
- Agents must NOT use `remote-browser` or any other tool to post, submit, or publish content on any platform.
- All AI-generated captions must be passed through a brand-voice filter before human review.

## Escalation Rules
- **Escalate to Marketing Lead**: If creative briefs are rejected by AI agents 3+ times.
- **Escalate to Orchestrator**: If visual production tools (e.g., Remotion) encounter runtime errors.
- **Escalate to Human (CEO/Admin)**: If distribution fails on more than two scheduled platforms simultaneously.

## Maintenance
- This SOP is reviewed monthly by the Content Strategist.
- Updates to tool names and parameters must be synchronized with the `AGENT_SKILLS_CATALOG.md`.
- Brand voice filters should be retrained quarterly using the latest high-performing content.
