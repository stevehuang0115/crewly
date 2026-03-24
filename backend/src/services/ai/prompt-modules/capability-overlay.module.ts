import * as fs from 'fs';
import * as path from 'path';
import { PromptModule, ModuleConfig } from './prompt-module.interface.js';

/**
 * Capability Overlay module — generates a Decision Rights Matrix and loads capability overlays.
 *
 * Produces autonomy-level-specific decision rights and loads optional
 * capability overlay files from config/overlays/{capability}.md.
 * V1 is a CONSTRAINT layer, not an action authorization layer.
 */
export class CapabilityOverlayModule implements PromptModule {
	name = 'capability-overlay';
	priority = 7;
	maxTokens = 600;
	compactable = true;

	/**
	 * Include when autonomyLevel is not 'directed' (and not undefined),
	 * or when capabilities array has entries.
	 *
	 * @param config - Module configuration with optional autonomyLevel and capabilities
	 * @returns True if the module should be included in the prompt
	 */
	shouldInclude(config: ModuleConfig): boolean {
		const hasCapabilities = Array.isArray(config.capabilities) && config.capabilities.length > 0;
		const hasNonDirectedAutonomy = !!config.autonomyLevel && config.autonomyLevel !== 'directed';
		return hasNonDirectedAutonomy || hasCapabilities;
	}

	/**
	 * Build the capability overlay section with decision rights and capability files.
	 *
	 * Generates a Decision Rights Matrix based on the configured autonomy level,
	 * then appends any capability overlay files found in config/overlays/.
	 *
	 * @param config - Module configuration containing autonomyLevel, capabilities, and projectRoot
	 * @returns Formatted markdown section with decision rights and capability overlays
	 */
	async build(config: ModuleConfig): Promise<string> {
		// V1 is a CONSTRAINT layer, not an action authorization layer
		const sections: string[] = ['## Capability Overlay'];

		if (config.autonomyLevel === 'bounded') {
			sections.push(`### Decision Rights: Bounded Autonomy
- Make decisions within your assigned task and domain scope
- Log your reasoning for every non-trivial decision
- Escalate when risk or ambiguity exceeds your domain boundaries
- You may NOT: auto-deploy, modify production, or communicate directly with users`);
		} else if (config.autonomyLevel === 'domain_autonomous') {
			sections.push(`### Decision Rights: Domain Autonomous
- Monitor your domain continuously
- Make pre-approved decisions within your domain without waiting for delegation
- Log reasoning AND outcome for every autonomous decision
- Escalate: anomalies, threshold breaches, anything outside defined domain scope
- You may NOT: take actions outside your domain SOP, skip logging, ignore risk policy`);
		}

		if (Array.isArray(config.capabilities) && config.capabilities.length > 0) {
			sections.push('### Capability Overlays');
			for (const capability of config.capabilities) {
				const overlayPath = path.join(config.projectRoot, 'config', 'overlays', `${capability}.md`);
				try {
					const content = fs.readFileSync(overlayPath, 'utf-8').trim();
					sections.push(content);
				} catch {
					sections.push(`- **${capability}**: (no overlay file found)`);
				}
			}
		}

		return sections.join('\n\n');
	}
}
