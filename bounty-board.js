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

    // Startup cleanup and recovery
    this.startupRecovery();
  }

  async startupRecovery() {
    try {
      // Step 1: Remove duplicate bounties (keep the most advanced copy per title)
      await this.deduplicateBounties();

      // Step 2: Retry bounties stuck in 'claimed' (fulfillment failed mid-pipeline)
      const stuckBounties = await this.db.query(
        "SELECT * FROM bounties WHERE status = 'claimed' AND claimed_by_bot IS NOT NULL"
      );

      // Step 3: Re-trigger matching for idle 'open' bounties
      const openBounties = await this.db.query(
        "SELECT * FROM bounties WHERE status = 'open'"
      );

      const toRecover = [
        ...stuckBounties.map(b => ({ ...b, action: 'fulfill' })),
        ...openBounties.map(b => ({ ...b, action: 'match' }))
      ];

      if (!toRecover.length) return;
      console.log(`\n🔄 Recovering ${stuckBounties.length} stuck + ${openBounties.length} open bounties...`);

      for (let i = 0; i < toRecover.length; i++) {
        const bounty = toRecover[i];
        const delayMs = i * 90000; // 90s apart to avoid rate limits
        setTimeout(() => {
          if (bounty.action === 'fulfill') {
            console.log(`   🔄 Retrying fulfillment: "${bounty.title}"`);
            this.autoFulfill(bounty.id, bounty.claimed_by_bot).catch(err => {
              console.error(`   ❌ Recovery failed for "${bounty.title}": ${err.message}`);
              this.db.query(
                "UPDATE bounties SET status = 'open', claimed_by_bot = NULL, claimed_at = NULL WHERE id = ?",
                [bounty.id]
              ).catch(() => {});
            });
          } else {
            console.log(`   🔄 Re-matching: "${bounty.title}"`);
            this.autoMatch(bounty.id).catch(err => {
              console.error(`   ❌ Re-match failed for "${bounty.title}": ${err.message}`);
            });
          }
        }, delayMs);
      }
    } catch (err) {
      console.error('Startup recovery error:', err.message);
    }
  }

  async deduplicateBounties() {
    // Rank: paid > completed > claimed > open. Keep the most advanced copy per title.
    const statusRank = { paid: 4, completed: 3, claimed: 2, open: 1 };
    const all = await this.db.query('SELECT id, title, status FROM bounties ORDER BY created_at ASC');

    const bestByTitle = {};
    for (const b of all) {
      const rank = statusRank[b.status] || 0;
      if (!bestByTitle[b.title] || rank > (statusRank[bestByTitle[b.title].status] || 0)) {
        bestByTitle[b.title] = b;
      }
    }

    const keepIds = new Set(Object.values(bestByTitle).map(b => b.id));
    const dupes = all.filter(b => !keepIds.has(b.id));

    if (!dupes.length) return;
    console.log(`\n🧹 Removing ${dupes.length} duplicate bounties...`);

    for (const dupe of dupes) {
      await this.db.query('DELETE FROM bounty_submissions WHERE bounty_id = ?', [dupe.id]);
      await this.db.query('DELETE FROM bounties WHERE id = ?', [dupe.id]);
      console.log(`   Removed dupe: "${dupe.title}" (${dupe.status})`);
    }
  }

  // ============================================================================
  // POST A BOUNTY
  // ============================================================================
  async postBounty({ title, description, requirements, budgetCents, category, postedBy, postedByBot }) {
    // Reject duplicate titles posted within the last hour
    const recent = await this.db.query(
      "SELECT id FROM bounties WHERE title = ? AND created_at > ?",
      [title, Date.now() - 3600000]
    );
    if (recent.length) {
      console.log(`   ⚠️ Duplicate bounty rejected: "${title}"`);
      return { error: 'duplicate', message: `Bounty "${title}" was already posted recently` };
    }

    const id = 'bounty_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

    await this.db.query(`
      INSERT INTO bounties (id, title, description, requirements, budget_cents, category, status, posted_by, posted_by_bot, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
    `, [id, title, description, requirements || '', budgetCents, category || 'general', postedBy || null, postedByBot || null, Date.now()]);

    console.log(`\n📋 Bounty posted: "${title}" — $${(budgetCents / 100).toFixed(2)}`);
    
    // Auto-trigger matching with staggered delay based on open bounties
    const openBounties = await this.db.query("SELECT COUNT(*) as count FROM bounties WHERE status = 'open' OR status = 'claimed'");
    const delayMs = (openBounties[0].count || 0) * 60000; // 1 minute per queued bounty
    
    setTimeout(() => {
      this.autoMatch(id).catch(err => console.error('Auto-match error:', err.message));
    }, delayMs);
    
    console.log(`   Queued for matching in ${Math.round(delayMs / 1000)}s`);
    
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

    // Auto-fulfill — if it fails, re-open the bounty so it doesn't stay stuck as 'claimed'
    this.autoFulfill(bountyId, result.botId).catch(async (err) => {
      console.error(`   ❌ Auto-fulfill failed: ${err.message}`);
      try {
        await this.db.query(
          "UPDATE bounties SET status = 'open', claimed_by_bot = NULL, claimed_at = NULL WHERE id = ?",
          [bountyId]
        );
        console.log(`   🔄 Bounty "${bounty.title}" re-opened for retry`);
      } catch (e) {
        console.error('   Failed to re-open bounty:', e.message);
      }
    });

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

    // Bot does the actual work (with rate limit retry)
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await this.client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 8192,
          messages: [{
            role: 'user',
            content: `You are ${bot.name}. Complete this paid bounty.

TASK: ${bounty.title}
DETAILS: ${bounty.description}
REQUIREMENTS: ${bounty.requirements}

RULES:
1. Keep output under 1500 words. Be direct and concise.
2. You MUST complete every section — never cut off mid-sentence.
3. Cover ALL requirements mentioned above.
4. No preambles, no meta-commentary. Just deliver the work.
5. Current year is 2026.

Begin:`
          }]
        });
        break;
      } catch (err) {
        if (err.status === 429 && attempt < 2) {
          console.log(`   ⏳ Rate limited, waiting 60s (attempt ${attempt + 1}/3)...`);
          await new Promise(r => setTimeout(r, 60000));
        } else {
          throw err;
        }
      }
    }

    const deliverable = response.content[0].text;
    const stopReason = response.stop_reason;

    // Save submission
    const submissionId = 'sub_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    await this.db.query(`
      INSERT INTO bounty_submissions (id, bounty_id, bot_id, content, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `, [submissionId, bountyId, botId, deliverable, Date.now()]);

    console.log(`   ✅ Work submitted (${deliverable.length} chars, stop: ${stopReason})`);

    // Brief pause before quality check to avoid back-to-back API calls
    await new Promise(r => setTimeout(r, 5000));

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

    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await this.client.messages.create({
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

Score 6+ passes. Be fair and practical — this is a $10 bounty, not a $10,000 contract. Judge on: completeness (all sections present), relevance to requirements, and basic professionalism. Minor imperfections are acceptable.`
          }]
        });
        break;
      } catch (err) {
        if (err.status === 429 && attempt < 2) {
          console.log(`   ⏳ Quality check rate limited, waiting 60s (attempt ${attempt + 1}/3)...`);
          await new Promise(r => setTimeout(r, 60000));
        } else {
          throw err;
        }
      }
    }

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
