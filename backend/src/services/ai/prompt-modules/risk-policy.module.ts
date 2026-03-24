/**
 * Risk Policy module — loads risk-specific policy documents.
 *
 * Reads a markdown policy file from config/risk-policies/{riskPolicy}.policy.md
 * and injects it into the agent prompt as a constraint layer.
 * V1 scope: constraint and procedure layer only.
 *
 * Delegates to buildMarkdownFileModule for the shared read-file-and-format logic.
 */

import { buildMarkdownFileModule } from './markdown-file-module.js';
import type { PromptModule, ModuleConfig } from './prompt-module.interface.js';

const delegate = buildMarkdownFileModule({
	name: 'risk-policy',
	priority: 10,
	maxTokens: 800,
	compactable: true,
	configSubDir: 'risk-policies',
	fileExtension: '.policy.md',
	headingLabel: 'Risk Policy',
	missingFileHint: 'Policy file not found at',
	getConfigValue: (config) => config.riskPolicy,
});

/**
 * Prompt module that loads risk-specific policies from disk.
 * Instantiable class wrapper around the shared markdown-file helper.
 */
export class RiskPolicyModule implements PromptModule {
	name = delegate.name;
	priority = delegate.priority;
	maxTokens = delegate.maxTokens;
	compactable = delegate.compactable;

	/**
	 * Include this module only when a riskPolicy name is configured.
	 *
	 * @param config - Module configuration with optional riskPolicy field
	 * @returns True if riskPolicy is set, false otherwise
	 */
	shouldInclude(config: ModuleConfig): boolean {
		return delegate.shouldInclude(config);
	}

	/**
	 * Build the risk policy section by loading the corresponding markdown file.
	 *
	 * @param config - Module configuration containing riskPolicy name and projectRoot
	 * @returns Formatted markdown section with policy content or fallback message
	 */
	async build(config: ModuleConfig): Promise<string> {
		return delegate.build(config);
	}
}
