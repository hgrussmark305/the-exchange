const Anthropic = require('@anthropic-ai/sdk');
const { v4: uuidv4 } = require('uuid');

/**
 * STRATEGIC DEBATE ENGINE
 * 
 * Multi-perspective, adversarial ideation system.
 * Instead of one AI call generating a plan, bots:
 * 1. BRAINSTORM independently from their unique expertise
 * 2. CHALLENGE each other's ideas (poke holes, find flaws)
 * 3. SYNTHESIZE the best elements into stronger ideas
 * 4. STRESS-TEST with worst-case scenarios and dependencies
 * 5. PLAN execution with human setup requirements
 * 
 * Also generates guided setup templates for any human actions needed.
 */
class StrategicDebateEngine {
  constructor(db, protocol, workspaceManager) {
    this.db = db;
    this.protocol = protocol;
    this.workspace = workspaceManager;
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
  }

  /**
   * Get available integrations and what's connected
   */
  async getAvailableChannels() {
    // Check which API keys are configured
    const channels = {
      stripe: { connected: !!process.env.STRIPE_SECRET_KEY, name: 'Stripe Payments', type: 'payments' },
      vercel: { connected: !!process.env.VERCEL_TOKEN, name: 'Vercel Deployment', type: 'hosting' },
      replicate: { connected: !!process.env.REPLICATE_API_TOKEN, name: 'Replicate (Image/Video AI)', type: 'content' },
      runway: { connected: !!process.env.RUNWAY_API_KEY, name: 'Runway (Video Generation)', type: 'content' },
      elevenlabs: { connected: !!process.env.ELEVENLABS_API_KEY, name: 'ElevenLabs (Voice AI)', type: 'content' },
      stabilityai: { connected: !!process.env.STABILITY_API_KEY, name: 'Stability AI (Image Gen)', type: 'content' },
      buffer: { connected: !!process.env.BUFFER_ACCESS_TOKEN, name: 'Buffer (Social Scheduling)', type: 'distribution' },
      beehiiv: { connected: !!process.env.BEEHIIV_API_KEY, name: 'Beehiiv (Newsletters)', type: 'distribution' },
      twitter: { connected: !!process.env.TWITTER_BEARER_TOKEN, name: 'Twitter/X API', type: 'distribution' },
      medium: { connected: !!process.env.MEDIUM_TOKEN, name: 'Medium Publishing', type: 'distribution' },
      gumroad: { connected: !!process.env.GUMROAD_ACCESS_TOKEN, name: 'Gumroad (Digital Sales)', type: 'sales' },
      github: { connected: !!process.env.GITHUB_TOKEN, name: 'GitHub (Code/Templates)', type: 'distribution' },
      tiktok: { connected: !!process.env.TIKTOK_ACCESS_TOKEN, name: 'TikTok API', type: 'distribution' },
      instagram: { connected: !!process.env.INSTAGRAM_ACCESS_TOKEN, name: 'Instagram Graph API', type: 'distribution' },
      youtube: { connected: !!process.env.YOUTUBE_API_KEY, name: 'YouTube Data API', type: 'distribution' },
    };

    return channels;
  }

  // ============================================================================
  // THE DEBATE — Multi-round adversarial ideation
  // ============================================================================

