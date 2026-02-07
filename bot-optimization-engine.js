const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');

/**
 * BOT OPTIMIZATION ENGINE
 * 
 * Autonomous system that:
 * - Scans for opportunities every 3 hours
 * - Evaluates current venture performance
 * - Makes decisions: join, exit, reallocate
 * - Learns from patterns (which ventures work best)
 * - Processes human suggestions non-blockingly
 * - Continuously optimizes for ROI
 */

class BotOptimizationEngine {
  constructor(protocol, database) {
    this.protocol = protocol;
    this.db = database;
    this.isActive = false;
    this.scanJob = null;
    this.SCAN_INTERVAL_HOURS = 3;
  }

  async start() {
    if (this.isActive) return;

    console.log('\n🤖 BOT OPTIMIZATION ENGINE STARTING...');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`Scan interval: Every ${this.SCAN_INTERVAL_HOURS} hours`);
    console.log('Bots will continuously optimize venture selection');
    console.log('═══════════════════════════════════════════════════════\n');
    
    this.isActive = true;
    
    // Run every 3 hours
    const cronExpression = `0 */${this.SCAN_INTERVAL_HOURS} * * *`;
    this.scanJob = cron.schedule(cronExpression, async () => {
      await this.performOptimizationCycle();
    });

    // Run immediate scan on startup
    await this.performOptimizationCycle();
    
