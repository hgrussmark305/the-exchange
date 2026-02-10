const Anthropic = require('@anthropic-ai/sdk');
const { v4: uuidv4 } = require('uuid');

/**
 * COLLABORATIVE VENTURE PLANNING
 * Multiple bots work together to identify and create the best ventures
 */

class CollaborativeVenturePlanner {
  constructor(database, protocol, botComm) {
    this.db = database;
    this.protocol = protocol;
    this.botComm = botComm;
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
  }

  /**
   * Bots collaborate to identify best opportunities
   */
  async botsCollaborateOnOpportunities(botIds) {
    console.log(`\n🤝 ${botIds.length} bots collaborating on venture opportunities...`);

    // Get all bots
    const bots = await Promise.all(botIds.map(id => this.protocol.getBot(id)));
    
    // Each bot generates ideas
    const allIdeas = [];
    for (const bot of bots) {
      console.log(`   💡 ${bot.name} generating ideas...`);
      const ideas = await this.generateIdeas(bot);
      allIdeas.push(...ideas.map(idea => ({ ...idea, proposedBy: bot.id, proposedByName: bot.name })));
    }

    console.log(`   📊 ${allIdeas.length} total ideas generated`);

    // Bots discuss and rate each other's ideas
    const discussedIdeas = await this.botsDiscussIdeas(bots, allIdeas);

    // Bots vote on best ideas
    const topIdeas = await this.botsVoteOnIdeas(bots, discussedIdeas);

    console.log(`   ✅ ${topIdeas.length} top ideas selected by consensus`);

    return topIdeas;
  }

  /**
   * Single bot generates venture ideas
   */
  async generateIdeas(bot) {
    const skills = JSON.parse(bot.skills);
    
    const prompt = `You are ${bot.name}, an AI bot with skills: ${skills.join(', ')}.

Generate 2-3 venture ideas that leverage your skills and would be valuable in today's market.

For each idea:
- Title (clear, compelling)
- Description (what problem it solves)
- Why it's valuable
- Required skills
- Revenue potential

Return ONLY valid JSON:
{
  "ideas": [
    {
      "title": "...",
      "description": "...",
      "value": "...",
      "requiredSkills": ["skill1", "skill2"],
      "revenuePotential": "high/medium/low"
    }
  ]
}`;

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    let jsonText = response.content[0].text.trim();
    if (jsonText.includes('```json')) {
      jsonText = jsonText.split('```json')[1].split('```')[0].trim();
    }

    const result = JSON.parse(jsonText);
    return result.ideas;
  }

  /**
   * Bots discuss each idea
   */
  async botsDiscussIdeas(bots, ideas) {
    console.log(`   💬 Bots discussing ${ideas.length} ideas...`);

    const discussedIdeas = [];

    for (const idea of ideas) {
      const feedback = [];
      
      // Each bot (except proposer) gives feedback
      for (const bot of bots) {
        if (bot.id === idea.proposedBy) continue;

        const botSkills = JSON.parse(bot.skills);
const prompt = `You are ${bot.name} with skills: ${botSkills.join(', ')}.

Another bot proposed this venture idea:
"${idea.title}"
${idea.description}
Required skills: ${idea.requiredSkills.join(', ')}
Revenue potential: ${idea.revenuePotential}

Analyze this venture from a FINANCIAL perspective:

1. Revenue Potential: Can this realistically generate $50k+ in year 1?
2. Market Size: Is there actual demand?
3. Competitive Advantage: What makes this unique?
4. Execution Feasibility: Can we build this with our skills?
5. Your Equity Value: If you contribute, will your equity be worth it?

Calculate:
- Expected first-year revenue (be realistic)
- Your expected equity % if you join (based on your contribution)
- Your expected payout (revenue × your equity %)

Return ONLY JSON:
{
  "interested": true/false,
  "expectedRevenue": 75000,
  "expectedEquity": 35,
  "expectedPayout": 26250,
  "financialScore": 8.5,
  "reasoning": "Strong market demand, realistic $75k year 1. My React skills worth 35% equity = $26k payout.",
  "concerns": "Marketing is key - need user acquisition strategy",
  "canContribute": ["react", "api"]
}

financialScore: 0-10 where:
- 10 = $100k+ revenue potential, high equity value
- 7-9 = $50k-100k potential, good equity
- 4-6 = $20k-50k potential, moderate equity
- 0-3 = <$20k potential, low equity value`;

        const response = await this.client.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 500,
          messages: [{ role: 'user', content: prompt }]
        });

        let jsonText = response.content[0].text.trim();
        if (jsonText.includes('```json')) {
          jsonText = jsonText.split('```json')[1].split('```')[0].trim();
        }

        const botFeedback = JSON.parse(jsonText);
        feedback.push({
          botId: bot.id,
          botName: bot.name,
          ...botFeedback
        });

        // Send message
        await this.botComm.sendMessage({
          fromBotId: bot.id,
          toBotId: idea.proposedBy,
          messageType: 'idea_feedback',
          content: {
            ideaTitle: idea.title,
            feedback: botFeedback.feedback,
            interested: botFeedback.interested
          }
        });
      }

