/**
 * Base helper for prompt modules that load a markdown file from disk.
 *
 * DomainSOPModule and RiskPolicyModule share identical structure:
 *   1. Check a config key to decide shouldInclude
 *   2. Build a path from projectRoot + subDir + configValue
 *   3. Read the file, format with a heading, or return a fallback
 *
 * This helper captures that pattern so each concrete module only
 * supplies metadata (name, priority, heading label, config key, etc.).
 *
 * @module services/ai/prompt-modules/markdown-file-module
 */

import * as fs from 'fs';
import * as path from 'path';
import { PromptModule, ModuleConfig } from './prompt-module.interface.js';

/**
 * Descriptor for a markdown-file-based prompt module.
 * Concrete modules provide this to buildMarkdownFileModule().
 */
export interface MarkdownFileModuleDescriptor {
	/** Module name used for logging */
	name: string;
	/** Assembly priority (lower = earlier) */
	priority: number;
	/** Token soft cap */
	maxTokens: number;
	/** Whether the module can be trimmed under token pressure */
	compactable: boolean;
	/** Sub-directory under config/ where files live (e.g. 'domain-sops') */
	configSubDir: string;
	/** File extension including the dot (e.g. '.sop.md') */
	fileExtension: string;
	/** Heading label used in output (e.g. 'Domain SOP') */
	headingLabel: string;
	/** Fallback description shown when file is missing */
	missingFileHint: string;
	/** Extracts the config value that determines inclusion and file lookup */
	getConfigValue: (config: ModuleConfig) => string | undefined;
}

/**
 * Build a PromptModule from a MarkdownFileModuleDescriptor.
 *
 * @param descriptor - Module metadata and behavior hooks
 * @returns A fully implemented PromptModule
 */
export function buildMarkdownFileModule(descriptor: MarkdownFileModuleDescriptor): PromptModule {
	return {
		name: descriptor.name,
		priority: descriptor.priority,
		maxTokens: descriptor.maxTokens,
		compactable: descriptor.compactable,

		shouldInclude(config: ModuleConfig): boolean {
			return !!descriptor.getConfigValue(config);
		},

		async build(config: ModuleConfig): Promise<string> {
			const value = descriptor.getConfigValue(config)!;
			const filePath = path.join(
				config.projectRoot,
				'config',
				descriptor.configSubDir,
				`${value}${descriptor.fileExtension}`,
			);

			try {
				const content = fs.readFileSync(filePath, 'utf-8').trim();
				return `## ${descriptor.headingLabel}: ${value}\n\n${content}`;
			} catch {
				return `## ${descriptor.headingLabel}: ${value}\n\n_${descriptor.missingFileHint} ${filePath}. Create it to define ${descriptor.headingLabel.toLowerCase()}-specific procedures._`;
			}
		},
	};
}
