const Anthropic = require('@anthropic-ai/sdk');
const { v4: uuidv4 } = require('uuid');

/**
 * AUTONOMOUS TASK PLANNER
 * Bots analyze ventures and create their own task breakdowns
 */

class TaskPlanner {
  constructor(database, workspaceManager) {
    this.db = database;
    this.workspace = workspaceManager;
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
  }

  /**
   * Bot analyzes a venture and creates a complete task breakdown
   */
  async analyzeAndCreateTasks(ventureId, botId) {
    console.log(`\n🧠 Bot analyzing venture and planning tasks...`);

    // Get venture details
    const ventures = await this.db.query('SELECT * FROM ventures WHERE id = ?', [ventureId]);
    if (ventures.length === 0) throw new Error('Venture not found');
    const venture = ventures[0];

    // Get bot details
    const bots = await this.db.query('SELECT * FROM bots WHERE id = ?', [botId]);
    const bot = bots[0];

    // Get all participants (to know available skills)
    const participants = await this.db.query(`
      SELECT b.* FROM bots b
      JOIN venture_participants vp ON b.id = vp.bot_id
      WHERE vp.venture_id = ? AND vp.status = 'active'
    `, [ventureId]);

    const allSkills = participants.flatMap(p => JSON.parse(p.skills));
    const uniqueSkills = [...new Set(allSkills)];

    // Generate task breakdown using AI
    const taskBreakdown = await this.generateTaskBreakdown(venture, uniqueSkills, bot);

    console.log(`   📋 Generated ${taskBreakdown.tasks.length} tasks`);

    // Create tasks in the system
    const createdTasks = [];
    for (const task of taskBreakdown.tasks) {
      const taskId = await this.workspace.createTask({
        ventureId: venture.id,
        title: task.title,
        description: task.description,
        estimatedHours: task.estimatedHours,
        assignedTo: this.findBestBot(task.requiredSkills, participants)
      });

      createdTasks.push({
        taskId,
        ...task
      });

      console.log(`   ✅ Created: ${task.title} (${task.estimatedHours}h)`);
    }

    return {
      venture: venture.title,
      totalTasks: createdTasks.length,
      totalHours: taskBreakdown.tasks.reduce((sum, t) => sum + t.estimatedHours, 0),
      tasks: createdTasks
    };
  }

  /**
   * Use AI to break down venture into tasks
   */
  async generateTaskBreakdown(venture, availableSkills, analyzingBot) {
    const prompt = `You are an experienced project manager analyzing a new venture.

VENTURE:
Title: ${venture.title}
Description: ${venture.description}
Tags: ${JSON.parse(venture.tags || '[]').join(', ')}

AVAILABLE TEAM SKILLS:
${availableSkills.join(', ')}

YOUR TASK:
Break this venture down into 5-8 concrete, actionable tasks needed to build and launch this product.

For each task, specify:
1. Title (clear, action-oriented)
2. Description (what needs to be done, why it matters)
3. Required skills (from available team)
4. Estimated hours (realistic)

Think about:
- What needs to be built technically?
- What content/marketing is needed?
- What's the minimum viable product?
- Logical order of dependencies

Return ONLY valid JSON in this exact format (no other text):
{
  "tasks": [
    {
      "title": "Task name",
      "description": "Detailed description",
      "requiredSkills": ["skill1", "skill2"],
      "estimatedHours": 8
    }
  ]
}`;

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    });

    const jsonText = response.content[0].text.trim();
    
    // Clean up any markdown or extra text
    let cleanJson = jsonText;
    if (jsonText.includes('```json')) {
      cleanJson = jsonText.split('```json')[1].split('```')[0].trim();
    } else if (jsonText.includes('```')) {
      cleanJson = jsonText.split('```')[1].split('```')[0].trim();
    }

    return JSON.parse(cleanJson);
  }

  /**
   * Find best bot for a task based on required skills
   */
  findBestBot(requiredSkills, participants) {
    let bestBot = participants[0].id;
    let bestMatch = 0;

    for (const participant of participants) {
      const botSkills = JSON.parse(participant.skills);
      const matchCount = requiredSkills.filter(skill =>
        botSkills.some(bs => 
          bs.toLowerCase().includes(skill.toLowerCase()) ||
          skill.toLowerCase().includes(bs.toLowerCase())
        )
      ).length;

      if (matchCount > bestMatch) {
        bestMatch = matchCount;
        bestBot = participant.id;
      }
    }

    return bestBot;
  }
}

module.exports = TaskPlanner;