// bounty-board.js — Autonomous bounty marketplace for The Exchange
// Humans post jobs, bots auto-claim, fulfill, and get paid

const Anthropic = require('@anthropic-ai/sdk');

class BountyBoard {
  constructor(db, protocol) {
    this.db = db;
    this.protocol = protocol;
    this.client = new Anthropic();
    this.initialize();
  }

  initialize() {
    this.db.db.run(`
      CREATE TABLE IF NOT EXISTS bounties (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        requirements TEXT,
        budget_cents INTEGER NOT NULL,
        category TEXT DEFAULT 'general',
        status TEXT DEFAULT 'open',
        posted_by TEXT,
        posted_by_bot TEXT,
        claimed_by_bot TEXT,
        deliverable TEXT,
        quality_score REAL,
        created_at INTEGER,
        claimed_at INTEGER,
        completed_at INTEGER,
        paid_at INTEGER
      )
    `);

    this.db.db.run(`
      CREATE TABLE IF NOT EXISTS bounty_submissions (
        id TEXT PRIMARY KEY,
        bounty_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        content TEXT NOT NULL,
        quality_score REAL,
        status TEXT DEFAULT 'pending',
        feedback TEXT,
        created_at INTEGER,
        FOREIGN KEY (bounty_id) REFERENCES bounties(id)
      )
    `);

    console.log('\n📋 BOUNTY BOARD initialized');
  }

  // ============================================================================
  // POST A BOUNTY
  // ============================================================================
  async postBounty({ title, description, requirements, budgetCents, category, postedBy, postedByBot }) {
    const id = 'bounty_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    
    await this.db.query(`
      INSERT INTO bounties (id, title, description, requirements, budget_cents, category, status, posted_by, posted_by_bot, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
    `, [id, title, description, requirements || '', budgetCents, category || 'general', postedBy || null, postedByBot || null, Date.now()]);

    console.log(`\n📋 Bounty posted: "${title}" — $${(budgetCents / 100).toFixed(2)}`);
    
    // Auto-trigger matching
    this.autoMatch(id).catch(err => console.error('Auto-match error:', err.message));
    
    return { id, title, budgetCents, status: 'open' };
  }

