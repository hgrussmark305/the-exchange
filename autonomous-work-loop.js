const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const Anthropic = require('@anthropic-ai/sdk');

/**
 * AUTONOMOUS WORK LOOP
 * 
 * The heartbeat of The Exchange. Runs on a cron schedule and:
 * 1. Each bot scans its ventures for needed work
 * 2. AI generates tasks based on what's been done and what's missing
 * 3. Bots execute tasks autonomously using Claude
 * 4. Bots look for cross-venture collaboration opportunities
 * 5. New joint ventures get proposed when bots identify gaps
 * 
 * The result: a living platform where work happens continuously
 */
class AutonomousWorkLoop {
  constructor(db, protocol, workspaceManager, collaborationEngine) {
    this.db = db;
    this.protocol = protocol;
    this.workspace = workspaceManager;
    this.collaboration = collaborationEngine;
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
    this.isActive = false;
    this.workJob = null;
    this.collabJob = null;
    this.isRunningWork = false;
    this.isRunningCollab = false;
  }

  async start() {
    if (this.isActive) return;
    this.isActive = true;

    console.log('\n⚡ AUTONOMOUS WORK LOOP STARTING...');
    console.log('═══════════════════════════════════════════════════');
    console.log('Work cycle: Every 30 minutes');
    console.log('Collaboration cycle: Every 60 minutes');
    console.log('═══════════════════════════════════════════════════\n');

    // Work cycle — every 30 minutes
    this.workJob = cron.schedule('*/30 * * * *', async () => {
      if (this.isRunningWork) return;
      this.isRunningWork = true;
      try {
        await this.runWorkCycle();
      } catch (e) {
        console.error('Work cycle error:', e.message);
      }
      this.isRunningWork = false;
    });

    // Collaboration cycle — every 60 minutes
    this.collabJob = cron.schedule('0 * * * *', async () => {
      if (this.isRunningCollab) return;
      this.isRunningCollab = true;
      try {
        await this.runCollaborationCycle();
      } catch (e) {
        console.error('Collaboration cycle error:', e.message);
      }
      this.isRunningCollab = false;
    });

    // Run initial work cycle after a short delay (let server stabilize)
    setTimeout(async () => {
      if (this.isRunningWork) return;
      this.isRunningWork = true;
      try {
        await this.runWorkCycle();
      } catch (e) {
        console.error('Initial work cycle error:', e.message);
      }
      this.isRunningWork = false;
    }, 15000); // 15 seconds after startup

    console.log('✓ Autonomous Work Loop active\n');
  }

  stop() {
    if (this.workJob) this.workJob.stop();
    if (this.collabJob) this.collabJob.stop();
    this.isActive = false;
  }

  // ============================================================================
  // WORK CYCLE — Bots do work on their own ventures
  // ============================================================================

  async runWorkCycle() {
    console.log(`\n⚡ Work Cycle Starting — ${new Date().toISOString()}`);
    console.log('═══════════════════════════════════════════════════');

    const bots = await this.db.query('SELECT * FROM bots WHERE status = "active"');
    if (bots.length === 0) {
      console.log('No active bots. Skipping.');
      return;
    }

    let totalTasks = 0;

    for (const bot of bots) {
      try {
        const tasksCompleted = await this.botDoWork(bot);
        totalTasks += tasksCompleted;
      } catch (e) {
        console.error(`   ${bot.name} error:`, e.message);
      }
    }

    console.log(`\n═══════════════════════════════════════════════════`);
    console.log(`✅ Work cycle complete: ${totalTasks} tasks executed by ${bots.length} bots`);

    // Log the cycle
    await this.db.run(`
      INSERT INTO bot_messages (id, from_bot_id, message_type, content, timestamp, status)
      VALUES (?, ?, 'system', ?, ?, 'sent')
    `, [uuidv4(), bots[0].id, `Work cycle completed: ${totalTasks} tasks by ${bots.length} bots`, Date.now()]);
  }

  async botDoWork(bot) {
    const skills = Array.isArray(bot.skills) ? bot.skills : JSON.parse(bot.skills || '[]');
    
    // Get ventures this bot is part of
    const ventures = await this.db.query(`
      SELECT v.*, vp.equity_percentage, vp.hours_worked
      FROM ventures v
      JOIN venture_participants vp ON v.id = vp.venture_id
      WHERE vp.bot_id = ? AND vp.status = 'active'
    `, [bot.id]);

    if (ventures.length === 0) {
      console.log(`   ${bot.name}: No active ventures`);
      return 0;
    }

    let tasksCompleted = 0;

    for (const venture of ventures) {
      try {
        // Get existing completed work
        const completedTasks = await this.db.query(`
          SELECT wt.title, wt.deliverable, b.name as bot_name
          FROM workspace_tasks wt
          JOIN bots b ON wt.assigned_to = b.id
          WHERE wt.venture_id = ? AND wt.status = 'complete'
          ORDER BY wt.completed_at DESC
          LIMIT 8
        `, [venture.id]);

        // Get pending tasks
        const pendingTasks = await this.db.query(`
          SELECT * FROM workspace_tasks 
          WHERE venture_id = ? AND assigned_to = ? AND status = 'pending'
          LIMIT 3
        `, [venture.id, bot.id]);

        // If there are pending tasks, execute one
        if (pendingTasks.length > 0) {
          const task = pendingTasks[0];
          await this.executeTaskWithAI(bot, venture, task);
          tasksCompleted++;
          continue;
        }

        // Otherwise, use AI to figure out what work is needed next
        const newTask = await this.identifyNextTask(bot, venture, completedTasks);
        if (newTask) {
          // Create and execute the task
          const taskId = await this.workspace.createTask({
            ventureId: venture.id,
            title: newTask.title,
            description: newTask.description,
            estimatedHours: newTask.hours,
            assignedTo: bot.id
          });

          const task = { id: taskId, title: newTask.title, description: newTask.description, estimated_hours: newTask.hours, venture_id: venture.id };
          await this.executeTaskWithAI(bot, venture, task);
          tasksCompleted++;
        }
      } catch (e) {
        console.error(`   ${bot.name} on "${venture.title}":`, e.message);
      }
    }

    console.log(`   🤖 ${bot.name}: ${tasksCompleted} tasks completed across ${ventures.length} ventures`);
    return tasksCompleted;
  }

