/**
 * Brand Onboarding Service for Marketing Team templates.
 *
 * Manages the onboarding questionnaire flow that collects brand information
 * from SMB owners and generates a Brand Voice Guide. Supports two channels:
 *   - CLI: Interactive readline-based questionnaire
 *   - Programmatic: Step-by-step answer submission via API
 *
 * The generated Brand Voice Guide is stored in the team's knowledge directory
 * and used by all marketing agents to maintain brand consistency.
 *
 * @module brand-onboarding-service
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import {
  BrandProfile,
  DEFAULT_CONTENT_MIX,
  GenerateGuideOptions,
  ONBOARDING_QUESTIONS,
  OnboardingAnswer,
  OnboardingQuestion,
  OnboardingSession,
  OnboardingStatus,
} from './brand-onboarding.types.js';

// =============================================================================
// Constants
// =============================================================================

/** Directory name for storing onboarding sessions. */
const ONBOARDING_DIR = 'onboarding';

/** File name for the generated Brand Voice Guide. */
const BRAND_VOICE_GUIDE_FILENAME = 'brand-voice-guide.md';

// =============================================================================
// Service
// =============================================================================

/**
 * Service that manages brand onboarding questionnaire sessions and
 * generates Brand Voice Guides for marketing team templates.
 *
 * Follows the singleton pattern for consistency with other Crewly services.
 */
export class BrandOnboardingService {
  private static instance: BrandOnboardingService | null = null;
  private sessions: Map<string, OnboardingSession> = new Map();
  private crewlyHome: string;

  /**
   * Create a new BrandOnboardingService.
   *
   * @param crewlyHome - Path to the .crewly home directory (default: ~/.crewly)
   */
  constructor(crewlyHome?: string) {
    this.crewlyHome = crewlyHome ?? join(
      process.env.HOME ?? process.env.USERPROFILE ?? '.',
      '.crewly'
    );
  }

  /**
   * Get or create the singleton instance.
   *
   * @param crewlyHome - Optional override for .crewly home path
   * @returns Singleton instance
   */
  static getInstance(crewlyHome?: string): BrandOnboardingService {
    if (!BrandOnboardingService.instance) {
      BrandOnboardingService.instance = new BrandOnboardingService(crewlyHome);
    }
    return BrandOnboardingService.instance;
  }

  /**
   * Reset the singleton (for testing).
   */
  static resetInstance(): void {
    BrandOnboardingService.instance = null;
  }

  // ---------------------------------------------------------------------------
  // Session Management
  // ---------------------------------------------------------------------------