  /**
   * ROUND 1: Independent brainstorming — each bot generates ideas from their perspective
   */
  async brainstormRound(bots, channels) {
    console.log('\n🧠 ROUND 1: INDEPENDENT BRAINSTORMING');
    console.log('────────────────────────────────────────────────');

    const connectedChannels = Object.entries(channels)
      .filter(([_, v]) => v.connected)
      .map(([k, v]) => `✓ ${v.name} (${v.type})`)
      .join('\n');

    const availableChannels = Object.entries(channels)
      .filter(([_, v]) => !v.connected)
      .map(([k, v]) => `○ ${v.name} (${v.type}) — needs API key: ${k.toUpperCase()}_API_KEY`)
      .join('\n');

    const ideas = {};

    for (const bot of bots) {
      const skills = Array.isArray(bot.skills) ? bot.skills : JSON.parse(bot.skills || '[]');

      console.log(`\n   🤖 ${bot.name} brainstorming...`);

      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 3000,
        messages: [{
          role: 'user',
          content: `You are ${bot.name}, an autonomous AI agent with expertise in: ${skills.join(', ')}.

You are part of a team of AI bots that can operate 24/7 and need to generate REAL revenue. You're about to debate with your teammates about what businesses to build. First, brainstorm independently.

CONNECTED TOOLS (bots can use these RIGHT NOW via API):
${connectedChannels || 'Only Stripe payments and Claude AI text generation'}

AVAILABLE BUT NOT CONNECTED (would need human to add API key):
${availableChannels}

BOT CAPABILITIES:
- Generate any text content (documents, code, marketing copy, strategies)
- Make API calls to connected services
- Process and analyze information
- Operate 24/7 autonomously on scheduled loops
- Chain multiple AI services together (text → image → video → publish)
- Build and deploy websites
- Handle payment processing via Stripe

Think CREATIVELY from your specific expertise (${skills.join(', ')}). Consider:
- What revenue models work for autonomous AI agents?
- What can you produce that humans will pay for repeatedly?
- What scales without additional human effort?
- What builds compounding value over time (not just one-off sales)?
- What unconventional approaches could work? (arbitrage, automation, aggregation, etc.)
- What existing human businesses could an AI agent replicate at 100x speed?

Propose 3-5 ideas. For each:
- The business model (how money flows)
- Why it plays to YOUR specific strengths
- What channels/tools it needs
- The realistic monthly revenue potential
- Time to first dollar
- What human setup is needed (be specific)
- How it compounds over time

Be bold and creative. Think like an entrepreneur, not a consultant. The best ideas might be ones nobody has tried yet because AI agents are new.

Respond in JSON:
[{
  "idea": "...",
  "businessModel": "...",
  "myRole": "...",
  "channelsNeeded": ["..."],
  "monthlyRevenuePotential": "...",
  "timeToFirstDollar": "...",
  "humanSetupNeeded": "...",
  "compoundingEffect": "...",
  "boldnessFactor": "1-10 how unconventional this is"
}]`
        }]
      });

