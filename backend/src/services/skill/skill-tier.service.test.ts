/**
 * Tests for SkillTierService
 *
 * Covers tier comparison, skill resolution with degradation,
 * and degradation notice generation.
 */

// Uses jest (project standard), not vitest
import {
	SkillTierService,
	getSkillTierService,
	resetSkillTierService,
	SkillTierInfo,
	ResolvedSkillSet,
	DegradedSkill,
} from './skill-tier.service.js';
import { CLOUD_CONSTANTS, CloudTier } from '../../constants.js';

const { FREE, PRO, ENTERPRISE } = CLOUD_CONSTANTS.TIERS;

describe('SkillTierService', () => {
	let service: SkillTierService;

	beforeEach(() => {
		resetSkillTierService();
		service = getSkillTierService();
	});

	describe('singleton', () => {
		it('should return the same instance on multiple calls', () => {
			const instance1 = getSkillTierService();
			const instance2 = getSkillTierService();
			expect(instance1).toBe(instance2);
		});

		it('should return a new instance after reset', () => {
			const instance1 = getSkillTierService();
			resetSkillTierService();
			const instance2 = getSkillTierService();
			expect(instance1).not.toBe(instance2);
		});

		it('should return same instance via static method and module function', () => {
			const viaStatic = SkillTierService.getInstance();
			const viaFunction = getSkillTierService();
			expect(viaStatic).toBe(viaFunction);
		});
	});

	describe('isTierSufficient', () => {
		it('should allow free tier for free-required skills', () => {
			expect(service.isTierSufficient(FREE, FREE)).toBe(true);
		});

		it('should allow pro tier for free-required skills', () => {
			expect(service.isTierSufficient(PRO, FREE)).toBe(true);
		});

		it('should allow enterprise tier for free-required skills', () => {
			expect(service.isTierSufficient(ENTERPRISE, FREE)).toBe(true);
		});

		it('should deny free tier for pro-required skills', () => {
			expect(service.isTierSufficient(FREE, PRO)).toBe(false);
		});

		it('should allow pro tier for pro-required skills', () => {
			expect(service.isTierSufficient(PRO, PRO)).toBe(true);
		});

		it('should allow enterprise tier for pro-required skills', () => {
			expect(service.isTierSufficient(ENTERPRISE, PRO)).toBe(true);
		});

		it('should deny free tier for enterprise-required skills', () => {
			expect(service.isTierSufficient(FREE, ENTERPRISE)).toBe(false);
		});

		it('should deny pro tier for enterprise-required skills', () => {
			expect(service.isTierSufficient(PRO, ENTERPRISE)).toBe(false);
		});

		it('should allow enterprise tier for enterprise-required skills', () => {
			expect(service.isTierSufficient(ENTERPRISE, ENTERPRISE)).toBe(true);
		});

		it('should treat unknown tier as free (level 0)', () => {
			expect(service.isTierSufficient('unknown' as CloudTier, FREE)).toBe(true);
			expect(service.isTierSufficient('unknown' as CloudTier, PRO)).toBe(false);
		});
	});

	describe('resolveSkills', () => {
		it('should resolve all free skills for a free user', () => {
			const skills: SkillTierInfo[] = [
				{ id: 'code-review', requiredTier: FREE },
				{ id: 'report-status', requiredTier: FREE },
			];
			const result = service.resolveSkills(skills, FREE);

			expect(result.skills).toHaveLength(2);
			expect(result.skills[0]).toEqual({ id: 'code-review', source: 'direct' });
			expect(result.skills[1]).toEqual({ id: 'report-status', source: 'direct' });
			expect(result.degraded).toHaveLength(0);
		});

		it('should treat skills with no requiredTier as free', () => {
			const skills: SkillTierInfo[] = [
				{ id: 'basic-skill' },
			];
			const result = service.resolveSkills(skills, FREE);

			expect(result.skills).toHaveLength(1);
			expect(result.skills[0]).toEqual({ id: 'basic-skill', source: 'direct' });
			expect(result.degraded).toHaveLength(0);
		});

		it('should degrade pro skills to fallback for free user', () => {
			const skills: SkillTierInfo[] = [
				{ id: 'advanced-code-review', requiredTier: PRO, fallbackSkill: 'code-review' },
			];
			const result = service.resolveSkills(skills, FREE);

			expect(result.skills).toHaveLength(1);
			expect(result.skills[0]).toEqual({ id: 'code-review', source: 'degraded' });
			expect(result.degraded).toHaveLength(1);
			expect(result.degraded[0]).toEqual({
				original: 'advanced-code-review',
				fallback: 'code-review',
				requiredTier: PRO,
			});
		});

		it('should remove pro skills without fallback for free user', () => {
			const skills: SkillTierInfo[] = [
				{ id: 'security-scan', requiredTier: PRO },
			];
			const result = service.resolveSkills(skills, FREE);

			expect(result.skills).toHaveLength(0);
			expect(result.degraded).toHaveLength(1);
			expect(result.degraded[0]).toEqual({
				original: 'security-scan',
				fallback: null,
				requiredTier: PRO,
			});
		});

		it('should allow all skills for enterprise user', () => {
			const skills: SkillTierInfo[] = [
				{ id: 'code-review', requiredTier: FREE },
				{ id: 'advanced-code-review', requiredTier: PRO, fallbackSkill: 'code-review' },
				{ id: 'compliance-checker', requiredTier: ENTERPRISE },
			];
			const result = service.resolveSkills(skills, ENTERPRISE);

			expect(result.skills).toHaveLength(3);
			expect(result.skills.every(s => s.source === 'direct')).toBe(true);
			expect(result.degraded).toHaveLength(0);
		});

		it('should handle mixed tiers for a pro user', () => {
			const skills: SkillTierInfo[] = [
				{ id: 'code-review', requiredTier: FREE },
				{ id: 'advanced-code-review', requiredTier: PRO },
				{ id: 'compliance-checker', requiredTier: ENTERPRISE, fallbackSkill: 'basic-compliance' },
				{ id: 'audit-trail', requiredTier: ENTERPRISE },
			];
			const result = service.resolveSkills(skills, PRO);

			expect(result.skills).toHaveLength(3);
			expect(result.skills[0]).toEqual({ id: 'code-review', source: 'direct' });
			expect(result.skills[1]).toEqual({ id: 'advanced-code-review', source: 'direct' });
			expect(result.skills[2]).toEqual({ id: 'basic-compliance', source: 'degraded' });

			expect(result.degraded).toHaveLength(2);
			expect(result.degraded[0].original).toBe('compliance-checker');
			expect(result.degraded[0].fallback).toBe('basic-compliance');
			expect(result.degraded[1].original).toBe('audit-trail');
			expect(result.degraded[1].fallback).toBeNull();
		});

		it('should handle empty skill list', () => {
			const result = service.resolveSkills([], FREE);

			expect(result.skills).toHaveLength(0);
			expect(result.degraded).toHaveLength(0);
		});

		it('should preserve order of resolved skills', () => {
			const skills: SkillTierInfo[] = [
				{ id: 'alpha' },
				{ id: 'beta', requiredTier: PRO, fallbackSkill: 'beta-free' },
				{ id: 'gamma' },
			];
			const result = service.resolveSkills(skills, FREE);

			expect(result.skills.map(s => s.id)).toEqual(['alpha', 'beta-free', 'gamma']);
		});

		it('should not deduplicate fallback skills that match other direct skills', () => {
			const skills: SkillTierInfo[] = [
				{ id: 'code-review', requiredTier: FREE },
				{ id: 'advanced-code-review', requiredTier: PRO, fallbackSkill: 'code-review' },
			];
			const result = service.resolveSkills(skills, FREE);

			// Both the direct and fallback appear — dedup is the caller's responsibility
			expect(result.skills).toHaveLength(2);
			expect(result.skills[0]).toEqual({ id: 'code-review', source: 'direct' });
			expect(result.skills[1]).toEqual({ id: 'code-review', source: 'degraded' });
		});
	});

	describe('buildDegradationNotice', () => {
		it('should return empty string when no degraded skills', () => {
			const notice = service.buildDegradationNotice([], FREE);
			expect(notice).toBe('');
		});

		it('should include fallback info for degraded skills with fallback', () => {
			const degraded: DegradedSkill[] = [
				{ original: 'advanced-code-review', fallback: 'code-review', requiredTier: PRO },
			];
			const notice = service.buildDegradationNotice(degraded, FREE);

			expect(notice).toContain('## Premium Skills Notice');
			expect(notice).toContain('**free** tier');
			expect(notice).toContain('**advanced-code-review**');
			expect(notice).toContain('downgraded to `code-review`');
			expect(notice).toContain('requires pro');
			expect(notice).toContain('crewlyai.com/pricing');
		});

		it('should show "not available" for degraded skills without fallback', () => {
			const degraded: DegradedSkill[] = [
				{ original: 'security-scan', fallback: null, requiredTier: PRO },
			];
			const notice = service.buildDegradationNotice(degraded, FREE);

			expect(notice).toContain('**security-scan**');
			expect(notice).toContain('not available');
			expect(notice).toContain('requires pro');
		});

		it('should list multiple degraded skills', () => {
			const degraded: DegradedSkill[] = [
				{ original: 'advanced-code-review', fallback: 'code-review', requiredTier: PRO },
				{ original: 'auto-deploy', fallback: null, requiredTier: PRO },
				{ original: 'compliance-checker', fallback: 'basic-compliance', requiredTier: ENTERPRISE },
			];
			const notice = service.buildDegradationNotice(degraded, FREE);

			expect(notice).toContain('**advanced-code-review**');
			expect(notice).toContain('**auto-deploy**');
			expect(notice).toContain('**compliance-checker**');
			expect(notice).toContain('downgraded to `code-review`');
			expect(notice).toContain('downgraded to `basic-compliance`');
			// auto-deploy has no fallback
			const autoDeployLine = notice.split('\n').find(l => l.includes('auto-deploy'));
			expect(autoDeployLine).toContain('not available');
		});

		it('should display the user tier in the notice', () => {
			const degraded: DegradedSkill[] = [
				{ original: 'audit-trail', fallback: null, requiredTier: ENTERPRISE },
			];

			const noticeFree = service.buildDegradationNotice(degraded, FREE);
			expect(noticeFree).toContain('**free** tier');

			const noticePro = service.buildDegradationNotice(degraded, PRO);
			expect(noticePro).toContain('**pro** tier');
		});
	});

	describe('end-to-end: resolveSkills + buildDegradationNotice', () => {
		it('should produce correct notice from resolution result', () => {
			const skills: SkillTierInfo[] = [
				{ id: 'report-status' },
				{ id: 'advanced-code-review', requiredTier: PRO, fallbackSkill: 'code-review' },
				{ id: 'auto-deploy', requiredTier: PRO },
				{ id: 'compliance-checker', requiredTier: ENTERPRISE, fallbackSkill: 'basic-compliance' },
			];

			const result = service.resolveSkills(skills, FREE);
			const notice = service.buildDegradationNotice(result.degraded, FREE);

			// Resolved: report-status (direct), code-review (degraded), basic-compliance (degraded)
			expect(result.skills).toHaveLength(3);

			// Notice should list all 3 degraded
			expect(result.degraded).toHaveLength(3);
			expect(notice).toContain('advanced-code-review');
			expect(notice).toContain('auto-deploy');
			expect(notice).toContain('compliance-checker');
			expect(notice).toContain('crewlyai.com/pricing');
		});

		it('should produce no notice for enterprise user', () => {
			const skills: SkillTierInfo[] = [
				{ id: 'advanced-code-review', requiredTier: PRO },
				{ id: 'compliance-checker', requiredTier: ENTERPRISE },
			];

			const result = service.resolveSkills(skills, ENTERPRISE);
			const notice = service.buildDegradationNotice(result.degraded, ENTERPRISE);

			expect(result.skills).toHaveLength(2);
			expect(result.degraded).toHaveLength(0);
			expect(notice).toBe('');
		});
	});
});