  /**
   * Start a new onboarding session for a team.
   *
   * @param teamId - The team this onboarding belongs to
   * @param templateId - The template that triggered onboarding
   * @returns The created onboarding session
   */
  startSession(teamId: string, templateId: string): OnboardingSession {
    const session: OnboardingSession = {
      id: randomUUID(),
      teamId,
      templateId,
      status: 'in_progress',
      answers: [],
      currentQuestionIndex: 0,
      totalQuestions: ONBOARDING_QUESTIONS.length,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.sessions.set(session.id, session);
    this.persistSession(session);
    return session;
  }

  /**
   * Get an existing onboarding session.
   *
   * @param sessionId - Session identifier
   * @returns The session or null if not found
   */
  getSession(sessionId: string): OnboardingSession | null {
    return this.sessions.get(sessionId) ?? this.loadSession(sessionId);
  }

  /**
   * Get the current question for a session.
   *
   * @param sessionId - Session identifier
   * @returns The current question or null if session complete/not found
   */
  getCurrentQuestion(sessionId: string): OnboardingQuestion | null {
    const session = this.getSession(sessionId);
    if (!session || session.status !== 'in_progress') return null;
    if (session.currentQuestionIndex >= ONBOARDING_QUESTIONS.length) return null;
    return ONBOARDING_QUESTIONS[session.currentQuestionIndex];
  }

  /**
   * Submit an answer to the current question and advance to the next.
   *
   * @param sessionId - Session identifier
   * @param value - The answer value
   * @returns Updated session with next question index, or null if session not found
   * @throws Error if answer validation fails
   */
  submitAnswer(sessionId: string, value: string): OnboardingSession | null {
    const session = this.getSession(sessionId);
    if (!session) return null;
    if (session.status !== 'in_progress') return session;

    const question = ONBOARDING_QUESTIONS[session.currentQuestionIndex];
    if (!question) return session;

    // Validate required fields
    const trimmedValue = value.trim();
    if (question.required && !trimmedValue) {
      throw new Error(`Answer to "${question.text}" is required.`);
    }

    // Record the answer
    const answer: OnboardingAnswer = {
      questionId: question.id,
      value: trimmedValue || question.defaultValue || '',
      answeredAt: new Date().toISOString(),
    };

    session.answers.push(answer);
    session.currentQuestionIndex += 1;
    session.updatedAt = new Date().toISOString();

    // Check if all questions answered
    if (session.currentQuestionIndex >= ONBOARDING_QUESTIONS.length) {
      session.status = 'completed';
    }

    this.sessions.set(session.id, session);
    this.persistSession(session);
    return session;
  }

  /**
   * Submit all answers at once (batch mode for programmatic use).
   *
   * @param sessionId - Session identifier
   * @param answers - Map of questionId → answer value
   * @returns Updated session
   */
  submitAllAnswers(
    sessionId: string,
    answers: Record<string, string>
  ): OnboardingSession | null {
    const session = this.getSession(sessionId);
    if (!session) return null;

    for (const question of ONBOARDING_QUESTIONS) {
      const value = answers[question.id] ?? question.defaultValue ?? '';
      if (question.required && !value.trim()) {
        throw new Error(`Answer to "${question.text}" is required.`);
      }

      session.answers.push({
        questionId: question.id,
        value: value.trim(),
        answeredAt: new Date().toISOString(),
      });
    }

    session.currentQuestionIndex = ONBOARDING_QUESTIONS.length;
    session.status = 'completed';
    session.updatedAt = new Date().toISOString();
    this.sessions.set(session.id, session);
    this.persistSession(session);
    return session;
  }

  // ---------------------------------------------------------------------------
  // Brand Profile Extraction
  // ---------------------------------------------------------------------------

  /**
   * Extract a structured BrandProfile from onboarding answers.
   *
   * @param session - Completed onboarding session with all answers
   * @returns Structured brand profile
   * @throws Error if session is not completed
   */
  extractBrandProfile(session: OnboardingSession): BrandProfile {
    if (session.status !== 'completed' && session.status !== 'generating' && session.status !== 'done') {
      throw new Error('Cannot extract profile from incomplete session.');
    }

    const getAnswer = (questionId: string): string => {
      const answer = session.answers.find(a => a.questionId === questionId);
      return answer?.value ?? '';
    };

    return {
      businessName: getAnswer('business_name'),
      industry: getAnswer('industry'),
      description: getAnswer('description'),
      targetCustomer: getAnswer('target_customer'),
      competitors: getAnswer('competitors')
        .split(/[,;]/)
        .map(s => s.trim())
        .filter(Boolean),
      personality: getAnswer('personality')
        .split(/[,;]/)
        .map(s => s.trim())
        .filter(Boolean),
      tone: this.parseTone(getAnswer('tone')),
      goals: getAnswer('goals')
        .split(/[,;]/)
        .map(s => s.trim())
        .filter(Boolean),
      platforms: getAnswer('platforms')
        .split(/[,;]/)
        .map(s => s.trim())
        .filter(Boolean),
      contentExamples: getAnswer('content_examples')
        .split(/[,;]/)
        .map(s => s.trim())
        .filter(Boolean),
    };
  }

  // ---------------------------------------------------------------------------
  // Brand Voice Guide Generation
  // ---------------------------------------------------------------------------

  /**
   * Generate the Brand Voice Guide markdown file from a brand profile.
   *
   * This creates a structured markdown document that all marketing agents
   * reference to maintain brand consistency.
   *
   * @param options - Generation options including profile and output path
   * @returns Path to the generated guide file
   */
  generateBrandVoiceGuide(options: GenerateGuideOptions): string {
    const { profile, outputDir } = options;

    const guide = this.buildGuideMarkdown(profile);

    // Ensure output directory exists
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    const guidePath = join(outputDir, BRAND_VOICE_GUIDE_FILENAME);
    writeFileSync(guidePath, guide, 'utf-8');

    return guidePath;
  }

  /**
   * Complete the onboarding flow: extract profile, generate guide, update session.
   *
   * @param sessionId - Session identifier
   * @param teamKnowledgeDir - Path to the team's knowledge/docs/ directory
   * @returns Updated session with guidePath populated, or null if not found
   */
  completeOnboarding(
    sessionId: string,
    teamKnowledgeDir: string
  ): OnboardingSession | null {
    const session = this.getSession(sessionId);
    if (!session || session.status !== 'completed') return null;

    session.status = 'generating';
    session.updatedAt = new Date().toISOString();
    this.sessions.set(session.id, session);

    try {
      const profile = this.extractBrandProfile(session);
      const guidePath = this.generateBrandVoiceGuide({
        profile,
        outputDir: teamKnowledgeDir,
      });

      session.brandVoiceGuide = readFileSync(guidePath, 'utf-8');
      session.guidePath = guidePath;
      session.status = 'done';
      session.updatedAt = new Date().toISOString();
    } catch (error) {
      session.status = 'failed';
      session.error = error instanceof Error ? error.message : String(error);
      session.updatedAt = new Date().toISOString();
    }

    this.sessions.set(session.id, session);
    this.persistSession(session);
    return session;
  }

  /**
   * Get all questions for display.
   *
   * @returns All onboarding questions in order
   */
  getQuestions(): OnboardingQuestion[] {
    return [...ONBOARDING_QUESTIONS];
  }

  // ---------------------------------------------------------------------------
  // Private Helpers
  // ---------------------------------------------------------------------------

  /**
   * Build the Brand Voice Guide markdown content from a brand profile.
   *
   * @param profile - Structured brand profile
   * @returns Markdown string for the guide
   */
  private buildGuideMarkdown(profile: BrandProfile): string {
    const dosAndDonts = this.generateDosAndDonts(profile);
    const platformGuidelines = this.generatePlatformGuidelines(profile.platforms);

    return `# Brand Voice Guide — ${profile.businessName}

> Auto-generated by Crewly AI Marketing Team onboarding.
> Last updated: ${new Date().toISOString().split('T')[0]}

## Business Profile

- **Name**: ${profile.businessName}
- **Industry**: ${profile.industry}
- **Description**: ${profile.description}
- **Target Customer**: ${profile.targetCustomer}
- **Competitors**: ${profile.competitors.join(', ') || 'Not specified'}

## Brand Voice

- **Personality**: ${profile.personality.join(', ')}
- **Tone**: ${profile.tone.charAt(0).toUpperCase() + profile.tone.slice(1)}

### Do's
${dosAndDonts.dos.map(d => `- ${d}`).join('\n')}

### Don'ts
${dosAndDonts.donts.map(d => `- ${d}`).join('\n')}

## Content Strategy

- **Goals**: ${profile.goals.join(', ')}
- **Platforms**: ${profile.platforms.join(', ')}
- **Content Mix**: ${DEFAULT_CONTENT_MIX.educational}% Educational, ${DEFAULT_CONTENT_MIX.behindTheScenes}% Behind-the-scenes, ${DEFAULT_CONTENT_MIX.promotional}% Promotional, ${DEFAULT_CONTENT_MIX.interactive}% Interactive

${platformGuidelines}

## Style Examples

${profile.contentExamples.length > 0
    ? profile.contentExamples.map(ex => `- ${ex}`).join('\n')
    : '- No examples provided yet. Add references as you discover content you like.'}

## Writing Rules

1. Always write as if you ARE ${profile.businessName}, not about ${profile.businessName}.
2. Match the ${profile.tone} tone consistently across all platforms.
3. Use the brand personality (${profile.personality.join(', ')}) to guide word choices.
4. Never use generic AI cliches like "In today's digital landscape" or "Unlock the power of".
5. Every post must have a clear purpose: educate, entertain, sell, or engage.
6. Include a call-to-action in at least 50% of posts.
7. Use hashtags strategically — 3-5 for Twitter/X, 10-15 for Instagram, 2-3 for LinkedIn.
`;
  }

  /**
   * Generate Do's and Don'ts based on brand personality and tone.
   *
   * @param profile - Brand profile
   * @returns Object with dos and donts arrays
   */
  private generateDosAndDonts(profile: BrandProfile): { dos: string[]; donts: string[] } {
    const dos: string[] = [];
    const donts: string[] = [];

    // Tone-based rules
    switch (profile.tone) {
      case 'formal':
        dos.push('Use complete sentences and proper grammar');
        dos.push('Cite data and statistics to support claims');
        donts.push('Use slang, abbreviations, or internet speak');
        donts.push('Use excessive emojis (max 1 per post)');
        break;
      case 'casual':
        dos.push('Write like you are talking to a friend');
        dos.push('Use contractions and conversational language');
        donts.push('Be overly corporate or stiff');
        donts.push('Use jargon that your audience might not understand');
        break;
      case 'playful':
        dos.push('Use humor, wordplay, and pop culture references');
        dos.push('Include emojis to add personality');
        donts.push('Be serious or dry in tone');
        donts.push('Make jokes that could offend or alienate');
        break;
      case 'authoritative':
        dos.push('Lead with expertise and industry knowledge');
        dos.push('Share original insights and thought leadership');
        donts.push('Hedge or use uncertain language ("maybe", "perhaps")');
        donts.push('Copy competitor messaging or talking points');
        break;
    }

    // Universal rules
    dos.push('Stay consistent with the brand personality across all platforms');
    dos.push('Engage authentically with comments and messages');
    donts.push('Use generic AI-sounding language');
    donts.push('Post identical content across all platforms (adapt per platform)');

    return { dos, donts };
  }

  /**
   * Generate platform-specific content guidelines.
   *
   * @param platforms - List of active platforms
   * @returns Markdown string with platform guidelines
   */
  private generatePlatformGuidelines(platforms: string[]): string {
    const guidelines: string[] = ['## Platform Guidelines\n'];

    const platformRules: Record<string, string> = {
      'X (Twitter)': '- Max 280 characters. Punchy and engaging.\n- Use threads for longer content.\n- 3-5 relevant hashtags.\n- Best times: 9-11am, 1-3pm weekdays.',
      'LinkedIn': '- Professional tone. 1200-1500 characters optimal.\n- Start with a hook (first line is critical).\n- 2-3 hashtags max.\n- Best times: Tue-Thu 8-10am.',
      'Instagram': '- Conversational and visual-first.\n- Include emojis naturally.\n- 10-15 hashtags (mix of popular and niche).\n- Best times: 11am-1pm, 7-9pm.',
      'Facebook': '- Mix of content lengths.\n- Community-focused — ask questions.\n- 1-2 hashtags max (or none).\n- Best times: 1-4pm weekdays.',
    };

    for (const platform of platforms) {
      const rules = platformRules[platform];
      if (rules) {
        guidelines.push(`### ${platform}\n${rules}\n`);
      }
    }

    return guidelines.join('\n');
  }

  /**
   * Parse tone string to valid tone type.
   *
   * @param toneStr - Raw tone answer
   * @returns Normalized tone value
   */
  private parseTone(toneStr: string): 'formal' | 'casual' | 'playful' | 'authoritative' {
    const normalized = toneStr.toLowerCase().trim();
    if (['formal', 'casual', 'playful', 'authoritative'].includes(normalized)) {
      return normalized as 'formal' | 'casual' | 'playful' | 'authoritative';
    }
    return 'casual'; // Default fallback
  }

  /**
   * Persist session to disk for recovery.
   *
   * @param session - Session to save
   */
  private persistSession(session: OnboardingSession): void {
    try {
      const dir = join(this.crewlyHome, ONBOARDING_DIR);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const filePath = join(dir, `${session.id}.json`);
      writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');
    } catch {
      // Best-effort persistence — don't crash on write failure
    }
  }

  /**
   * Load a session from disk.
   *
   * @param sessionId - Session to load
   * @returns Loaded session or null
   */
  private loadSession(sessionId: string): OnboardingSession | null {
    try {
      const filePath = join(this.crewlyHome, ONBOARDING_DIR, `${sessionId}.json`);
      if (!existsSync(filePath)) return null;
      const data = JSON.parse(readFileSync(filePath, 'utf-8')) as OnboardingSession;
      this.sessions.set(data.id, data);
      return data;
    } catch {
      return null;
    }
  }
}