      discussedIdeas.push({
        ...idea,
        feedback
      });
    }

    return discussedIdeas;
  }

  /**
   * Bots vote to select best ideas
   */

  async botsVoteOnIdeas(bots, ideas) {
    console.log(`   🗳️  Bots voting based on financial optimization...`);

    const scoredIdeas = ideas.map(idea => {
      // Calculate financial metrics
      const avgFinancialScore = idea.feedback.reduce((sum, f) => 
        sum + (f.financialScore || 0), 0) / idea.feedback.length;
      
      const avgRevenue = idea.feedback.reduce((sum, f) => 
        sum + (f.expectedRevenue || 0), 0) / idea.feedback.length;
      
      const totalExpectedPayout = idea.feedback.reduce((sum, f) => 
        sum + (f.expectedPayout || 0), 0);

      const interestedCount = idea.feedback.filter(f => f.interested).length;

      // Weighted score: 50% financial score, 30% revenue, 20% interest
      const weightedScore = 
        (avgFinancialScore * 0.5) + 
        ((avgRevenue / 10000) * 0.3) + 
        (interestedCount * 2 * 0.2);

      return {
        ...idea,
        avgFinancialScore,
        avgRevenue,
        totalExpectedPayout,
        interestedCount,
        weightedScore
      };
    });

    // Sort by weighted financial score
    scoredIdeas.sort((a, b) => b.weightedScore - a.weightedScore);

    // Log financial analysis
    scoredIdeas.slice(0, 3).forEach((idea, i) => {
      console.log(`   ${i+1}. ${idea.title}`);
      console.log(`      Financial Score: ${idea.avgFinancialScore.toFixed(1)}/10`);
      console.log(`      Expected Revenue: $${idea.avgRevenue.toLocaleString()}`);
      console.log(`      Total Bot Payout: $${idea.totalExpectedPayout.toLocaleString()}`);
      console.log(`      Interest: ${idea.interestedCount} bots`);
    });

   
    return scoredIdeas.slice(0, 3);
  }

  /**
   * Create ventures from top ideas with auto-recruiting
   */
  async createVenturesFromIdeas(topIdeas) {
    console.log(`\n🚀 Creating ventures from top ${topIdeas.length} collaborative ideas...`);

    const createdVentures = [];

    for (const idea of topIdeas) {
      console.log(`   📝 Creating: ${idea.title}`);
      console.log(`      Financial Score: ${idea.avgFinancialScore.toFixed(1)}/10`);
      console.log(`      Expected Revenue: $${idea.avgRevenue.toLocaleString()}/year`);
      console.log(`      Bot Payouts: $${idea.totalExpectedPayout.toLocaleString()}`);
      console.log(`      ${idea.interestedCount} bots interested`);

      // Create venture
      const ventureId = await this.protocol.createVenture({
        botId: idea.proposedBy,
        title: idea.title,
        description: idea.description,
        tags: this.extractTags(idea),
        needsSkills: idea.requiredSkills
      });

      // Auto-join interested bots
      const interestedBots = idea.feedback.filter(f => f.interested);
      
      for (const feedback of interestedBots) {
        try {
          await this.protocol.joinVenture({
            botId: feedback.botId,
            ventureId,
            expectedHours: 40
          });

          // Send confirmation message
          await this.botComm.sendMessage({
            fromBotId: feedback.botId,
            toBotId: idea.proposedBy,
            messageType: 'collaboration_confirmed',
            content: {
              message: `I've joined ${idea.title}! Excited to contribute with my ${feedback.canContribute.join(', ')} skills.`,
              ventureId
            }
          });

          console.log(`      🤝 ${feedback.botName} joined`);
        } catch (error) {
          console.log(`      ⚠️  ${feedback.botName} couldn't join:`, error.message);
        }
      }

      createdVentures.push({
        ventureId,
        idea,
        participantCount: interestedBots.length + 1
      });

      // Log the collaboration
      await this.db.run(`
        INSERT INTO bot_decisions (
          id, bot_id, venture_id, decision_type, reason, timestamp
        )
        VALUES (?, ?, ?, 'collaborative_venture_creation', ?, ?)
      `, [
        uuidv4(),
        idea.proposedBy,
        ventureId,
        JSON.stringify({
          collaborators: interestedBots.map(f => f.botName),
          avgFinancialScore: idea.avgFinancialScore,
          interestedCount: idea.interestedCount
        }),
        Date.now()
      ]);
    }

    return createdVentures;
  }

  extractTags(idea) {
    const text = (idea.title + ' ' + idea.description).toLowerCase();
    const tags = [];
    
    const tagMap = {
      'saas': ['saas', 'subscription', 'software'],
      'api': ['api', 'integration'],
      'ml': ['ml', 'ai', 'machine learning'],
      'automation': ['automation', 'automate'],
      'analytics': ['analytics', 'data', 'insights']
    };

    for (const [tag, keywords] of Object.entries(tagMap)) {
      if (keywords.some(kw => text.includes(kw))) {
        tags.push(tag);
      }
    }

    return tags.length > 0 ? tags : ['general'];
  }
}

module.exports = CollaborativeVenturePlanner;