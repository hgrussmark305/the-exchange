// job-engine.js — Intelligent job marketplace engine for The Exchange
// Handles job posting, matching, multi-step collaboration, quality checks, and payment

const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');

class JobEngine {
  constructor(db, protocol, bountyBoard) {
    this.db = db;
    this.protocol = protocol;
    this.bountyBoard = bountyBoard; // for accessing internal/external bots
    this.stripeIntegration = null;
    this.client = new Anthropic();
  }

  setStripeIntegration(stripeIntegration) {
    this.stripeIntegration = stripeIntegration;
  }

  // ============================================================================
  // POST A JOB
  // ============================================================================
  async postJob({ title, description, requirements, budgetCents, category, postedByHuman, postedByBot, posterEmail }) {
    // Reject duplicate titles posted within the last hour
    const recent = await this.db.query(
      "SELECT id FROM jobs WHERE title = ? AND created_at > ?",
      [title, Date.now() - 3600000]
    );
    if (recent.length) {
      return { error: 'duplicate', message: `Job "${title}" was already posted recently` };
    }

    const id = 'job_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');

    await this.db.query(`
      INSERT INTO jobs (id, title, description, requirements, budget_cents, category, status, posted_by_human, posted_by_bot, poster_email, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)
    `, [id, title, description, requirements || '', budgetCents, category || 'general', postedByHuman || null, postedByBot || null, posterEmail || null, Date.now()]);

    console.log(`\n📋 Job posted: "${title}" — $${(budgetCents / 100).toFixed(2)}`);

    // Auto-trigger matching
    setTimeout(() => {
      this.analyzeAndMatch(id).catch(err => console.error('Auto-match error:', err.message));
    }, 5000);

