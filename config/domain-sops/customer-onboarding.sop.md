# Customer Onboarding SOP

This SOP outlines the standard process for onboarding new service-business clients into the Crewly ecosystem, ensuring a rapid transition from contract signature to first value delivery.

## Scope
This procedure applies to all new service-business clients and covers kickoff communication, discovery, technical provisioning, and early-stage project execution.

## Procedures

### Phase 1: Kickoff
*   **Objective**: Establish a professional connection and deliver the "Welcome Kit."
*   **Inputs**: Signed service contract, client contact information.
*   **Outputs**: Sent Welcome Kit, scheduled kickoff call, project workspace initialized.
*   **Responsible Roles**: Account Manager, Onboarding Coordinator.
*   **Crewly Tools**: `send-message` (automated welcome email/Slack), `reply-chat` (for internal coordination).
*   **Quality Gates**: Contact confirmed by client; kickoff call scheduled within 48 hours of contract signature.
*   **Estimated Duration**: 48 hours.

### Phase 2: Discovery
*   **Objective**: Perform a comprehensive audit of client brand assets and project requirements.
*   **Inputs**: Client website URL, existing brand style guides, historical performance data.
*   **Outputs**: Discovery Audit Document, finalized project scope, asset gap report.
*   **Responsible Roles**: Strategist, Brand Auditor.
*   **Crewly Tools**: `remote-browser` (for website/competitor audit), `recall` (to cross-reference industry patterns).
*   **Quality Gates**: All mandatory brand assets (logo, font, colors) verified; scope of work signed off by client.
*   **Estimated Duration**: 1 week.

### Phase 3: Provisioning
*   **Objective**: Set up the specialized AI Team and project architecture in Crewly.
*   **Inputs**: Discovery Audit Document, approved project scope.
*   **Outputs**: Active AI Team (Agents + Skills), configured project directory, initial goal set.
*   **Responsible Roles**: DevOps Agent, Orchestrator.
*   **Crewly Tools**: `register-self` (for new agent initialization), `remember` (to store project-specific norms and keys), `create-task` (for initial setup work).
*   **Quality Gates**: All required skills (e.g., specific platform scrapers) tested and active; project goals recorded in `.crewly/goals/`.
*   **Estimated Duration**: 48 hours.

### Phase 4: Value Delivery (The "Quick Win")
*   **Objective**: Execute and deliver the first high-impact project item to demonstrate immediate value.
*   **Inputs**: Priority task from the discovery phase.
*   **Outputs**: First deliverable (e.g., sample content, initial audit report, or automation script).
*   **Responsible Roles**: Dedicated Execution Agent, QA Auditor.
*   **Crewly Tools**: `create-task` (for delegation), `report-status` (real-time progress updates to client).
*   **Quality Gates**: Deliverable passes internal QA; client confirms "Value Received" via feedback loop.
*   **Estimated Duration**: 1 week.

### Phase 5: Evaluation
*   **Objective**: Gather onboarding feedback and lock the long-term project roadmap.
*   **Inputs**: Delivery results from Phase 4, client feedback notes.
*   **Outputs**: Post-onboarding sentiment report, locked 90-day roadmap, transitioned to "Ongoing Management" status.
*   **Responsible Roles**: Account Manager, Strategist.
*   **Crewly Tools**: `feedback-analyzer` (to extract actionable insights), `record-learning` (to document client preferences).
*   **Quality Gates**: Positive sentiment score > 0.7; 90-day roadmap approved by client.
*   **Estimated Duration**: 72 hours.

## Success Metrics
- **Time-to-Value (TTV)**: < 14 days from contract signature to first "Quick Win" delivery.
- **Onboarding NPS**: Average score > 8.5.
- **Provisioning Accuracy**: Zero skill-compatibility errors during Phase 3.
- **Client Engagement**: 100% attendance on scheduled kickoff and evaluation calls.

## Constraints (V1)
- No technical provisioning (Phase 3) should occur before discovery sign-off (Phase 2).
- Client credentials must be stored exclusively in secured environment variables or encrypted memory.
- All "Quick Win" deliverables must undergo a mandatory human-led quality check before delivery.

## Escalation Rules
- **Escalate to Team Lead**: If client fails to provide mandatory brand assets within 5 business days.
- **Escalate to Orchestrator**: If initial provisioning encounters skill-compatibility conflicts.
- **Escalate to Human (Sales/BD)**: If client expresses significant dissatisfaction during the Phase 5 evaluation.

## Maintenance
- This SOP is reviewed quarterly by the Onboarding Lead.
- Provisioning templates should be updated as new AI agent roles are added to the marketplace.
- "Quick Win" examples are updated every 6 months based on client performance data.