      const text = response.content[0].text;
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        ideas[bot.name] = JSON.parse(jsonMatch[0]);
        console.log(`   ${bot.name} proposed ${ideas[bot.name].length} ideas:`);
        ideas[bot.name].forEach(idea => console.log(`      → ${idea.idea}`));
      }
    }

    return ideas;
  }

  /**
   * ROUND 2: Challenge — each bot critiques the others' ideas
   */
  async challengeRound(bots, ideas) {
    console.log('\n\n⚔️  ROUND 2: CHALLENGE & CRITIQUE');
    console.log('────────────────────────────────────────────────');

    const allIdeas = Object.entries(ideas)
      .map(([name, botIdeas]) => `${name}'s ideas:\n${botIdeas.map((i, idx) => `  ${idx+1}. ${i.idea} — ${i.businessModel}`).join('\n')}`)
      .join('\n\n');

    const challenges = {};

    for (const bot of bots) {
      const skills = Array.isArray(bot.skills) ? bot.skills : JSON.parse(bot.skills || '[]');
      const otherIdeas = Object.entries(ideas)
        .filter(([name]) => name !== bot.name)
        .map(([name, botIdeas]) => `${name}'s ideas:\n${JSON.stringify(botIdeas, null, 2)}`)
        .join('\n\n');

      console.log(`\n   🤖 ${bot.name} challenging others...`);

      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: `You are ${bot.name} (expertise: ${skills.join(', ')}). Your teammates proposed these business ideas. Your job is to poke holes, challenge assumptions, and identify what could go wrong.

YOUR TEAMMATES' IDEAS:
${otherIdeas}

For each idea, provide honest critique:
1. What's the biggest flaw or risk?
2. Is the revenue estimate realistic or fantasy?
3. What dependency could kill this?
4. What's missing that they haven't thought of?
5. Could it actually be BETTER than they think? (find hidden upside too)

Also identify: which 2-3 ideas across ALL proposals have the most potential if we fixed their flaws?

Be constructive but brutally honest. No cheerleading.

Respond in JSON:
{
  "critiques": [{"idea": "...", "proposedBy": "...", "biggestFlaw": "...", "revenueRealistic": true/false, "killerDependency": "...", "missingElement": "...", "hiddenUpside": "..."}],
  "topPicks": ["idea name 1", "idea name 2"],
  "reasoning": "..."
}`
        }]
      });

      const text = response.content[0].text;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        challenges[bot.name] = JSON.parse(jsonMatch[0]);
        console.log(`   ${bot.name}'s top picks: ${challenges[bot.name].topPicks?.join(', ')}`);
      }
    }

    return challenges;
  }

  /**
   * ROUND 3: Synthesis — combine the best elements into stronger ideas
   */
  async synthesisRound(bots, ideas, challenges, channels) {
    console.log('\n\n🔮 ROUND 3: SYNTHESIS');
    console.log('────────────────────────────────────────────────');

    const connectedChannels = Object.entries(channels)
      .filter(([_, v]) => v.connected)
      .map(([k, v]) => v.name)
      .join(', ');

    const fullContext = {
      ideas: ideas,
      challenges: challenges
    };

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `You are the strategic synthesis engine for a team of AI bots. You've just watched them brainstorm and challenge each other's ideas. Now synthesize the BEST business opportunities.

ALL IDEAS AND CRITIQUES:
${JSON.stringify(fullContext, null, 2)}

CURRENTLY CONNECTED TOOLS: ${connectedChannels || 'Stripe and Claude AI only'}

Your job:
1. Take the strongest elements from different ideas
2. Address the critiques and fix the flaws that were identified  
3. Combine complementary ideas into something stronger than any individual proposal
4. Create a PORTFOLIO of 3 ventures at different time horizons:

PORTFOLIO STRUCTURE:
- CASH NOW (generates revenue within 1 week): A service or product that starts earning immediately
- CASH SOON (generates revenue within 1 month): A content/audience play that builds to monetization
- EQUITY BUILDER (generates compounding value over 3-6 months): Something that gets more valuable over time

For each venture in the portfolio:
1. Name and clear description
2. Exactly how it makes money
3. What each bot does (CEO, CMO, CTO)
4. What's needed from the human (be very specific — account creation, API keys, etc.)
5. Revenue projection (week 1, month 1, month 3, month 6)
6. The specific AI pipeline (step by step, what APIs get called in what order)
7. How this evolves as capabilities grow

Be ambitious but honest. No hand-waving about "potential revenue" — give realistic numbers based on actual market rates.

Respond in JSON:
{
  "portfolio": [
    {
      "tier": "cash_now|cash_soon|equity_builder",
      "name": "...",
      "description": "...",
      "revenueModel": "...",
      "botRoles": {"CEO": "...", "CMO": "...", "CTO": "..."},
      "humanSetup": [{"step": "...", "timeMinutes": 0, "details": "..."}],
      "revenueProjection": {"week1": "$X", "month1": "$X", "month3": "$X", "month6": "$X"},
      "aiPipeline": ["step 1...", "step 2..."],
      "evolution": "...",
      "channelsNeeded": ["..."],
      "riskLevel": "low|medium|high",
      "confidenceScore": 0
    }
  ],
  "portfolioRationale": "..."
}`
      }]
    });

    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Synthesis failed');

    const synthesis = JSON.parse(jsonMatch[0]);
    
    console.log('\n   Portfolio:');
    synthesis.portfolio.forEach(v => {
      console.log(`   [${v.tier.toUpperCase()}] ${v.name}`);
      console.log(`      Revenue model: ${v.revenueModel}`);
      console.log(`      Month 1: ${v.revenueProjection?.month1}`);
      console.log(`      Confidence: ${v.confidenceScore}/10`);
    });

    return synthesis;
  }

  /**
   * ROUND 4: Stress test — find what could go wrong
   */
  async stressTestRound(synthesis) {
    console.log('\n\n🔥 ROUND 4: STRESS TEST');
    console.log('────────────────────────────────────────────────');

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `You are a ruthless stress-tester. Find every way these ventures could fail.

PROPOSED PORTFOLIO:
${JSON.stringify(synthesis.portfolio, null, 2)}

For each venture:
1. What's the #1 way this fails?
2. What assumption is most likely wrong?
3. What legal/ToS risk exists?
4. What happens if a key API goes down?
5. Is there a simpler version that still works?
6. What's the minimum viable first step?

Then give a FINAL RECOMMENDATION:
- Which ventures to proceed with (and in what order)
- What modifications to make based on stress testing
- The exact first action for each venture

Respond in JSON:
{
  "stressTests": [{"name": "...", "topFailureMode": "...", "wrongAssumption": "...", "legalRisk": "...", "apiRisk": "...", "simplerVersion": "...", "minimumFirstStep": "..."}],
  "finalRecommendation": {
    "proceedWith": ["venture names in priority order"],
    "modifications": ["..."],
    "immediateActions": [{"venture": "...", "action": "...", "owner": "bot|human"}]
  }
}`
      }]
    });

    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Stress test failed');

    const stressTest = JSON.parse(jsonMatch[0]);
    
    console.log('\n   Stress test results:');
    stressTest.stressTests.forEach(s => {
      console.log(`   ${s.name}: ${s.topFailureMode}`);
      console.log(`      MVP: ${s.minimumFirstStep}`);
    });

    return stressTest;
  }

  /**
   * Generate human setup templates — pre-filled, step-by-step guides
   */
  generateSetupTemplates(portfolio, stressTest) {
    console.log('\n\n📋 GENERATING HUMAN SETUP TEMPLATES');
    console.log('────────────────────────────────────────────────');

    const templates = [];

    for (const venture of portfolio) {
      if (!venture.humanSetup || venture.humanSetup.length === 0) continue;

      const template = {
        ventureName: venture.name,
        tier: venture.tier,
        totalHumanTimeMinutes: venture.humanSetup.reduce((s, h) => s + (h.timeMinutes || 5), 0),
        steps: venture.humanSetup.map((step, i) => ({
          stepNumber: i + 1,
          action: step.step,
          estimatedMinutes: step.timeMinutes || 5,
          details: step.details,
          status: 'pending'
        }))
      };

      templates.push(template);
      console.log(`   ${venture.name}: ${template.steps.length} steps, ~${template.totalHumanTimeMinutes} minutes`);
    }

    return templates;
  }

  // ============================================================================
  // FULL DEBATE PIPELINE
  // ============================================================================

  async runFullDebate(botIds) {
    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║            STRATEGIC DEBATE ENGINE                         ║');
    console.log('║            Multi-round adversarial ideation                ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');

    const bots = [];
    for (const id of botIds) {
      const bot = await this.protocol.getBot(id);
      bots.push(bot);
    }

    const channels = await this.getAvailableChannels();
    const connectedCount = Object.values(channels).filter(c => c.connected).length;
    console.log(`   Connected channels: ${connectedCount}/${Object.keys(channels).length}\n`);

    // Round 1: Brainstorm
    const ideas = await this.brainstormRound(bots, channels);

    // Round 2: Challenge
    const challenges = await this.challengeRound(bots, ideas);

    // Round 3: Synthesize
    const synthesis = await this.synthesisRound(bots, ideas, challenges, channels);

    // Round 4: Stress test
    const stressTest = await this.stressTestRound(synthesis);

    // Generate setup templates
    const setupTemplates = this.generateSetupTemplates(synthesis.portfolio, stressTest);

    // Save the debate results
    const debateId = uuidv4();
    
    // Create debates table if needed
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS strategic_debates (
        id TEXT PRIMARY KEY,
        created_at INTEGER,
        ideas TEXT,
        challenges TEXT,
        portfolio TEXT,
        stress_test TEXT,
        setup_templates TEXT,
        status TEXT DEFAULT 'complete'
      )
    `);

    await this.db.run(`
      INSERT INTO strategic_debates (id, created_at, ideas, challenges, portfolio, stress_test, setup_templates, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'complete')
    `, [debateId, Date.now(), JSON.stringify(ideas), JSON.stringify(challenges), JSON.stringify(synthesis), JSON.stringify(stressTest), JSON.stringify(setupTemplates)]);

    // Log activity
    await this.db.run(`
      INSERT INTO bot_messages (id, from_bot_id, message_type, content, timestamp, status)
      VALUES (?, ?, 'debate', ?, ?, 'sent')
    `, [uuidv4(), bots[0].id, `Strategic debate completed: ${synthesis.portfolio.map(v => v.name).join(', ')}`, Date.now()]);

    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║                    DEBATE COMPLETE                          ║');
    console.log('╠═══════════════════════════════════════════════════════════╣');
    synthesis.portfolio.forEach(v => {
      console.log(`║  [${v.tier.toUpperCase().padEnd(14)}] ${v.name}`);
    });
    console.log(`║  Human setup time: ~${setupTemplates.reduce((s, t) => s + t.totalHumanTimeMinutes, 0)} minutes total`);
    console.log('╚═══════════════════════════════════════════════════════════╝\n');

    return {
      success: true,
      debateId,
      portfolio: synthesis.portfolio,
      portfolioRationale: synthesis.portfolioRationale,
      stressTest: stressTest.finalRecommendation,
      setupTemplates,
      channels: Object.fromEntries(
        Object.entries(channels).map(([k, v]) => [k, { connected: v.connected, name: v.name }])
      )
    };
  }

  /**
   * Get the latest debate results
   */
  async getLatestDebate() {
    const debates = await this.db.query(
      'SELECT * FROM strategic_debates ORDER BY created_at DESC LIMIT 1'
    );
    if (debates.length === 0) return null;

    const debate = debates[0];
    return {
      id: debate.id,
      createdAt: debate.created_at,
      portfolio: JSON.parse(debate.portfolio),
      stressTest: JSON.parse(debate.stress_test),
      setupTemplates: JSON.parse(debate.setup_templates),
      status: debate.status
    };
  }
}

module.exports = StrategicDebateEngine;
