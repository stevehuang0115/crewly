/**
 * Domain SOP module — loads domain-specific standard operating procedures.
 *
 * Reads a markdown SOP file from config/domain-sops/{domainSOP}.sop.md
 * and injects it into the agent prompt as a constraint and procedure layer.
 * V1 scope: constraint and procedure layer only.
 *
 * Delegates to buildMarkdownFileModule for the shared read-file-and-format logic.
 */

import { buildMarkdownFileModule } from './markdown-file-module.js';
import type { PromptModule, ModuleConfig } from './prompt-module.interface.js';

const delegate = buildMarkdownFileModule({
	name: 'domain-sop',
	priority: 9,
	maxTokens: 800,
	compactable: true,
	configSubDir: 'domain-sops',
	fileExtension: '.sop.md',
	headingLabel: 'Domain SOP',
	missingFileHint: 'SOP file not found at',
	getConfigValue: (config) => config.domainSOP,
});

/**
 * Prompt module that loads domain-specific SOPs from disk.
 * Instantiable class wrapper around the shared markdown-file helper.
 */
export class DomainSOPModule implements PromptModule {
	name = delegate.name;
	priority = delegate.priority;
	maxTokens = delegate.maxTokens;
	compactable = delegate.compactable;

	/**
	 * Include this module only when a domainSOP name is configured.
	 *
	 * @param config - Module configuration with optional domainSOP field
	 * @returns True if domainSOP is set, false otherwise
	 */
	shouldInclude(config: ModuleConfig): boolean {
		return delegate.shouldInclude(config);
	}

	/**
	 * Build the domain SOP section by loading the corresponding markdown file.
	 *
	 * @param config - Module configuration containing domainSOP name and projectRoot
	 * @returns Formatted markdown section with SOP content or fallback message
	 */
	async build(config: ModuleConfig): Promise<string> {
		return delegate.build(config);
	}
}