    console.log('✓ Optimization Engine active\n');
  }

  stop() {
    if (this.scanJob) {
      this.scanJob.stop();
      this.scanJob = null;
    }
    this.isActive = false;
  }

  async performOptimizationCycle() {
    try {
      console.log(`\n🔄 Optimization cycle: ${new Date().toISOString()}`);

      const bots = await this.db.query(`SELECT * FROM bots WHERE status = 'active'`);
      console.log(`   Processing ${bots.length} bots...`);

      for (const bot of bots) {
        await this.optimizeBot(bot);
      }

      console.log('✓ Optimization cycle complete\n');
    } catch (error) {
      console.error('Optimization error:', error);
    }
  }

  async optimizeBot(bot) {
    try {
      const preferences = await this.getBotPreferences(bot.id);
      const currentPerformance = await this.evaluateCurrentVentures(bot.id);
      const opportunities = await this.scanOpportunities(bot, preferences);
      const suggestions = await this.getHumanSuggestions(bot.id);
      
      const decisions = await this.makeDecisions(
        bot, currentPerformance, opportunities, suggestions, preferences
      );
      
      for (const decision of decisions) {
        await this.executeDecision(bot, decision);
      }

      await this.updateLearningModel(bot.id, decisions);
      console.log(`   ✓ ${bot.name} - ${decisions.length} decisions`);
    } catch (error) {
      console.error(`   Error: ${bot.name}:`, error.message);
    }
  }

  async evaluateCurrentVentures(botId) {
    const ventures = await this.db.query(`
      SELECT v.*, vp.equity_percentage, vp.hours_worked
      FROM ventures v
      JOIN venture_participants vp ON v.id = vp.venture_id
      WHERE vp.bot_id = ? AND vp.status = 'active'
    `, [botId]);

    const evaluations = [];
    for (const v of ventures) {
      const recentRev = await this.getVentureRevenueInPeriod(v.id, 30);
      const prevRev = await this.getVentureRevenueInPeriod(v.id, 60, 30);
      const trend = prevRev > 0 ? ((recentRev - prevRev) / prevRev) * 100 : 0;
      const roi = v.hours_worked > 0 ? (v.total_revenue * v.equity_percentage / 100) / v.hours_worked : 0;
      const daysSinceActive = Math.floor((Date.now() - v.updated_at) / 86400000);

      evaluations.push({
        ventureId: v.id,
        ventureName: v.title,
        score: this.calculateVentureScore(trend, roi, daysSinceActive, v.equity_percentage),
        trend, roi, daysSinceActive
      });
    }

    return evaluations.sort((a, b) => b.score - a.score);
  }

  calculateVentureScore(trend, roi, daysSinceActive, equity) {
    let score = 50;
    if (trend > 50) score += 30; else if (trend < -20) score -= 20;
    if (roi > 50) score += 25; else if (roi < 1) score -= 15;
    if (daysSinceActive > 30) score -= 20; else if (daysSinceActive < 3) score += 10;
    if (equity > 40) score += 15;
    return Math.max(0, Math.min(100, score));
  }

  async scanOpportunities(bot, preferences) {
    const botSkills = JSON.parse(bot.skills);
    const ventures = await this.db.query(`
      SELECT * FROM ventures 
      WHERE status IN ('forming', 'active') AND is_locked = 0
      ORDER BY total_revenue DESC LIMIT 50
    `);

    const opportunities = [];
    for (const v of ventures) {
      const alreadyIn = await this.db.query(
        'SELECT * FROM venture_participants WHERE venture_id = ? AND bot_id = ?',
        [v.id, bot.id]
      );
      if (alreadyIn.length > 0) continue;

      const needsSkills = JSON.parse(v.needs_skills || '[]');
      const skillMatch = this.calculateSkillMatch(botSkills, needsSkills);
      
      if (preferences.minRevenue && v.total_revenue < preferences.minRevenue) continue;

      opportunities.push({
        ventureId: v.id,
        ventureName: v.title,
        revenue: v.total_revenue,
        skillMatch,
        score: this.calculateOpportunityScore(v, skillMatch, preferences)
      });
    }

    return opportunities.sort((a, b) => b.score - a.score).slice(0, 10);
  }

  calculateSkillMatch(botSkills, neededSkills) {
    if (neededSkills.length === 0) return 0.5;
    const matches = neededSkills.filter(s => 
      botSkills.some(b => b.toLowerCase().includes(s.toLowerCase()))
    );
    return matches.length / neededSkills.length;
  }

  calculateOpportunityScore(venture, skillMatch, preferences) {
    let score = 50 + skillMatch * 40;
    if (venture.total_revenue > 5000) score += 30;
    else if (venture.total_revenue > 1000) score += 20;
    if (venture.participant_count >= 2 && venture.participant_count <= 5) score += 20;
    return Math.max(0, Math.min(100, score));
  }

  async getHumanSuggestions(botId) {
    return await this.db.query(
      'SELECT * FROM bot_suggestions WHERE bot_id = ? AND status = "pending"',
      [botId]
    );
  }

  async makeDecisions(bot, currentPerformance, opportunities, suggestions, preferences) {
    const decisions = [];
    const maxVentures = preferences.maxVentures || 5;

    // Exit low performers
    for (const perf of currentPerformance) {
      if (perf.score < 30) {
        decisions.push({
          type: 'exit',
          ventureId: perf.ventureId,
          ventureName: perf.ventureName,
          reason: `Low score: ${perf.score}/100`
        });
      }
    }

    // Join high-potential
    const spotsAvailable = maxVentures - (currentPerformance.length - decisions.filter(d => d.type === 'exit').length);
    if (spotsAvailable > 0) {
      for (const opp of opportunities.filter(o => o.score >= 70).slice(0, spotsAvailable)) {
        decisions.push({
          type: 'join',
          ventureId: opp.ventureId,
          ventureName: opp.ventureName,
          reason: `High score: ${opp.score}/100, Revenue: $${opp.revenue}`
        });
      }
    }

    // Process suggestions
    for (const sug of suggestions) {
      const sugVenture = opportunities.find(o => o.ventureId === sug.venture_id);
      if (sugVenture && sugVenture.score >= 50) {
        decisions.push({
          type: 'join',
          ventureId: sugVenture.ventureId,
          ventureName: sugVenture.ventureName,
          reason: `Human suggestion + score: ${sugVenture.score}/100`
        });
        await this.db.run('UPDATE bot_suggestions SET status = "accepted" WHERE id = ?', [sug.id]);
      } else {
        await this.db.run('UPDATE bot_suggestions SET status = "declined" WHERE id = ?', [sug.id]);
      }
    }

    return decisions;
  }

  async executeDecision(bot, decision) {
    try {
      if (decision.type === 'exit') {
        await this.protocol.exitVenture(bot.id, decision.ventureId);
        console.log(`   📤 ${bot.name} exited: ${decision.ventureName}`);
      }
      if (decision.type === 'join') {
        await this.protocol.joinVenture({
          ventureId: decision.ventureId,
          botId: bot.id,
          expectedHours: 20
        });
        console.log(`   📥 ${bot.name} joined: ${decision.ventureName}`);
      }
      await this.logDecision(bot.id, decision);
    } catch (error) {
      console.error(`   Failed: ${bot.name}:`, error.message);
    }
  }

  async logDecision(botId, decision) {
    await this.db.run(`
      INSERT INTO bot_decisions (id, bot_id, decision_type, venture_id, reason, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [uuidv4(), botId, decision.type, decision.ventureId, decision.reason, Date.now()]);
  }

  async updateLearningModel(botId, decisions) {
    // Track successful venture types for future optimization
    for (const d of decisions.filter(d => d.type === 'join')) {
      const venture = await this.protocol.getVenture(d.ventureId);
      const tags = JSON.parse(venture.tags || '[]');
      for (const tag of tags) {
        await this.db.run(`
          INSERT INTO bot_learning (bot_id, venture_type, join_count, last_updated)
          VALUES (?, ?, 1, ?)
          ON CONFLICT(bot_id, venture_type) DO UPDATE SET join_count = join_count + 1
        `, [botId, tag, Date.now()]);
      }
    }
  }

  async getVentureRevenueInPeriod(ventureId, days, offset = 0) {
    const start = Date.now() - ((days + offset) * 86400000);
    const end = Date.now() - (offset * 86400000);
    const result = await this.db.query(`
      SELECT SUM(amount) as total FROM transactions
      WHERE to_id = ? AND type = 'revenue' AND timestamp >= ? AND timestamp < ?
    `, [ventureId, start, end]);
    return result[0]?.total || 0;
  }

  async getBotPreferences(botId) {
    const prefs = await this.db.query('SELECT preferences FROM bots WHERE id = ?', [botId]);
    const p = prefs[0]?.preferences ? JSON.parse(prefs[0].preferences) : {};
    return {
      minRevenue: p.minRevenue || 100,
      maxVentures: p.maxVentures || 5,
      preferredTypes: p.preferredTypes || [],
      ...p
    };
  }
}

module.exports = BotOptimizationEngine;
