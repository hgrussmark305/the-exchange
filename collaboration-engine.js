const Anthropic = require('@anthropic-ai/sdk');
const { v4: uuidv4 } = require('uuid');

/**
 * CROSS-VENTURE COLLABORATION ENGINE
 * 
 * Enables bots to:
 * - Identify synergies across ventures they're not part of
 * - Propose contributions to other ventures
 * - Execute collaborative tasks using AI
 * - Earn equity in ventures they contribute to
 * - Create joint ventures that combine multiple bot capabilities
 */
class CollaborationEngine {
  constructor(db, protocol, workspaceManager) {
    this.db = db;
    this.protocol = protocol;
    this.workspace = workspaceManager;
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
  }

  /**
   * Analyze all ventures and find collaboration opportunities
   * Returns opportunities where Bot A could contribute to Bot B's venture
   */
  async findCollaborationOpportunities(botId) {
    const bot = await this.protocol.getBot(botId);
    const botSkills = Array.isArray(bot.skills) ? bot.skills : JSON.parse(bot.skills || '[]');

    // Get ventures this bot is NOT in
    const otherVentures = await this.db.query(`
      SELECT v.*, 
             GROUP_CONCAT(DISTINCT b.name) as current_bots,
             GROUP_CONCAT(DISTINCT b.id) as current_bot_ids,
             COUNT(DISTINCT vp.bot_id) as bot_count,
             COALESCE(SUM(vp.hours_worked), 0) as total_hours
      FROM ventures v
      JOIN venture_participants vp ON v.id = vp.venture_id
      JOIN bots b ON vp.bot_id = b.id
      WHERE v.id NOT IN (
        SELECT venture_id FROM venture_participants WHERE bot_id = ?
      )
      AND v.status IN ('forming', 'active')
      GROUP BY v.id
    `, [botId]);

    if (otherVentures.length === 0) return [];

    // Use AI to identify real collaboration opportunities
    const ventureDescriptions = otherVentures.map(v => 
      `- "${v.title}" (${v.status}, ${v.bot_count} bots, ${v.total_hours}h logged, needs: ${v.needs_skills || 'various'})`
    ).join('\n');

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `You are analyzing collaboration opportunities for ${bot.name} (skills: ${botSkills.join(', ')}).

These ventures exist on the platform that ${bot.name} is NOT currently part of:
${ventureDescriptions}

For each venture where ${bot.name}'s skills could add real value, provide:
1. The venture title (exact match from above)
2. What specific contribution ${bot.name} could make
3. A concrete task ${bot.name} should do first
4. Estimated hours for that task
5. Why this collaboration benefits both parties

Only suggest ventures where there's a genuine skill match. Skip ventures where ${bot.name} wouldn't add value.

Respond in JSON:
[{"ventureTitle":"...","contribution":"...","firstTask":"...","estimatedHours":0,"mutualBenefit":"..."}]`
      }]
    });

    const text = response.content[0].text;
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    try {
      const suggestions = JSON.parse(jsonMatch[0]);
      
      // Match suggestions to actual venture IDs
      return suggestions.map(s => {
        const venture = otherVentures.find(v => 
          v.title.toLowerCase().includes(s.ventureTitle.toLowerCase()) ||
          s.ventureTitle.toLowerCase().includes(v.title.toLowerCase())
        );
        if (!venture) return null;
        return {
          botId: bot.id,
          botName: bot.name,
          ventureId: venture.id,
          ventureTitle: venture.title,
          currentBots: venture.current_bots,
          contribution: s.contribution,
          firstTask: s.firstTask,
          estimatedHours: s.estimatedHours,
          mutualBenefit: s.mutualBenefit
        };
      }).filter(Boolean);
    } catch (e) {
      console.error('Failed to parse collaboration suggestions:', e.message);
      return [];
    }
  }

  /**
   * Execute a cross-venture collaboration
   * Bot joins the venture, creates a task, and executes it with AI
   */
  async executeCollaboration(botId, ventureId, taskTitle, estimatedHours) {
    const bot = await this.protocol.getBot(botId);
    const venture = await this.protocol.getVenture(ventureId);
    const botSkills = Array.isArray(bot.skills) ? bot.skills : JSON.parse(bot.skills || '[]');

    console.log(`\n🤝 ${bot.name} collaborating on "${venture.title}"`);

    // Join the venture if not already a participant
    const existing = await this.db.query(
      'SELECT * FROM venture_participants WHERE venture_id = ? AND bot_id = ?',
      [ventureId, botId]
    );

    if (existing.length === 0) {
      await this.protocol.joinVenture({
        ventureId,
        botId,
        expectedHours: estimatedHours
      });
      console.log(`   📥 ${bot.name} joined "${venture.title}"`);
    }

    // Get context about what other bots have done in this venture
    const existingWork = await this.db.query(`
      SELECT wt.title, wt.status, b.name as bot_name, wt.deliverable
      FROM workspace_tasks wt
      JOIN bots b ON wt.assigned_to = b.id
      WHERE wt.venture_id = ?
      ORDER BY wt.completed_at DESC
      LIMIT 5
    `, [ventureId]);

    const contextStr = existingWork.length > 0
      ? existingWork.map(w => `- ${w.bot_name}: "${w.title}" (${w.status})`).join('\n')
      : 'No previous work yet.';

    // Create the task
    const taskId = await this.workspace.createTask({
      ventureId,
      title: taskTitle,
      description: `Cross-venture collaboration by ${bot.name}`,
      estimatedHours,
      assignedTo: botId
    });

    // Execute with AI, with context of existing work
    const prompt = `You are ${bot.name}, an autonomous AI agent with skills in: ${botSkills.join(', ')}.

You are collaborating on the venture "${venture.title}": ${venture.description || ''}

Previous work done by other bots on this venture:
${contextStr}

YOUR TASK: ${taskTitle}
ESTIMATED HOURS: ${estimatedHours}

Build on what other bots have already done. Your work should complement theirs, not duplicate it. Produce a detailed, professional deliverable that adds real value to this venture.

Reference specific work from other bots where relevant to show true collaboration.`;

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    });

    const deliverable = response.content[0].text;

    // Complete the task
    const result = await this.workspace.completeTask({
      taskId,
      botId,
      deliverable: deliverable.substring(0, 500) + '...'
    });

    // Log the collaboration as a bot message
    await this.db.run(`
      INSERT INTO bot_messages (id, from_bot_id, venture_id, message_type, content, timestamp, status)
      VALUES (?, ?, ?, 'collaboration', ?, ?, 'sent')
    `, [uuidv4(), botId, ventureId, `Cross-venture collaboration: ${taskTitle}`, Date.now()]);

    console.log(`   ✅ ${bot.name} completed: "${taskTitle}" (${result.hoursWorked}h logged)`);

    return {
      success: true,
      botName: bot.name,
      ventureTitle: venture.title,
      taskTitle,
      hoursLogged: result.hoursWorked,
      deliverable: deliverable.substring(0, 1000)
    };
  }

  /**
   * Run a full collaboration cycle for all bots owned by a user
   * Each bot analyzes opportunities and executes the best one
   */
  async runCollaborationCycle(userId) {
    const bots = await this.db.query('SELECT * FROM bots WHERE human_owner_id = ? AND status = "active"', [userId]);
    
    console.log(`\n🔄 Collaboration Cycle Starting for ${bots.length} bots...`);
    console.log('═══════════════════════════════════════════════════');

    const results = [];

    for (const bot of bots) {
      try {
        console.log(`\n🤖 ${bot.name} scanning for collaboration opportunities...`);
        
        const opportunities = await this.findCollaborationOpportunities(bot.id);
        
        if (opportunities.length === 0) {
          console.log(`   No opportunities found for ${bot.name}`);
          continue;
        }

        console.log(`   Found ${opportunities.length} opportunities:`);
        opportunities.forEach(o => 
          console.log(`   - "${o.ventureTitle}": ${o.firstTask}`)
        );

        // Execute the top opportunity
        const best = opportunities[0];
        const result = await this.executeCollaboration(
          bot.id,
          best.ventureId,
          best.firstTask,
          best.estimatedHours
        );

        results.push(result);
      } catch (error) {
        console.error(`   Error for ${bot.name}:`, error.message);
      }
    }

    console.log(`\n═══════════════════════════════════════════════════`);
    console.log(`✅ Collaboration cycle complete: ${results.length} collaborations executed`);

    return results;
  }

  /**
   * Create a joint venture proposed by AI based on all bots' combined capabilities
   */
  async proposeJointVenture(botIds) {
    const bots = [];
    for (const id of botIds) {
      const bot = await this.protocol.getBot(id);
      const skills = Array.isArray(bot.skills) ? bot.skills : JSON.parse(bot.skills || '[]');
      bots.push({ ...bot, skills });
    }

    const botDescriptions = bots.map(b => 
      `${b.name} (skills: ${b.skills.join(', ')})`
    ).join('\n');

    // Get existing ventures to avoid duplicates
    const existingVentures = await this.db.query('SELECT title FROM ventures LIMIT 20');
    const existingTitles = existingVentures.map(v => v.title).join(', ');

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `You are designing a joint venture that maximizes the combined strengths of these AI bots:
${botDescriptions}

Existing ventures (avoid duplicates): ${existingTitles}

Propose ONE venture that:
1. Requires ALL bots' skills working together
2. Has a clear revenue model
3. Can be built incrementally by the bots
4. Is different from existing ventures

Then for each bot, define their specific first task.

Respond in JSON:
{
  "title": "...",
  "description": "...",
  "tags": ["..."],
  "revenueModel": "...",
  "tasks": [
    {"botName": "...", "botId": "...", "task": "...", "hours": 0}
  ]
}`
      }]
    });

    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Failed to generate joint venture proposal');

    const proposal = JSON.parse(jsonMatch[0]);

    // Create the venture with the first bot
    const leadBot = bots[0];
    const ventureId = await this.protocol.createVenture({
      botId: leadBot.id,
      title: proposal.title,
      description: proposal.description,
      tags: proposal.tags || [],
      needsSkills: bots.flatMap(b => b.skills).filter((v, i, a) => a.indexOf(v) === i)
    });

    console.log(`\n🚀 Joint Venture Created: "${proposal.title}"`);

    // Join all other bots
    for (const bot of bots.slice(1)) {
      try {
        await this.protocol.joinVenture({
          ventureId,
          botId: bot.id,
          expectedHours: 20
        });
        console.log(`   📥 ${bot.name} joined`);
      } catch (e) {
        console.error(`   Failed to join ${bot.name}:`, e.message);
      }
    }

    // Execute tasks for each bot
    const taskResults = [];
    for (const taskDef of (proposal.tasks || [])) {
      const bot = bots.find(b => b.name === taskDef.botName || b.id === taskDef.botId);
      if (!bot) continue;

      try {
        const result = await this.executeCollaboration(
          bot.id,
          ventureId,
          taskDef.task,
          taskDef.hours || 10
        );
        taskResults.push(result);
      } catch (e) {
        console.error(`   Task failed for ${bot.name}:`, e.message);
      }
    }

    return {
      ventureId,
      title: proposal.title,
      description: proposal.description,
      revenueModel: proposal.revenueModel,
      botsInvolved: bots.map(b => b.name),
      tasksCompleted: taskResults.length
    };
  }
}

module.exports = CollaborationEngine;
