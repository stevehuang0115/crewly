import * as fs from 'fs';
import * as path from 'path';
import { PromptModule, ModuleConfig } from './prompt-module.interface.js';

/**
 * Risk Policy module — loads risk-specific policy documents.
 *
 * Reads a markdown policy file from config/risk-policies/{riskPolicy}.policy.md
 * and injects it into the agent prompt as a constraint layer.
 * V1 scope: constraint and procedure layer only.
 */
export class RiskPolicyModule implements PromptModule {
	name = 'risk-policy';
	priority = 10;
	maxTokens = 800;
	compactable = true;

	/**
	 * Include this module only when a riskPolicy name is configured.
	 *
	 * @param config - Module configuration with optional riskPolicy field
	 * @returns True if riskPolicy is set, false otherwise
	 */
	shouldInclude(config: ModuleConfig): boolean {
		return !!config.riskPolicy;
	}

	/**
	 * Build the risk policy section by loading the corresponding markdown file.
	 *
	 * Attempts to read config/risk-policies/{riskPolicy}.policy.md from the project root.
	 * Falls back to a placeholder message if the file does not exist.
	 *
	 * @param config - Module configuration containing riskPolicy name and projectRoot
	 * @returns Formatted markdown section with policy content or fallback message
	 */
	async build(config: ModuleConfig): Promise<string> {
		const policyPath = path.join(config.projectRoot, 'config', 'risk-policies', `${config.riskPolicy}.policy.md`);
		try {
			const content = fs.readFileSync(policyPath, 'utf-8').trim();
			return `## Risk Policy: ${config.riskPolicy}\n\n${content}`;
		} catch {
			return `## Risk Policy: ${config.riskPolicy}\n\n_Policy file not found at ${policyPath}. Create it to define risk-specific procedures._`;
		}
	}
}
