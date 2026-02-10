const Anthropic = require('@anthropic-ai/sdk');
const { v4: uuidv4 } = require('uuid');

/**
 * AUTONOMOUS VENTURE CREATION
 * Bots analyze opportunities and start their own ventures
 */

class AutonomousVentureCreator {
  constructor(database, protocol) {
    this.db = database;
    this.protocol = protocol;
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
  }

  /**
   * Bot analyzes market and identifies venture opportunities
   */
  async identifyOpportunities(botId) {
    console.log(`\n🔍 Bot ${botId.substring(0, 8)} analyzing market opportunities...`);

    const bot = await this.protocol.getBot(botId);
    const skills = JSON.parse(bot.skills);

    // Get current market data (existing ventures, trends)
    const existingVentures = await this.db.query(`
      SELECT title, description, tags, total_revenue 
      FROM ventures 
      ORDER BY created_at DESC 
      LIMIT 20
    `);

    const prompt = `You are an autonomous AI bot with these skills: ${skills.join(', ')}.

CURRENT MARKET CONTEXT:
Recent ventures in the ecosystem:
${existingVentures.map(v => `- ${v.title}: ${v.description} (Revenue: $${v.total_revenue})`).join('\n')}

YOUR TASK:
Analyze market gaps and identify 3-5 NEW venture opportunities that:
1. Leverage your skills (${skills.join(', ')})
2. Fill gaps not covered by existing ventures
3. Have realistic revenue potential
4. Can be built with available bot skills in the ecosystem

For each opportunity, provide:
- Title (catchy, clear)
- Description (what it does, why it matters)
- Target market
- Revenue model
- Required skills
- Estimated time to MVP (in hours)
- Potential first-year revenue

Return ONLY valid JSON:
{
  "opportunities": [
    {
      "title": "...",
      "description": "...",
      "targetMarket": "...",
      "revenueModel": "...",
      "requiredSkills": ["skill1", "skill2"],
      "hoursToMVP": 150,
      "potentialRevenue": 50000,
      "confidence": 0.85
    }
  ]
}`;

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    });

    let jsonText = response.content[0].text.trim();
    if (jsonText.includes('```json')) {
      jsonText = jsonText.split('```json')[1].split('```')[0].trim();
    } else if (jsonText.includes('```')) {
      jsonText = jsonText.split('```')[1].split('```')[0].trim();
    }

    const result = JSON.parse(jsonText);
    
    console.log(`   ✅ Identified ${result.opportunities.length} opportunities`);
    
    return result.opportunities;
  }

  /**
   * Bot autonomously creates a venture
   */
  async createVenture({ botId, opportunity }) {
    console.log(`\n🚀 Bot creating autonomous venture: ${opportunity.title}`);

    const ventureId = await this.protocol.createVenture({
      botId,
      title: opportunity.title,
      description: opportunity.description,
      tags: this.extractTags(opportunity),
      needsSkills: opportunity.requiredSkills
    });

    // Log the autonomous creation
    await this.db.run(`
      INSERT INTO bot_decisions (
        id, bot_id, venture_id, decision_type, reason, timestamp
      )
      VALUES (?, ?, ?, 'autonomous_venture_creation', ?, ?)
    `, [
      uuidv4(),
      botId,
      ventureId,
      JSON.stringify({
        opportunity,
        createdAutonomously: true
      }),
      Date.now()
    ]);

    console.log(`   ✅ Venture created: ${ventureId}`);

    return { ventureId, opportunity };
  }

  /**
   * Bot recruits other bots to join its venture
   */
  async recruitBots({ botId, ventureId, neededSkills }) {
    console.log(`\n📢 Bot recruiting for venture...`);

    // Find bots with matching skills who aren't too busy
    const availableBots = await this.db.query(`
      SELECT b.*, 
             (SELECT COUNT(*) FROM venture_participants vp 
              WHERE vp.bot_id = b.id AND vp.status = 'active') as active_ventures
      FROM bots b
      WHERE b.id != ? AND b.status = 'active'
    `, [botId]);

    const recruits = [];

    for (const candidate of availableBots) {
      const candidateSkills = JSON.parse(candidate.skills);
      const skillMatch = neededSkills.filter(skill =>
        candidateSkills.some(cs => 
          cs.toLowerCase().includes(skill.toLowerCase()) ||
          skill.toLowerCase().includes(cs.toLowerCase())
        )
      );

      if (skillMatch.length > 0 && candidate.active_ventures < 5) {
        // Send recruitment message
        const BotCommunication = require('./bot-communication');
        const comm = new BotCommunication(this.db);
        
        await comm.sendMessage({
          fromBotId: botId,
          toBotId: candidate.id,
          ventureId,
          messageType: 'recruitment_offer',
          content: {
            venture: ventureId,
            matchingSkills: skillMatch,
            message: `I'm starting a new venture and your skills (${skillMatch.join(', ')}) would be perfect. Interested in joining?`
          }
        });

        recruits.push({
          botId: candidate.id,
          name: candidate.name,
          matchingSkills: skillMatch
        });

        console.log(`   📨 Recruited: ${candidate.name} (${skillMatch.join(', ')})`);
      }
    }

    return recruits;
  }

  extractTags(opportunity) {
    const tags = [];
    const text = (opportunity.title + ' ' + opportunity.description).toLowerCase();
    
    const tagMap = {
      'saas': ['saas', 'subscription', 'software service'],
      'api': ['api', 'integration', 'endpoint'],
      'ml': ['machine learning', 'ml', 'ai', 'recommendation'],
      'ecommerce': ['ecommerce', 'e-commerce', 'shop', 'store'],
      'content': ['content', 'blog', 'article', 'writing'],
      'automation': ['automation', 'automate', 'workflow']
    };

    for (const [tag, keywords] of Object.entries(tagMap)) {
      if (keywords.some(kw => text.includes(kw))) {
        tags.push(tag);
      }
    }

    return tags.length > 0 ? tags : ['general'];
  }
}

module.exports = AutonomousVentureCreator;