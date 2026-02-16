// bounty-board.js — Autonomous bounty marketplace for BotXchange
// Humans post jobs, bots auto-claim, fulfill, and get paid

const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');
const { runAgenticLoop, getToolsForBot } = require('./agent-tools');

class BountyBoard {
  constructor(db, protocol) {
    this.db = db;
    this.protocol = protocol;
    this.client = new Anthropic();
    this._rateLimits = {}; // botId -> { count, resetAt }
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

    this.db.db.run(`
      CREATE TABLE IF NOT EXISTS external_bots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        skills TEXT,
        description TEXT,
        owner_email TEXT NOT NULL,
        api_key_hash TEXT NOT NULL,
        total_earned INTEGER DEFAULT 0,
        bounties_completed INTEGER DEFAULT 0,
        bounties_failed INTEGER DEFAULT 0,
        avg_quality_score REAL DEFAULT 0,
        status TEXT DEFAULT 'active',
        created_at INTEGER
      )
    `);

    // Add new columns (safe — ignore errors if columns already exist)
    const newCols = ['poster_email TEXT', 'stripe_session_id TEXT', 'stripe_payment_intent TEXT', 'revision_count INTEGER DEFAULT 0', 'revision_reason TEXT', 'tool_log TEXT'];
    for (const col of newCols) {
      this.db.db.run(`ALTER TABLE bounties ADD COLUMN ${col}`, (err) => {
        // Ignore "duplicate column" errors — column already exists
      });
    }

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

    if (!dupes.length) return 0;
    console.log(`\n🧹 Removing ${dupes.length} duplicate bounties...`);

    for (const dupe of dupes) {
      await this.db.query('DELETE FROM bounty_submissions WHERE bounty_id = ?', [dupe.id]);
      await this.db.query('DELETE FROM bounties WHERE id = ?', [dupe.id]);
      console.log(`   Removed dupe: "${dupe.title}" (${dupe.status})`);
    }
    return dupes.length;
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

  // Post a bounty that requires Stripe payment before activation
  async postPaidBounty({ title, description, requirements, budgetCents, category, postedBy, posterEmail }) {
    // Reject duplicate titles posted within the last hour
    const recent = await this.db.query(
      "SELECT id FROM bounties WHERE title = ? AND created_at > ?",
      [title, Date.now() - 3600000]
    );
    if (recent.length) {
      return { error: 'duplicate', message: `Bounty "${title}" was already posted recently` };
    }

    const id = 'bounty_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

    await this.db.query(`
      INSERT INTO bounties (id, title, description, requirements, budget_cents, category, status, posted_by, poster_email, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending_payment', ?, ?, ?)
    `, [id, title, description, requirements || '', budgetCents, category || 'general', postedBy || null, posterEmail || null, Date.now()]);

    console.log(`\n📋 Bounty created (pending payment): "${title}" — $${(budgetCents / 100).toFixed(2)}`);
    return { id, title, budgetCents, status: 'pending_payment' };
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
      console.error(err.stack);
      try {
        // Store error in tool_log for debugging via API
        await this.db.query(
          "UPDATE bounties SET status = 'open', claimed_by_bot = NULL, claimed_at = NULL, tool_log = ? WHERE id = ?",
          [JSON.stringify({ error: err.message, stack: err.stack }), bountyId]
        );
        console.log(`   🔄 Bounty "${bounty.title}" re-opened for retry`);
      } catch (e) {
        console.error('   Failed to re-open bounty:', e.message);
      }
    });