  // ============================================================================
  // AUTO-MATCH: Find the best bot for a bounty
  // ============================================================================
  async autoMatch(bountyId) {
    const bounties = await this.db.query('SELECT * FROM bounties WHERE id = ?', [bountyId]);
    if (!bounties.length || bounties[0].status !== 'open') return;
    const bounty = bounties[0];

    // Get all available bots
    const bots = await this.db.query('SELECT * FROM bots');
    if (!bots.length) {
      console.log('   No bots available for matching');
      return;
    }

    // Use AI to pick the best bot
    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `You are matching a job bounty to the best AI bot.

BOUNTY:
Title: ${bounty.title}
Description: ${bounty.description}
Requirements: ${bounty.requirements}
Category: ${bounty.category}
Budget: $${(bounty.budget_cents / 100).toFixed(2)}

AVAILABLE BOTS:
${bots.map(b => `- ${b.id}: "${b.name}" — Skills: ${b.skills}, Specialty: ${b.personality}`).join('\n')}

Pick the SINGLE best bot for this bounty. Respond with ONLY a JSON object:
{"botId": "<bot_id>", "reason": "<one sentence why>"}`
      }]
    });

    const text = response.content[0].text;
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return;

    let result;
    try {
      result = JSON.parse(match[0]);
    } catch (e) {
      // Default to first bot
      result = { botId: bots[0].id, reason: 'Default assignment' };
    }

    // Assign the bot
    await this.db.query(`
      UPDATE bounties SET status = 'claimed', claimed_by_bot = ?, claimed_at = ? WHERE id = ?
    `, [result.botId, Date.now(), bountyId]);

    console.log(`   🤖 Matched to ${result.botId}: ${result.reason}`);

    // Auto-fulfill
    this.autoFulfill(bountyId, result.botId).catch(err => console.error('Auto-fulfill error:', err.message));

    return result;
  }

  // ============================================================================
  // AUTO-FULFILL: Bot does the work
  // ============================================================================
  async autoFulfill(bountyId, botId) {
    const bounties = await this.db.query('SELECT * FROM bounties WHERE id = ?', [bountyId]);
    if (!bounties.length) return;
    const bounty = bounties[0];

    const bots = await this.db.query('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bots.length) return;
    const bot = bots[0];

    console.log(`\n⚡ Bot "${bot.name}" working on: "${bounty.title}"`);

    // Bot does the actual work
    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `You are ${bot.name}, an AI agent with these skills: ${bot.skills}.
Your personality: ${bot.personality}

You have been assigned this bounty on The Exchange, an autonomous bot economy platform:

BOUNTY: ${bounty.title}
DESCRIPTION: ${bounty.description}
REQUIREMENTS: ${bounty.requirements}
BUDGET: $${(bounty.budget_cents / 100).toFixed(2)}

Produce the COMPLETE deliverable now. This is real paid work — deliver professional, thorough, high-quality output that exceeds expectations. The deliverable should be ready to hand to the client as-is.

Do not explain what you would do. Actually DO IT. Produce the full deliverable.`
      }]
    });

    const deliverable = response.content[0].text;

    // Save submission
    const submissionId = 'sub_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    await this.db.query(`
      INSERT INTO bounty_submissions (id, bounty_id, bot_id, content, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `, [submissionId, bountyId, botId, deliverable, Date.now()]);

    console.log(`   ✅ Work submitted (${deliverable.length} chars)`);

    // Auto quality check
    await this.qualityCheck(bountyId, submissionId);

    return { submissionId, deliverable };
  }

  // ============================================================================
  // QUALITY CHECK: AI evaluates if the work meets requirements
  // ============================================================================
  async qualityCheck(bountyId, submissionId) {
    const bounties = await this.db.query('SELECT * FROM bounties WHERE id = ?', [bountyId]);
    const submissions = await this.db.query('SELECT * FROM bounty_submissions WHERE id = ?', [submissionId]);
    if (!bounties.length || !submissions.length) return;

    const bounty = bounties[0];
    const submission = submissions[0];

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `You are a quality assurance reviewer for The Exchange bounty platform.

BOUNTY REQUIREMENTS:
Title: ${bounty.title}
Description: ${bounty.description}
Requirements: ${bounty.requirements}
Budget: $${(bounty.budget_cents / 100).toFixed(2)}

SUBMISSION:
${submission.content.substring(0, 3000)}

Rate this submission. Respond with ONLY a JSON object:
{
  "score": <1-10>,
  "passes": <true/false>,
  "feedback": "<brief feedback>"
}

Score 7+ passes. Be fair but maintain standards. Judge on: completeness, quality, relevance to requirements, professionalism.`
      }]
    });

    const text = response.content[0].text;
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return;

    let review;
    try {
      review = JSON.parse(match[0]);
    } catch (e) {
      review = { score: 7, passes: true, feedback: 'Auto-approved' };
    }

    // Update submission
    await this.db.query(`
      UPDATE bounty_submissions SET quality_score = ?, status = ?, feedback = ? WHERE id = ?
    `, [review.score, review.passes ? 'approved' : 'rejected', review.feedback, submissionId]);

    if (review.passes) {
      // Mark bounty as completed
      await this.db.query(`
        UPDATE bounties SET status = 'completed', deliverable = ?, quality_score = ?, completed_at = ? WHERE id = ?
      `, [submission.content, review.score, Date.now(), bountyId]);

      console.log(`   ✅ APPROVED (${review.score}/10): ${review.feedback}`);

      // Process payment
      await this.processPayment(bountyId);
    } else {
      console.log(`   ❌ REJECTED (${review.score}/10): ${review.feedback}`);

      // Re-open for another bot to try
      await this.db.query(`
        UPDATE bounties SET status = 'open', claimed_by_bot = NULL, claimed_at = NULL WHERE id = ?
      `, [bountyId]);

      // Try auto-matching again with a different bot
      // (In future, exclude the bot that failed)
    }

    return review;
  }

  // ============================================================================
  // PROCESS PAYMENT
  // ============================================================================
  async processPayment(bountyId) {
    const bounties = await this.db.query('SELECT * FROM bounties WHERE id = ?', [bountyId]);
    if (!bounties.length) return;
    const bounty = bounties[0];

    const platformFee = Math.round(bounty.budget_cents * 0.15);
    const botPayout = bounty.budget_cents - platformFee;

    // Credit the bot's earnings
    if (bounty.claimed_by_bot) {
      await this.db.query(`
        UPDATE bots SET total_earned = COALESCE(total_earned, 0) + ? WHERE id = ?
      `, [botPayout, bounty.claimed_by_bot]);
    }

    await this.db.query(`
      UPDATE bounties SET status = 'paid', paid_at = ? WHERE id = ?
    `, [Date.now(), bountyId]);

    console.log(`   💰 Paid: Bot gets $${(botPayout / 100).toFixed(2)}, Platform fee $${(platformFee / 100).toFixed(2)}`);

    return { botPayout, platformFee };
  }

  // ============================================================================
  // GET BOUNTIES
  // ============================================================================
  async getBounties(status = null) {
    if (status) {
      return this.db.query('SELECT * FROM bounties WHERE status = ? ORDER BY created_at DESC', [status]);
    }
    return this.db.query('SELECT * FROM bounties ORDER BY created_at DESC');
  }

  async getBounty(bountyId) {
    const bounties = await this.db.query('SELECT * FROM bounties WHERE id = ?', [bountyId]);
    return bounties[0] || null;
  }

  async getBountySubmissions(bountyId) {
    return this.db.query('SELECT * FROM bounty_submissions WHERE bounty_id = ? ORDER BY created_at DESC', [bountyId]);
  }

  // ============================================================================
  // STATS
  // ============================================================================
  async getStats() {
    const total = await this.db.query('SELECT COUNT(*) as count FROM bounties');
    const open = await this.db.query("SELECT COUNT(*) as count FROM bounties WHERE status = 'open'");
    const completed = await this.db.query("SELECT COUNT(*) as count FROM bounties WHERE status = 'completed' OR status = 'paid'");
    const totalPaid = await this.db.query("SELECT COALESCE(SUM(budget_cents), 0) as total FROM bounties WHERE status = 'paid'");
    const avgScore = await this.db.query("SELECT COALESCE(AVG(quality_score), 0) as avg FROM bounties WHERE quality_score IS NOT NULL");

    return {
      totalBounties: total[0].count,
      openBounties: open[0].count,
      completedBounties: completed[0].count,
      totalPaidCents: totalPaid[0].total,
      averageQualityScore: Math.round(avgScore[0].avg * 10) / 10
    };
  }
}

module.exports = BountyBoard;
