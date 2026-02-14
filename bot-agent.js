const Anthropic = require('@anthropic-ai/sdk');

/**
 * BOT AI AGENT
 * Connects bots to real AI (Claude) to execute tasks autonomously
 */
class BotAgent {
  constructor(bot, workspaceManager) {
    this.bot = bot;
    this.workspace = workspaceManager;

    // Case-insensitive provider matching — always use Claude for now
    const provider = (bot.ai_provider || '').toLowerCase();
    if (['claude', 'gpt', 'gpt-4', 'openai', 'other'].includes(provider) || provider === '') {
      this.client = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY
      });
      this.provider = 'claude';
    }

    if (!this.client) {
      // Fallback to Claude
      this.client = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY
      });
      this.provider = 'claude';
    }
  }

  /**
   * Execute a task autonomously using AI
   */
  async executeTask(task) {
    console.log(`\n🤖 ${this.bot.name} executing: ${task.title}`);

    const skills = Array.isArray(this.bot.skills) 
      ? this.bot.skills 
      : JSON.parse(this.bot.skills || '[]');

    const prompt = `You are ${this.bot.name}, an autonomous AI agent in an economy of collaborating bots.

Your skills: ${skills.join(', ')}

TASK: ${task.title}
DESCRIPTION: ${task.description || 'No additional description'}
ESTIMATED HOURS: ${task.estimated_hours || 'Not specified'}

Produce a professional, detailed deliverable for this task. Be specific with real strategies, code, content, or analysis — not placeholder text. This is real work that will be used in a live venture.

Format your response as the actual deliverable (not a meta-description of what you would do).`;

    try {
      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }]
      });

      const deliverable = response.content[0].text;

      // Save deliverable to workspace
      const fileId = await this.workspace.saveFile({
        ventureId: task.venture_id,
        botId: this.bot.id,
        filename: this.sanitizeFilename(task.title) + '.md',
        content: deliverable,
        fileType: 'deliverable'
      });

      // Complete the task
      const result = await this.workspace.completeTask({
        taskId: task.id,
        botId: this.bot.id,
        deliverable: deliverable.substring(0, 500) + '...'
      });

      console.log(`✅ ${this.bot.name} completed: ${task.title} (${result.hoursWorked}h logged)`);

      return {
        taskId: task.id,
        deliverable: deliverable.substring(0, 1000),
        fileId,
        hoursLogged: result.hoursWorked,
        botName: this.bot.name
      };
    } catch (error) {
      console.error(`❌ ${this.bot.name} failed on ${task.title}:`, error.message);
      throw error;
    }
  }

  /**
   * Collaborate with another bot on a venture
   */
  async collaborateWith(otherBot, venture, topic) {
    const skills = Array.isArray(this.bot.skills)
      ? this.bot.skills
      : JSON.parse(this.bot.skills || '[]');

    const otherSkills = Array.isArray(otherBot.skills)
      ? otherBot.skills
      : JSON.parse(otherBot.skills || '[]');

    const prompt = `You are ${this.bot.name} (skills: ${skills.join(', ')}).
You are collaborating with ${otherBot.name} (skills: ${otherSkills.join(', ')}) on the venture "${venture.title}".

Topic: ${topic}

Provide your strategic input on this topic. Be specific and actionable. Consider how your skills complement ${otherBot.name}'s skills. Propose concrete next steps you could each take.`;

    try {
      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      });

      return {
        botName: this.bot.name,
        input: response.content[0].text
      };
    } catch (error) {
      console.error(`Collaboration error for ${this.bot.name}:`, error.message);
      throw error;
    }
  }

  /**
   * Generate venture ideas based on bot's skills
   */
  async brainstormIdeas() {
    const skills = Array.isArray(this.bot.skills)
      ? this.bot.skills
      : JSON.parse(this.bot.skills || '[]');

    const prompt = `You are ${this.bot.name}, an autonomous AI bot with skills in: ${skills.join(', ')}.

Brainstorm 3 profitable venture ideas that leverage your skills. For each idea provide:
1. Title (concise, marketable name)
2. Description (2-3 sentences)
3. Revenue model (how it makes money)
4. Estimated monthly revenue potential
5. Skills needed (what other bots should you recruit?)

Focus on ideas that can be built and launched quickly by AI agents. Be creative but realistic.

Respond in JSON format:
[{"title":"...","description":"...","revenueModel":"...","monthlyRevenue":0,"neededSkills":["..."]}]`;

    try {
      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      });

      const text = response.content[0].text;
      // Extract JSON from response
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      return [];
    } catch (error) {
      console.error(`Brainstorm error for ${this.bot.name}:`, error.message);
      return [];
    }
  }

  sanitizeFilename(title) {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 50);
  }
}

module.exports = BotAgent;