    return result;
  }

  // ============================================================================
  // API CALL HELPER: Rate limit retry
  // ============================================================================
  async _callWithRetry(params) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.client.messages.create(params);
      } catch (err) {
        if (err.status === 429 && attempt < 2) {
          console.log(`   ⏳ Rate limited, waiting 60s (attempt ${attempt + 1}/3)...`);
          await new Promise(r => setTimeout(r, 60000));
        } else {
          throw err;
        }
      }
    }
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

    console.log(`\n⚡ Bot "${bot.name}" working on: "${bounty.title}"${bounty.revision_count ? ' (REVISION #' + bounty.revision_count + ')' : ''}`);

    const revisionContext = bounty.revision_reason
      ? `\n\nIMPORTANT — REVISION REQUEST:\nThe client was not satisfied with the previous submission. Their feedback:\n"${bounty.revision_reason}"\nAddress this feedback directly in your revised work.\n`
      : '';

    // Flex word limit based on category/complexity
    const category = (bounty.category || '').toLowerCase();
    const complexCategories = ['research', 'analysis', 'technical', 'architecture', 'strategy', 'report'];
    const simpleCategories = ['social', 'email', 'copy', 'tagline', 'tweet'];
    let wordLimit;
    if (simpleCategories.some(c => category.includes(c))) {
      wordLimit = 800;
    } else if (complexCategories.some(c => category.includes(c))) {
      wordLimit = 3000;
    } else {
      wordLimit = 2000;
    }

    let deliverable;
    let stopReason;
    let toolLog = null;

    // ── AGENTIC TOOL-USE PATH ──
    if (process.env.ENABLE_AGENTIC_TOOLS === 'true') {
      // Budget-aware iteration limits: $5 = 5 iters, $10 = 8, $25 = 12, $50+ = 15
      const budgetDollars = bounty.budget_cents / 100;
      const maxIterations = budgetDollars >= 50 ? 15 : budgetDollars >= 25 ? 12 : budgetDollars >= 10 ? 8 : 5;

      console.log(`   🔧 Agentic mode: ${maxIterations} max iterations, all tools enabled`);

      const result = await runAgenticLoop({
        client: this.client,
        model: 'claude-sonnet-4-20250514',
        systemPrompt: `You are ${bot.name}, a professional freelancer on BotXchange. You have real tools available — use them to gather data, research, and produce high-quality work grounded in real information.

Completeness is your #1 priority — every response must have a clear ending and cover all requirements.

TOOL STRATEGY:
- Use web_search to find current, real-world data relevant to the task
- Use web_fetch to scrape specific pages for detailed information
- Use generate_file to create structured deliverables (reports, analyses, etc.)
- Use run_javascript for data processing and calculations
- Use store_artifact to save intermediate findings

After gathering data with tools, write your final deliverable as your last message. The final text you output (not tool calls) becomes the deliverable.`,
        userPrompt: `Complete this paid bounty.

TASK: ${bounty.title}
DETAILS: ${bounty.description}
REQUIREMENTS: ${bounty.requirements}${revisionContext}

RULES:
1. Use your tools to gather REAL data before writing. Search the web, fetch relevant pages.
2. Be as concise as possible while fully covering all requirements. Aim for under ${wordLimit} words.
3. You MUST complete every section — never cut off mid-sentence.
4. Cover ALL requirements mentioned above with concrete, specific details.
5. No preambles, no meta-commentary. Just deliver the work.
6. Current year is 2026.

Begin by researching, then produce the final deliverable.`,
        maxIterations,
        maxTokens: 8192,
        enabledTools: getToolsForBot('default')
      });

      deliverable = result.deliverable;
      toolLog = result.toolLog;
      stopReason = 'end_turn';

      console.log(`   🔧 Agentic loop: ${result.iterations} iterations, ${toolLog.length} tool calls`);

      // Save tool log
      if (toolLog.length > 0) {
        await this.db.query(
          "UPDATE bounties SET tool_log = ? WHERE id = ?",
          [JSON.stringify(toolLog), bountyId]
        );
      }
    } else {
      // ── LEGACY SINGLE-SHOT PATH ──
      let response = await this._callWithRetry({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8192,
        system: 'You are a professional freelancer. Completeness is your #1 priority — every response must have a clear ending and cover all requirements.',
        messages: [{
          role: 'user',
          content: `You are ${bot.name}. Complete this paid bounty.

TASK: ${bounty.title}
DETAILS: ${bounty.description}
REQUIREMENTS: ${bounty.requirements}${revisionContext}

RULES:
1. Be as concise as possible while fully covering all requirements. Aim for under ${wordLimit} words.
2. You MUST complete every section — never cut off mid-sentence.
3. Cover ALL requirements mentioned above with concrete, specific details.
4. No preambles, no meta-commentary. Just deliver the work.
5. Current year is 2026.

Begin:`
        }]
      });

      // If truncated (max_tokens), retry with a shorter prompt
      if (response.stop_reason === 'max_tokens') {
        console.log('   ⚠️ Output truncated, retrying with shorter prompt...');
        await new Promise(r => setTimeout(r, 5000));
        response = await this._callWithRetry({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 8192,
          system: 'Completeness is mandatory. Every response MUST have a conclusion.',
          messages: [{
            role: 'user',
            content: `Provide a COMPLETE response in under ${Math.round(wordLimit * 0.6)} words.

TASK: ${bounty.title}
REQUIREMENTS: ${bounty.requirements}

Cover all requirements with specific details. No preamble. Current year is 2026. Begin:`
          }]
        });
      }

      deliverable = response.content[0].text;
      stopReason = response.stop_reason;
    }

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

    // Check if this bounty has already failed 3+ times — auto-approve the best submission
    const allSubs = await this.db.query(
      "SELECT * FROM bounty_submissions WHERE bounty_id = ? ORDER BY quality_score DESC",
      [bountyId]
    );
    const rejectedCount = allSubs.filter(s => s.status === 'rejected').length;

    if (rejectedCount >= 3) {
      const bestSub = allSubs.reduce((best, s) => (s.quality_score || 0) > (best.quality_score || 0) ? s : best, submission);
      console.log(`   ⚡ Auto-approving after ${rejectedCount} rejections (best score: ${bestSub.quality_score || 'unscored'})`);

      await this.db.query(
        "UPDATE bounty_submissions SET status = 'approved', feedback = 'Auto-approved after multiple attempts' WHERE id = ?",
        [bestSub.id]
      );
      await this.db.query(
        "UPDATE bounties SET status = 'completed', deliverable = ?, quality_score = ?, completed_at = ? WHERE id = ?",
        [bestSub.content, bestSub.quality_score || 6, Date.now(), bountyId]
      );
      await this.processPayment(bountyId);
      return { score: bestSub.quality_score || 6, passes: true, feedback: 'Auto-approved after multiple attempts' };
    }

    const response = await this._callWithRetry({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `You are a quality reviewer for BotXchange bounty platform. Your job is to confirm work is GOOD ENOUGH to deliver, not to find flaws.

BOUNTY REQUIREMENTS:
Title: ${bounty.title}
Description: ${bounty.description}
Requirements: ${bounty.requirements}
Category: ${bounty.category || 'general'}
Budget: $${(bounty.budget_cents / 100).toFixed(2)}

SUBMISSION:
${submission.content}

Rate this submission on these dimensions (each 1-10):
1. COMPLETENESS: Does it address the key requirements?
2. SPECIFICITY: Does it give concrete, actionable details rather than vague platitudes?
3. QUALITY: Is it well-structured, readable, and professional?
${(bounty.category === 'marketing' || bounty.category === 'content' || bounty.category === 'seo') ? '4. SEO: Proper keywords, structure, meta descriptions?' : '(SEO dimension skipped — not relevant for this category)'}

Respond with ONLY a JSON object:
{
  "score": <1-10>,
  "passes": <true/false>,
  "feedback": "<brief feedback>"
}

Score 6+ passes. This is a $${(bounty.budget_cents / 100).toFixed(2)} bounty — judge accordingly. The question is: "Would a reasonable customer be satisfied with this for the price?" If the work covers the requirements and provides real value, it passes. Don't penalize for minor imperfections or stylistic preferences.`
      }]
    });

    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    let review;
    try {
      review = JSON.parse(jsonMatch[0]);
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

    // Credit the bot's earnings (internal or external)
    if (bounty.claimed_by_bot) {
      // Try internal bots first, then external
      const internal = await this.db.query('SELECT id FROM bots WHERE id = ?', [bounty.claimed_by_bot]);
      if (internal.length) {
        await this.db.query('UPDATE bots SET total_earned = COALESCE(total_earned, 0) + ? WHERE id = ?', [botPayout, bounty.claimed_by_bot]);
      } else {
        await this.db.query('UPDATE external_bots SET total_earned = COALESCE(total_earned, 0) + ?, bounties_completed = bounties_completed + 1 WHERE id = ?', [botPayout, bounty.claimed_by_bot]);
      }
    }

    await this.db.query(`
      UPDATE bounties SET status = 'paid', paid_at = ? WHERE id = ?
    `, [Date.now(), bountyId]);

    console.log(`   💰 Paid: Bot gets $${(botPayout / 100).toFixed(2)}, Platform fee $${(platformFee / 100).toFixed(2)}`);

    // Notify bounty poster
    await this.notifyPoster(bounty);

    return { botPayout, platformFee };
  }

  // ============================================================================
  // NOTIFICATIONS
  // ============================================================================
  async notifyPoster(bounty) {
    const email = bounty.poster_email;
    if (!email) return;

    // Get best submission for quality score
    const submissions = await this.db.query(
      'SELECT * FROM bounty_submissions WHERE bounty_id = ? ORDER BY quality_score DESC LIMIT 1',
      [bounty.id]
    );
    const bestSubmission = submissions[0];
    const qualityScore = bestSubmission?.quality_score || 'N/A';

    // Store notification in DB
    this.db.db.run(`CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bounty_id TEXT,
      email TEXT,
      type TEXT,
      subject TEXT,
      body TEXT,
      sent_at INTEGER,
      status TEXT DEFAULT 'logged'
    )`, () => {});

    const subject = `Your bounty is complete: "${bounty.title}"`;
    const body = [
      `Your bounty "${bounty.title}" has been completed!`,
      ``,
      `Quality Score: ${qualityScore}/10`,
      `Budget: $${(bounty.budget_cents / 100).toFixed(2)}`,
      `Completed by: ${bounty.claimed_by_bot}`,
      ``,
      `View your deliverable: https://botxchange.ai/bounties/${bounty.id}`,
      ``,
      `Not satisfied? You can request one free revision from the bounty detail page.`
    ].join('\n');

    this.db.db.run(
      'INSERT INTO notifications (bounty_id, email, type, subject, body, sent_at) VALUES (?, ?, ?, ?, ?, ?)',
      [bounty.id, email, 'bounty_completed', subject, body, Date.now()],
      () => {}
    );

    console.log(`   📧 Notification logged for ${email}: "${bounty.title}" (score: ${qualityScore}/10)`);
  }

  // ============================================================================
  // REVISION SYSTEM
  // ============================================================================
  async requestRevision(bountyId, reason) {
    const bounties = await this.db.query('SELECT * FROM bounties WHERE id = ?', [bountyId]);
    if (!bounties.length) throw new Error('Bounty not found');
    const bounty = bounties[0];

    // Only completed/paid bounties can be revised
    if (bounty.status !== 'completed' && bounty.status !== 'paid') {
      throw new Error(`Cannot request revision for bounty with status "${bounty.status}"`);
    }

    // Check revision count — max 1 free revision
    const revisionCount = bounty.revision_count || 0;
    if (revisionCount >= 1) {
      throw new Error('Maximum 1 free revision per bounty. Contact support for a refund.');
    }

    const originalBot = bounty.claimed_by_bot;

    // Re-open the bounty for the same bot to retry
    await this.db.query(`
      UPDATE bounties SET status = 'claimed', revision_count = ?, revision_reason = ?, completed_at = NULL, quality_score = NULL, paid_at = NULL WHERE id = ?
    `, [revisionCount + 1, reason, bountyId]);

    console.log(`🔄 Revision requested for "${bounty.title}" — bot ${originalBot} will redo the work`);
    console.log(`   Reason: ${reason}`);

    // Auto-fulfill the revision with the revision feedback
    setTimeout(async () => {
      try {
        await this.autoFulfill(bountyId);
      } catch (err) {
        console.error(`   Revision fulfillment error: ${err.message}`);
      }
    }, 5000);

    return { bountyId, revisionCount: revisionCount + 1, bot: originalBot };
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

  // ============================================================================
  // EXTERNAL BOT API
  // ============================================================================

  async registerBot({ name, skills, description, ownerEmail }) {
    const id = 'exbot_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
    const apiKey = 'exbot_' + crypto.randomBytes(24).toString('hex');
    const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

    await this.db.query(`
      INSERT INTO external_bots (id, name, skills, description, owner_email, api_key_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [id, name, skills || '', description || '', ownerEmail, apiKeyHash, Date.now()]);

    console.log(`\n🤖 External bot registered: "${name}" (${id})`);
    return { id, name, apiKey }; // Return raw API key only once
  }

  async authenticateBot(apiKey) {
    if (!apiKey || !apiKey.startsWith('exbot_')) return null;
    const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
    const bots = await this.db.query('SELECT * FROM external_bots WHERE api_key_hash = ? AND status = ?', [hash, 'active']);
    return bots[0] || null;
  }

  checkRateLimit(botId) {
    const now = Date.now();
    const limit = this._rateLimits[botId];
    if (!limit || now > limit.resetAt) {
      this._rateLimits[botId] = { count: 1, resetAt: now + 60000 };
      return true;
    }
    if (limit.count >= 10) return false;
    limit.count++;
    return true;
  }

  async claimBounty(botId, bountyId) {
    const bounties = await this.db.query('SELECT * FROM bounties WHERE id = ? AND status = ?', [bountyId, 'open']);
    if (!bounties.length) return { error: 'Bounty not available (not open or does not exist)' };

    // Prevent a bot from claiming its own posted bounty
    if (bounties[0].posted_by_bot && bounties[0].posted_by_bot === botId) {
      return { error: 'Cannot claim your own bounty' };
    }

    await this.db.query(
      "UPDATE bounties SET status = 'claimed', claimed_by_bot = ?, claimed_at = ? WHERE id = ? AND status = 'open'",
      [botId, Date.now(), bountyId]
    );

    // Verify the update worked (race condition protection)
    const updated = await this.db.query('SELECT * FROM bounties WHERE id = ? AND claimed_by_bot = ?', [bountyId, botId]);
    if (!updated.length) return { error: 'Bounty was claimed by another bot' };

    console.log(`   🤖 External bot ${botId} claimed bounty: "${bounties[0].title}"`);
    return { success: true, bounty: bounties[0] };
  }

  async submitWork(botId, bountyId, content) {
    const bounties = await this.db.query('SELECT * FROM bounties WHERE id = ? AND claimed_by_bot = ? AND status = ?', [bountyId, botId, 'claimed']);
    if (!bounties.length) return { error: 'Bounty not claimed by this bot or not in claimed state' };

    const submissionId = 'sub_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
    await this.db.query(
      'INSERT INTO bounty_submissions (id, bounty_id, bot_id, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [submissionId, bountyId, botId, content, 'pending', Date.now()]
    );

    console.log(`   ✅ External bot ${botId} submitted work for "${bounties[0].title}" (${content.length} chars)`);

    // Run quality check (same as internal bots)
    await this.qualityCheck(bountyId, submissionId);

    // Return result
    const submission = await this.db.query('SELECT * FROM bounty_submissions WHERE id = ?', [submissionId]);
    const bounty = await this.db.query('SELECT status, quality_score FROM bounties WHERE id = ?', [bountyId]);
    return {
      success: true,
      submissionId,
      status: submission[0]?.status,
      qualityScore: submission[0]?.quality_score,
      feedback: submission[0]?.feedback,
      bountyStatus: bounty[0]?.status
    };
  }

  async getExternalBotEarnings(botId) {
    const bots = await this.db.query('SELECT * FROM external_bots WHERE id = ?', [botId]);
    if (!bots.length) return null;
    const bot = bots[0];
    const completedBounties = await this.db.query(
      "SELECT id, title, budget_cents, quality_score, completed_at FROM bounties WHERE claimed_by_bot = ? AND status = 'paid'",
      [botId]
    );
    return {
      totalEarned: bot.total_earned,
      bountiesCompleted: bot.bounties_completed,
      bountiesFailed: bot.bounties_failed,
      avgQualityScore: bot.avg_quality_score,
      recentBounties: completedBounties.slice(0, 10)
    };
  }

  async getLeaderboard() {
    // Combine internal and external bots — include job data
    const internal = await this.db.query(
      "SELECT id, name, 'internal' as type, total_earned, skills, tools, personality FROM bots WHERE total_earned > 0 ORDER BY total_earned DESC"
    );
    const external = await this.db.query(
      "SELECT id, name, 'external' as type, total_earned, skills, bounties_completed, bounties_failed, avg_quality_score FROM external_bots WHERE total_earned > 0 ORDER BY total_earned DESC"
    );

    // Get combined bounty + job stats for internal bots
    const allBots = await Promise.all([
      ...internal.map(async (bot) => {
        // Bounty stats
        const bountyCompleted = await this.db.query("SELECT COUNT(*) as c FROM bounties WHERE claimed_by_bot = ? AND status = 'paid'", [bot.id]);
        const bountyAvg = await this.db.query("SELECT COALESCE(AVG(quality_score), 0) as avg FROM bounties WHERE claimed_by_bot = ? AND quality_score IS NOT NULL", [bot.id]);

        // Job stats — count jobs where this bot was a collaborator
        const jobCompleted = await this.db.query("SELECT COUNT(DISTINCT jc.job_id) as c FROM job_collaborators jc JOIN jobs j ON jc.job_id = j.id WHERE jc.bot_id = ? AND j.status = 'paid'", [bot.id]);
        const jobAvg = await this.db.query("SELECT COALESCE(AVG(j.quality_score), 0) as avg FROM job_collaborators jc JOIN jobs j ON jc.job_id = j.id WHERE jc.bot_id = ? AND j.quality_score IS NOT NULL", [bot.id]);
        const jobEarned = await this.db.query("SELECT COALESCE(SUM(jc.earnings_share * j.budget_cents * 0.85), 0) as total FROM job_collaborators jc JOIN jobs j ON jc.job_id = j.id WHERE jc.bot_id = ? AND j.status = 'paid'", [bot.id]);

        const totalCompleted = (bountyCompleted[0].c || 0) + (jobCompleted[0].c || 0);
        const combinedScores = [];
        if (bountyAvg[0].avg > 0) combinedScores.push(bountyAvg[0].avg);
        if (jobAvg[0].avg > 0) combinedScores.push(jobAvg[0].avg);
        const avgScore = combinedScores.length > 0
          ? combinedScores.reduce((a, b) => a + b, 0) / combinedScores.length
          : 0;

        return {
          id: bot.id, name: bot.name, type: 'internal', skills: bot.skills,
          tools: bot.tools, personality: bot.personality,
          totalEarned: bot.total_earned || 0,
          bountiesCompleted: totalCompleted,
          jobsCompleted: jobCompleted[0].c || 0,
          jobEarnings: jobEarned[0].total || 0,
          avgQualityScore: Math.round(avgScore * 10) / 10
        };
      }),
      ...external.map(bot => ({
        id: bot.id, name: bot.name, type: 'external', skills: bot.skills,
        totalEarned: bot.total_earned || 0,
        bountiesCompleted: bot.bounties_completed || 0,
        jobsCompleted: 0,
        avgQualityScore: bot.avg_quality_score || 0
      }))
    ]);

    return allBots.sort((a, b) => b.totalEarned - a.totalEarned);
  }
}

module.exports = BountyBoard;
