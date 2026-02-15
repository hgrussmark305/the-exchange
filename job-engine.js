// job-engine.js — Intelligent job marketplace engine for The Exchange
// Handles job posting, matching, multi-step collaboration, quality checks, and payment

const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');
const { JobOrchestrator } = require('./bots');

class JobEngine {
  constructor(db, protocol, bountyBoard) {
    this.db = db;
    this.protocol = protocol;
    this.bountyBoard = bountyBoard; // for accessing internal/external bots
    this.stripeIntegration = null;
    this.client = new Anthropic();
    this.orchestrator = new JobOrchestrator(this.client);
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
  // ANALYZE AND MATCH — Phase 3 core (uses tool-integrated bots via JobOrchestrator)
  // ============================================================================
  async analyzeAndMatch(jobId) {
    const jobs = await this.db.query('SELECT * FROM jobs WHERE id = ?', [jobId]);
    if (!jobs.length || jobs[0].status !== 'open') return;
    const job = jobs[0];

    // Use the JobOrchestrator to create a smart execution plan
    let plan;
    try {
      plan = await this.orchestrator.analyzeAndPlan(job);
    } catch (err) {
      console.error(`   Orchestrator plan failed: ${err.message}`);
      // Fallback: simple writer-bot plan
      plan = {
        complexity: 'simple',
        steps: [{ step_number: 1, bot: 'writer-bot', method: 'writeContent', description: 'Complete the task', earnings_share: 1.0 }],
        lead_bot: 'writer-bot',
        estimated_quality: 'medium'
      };
    }

    // Save the collaboration plan
    await this.db.query(
      "UPDATE jobs SET collaboration_plan = ?, lead_bot = ?, status = 'claimed', claimed_at = ? WHERE id = ?",
      [JSON.stringify(plan), plan.lead_bot, Date.now(), jobId]
    );

    // Create job steps from orchestrator plan
    for (const step of plan.steps || []) {
      const stepId = 'step_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
      await this.db.query(`
        INSERT INTO job_steps (id, job_id, step_number, title, description, assigned_bot, required_skills, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `, [stepId, jobId, step.step_number, step.description || step.bot, step.description || '', step.bot, '[]', Date.now()]);
    }

    // Create job collaborators with earnings split
    const botShares = {};
    for (const step of plan.steps || []) {
      botShares[step.bot] = (botShares[step.bot] || 0) + (step.earnings_share || 0);
    }
    for (const [botId, share] of Object.entries(botShares)) {
      const collabId = 'collab_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
      const role = botId === plan.lead_bot ? 'lead' : 'contributor';
      await this.db.query(`
        INSERT INTO job_collaborators (id, job_id, bot_id, role, earnings_share, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?)
      `, [collabId, jobId, botId, role, share, Date.now()]);
    }

    console.log(`   Bot pipeline: ${(plan.steps || []).map(s => s.bot).join(' -> ')} -> QualityBot`);

    // Execute the pipeline using real bot tools
    this.executeJobPipeline(jobId, plan).catch(async (err) => {
      console.error(`   Pipeline failed: ${err.message}`);
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

    this.executeJobPipeline(job.id, null).catch(async (err) => {
      console.error(`   Pipeline failed: ${err.message}`);
      await this.db.query("UPDATE jobs SET status = 'open', lead_bot = NULL, claimed_at = NULL WHERE id = ?", [job.id]);
    });
  }

  // ============================================================================
  // EXECUTE JOB PIPELINE — Uses real tool-integrated bots via JobOrchestrator
  // ============================================================================
  async executeJobPipeline(jobId, plan) {
    const jobs = await this.db.query('SELECT * FROM jobs WHERE id = ?', [jobId]);
    if (!jobs.length) return;
    const job = jobs[0];

    await this.db.query("UPDATE jobs SET status = 'in_progress' WHERE id = ?", [jobId]);

    // If we have a plan from the orchestrator, use the real bot pipeline
    if (plan && plan.steps) {
      console.log(`   Executing ${plan.steps.length}-step bot pipeline...`);

      const dbSteps = await this.db.query('SELECT * FROM job_steps WHERE job_id = ? ORDER BY step_number', [jobId]);

      // Execute via orchestrator (real bots with tools)
      const result = await this.orchestrator.executeJob(job, plan);

      // Update DB steps with outputs (original plan steps)
      for (let i = 0; i < result.steps.length && i < dbSteps.length; i++) {
        const output = typeof result.steps[i].output === 'string'
          ? result.steps[i].output
          : JSON.stringify(result.steps[i].output);
        await this.db.query(
          "UPDATE job_steps SET output = ?, status = 'completed', completed_at = ? WHERE id = ?",
          [output, Date.now(), dbSteps[i].id]
        );
        console.log(`   Step ${i + 1} (${result.steps[i].bot}): ${output.length} chars`);
      }

      // Insert extra steps (peer review, revisions) that weren't in the original plan
      for (let i = dbSteps.length; i < result.steps.length; i++) {
        const extra = result.steps[i];
        const output = typeof extra.output === 'string' ? extra.output : JSON.stringify(extra.output);
        const stepId = 'step_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
        const stepTitle = extra.method === 'revision_after_peer_review' ? 'Peer Review Revision'
          : extra.method === 'revision_after_quality_review' ? 'Quality Improvement Revision'
          : 'Additional Step';
        await this.db.query(
          "INSERT INTO job_steps (id, job_id, step_number, title, description, assigned_bot, status, output, completed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)",
          [stepId, jobId, i + 1, stepTitle, extra.method || '', extra.bot, output, Date.now(), Date.now()]
        );
        console.log(`   Extra step ${i + 1} (${extra.bot} — ${stepTitle}): ${output.length} chars`);
      }

      // Build final deliverable
      let deliverable;
      if (typeof result.deliverable === 'string') {
        deliverable = result.deliverable;
      } else {
        deliverable = JSON.stringify(result.deliverable, null, 2);
      }

      // For multi-step, combine all step outputs
      if (result.steps.length > 1) {
        const reloadedSteps = await this.db.query('SELECT * FROM job_steps WHERE job_id = ? ORDER BY step_number', [jobId]);
        deliverable = reloadedSteps
          .filter(s => s.output)
          .map(s => `## ${s.title}\n\n${s.output}`)
          .join('\n\n---\n\n');
      }

      await this.db.query(
        "UPDATE jobs SET deliverable = ?, status = 'review' WHERE id = ?",
        [deliverable, jobId]
      );

      // Use orchestrator's quality result directly (may include revision improvements)
      const review = result.quality;
      const hadRevisions = result.steps.some(s => s.method && s.method.includes('revision'));
      await this.db.query(
        "UPDATE jobs SET quality_score = ?, quality_feedback = ? WHERE id = ?",
        [review.overall, review.feedback, jobId]
      );

      // Accept if passes quality check, OR if score >= 5 after revision (content has value)
      const accepted = review.passes || (hadRevisions && review.overall >= 5);
      if (accepted) {
        await this.db.query(
          "UPDATE jobs SET status = 'completed', completed_at = ? WHERE id = ?",
          [Date.now(), jobId]
        );
        console.log(`   APPROVED (${review.overall}/10${hadRevisions ? ', after revision' : ''}): ${review.feedback}`);
        if (review.scores) {
          console.log(`   Scores: completeness=${review.scores.completeness} accuracy=${review.scores.accuracy} quality=${review.scores.quality} seo=${review.scores.seo} value=${review.scores.value}`);
        }
        await this.processPayment(jobId);
      } else {
        await this._handleRejection(job, review);
      }
      return;
    }

    // Fallback: legacy generic prompt execution for external bot claims
    const steps = await this.db.query('SELECT * FROM job_steps WHERE job_id = ? ORDER BY step_number', [jobId]);
    let lastOutput = '';
    for (const step of steps) {
      await this.db.query("UPDATE job_steps SET status = 'in_progress' WHERE id = ?", [step.id]);

      const response = await this._callWithRetry({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8192,
        system: 'You are a professional working on The Exchange platform. Completeness is your #1 priority. Provide concrete, specific details — not vague generalities.',
        messages: [{ role: 'user', content: `Complete this step for a paid job.\n\nJOB: ${job.title}\nDESCRIPTION: ${job.description}\nREQUIREMENTS: ${job.requirements}\n\nSTEP: ${step.title}\nDETAILS: ${step.description}\n\nBe concise but thorough. Cover all requirements with specific details. Complete every section.\n\nBegin:` }]
      });

      lastOutput = response.content[0].text;
      await this.db.query("UPDATE job_steps SET output = ?, status = 'completed', completed_at = ? WHERE id = ?", [lastOutput, Date.now(), step.id]);
      if (step.step_number < steps.length) await new Promise(r => setTimeout(r, 3000));
    }

    const deliverable = steps.length > 1
      ? (await this.db.query('SELECT * FROM job_steps WHERE job_id = ? ORDER BY step_number', [jobId])).map(s => `## ${s.title}\n\n${s.output}`).join('\n\n---\n\n')
      : lastOutput;

    await this.db.query("UPDATE jobs SET deliverable = ?, status = 'review' WHERE id = ?", [deliverable, jobId]);
    await new Promise(r => setTimeout(r, 5000));
    await this.qualityCheck(jobId);
  }

  async _handleRejection(job, review) {
    const revisionCount = job.revision_count || 0;
    if (revisionCount < (job.max_revisions || 3)) {
      console.log(`   REJECTED (${review.overall}/10): ${review.feedback} — retrying (attempt ${revisionCount + 1}/${job.max_revisions || 3})`);
      await this.db.query(
        "UPDATE jobs SET status = 'open', lead_bot = NULL, claimed_at = NULL, revision_count = ? WHERE id = ?",
        [revisionCount + 1, job.id]
      );
    } else {
      if (job.stripe_payment_intent && this.stripeIntegration) {
        console.log(`   Auto-refunding after ${revisionCount + 1} failed attempts`);
        try {
          await this.stripeIntegration.handleJobRefund(job.id);
        } catch (refundErr) {
          console.error(`   Refund error: ${refundErr.message}`);
          await this.db.query("UPDATE jobs SET status = 'failed' WHERE id = ?", [job.id]);
        }
      } else {
        console.log(`   Job failed after ${revisionCount + 1} attempts`);
        await this.db.query("UPDATE jobs SET status = 'failed' WHERE id = ?", [job.id]);
      }
    }
  }

  // ============================================================================
  // QUALITY CHECK — 5-dimension scoring via QualityBot
  // ============================================================================
  async qualityCheck(jobId) {
    const jobs = await this.db.query('SELECT * FROM jobs WHERE id = ?', [jobId]);
    if (!jobs.length) return;
    const job = jobs[0];

    // Use QualityBot for 5-dimension scoring
    const qualityResult = await this.orchestrator.quality.reviewDeliverable(job, job.deliverable || '', null);

    const jsonMatch = qualityResult.match(/\{[\s\S]*\}/);
    let review;
    try {
      review = JSON.parse(jsonMatch[0]);
    } catch (e) {
      review = { overall: 7, passes: true, feedback: 'Auto-approved', scores: {} };
    }

    const score = review.overall || review.score || 7;
    await this.db.query(
      "UPDATE jobs SET quality_score = ?, quality_feedback = ? WHERE id = ?",
      [score, review.feedback, jobId]
    );

    if (review.passes) {
      await this.db.query(
        "UPDATE jobs SET status = 'completed', completed_at = ? WHERE id = ?",
        [Date.now(), jobId]
      );
      console.log(`   APPROVED (${score}/10): ${review.feedback}`);
      if (review.scores) {
        console.log(`   Scores: completeness=${review.scores.completeness} accuracy=${review.scores.accuracy} quality=${review.scores.quality} seo=${review.scores.seo} value=${review.scores.value}`);
      }
      await this.processPayment(jobId);
    } else {
      await this._handleRejection(job, review);
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