    return { id, title, budgetCents, status: 'open' };
  }

  // Post a job with pending_payment status (for Stripe checkout flow)
  async postPaidJob({ title, description, requirements, budgetCents, category, posterEmail }) {
    const recent = await this.db.query(
      "SELECT id FROM jobs WHERE title = ? AND created_at > ?",
      [title, Date.now() - 3600000]
    );
    if (recent.length) {
      return { error: 'duplicate', message: `Job "${title}" was already posted recently` };
    }

    const id = 'job_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');

    await this.db.query(`
      INSERT INTO jobs (id, title, description, requirements, budget_cents, category, status, poster_email, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending_payment', ?, ?)
    `, [id, title, description, requirements || '', budgetCents, category || 'general', posterEmail || null, Date.now()]);

    console.log(`\n📋 Job created (pending payment): "${title}" — $${(budgetCents / 100).toFixed(2)}`);
    return { id, title, budgetCents, status: 'pending_payment' };
  }

  // Activate a job after payment succeeds
  async activateJob(jobId) {
    await this.db.query("UPDATE jobs SET status = 'open' WHERE id = ? AND status = 'pending_payment'", [jobId]);
    console.log(`   ✅ Job ${jobId} activated after payment`);
    // Trigger matching
    setTimeout(() => {
      this.analyzeAndMatch(jobId).catch(err => console.error('Post-payment match error:', err.message));
    }, 3000);
  }

  // ============================================================================
  // ANALYZE AND MATCH — Phase 3 core
  // ============================================================================
  async analyzeAndMatch(jobId) {
    const jobs = await this.db.query('SELECT * FROM jobs WHERE id = ?', [jobId]);
    if (!jobs.length || jobs[0].status !== 'open') return;
    const job = jobs[0];

    // Get all available bots (internal + external)
    const internalBots = await this.db.query("SELECT id, name, skills, personality as description, 'internal' as platform FROM bots WHERE status = 'active'");
    const externalBots = await this.db.query("SELECT id, name, skills, description, tools, model, platform FROM external_bots WHERE status = 'active'");
    const allBots = [...internalBots, ...externalBots];

    if (!allBots.length) {
      console.log('   No bots available for matching');
      return;
    }

    // Ask AI to create an execution plan
    const response = await this._callWithRetry({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `You are the job orchestrator for The Exchange, a marketplace where AI bots collaborate to fulfill work.

JOB:
Title: ${job.title}
Description: ${job.description}
Requirements: ${job.requirements}
Category: ${job.category}
Budget: $${(job.budget_cents / 100).toFixed(2)}

AVAILABLE BOTS:
${allBots.map(b => `- ${b.id} "${b.name}" (${b.platform || 'internal'}): Skills: ${b.skills || 'general'}, Tools: ${b.tools || 'standard'}, Model: ${b.model || 'claude'}`).join('\n')}

Analyze this job and respond with a JSON execution plan:
{
  "complexity": "simple" or "multi_step",
  "steps": [
    {
      "step_number": 1,
      "title": "Step title",
      "description": "What this step does",
      "required_skills": ["skill1"],
      "best_bot": "bot_id",
      "reason": "Why this bot"
    }
  ],
  "lead_bot": "bot_id",
  "earnings_split": {"bot_id_1": 0.85},
  "estimated_quality": "high" or "medium" or "low"
}

For SIMPLE jobs ($5-15, single skill needed): assign one bot, one step.
For COMPLEX jobs ($15+, multiple skills): break into 2-4 steps with different bots.
Always prefer bots with relevant skills and higher quality scores.
Respond with ONLY the JSON object.`
      }]
    });

    const text = response.content[0].text;
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      // Fallback: assign to first bot with one step
      return this._simpleFallbackMatch(job, allBots[0]);
    }

    let plan;
    try {
      plan = JSON.parse(match[0]);
    } catch (e) {
      return this._simpleFallbackMatch(job, allBots[0]);
    }

    // Save the collaboration plan
    await this.db.query(
      "UPDATE jobs SET collaboration_plan = ?, lead_bot = ?, status = 'claimed', claimed_at = ? WHERE id = ?",
      [JSON.stringify(plan), plan.lead_bot, Date.now(), jobId]
    );

    // Create job steps
    for (const step of plan.steps || []) {
      const stepId = 'step_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
      await this.db.query(`
        INSERT INTO job_steps (id, job_id, step_number, title, description, assigned_bot, required_skills, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `, [stepId, jobId, step.step_number, step.title, step.description || '', step.best_bot, JSON.stringify(step.required_skills || []), Date.now()]);
    }

    // Create job collaborators with earnings split
    for (const [botId, share] of Object.entries(plan.earnings_split || {})) {
      const collabId = 'collab_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
      const role = botId === plan.lead_bot ? 'lead' : 'contributor';
      await this.db.query(`
        INSERT INTO job_collaborators (id, job_id, bot_id, role, earnings_share, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?)
      `, [collabId, jobId, botId, role, share, Date.now()]);
    }

    console.log(`   🤖 Job matched: lead=${plan.lead_bot}, ${(plan.steps || []).length} steps, complexity=${plan.complexity}`);

    // Execute the pipeline
    this.executeJobPipeline(jobId).catch(async (err) => {
      console.error(`   ❌ Pipeline failed: ${err.message}`);
      await this.db.query("UPDATE jobs SET status = 'open', lead_bot = NULL, claimed_at = NULL WHERE id = ?", [jobId]);
    });

    return plan;
  }

  async _simpleFallbackMatch(job, bot) {
    const stepId = 'step_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
    await this.db.query(
      "UPDATE jobs SET lead_bot = ?, status = 'claimed', claimed_at = ? WHERE id = ?",
      [bot.id, Date.now(), job.id]
    );
    await this.db.query(`
      INSERT INTO job_steps (id, job_id, step_number, title, description, assigned_bot, status, created_at)
      VALUES (?, ?, 1, 'Complete task', ?, ?, 'pending', ?)
    `, [stepId, job.id, job.description, bot.id, Date.now()]);

    const collabId = 'collab_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
    await this.db.query(`
      INSERT INTO job_collaborators (id, job_id, bot_id, role, earnings_share, status, created_at)
      VALUES (?, ?, ?, 'lead', 1.0, 'active', ?)
    `, [collabId, job.id, bot.id, Date.now()]);

    console.log(`   🤖 Fallback match: ${bot.name} assigned to "${job.title}"`);

    this.executeJobPipeline(job.id).catch(async (err) => {
      console.error(`   ❌ Pipeline failed: ${err.message}`);
      await this.db.query("UPDATE jobs SET status = 'open', lead_bot = NULL, claimed_at = NULL WHERE id = ?", [job.id]);
    });
  }

  // ============================================================================
  // EXECUTE JOB PIPELINE — Multi-step collaborative execution
  // ============================================================================
  async executeJobPipeline(jobId) {
    const jobs = await this.db.query('SELECT * FROM jobs WHERE id = ?', [jobId]);
    if (!jobs.length) return;
    const job = jobs[0];

    await this.db.query("UPDATE jobs SET status = 'in_progress' WHERE id = ?", [jobId]);

    const steps = await this.db.query('SELECT * FROM job_steps WHERE job_id = ? ORDER BY step_number', [jobId]);

    let lastOutput = '';
    for (const step of steps) {
      console.log(`   📝 Step ${step.step_number}: "${step.title}" → bot ${step.assigned_bot}`);

      await this.db.query("UPDATE job_steps SET status = 'in_progress' WHERE id = ?", [step.id]);

      // Get bot info
      let bot = (await this.db.query('SELECT * FROM bots WHERE id = ?', [step.assigned_bot]))[0];
      if (!bot) {
        bot = (await this.db.query('SELECT * FROM external_bots WHERE id = ?', [step.assigned_bot]))[0];
      }
      const botName = bot?.name || 'AI Bot';

      // Build context from previous steps
      const previousSteps = steps.filter(s => s.step_number < step.step_number && s.output);
      const contextBlock = previousSteps.length ? `\nPREVIOUS WORK:\n${previousSteps.map(s => `--- Step ${s.step_number}: ${s.title} ---\n${s.output}`).join('\n\n')}` : '';

      const revisionContext = job.revision_count > 0 ? `\n\nREVISION REQUEST: This is revision #${job.revision_count}. Focus on improving quality.` : '';

      const response = await this._callWithRetry({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8192,
        system: `You are ${botName}, a professional working on The Exchange platform. Completeness is your #1 priority — every response must have a clear ending. Be concise but thorough.`,
        messages: [{
          role: 'user',
          content: `Complete this step for a paid job.

JOB: ${job.title}
FULL DESCRIPTION: ${job.description}
REQUIREMENTS: ${job.requirements}

YOUR STEP: ${step.title}
STEP DETAILS: ${step.description}${contextBlock}${revisionContext}

RULES:
1. Keep output under 1500 words. Be direct and concise.
2. You MUST complete every section — never cut off mid-sentence.
3. No preambles or meta-commentary. Just deliver the work.
4. If this is a multi-step job, produce output the next step can build on.
5. Current year is 2026.

Begin:`
        }]
      });

      const output = response.content[0].text;
      lastOutput = output;

      await this.db.query(
        "UPDATE job_steps SET output = ?, status = 'completed', completed_at = ? WHERE id = ?",
        [output, Date.now(), step.id]
      );

      console.log(`   ✅ Step ${step.step_number} complete (${output.length} chars)`);

      // Brief pause between steps
      if (step.step_number < steps.length) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    // Final deliverable is the last step's output (or combined if multi-step)
    let deliverable;
    if (steps.length > 1) {
      const completedSteps = await this.db.query('SELECT * FROM job_steps WHERE job_id = ? ORDER BY step_number', [jobId]);
      deliverable = completedSteps.map(s => `## ${s.title}\n\n${s.output}`).join('\n\n---\n\n');
    } else {
      deliverable = lastOutput;
    }

    await this.db.query(
      "UPDATE jobs SET deliverable = ?, status = 'review' WHERE id = ?",
      [deliverable, jobId]
    );

    // Run quality check
    await new Promise(r => setTimeout(r, 5000));
    await this.qualityCheck(jobId);
  }

  // ============================================================================
  // QUALITY CHECK
  // ============================================================================
  async qualityCheck(jobId) {
    const jobs = await this.db.query('SELECT * FROM jobs WHERE id = ?', [jobId]);
    if (!jobs.length) return;
    const job = jobs[0];

    const response = await this._callWithRetry({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `You are a quality assurance reviewer for The Exchange job platform.

JOB REQUIREMENTS:
Title: ${job.title}
Description: ${job.description}
Requirements: ${job.requirements}
Budget: $${(job.budget_cents / 100).toFixed(2)}

DELIVERABLE:
${(job.deliverable || '').substring(0, 4000)}

Rate this submission. Respond with ONLY a JSON object:
{
  "score": <1-10>,
  "passes": <true/false>,
  "feedback": "<brief feedback>"
}

Score 6+ passes. Be fair and practical — judge on completeness, relevance to requirements, and professionalism. Minor imperfections are acceptable for the budget level.`
      }]
    });

    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    let review;
    try {
      review = JSON.parse(jsonMatch[0]);
    } catch (e) {
      review = { score: 7, passes: true, feedback: 'Auto-approved' };
    }

    await this.db.query(
      "UPDATE jobs SET quality_score = ?, quality_feedback = ? WHERE id = ?",
      [review.score, review.feedback, jobId]
    );

    if (review.passes) {
      await this.db.query(
        "UPDATE jobs SET status = 'completed', completed_at = ? WHERE id = ?",
        [Date.now(), jobId]
      );
      console.log(`   ✅ Job APPROVED (${review.score}/10): ${review.feedback}`);
      await this.processPayment(jobId);
    } else {
      const revisionCount = job.revision_count || 0;
      if (revisionCount < (job.max_revisions || 3)) {
        console.log(`   ❌ Job REJECTED (${review.score}/10): ${review.feedback} — retrying (attempt ${revisionCount + 1}/${job.max_revisions || 3})`);
        await this.db.query(
          "UPDATE jobs SET status = 'open', lead_bot = NULL, claimed_at = NULL, revision_count = ? WHERE id = ?",
          [revisionCount + 1, jobId]
        );
      } else {
        // Auto-refund after max retries if Stripe payment exists
        if (job.stripe_payment_intent && this.stripeIntegration) {
          console.log(`   💸 Auto-refunding after ${revisionCount + 1} failed attempts`);
          try {
            await this.stripeIntegration.handleJobRefund(jobId);
          } catch (refundErr) {
            console.error(`   Refund error: ${refundErr.message}`);
            // Mark as failed even if refund fails
            await this.db.query(
              "UPDATE jobs SET status = 'failed' WHERE id = ?",
              [jobId]
            );
          }
        } else {
          // No Stripe payment (free/authenticated job) — just mark failed
          console.log(`   ❌ Job failed after ${revisionCount + 1} attempts`);
          await this.db.query(
            "UPDATE jobs SET status = 'failed' WHERE id = ?",
            [jobId]
          );
        }
      }
    }

    return review;
  }

  // ============================================================================
  // PAYMENT DISTRIBUTION
  // ============================================================================
  async processPayment(jobId) {
    const jobs = await this.db.query('SELECT * FROM jobs WHERE id = ?', [jobId]);
    if (!jobs.length) return;
    const job = jobs[0];

    const platformFee = Math.round(job.budget_cents * 0.15);
    const botPool = job.budget_cents - platformFee;

    // Get collaborators and their earnings split
    const collabs = await this.db.query('SELECT * FROM job_collaborators WHERE job_id = ?', [jobId]);

    for (const collab of collabs) {
      const payout = Math.round(botPool * (collab.earnings_share || 1.0));

      // Credit internal or external bot
      const internal = await this.db.query('SELECT id FROM bots WHERE id = ?', [collab.bot_id]);
      if (internal.length) {
        await this.db.query('UPDATE bots SET total_earned = COALESCE(total_earned, 0) + ? WHERE id = ?', [payout, collab.bot_id]);
      } else {
        await this.db.query('UPDATE external_bots SET total_earned = COALESCE(total_earned, 0) + ?, bounties_completed = bounties_completed + 1 WHERE id = ?', [payout, collab.bot_id]);
      }

      console.log(`   💰 Bot ${collab.bot_id}: $${(payout / 100).toFixed(2)} (${Math.round((collab.earnings_share || 1) * 100)}%)`);
    }

    await this.db.query("UPDATE jobs SET status = 'paid', paid_at = ? WHERE id = ?", [Date.now(), jobId]);
    console.log(`   💰 Job paid: $${(botPool / 100).toFixed(2)} to bots, $${(platformFee / 100).toFixed(2)} platform fee`);

    // Update bot quality scores
    for (const collab of collabs) {
      const completedJobs = await this.db.query(
        "SELECT j.quality_score FROM jobs j JOIN job_collaborators jc ON j.id = jc.job_id WHERE jc.bot_id = ? AND j.quality_score IS NOT NULL",
        [collab.bot_id]
      );
      if (completedJobs.length) {
        const avgScore = completedJobs.reduce((s, j) => s + j.quality_score, 0) / completedJobs.length;
        await this.db.query('UPDATE external_bots SET avg_quality_score = ? WHERE id = ?', [Math.round(avgScore * 10) / 10, collab.bot_id]);
      }
    }
  }

  // ============================================================================
  // GETTERS
  // ============================================================================
  async getJob(jobId) {
    const jobs = await this.db.query('SELECT * FROM jobs WHERE id = ?', [jobId]);
    return jobs[0] || null;
  }

  async getJobs(status = null) {
    if (status) {
      return this.db.query("SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC", [status]);
    }
    return this.db.query("SELECT * FROM jobs WHERE status != 'pending_payment' ORDER BY created_at DESC");
  }

  async getJobSteps(jobId) {
    return this.db.query('SELECT * FROM job_steps WHERE job_id = ? ORDER BY step_number', [jobId]);
  }

  async getJobCollaborators(jobId) {
    return this.db.query(`
      SELECT jc.*,
        COALESCE(b.name, eb.name) as bot_name,
        COALESCE(b.skills, eb.skills) as bot_skills,
        COALESCE('internal', eb.platform) as bot_platform
      FROM job_collaborators jc
      LEFT JOIN bots b ON jc.bot_id = b.id
      LEFT JOIN external_bots eb ON jc.bot_id = eb.id
      WHERE jc.job_id = ?
      ORDER BY jc.earnings_share DESC
    `, [jobId]);
  }

  async getStats() {
    const [total] = await this.db.query('SELECT COUNT(*) as count FROM jobs');
    const [open] = await this.db.query("SELECT COUNT(*) as count FROM jobs WHERE status = 'open'");
    const [inProgress] = await this.db.query("SELECT COUNT(*) as count FROM jobs WHERE status IN ('claimed', 'in_progress', 'review')");
    const [completed] = await this.db.query("SELECT COUNT(*) as count FROM jobs WHERE status IN ('completed', 'paid')");
    const [totalPaid] = await this.db.query("SELECT COALESCE(SUM(budget_cents), 0) as total FROM jobs WHERE status = 'paid'");
    const [avgScore] = await this.db.query("SELECT COALESCE(AVG(quality_score), 0) as avg FROM jobs WHERE quality_score IS NOT NULL");

    return {
      totalJobs: total.count,
      openJobs: open.count,
      inProgressJobs: inProgress.count,
      completedJobs: completed.count,
      totalPaidCents: totalPaid.total,
      averageQualityScore: Math.round(avgScore.avg * 10) / 10
    };
  }

  // ============================================================================
  // REVISION
  // ============================================================================
  async requestRevision(jobId, reason) {
    const jobs = await this.db.query('SELECT * FROM jobs WHERE id = ?', [jobId]);
    if (!jobs.length) throw new Error('Job not found');
    const job = jobs[0];

    if (job.status !== 'completed' && job.status !== 'paid') {
      throw new Error(`Cannot request revision for job with status "${job.status}"`);
    }
    if ((job.revision_count || 0) >= (job.max_revisions || 1)) {
      throw new Error('Maximum revisions reached');
    }

    await this.db.query(`
      UPDATE jobs SET status = 'open', revision_count = revision_count + 1, lead_bot = NULL, claimed_at = NULL,
        completed_at = NULL, quality_score = NULL, quality_feedback = NULL, paid_at = NULL WHERE id = ?
    `, [jobId]);

    // Clear old steps
    await this.db.query("DELETE FROM job_steps WHERE job_id = ?", [jobId]);
    await this.db.query("DELETE FROM job_collaborators WHERE job_id = ?", [jobId]);

    console.log(`🔄 Revision requested for job "${job.title}"`);

    // Re-trigger matching
    setTimeout(() => {
      this.analyzeAndMatch(jobId).catch(err => console.error('Revision match error:', err.message));
    }, 5000);

    return { jobId, revisionCount: (job.revision_count || 0) + 1 };
  }

  // ============================================================================
  // HELPERS
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
}

module.exports = JobEngine;
