import * as fs from 'fs';
import * as path from 'path';
import { PromptModule, ModuleConfig } from './prompt-module.interface.js';

/**
 * Domain SOP module — loads domain-specific standard operating procedures.
 *
 * Reads a markdown SOP file from config/domain-sops/{domainSOP}.sop.md
 * and injects it into the agent prompt as a constraint and procedure layer.
 * V1 scope: constraint and procedure layer only.
 */
export class DomainSOPModule implements PromptModule {
	name = 'domain-sop';
	priority = 9;
	maxTokens = 800;
	compactable = true;

	/**
	 * Include this module only when a domainSOP name is configured.
	 *
	 * @param config - Module configuration with optional domainSOP field
	 * @returns True if domainSOP is set, false otherwise
	 */
	shouldInclude(config: ModuleConfig): boolean {
		return !!config.domainSOP;
	}

	/**
	 * Build the domain SOP section by loading the corresponding markdown file.
	 *
	 * Attempts to read config/domain-sops/{domainSOP}.sop.md from the project root.
	 * Falls back to a placeholder message if the file does not exist.
	 *
	 * @param config - Module configuration containing domainSOP name and projectRoot
	 * @returns Formatted markdown section with SOP content or fallback message
	 */
	async build(config: ModuleConfig): Promise<string> {
		const sopPath = path.join(config.projectRoot, 'config', 'domain-sops', `${config.domainSOP}.sop.md`);
		try {
			const content = fs.readFileSync(sopPath, 'utf-8').trim();
			return `## Domain SOP: ${config.domainSOP}\n\n${content}`;
		} catch {
			return `## Domain SOP: ${config.domainSOP}\n\n_SOP file not found at ${sopPath}. Create it to define domain-specific procedures._`;
		}
	}
}