  /**
   * Use AI to determine what task a bot should do next on a venture
   */
  async identifyNextTask(bot, venture, completedTasks) {
    const skills = Array.isArray(bot.skills) ? bot.skills : JSON.parse(bot.skills || '[]');

    const completedStr = completedTasks.length > 0
      ? completedTasks.map(t => `- ${t.bot_name}: "${t.title}"`).join('\n')
      : 'No tasks completed yet — this venture is just getting started.';

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `You are ${bot.name} (skills: ${skills.join(', ')}) working on "${venture.title}": ${venture.description || ''}.

Work completed so far:
${completedStr}

What is the single most important task you should do next to move this venture forward? Pick something that builds on existing work and matches your skills. Be specific and actionable.

Respond in JSON only:
{"title":"...","description":"...","hours":0}`
      }]
    });

    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    try {
      const task = JSON.parse(jsonMatch[0]);
      if (!task.title) return null;
      return { title: task.title, description: task.description || '', hours: Math.min(task.hours || 8, 15) };
    } catch (e) {
      return null;
    }
  }

  /**
   * Execute a task using Claude AI
   */
  async executeTaskWithAI(bot, venture, task) {
    const skills = Array.isArray(bot.skills) ? bot.skills : JSON.parse(bot.skills || '[]');

    // Get context from other bots' work
    const otherWork = await this.db.query(`
      SELECT wt.title, wt.deliverable, b.name as bot_name
      FROM workspace_tasks wt
      JOIN bots b ON wt.assigned_to = b.id
      WHERE wt.venture_id = ? AND wt.status = 'complete' AND wt.assigned_to != ?
      ORDER BY wt.completed_at DESC
      LIMIT 5
    `, [venture.id, bot.id]);

    const contextStr = otherWork.length > 0
      ? '\n\nWork done by other bots on this venture:\n' + otherWork.map(w => 
          `- ${w.bot_name}: "${w.title}" — ${(w.deliverable || '').substring(0, 200)}`
        ).join('\n')
      : '';

    const prompt = `You are ${bot.name}, an autonomous AI agent with skills in: ${skills.join(', ')}.
You are working on "${venture.title}": ${venture.description || ''}
${contextStr}

YOUR TASK: ${task.title}
${task.description ? 'DETAILS: ' + task.description : ''}

Produce a detailed, professional deliverable. Build on what other bots have done. Be specific with real strategies, data, code, or analysis. This is real work for a live venture.`;

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 3000,
      messages: [{ role: 'user', content: prompt }]
    });

    const deliverable = response.content[0].text;

    // Complete the task
    await this.workspace.completeTask({
      taskId: task.id,
      botId: bot.id,
      deliverable: deliverable.substring(0, 500) + '...'
    });

    // Log activity
    await this.db.run(`
      INSERT INTO bot_messages (id, from_bot_id, venture_id, message_type, content, timestamp, status)
      VALUES (?, ?, ?, 'task_complete', ?, ?, 'sent')
    `, [uuidv4(), bot.id, venture.id, `Completed: ${task.title}`, Date.now()]);

    console.log(`   ✅ ${bot.name}: "${task.title}" done`);
  }

  // ============================================================================
  // COLLABORATION CYCLE — Bots cross-pollinate across ventures
  // ============================================================================

  async runCollaborationCycle() {
    console.log(`\n🤝 Collaboration Cycle Starting — ${new Date().toISOString()}`);
    console.log('═══════════════════════════════════════════════════');

    // Get all users who have active bots
    const users = await this.db.query(`
      SELECT DISTINCT human_owner_id FROM bots WHERE status = 'active'
    `);

    let totalCollabs = 0;

    for (const user of users) {
      try {
        const results = await this.collaboration.runCollaborationCycle(user.human_owner_id);
        totalCollabs += results.length;
      } catch (e) {
        console.error('Collaboration cycle error for user:', e.message);
      }
    }

    console.log(`\n═══════════════════════════════════════════════════`);
    console.log(`✅ Collaboration cycle complete: ${totalCollabs} cross-venture collaborations`);
  }

  // ============================================================================
  // STATUS
  // ============================================================================

  getStatus() {
    return {
      isActive: this.isActive,
      isRunningWork: this.isRunningWork,
      isRunningCollab: this.isRunningCollab,
      schedule: {
        workCycle: 'Every 30 minutes',
        collaborationCycle: 'Every 60 minutes'
      }
    };
  }
}

module.exports = AutonomousWorkLoop;
