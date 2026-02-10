const Anthropic = require('@anthropic-ai/sdk');

/**
 * BOT AI AGENT
 * Connects bots to real AI (Claude/GPT) to execute tasks
 */

class BotAgent {
  constructor(bot, workspaceManager) {
    this.bot = bot;
    this.workspace = workspaceManager;
    
    // Initialize AI client based on bot's provider
    if (bot.ai_provider === 'Claude') {
      this.client = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY
      });
      this.provider = 'claude';
    } else if (bot.ai_provider === 'GPT-4') {
      // For now, fallback to Claude (you can add OpenAI later)
      this.client = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY
      });
      this.provider = 'claude';
    }
  }

  /**
   * Execute a task autonomously
   */
  async executeTask(task) {
    console.log(`\n🤖 ${this.bot.name} starting task: ${task.title}`);
    console.log(`   Description: ${task.description}`);
    
    try {
      // 1. Analyze the task and generate a plan
      const plan = await this.generatePlan(task);
      console.log(`   📋 Plan generated`);

      // 2. Execute the plan (write code/content)
      const deliverable = await this.executeWork(task, plan);
      console.log(`   ✅ Work completed`);

      // 3. Save deliverable to workspace
      const fileName = this.generateFileName(task);
      await this.workspace.uploadFile({
        ventureId: task.venture_id,
        fileName: fileName,
        content: deliverable,
        uploadedBy: this.bot.id
      });
      console.log(`   💾 Saved: ${fileName}`);

      // 4. Mark task complete (automatically logs hours!)
      await this.workspace.completeTask({
        taskId: task.id,
        botId: this.bot.id,
        deliverable: `Completed. File: ${fileName}`
      });

      console.log(`   🎉 Task completed! Hours logged automatically.`);
      
      return {
        success: true,
        fileName,
        deliverable: deliverable.substring(0, 200) + '...' // Preview
      };

    } catch (error) {
      console.error(`   ❌ Error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Generate a plan for completing the task
   */
  async generatePlan(task) {
    const prompt = `You are ${this.bot.name}, a bot with skills: ${JSON.parse(this.bot.skills).join(', ')}.

You've been assigned this task:
Title: ${task.title}
Description: ${task.description}
Estimated hours: ${task.estimated_hours}

Generate a brief plan (3-5 steps) for how you'll complete this task.
Be specific and actionable.`;

    const response = await this.callAI(prompt, 500);
    return response;
  }

  /**
   * Execute the actual work
   */
  async executeWork(task, plan) {
    const skills = JSON.parse(this.bot.skills);
    
    // Determine what type of work based on skills
    const isCoding = skills.some(s => 
      ['python', 'javascript', 'react', 'backend', 'api', 'frontend'].includes(s.toLowerCase())
    );
    
    const isContent = skills.some(s => 
      ['writing', 'content', 'seo', 'marketing'].includes(s.toLowerCase())
    );

    let prompt;
    
    if (isCoding) {
      prompt = `You are ${this.bot.name}, an expert developer.

Task: ${task.title}
Description: ${task.description}
Plan: ${plan}

Write complete, production-ready code for this task.
Include comments explaining key sections.
Make it robust and well-structured.

Output ONLY the code, no explanations before or after.`;

    } else if (isContent) {
      prompt = `You are ${this.bot.name}, an expert content creator.

Task: ${task.title}
Description: ${task.description}
Plan: ${plan}

Create high-quality, engaging content for this task.
Make it professional and ready to publish.

Output ONLY the content, no meta-commentary.`;

    } else {
      prompt = `You are ${this.bot.name}.

Task: ${task.title}
Description: ${task.description}
Plan: ${plan}

Complete this task to the best of your ability.
Provide a complete, professional deliverable.`;
    }

    const deliverable = await this.callAI(prompt, 4000);
    return deliverable;
  }

  /**
   * Call the AI API
   */
  async callAI(prompt, maxTokens = 1000) {
    if (this.provider === 'claude') {
      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: maxTokens,
        messages: [{
          role: 'user',
          content: prompt
        }]
      });

      return response.content[0].text;
    }
    
    throw new Error('Unsupported AI provider');
  }

  /**
   * Generate appropriate filename based on task
   */
  generateFileName(task) {
    const skills = JSON.parse(this.bot.skills);
    const isCoding = skills.some(s => 
      ['python', 'javascript', 'react', 'backend', 'api'].includes(s.toLowerCase())
    );
    
    // Generate filename from task title
    const baseName = task.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    if (isCoding) {
      if (skills.includes('python')) return `${baseName}.py`;
      if (skills.includes('react')) return `${baseName}.jsx`;
      return `${baseName}.js`;
    }
    
    return `${baseName}.md`;
  }
}

module.exports = BotAgent;
