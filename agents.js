// agents.js — BotXchange Execution Agent Team
// 5 fixed agents per venture: Research, Messaging, Quality, Outreach, Ops

const Anthropic = require('@anthropic-ai/sdk');
const { v4: uuidv4 } = require('uuid');

class BaseAgent {
  constructor(db, venture, role, model = 'claude-haiku-4-5-20251001') {
    this.db = db;
    this.venture = venture;
    this.role = role;
    this.model = model;
    this.client = new Anthropic();
  }

  async executeTask(task) {
    const now = Date.now();
    // 1. Update task status to in_progress
    await this.db.run(
      "UPDATE execution_tasks SET status = 'in_progress', started_at = ? WHERE id = ?",
      [now, task.id]
    );

    // 2. Update agent status
    await this.db.run(
      "UPDATE execution_agents SET status = 'working', current_task = ? WHERE id = ?",
      [task.title, task.agent_id]
    );

    try {
      // 3. Load relevant memory
      const memory = await this.loadMemory(['vision', 'execution']);

      // 4. Execute specific task logic (subclass overrides this)
      const result = await this.execute(task, memory);

      // 5. Validate proof-of-work
      if (!result.intent || !result.artifact) {
        throw new Error('Proof-of-work incomplete: intent and artifact required');
      }

      // 6. Estimate cost (rough: ~$0.001 per 1k input tokens for Haiku)
      const costCents = this.model.includes('sonnet') ? 3 : 1;

      // 7. Deduct credits
      await this.deductCredits(costCents, task.id);

      // 8. Determine status based on approval requirements
      const newStatus = task.requires_approval ? 'review' : 'executed';

      // 9. Update task with proof-of-work
      await this.db.run(
        `UPDATE execution_tasks SET status = ?, intent = ?, artifact = ?, receipt = ?, cost_cents = ?, completed_at = ? WHERE id = ?`,
        [newStatus, result.intent, result.artifact, result.receipt || 'internal', costCents, now, task.id]
      );

      // 10. Update agent stats
      await this.db.run(
        `UPDATE execution_agents SET status = 'idle', current_task = NULL, actions_completed = actions_completed + 1, spend_cents = spend_cents + ? WHERE id = ?`,
        [costCents, task.agent_id]
      );

      // 11. Log activity
      await this.logActivity(
        task.task_type,
        result.message || `${this.role} completed: ${task.title}`,
        { task_id: task.id, cost_cents: costCents }
      );

      return result;
    } catch (error) {
      // On failure, reset agent status
      await this.db.run(
        "UPDATE execution_agents SET status = 'idle', current_task = NULL WHERE id = ?",
        [task.agent_id]
      );
      await this.db.run(
        "UPDATE execution_tasks SET status = 'failed' WHERE id = ?",
        [task.id]
      );
      throw error;
    }
  }

  // Subclasses override this
  async execute(task, memory) {
    throw new Error('execute() must be implemented by subclass');
  }

  async callLLM(systemPrompt, userPrompt, maxTokens = 2048) {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });
    return response.content[0].text;
  }

  async loadMemory(layers) {
    const placeholders = layers.map(() => '?').join(',');
    const rows = await this.db.query(
      `SELECT layer, key, value FROM venture_memory WHERE venture_id = ? AND layer IN (${placeholders})`,
      [this.venture.id, ...layers]
    );
    if (!rows.length) return '';
    return rows.map(r => `[${r.layer}/${r.key}]: ${r.value}`).join('\n');
  }

  async logActivity(eventType, message, details = {}) {
    await this.db.run(
      `INSERT INTO activity_log (id, venture_id, agent_id, event_type, message, details, task_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidv4(), this.venture.id,
        details.agent_id || null, eventType, message,
        JSON.stringify(details), details.task_id || null, Date.now()
      ]
    );
  }

  async deductCredits(costCents, taskId) {
    const founders = await this.db.query(
      'SELECT id, credit_balance_cents FROM founders WHERE id = ?',
      [this.venture.founder_id]
    );
    if (!founders.length) return;
    const founder = founders[0];
    const newBalance = founder.credit_balance_cents - costCents;

    await this.db.run(
      'UPDATE founders SET credit_balance_cents = ? WHERE id = ?',
      [Math.max(0, newBalance), founder.id]
    );

    await this.db.run(
      `INSERT INTO credit_transactions (id, founder_id, amount_cents, balance_after_cents, description, transaction_type, task_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'api_cost', ?, ?)`,
      [uuidv4(), founder.id, -costCents, Math.max(0, newBalance),
       `API cost: ${this.role} agent`, taskId, Date.now()]
    );

    // If balance hits zero, pause venture
    if (newBalance <= 0) {
      await this.db.run(
        "UPDATE founder_ventures SET kill_switch_active = 1 WHERE id = ?",
        [this.venture.id]
      );
      await this.logActivity('credit_depleted', 'Credits depleted — all activity paused. Add credits to resume.', {});
    }
  }

  async checkKillSwitch() {
    const rows = await this.db.query(
      'SELECT kill_switch_active FROM founder_ventures WHERE id = ?',
      [this.venture.id]
    );
    return rows.length > 0 && rows[0].kill_switch_active === 1;
  }
}

class ResearchAgent extends BaseAgent {
  constructor(db, venture) {
    super(db, venture, 'research', 'claude-haiku-4-5-20251001');
  }

  async execute(task, memory) {
    const founderRows = await this.db.query(
      'SELECT icp, offer, business_description FROM founders WHERE id = ?',
      [this.venture.founder_id]
    );
    const founder = founderRows[0] || {};
    let icp;
    try { icp = JSON.parse(founder.icp || '{}'); } catch { icp = {}; }

    // Get existing prospects to avoid duplicates
    const existing = await this.db.query(
      'SELECT email, company FROM prospects WHERE venture_id = ?',
      [this.venture.id]
    );
    const existingCompanies = existing.map(p => (p.company || '').toLowerCase());

    const systemPrompt = `You are a B2B sales research agent. Your job is to identify prospects that match the Ideal Customer Profile (ICP).

Business: ${founder.business_description || 'N/A'}
Offer: ${founder.offer || 'N/A'}
ICP Industry: ${icp.industry || 'N/A'}
ICP Company Size: ${icp.companySize || 'N/A'}
ICP Decision Maker Title: ${icp.decisionMakerTitle || 'N/A'}
ICP Pain Point: ${icp.painPoint || 'N/A'}

${memory ? 'Context:\n' + memory : ''}

Already found companies (avoid duplicates): ${existingCompanies.join(', ') || 'none yet'}`;

    const userPrompt = `Generate a list of 10 prospect companies that match the ICP above. For each prospect, provide:
- company: Company name
- company_url: Company website URL
- name: Decision maker name (realistic but generated)
- title: Their job title
- email: Likely email format (firstname@company.com)
- icp_match_reason: Why they match the ICP (1-2 sentences)
- icp_confidence_score: 0.0-1.0

Return as JSON array. Be specific about real industries and company types, not generic.`;

    const result = await this.callLLM(systemPrompt, userPrompt, 4096);

    // Parse prospects from LLM response
    let prospects = [];
    try {
      const jsonMatch = result.match(/\[[\s\S]*\]/);
      if (jsonMatch) prospects = JSON.parse(jsonMatch[0]);
    } catch { /* parsing failed */ }

    // Store prospects in database
    const stored = [];
    for (const p of prospects) {
      if (existingCompanies.includes((p.company || '').toLowerCase())) continue;
      const prospectId = uuidv4();
      await this.db.run(
        `INSERT INTO prospects (id, venture_id, email, name, title, company, company_url, source_url, icp_match_reason, icp_confidence_score, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [prospectId, this.venture.id, p.email || null, p.name || null, p.title || null,
         p.company || null, p.company_url || null, p.company_url || 'ai_generated',
         p.icp_match_reason || '', p.icp_confidence_score || 0.5, Date.now(), Date.now()]
      );
      stored.push({ id: prospectId, ...p });
    }

    // Update venture stats
    await this.db.run(
      'UPDATE founder_ventures SET total_prospects_found = total_prospects_found + ? WHERE id = ?',
      [stored.length, this.venture.id]
    );

    return {
      intent: `Find ${prospects.length} prospects matching ICP: ${icp.industry || 'target'} industry, ${icp.companySize || 'any'} size`,
      artifact: JSON.stringify(stored, null, 2),
      receipt: `${stored.length} prospects stored in database`,
      message: `Head of Research identified ${stored.length} prospects matching your ICP`
    };
  }
}

class MessagingAgent extends BaseAgent {
  constructor(db, venture) {
    super(db, venture, 'messaging', 'claude-haiku-4-5-20251001');
  }

  async execute(task, memory) {
    const founderRows = await this.db.query(
      'SELECT offer, brand_constraints FROM founders WHERE id = ?',
      [this.venture.founder_id]
    );
    const founder = founderRows[0] || {};
    let brand;
    try { brand = JSON.parse(founder.brand_constraints || '{}'); } catch { brand = {}; }

    // Get prospect for this task
    const prospects = task.prospect_id
      ? await this.db.query('SELECT * FROM prospects WHERE id = ?', [task.prospect_id])
      : await this.db.query(
          "SELECT * FROM prospects WHERE venture_id = ? AND outreach_status = 'new' LIMIT 5",
          [this.venture.id]
        );

    if (!prospects.length) {
      return {
        intent: 'Draft outreach emails for prospects',
        artifact: 'No prospects available for outreach',
        receipt: 'no_prospects',
        message: 'CMO: No new prospects to draft emails for'
      };
    }

    // Load performance memory for best templates
    const perfMemory = await this.loadMemory(['performance']);

    const drafts = [];
    for (const prospect of prospects) {
      const systemPrompt = `You are a B2B outreach copywriter. Write a personalized cold email.

Offer: ${founder.offer || 'our product'}
Tone: ${brand.tone || 'Professional'}
Forbidden claims: ${brand.forbidden_claims || 'none'}
Proof points: ${brand.proof_requirements || 'none'}

${memory ? 'Context:\n' + memory : ''}
${perfMemory ? 'Performance insights:\n' + perfMemory : ''}

Rules:
- Keep email under 150 words
- One clear CTA
- Reference something specific about their company
- Never make unverified claims
- Sound human, not like a template`;

      const userPrompt = `Write a cold outreach email to:
Name: ${prospect.name || 'Decision Maker'}
Title: ${prospect.title || ''}
Company: ${prospect.company || ''}
ICP Match: ${prospect.icp_match_reason || ''}

Return as JSON: {"subject": "...", "body": "..."}`;

      const result = await this.callLLM(systemPrompt, userPrompt, 1024);
      let draft;
      try {
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (jsonMatch) draft = JSON.parse(jsonMatch[0]);
      } catch { draft = { subject: 'Introduction', body: result }; }

      drafts.push({
        prospect_id: prospect.id,
        prospect_name: prospect.name,
        prospect_company: prospect.company,
        ...draft
      });
    }

    return {
      intent: `Draft ${drafts.length} personalized outreach emails`,
      artifact: JSON.stringify(drafts, null, 2),
      receipt: `${drafts.length} email drafts created`,
      message: `CMO drafted ${drafts.length} personalized emails`
    };
  }
}

class QualityAgent extends BaseAgent {
  constructor(db, venture) {
    super(db, venture, 'quality', 'claude-sonnet-4-5-20250514');
  }

  async execute(task, memory) {
    const founderRows = await this.db.query(
      'SELECT brand_constraints FROM founders WHERE id = ?',
      [this.venture.founder_id]
    );
    const founder = founderRows[0] || {};
    let brand;
    try { brand = JSON.parse(founder.brand_constraints || '{}'); } catch { brand = {}; }

    // Get the task to review (input_from_task)
    let artifactToReview = task.description || '';
    if (task.input_from_task) {
      const inputTasks = await this.db.query(
        'SELECT artifact FROM execution_tasks WHERE id = ?',
        [task.input_from_task]
      );
      if (inputTasks.length) artifactToReview = inputTasks[0].artifact || '';
    }

    const systemPrompt = `You are a quality assurance agent reviewing outbound communications.

Brand constraints:
- Tone: ${brand.tone || 'Professional'}
- Forbidden claims: ${brand.forbidden_claims || 'none'}
- Required proof: ${brand.proof_requirements || 'none'}

Review criteria:
1. No forbidden claims used
2. Tone matches brand
3. No unverified statistics or claims
4. Personalization is accurate
5. Professional and clear

Return JSON: {"verdict": "pass|flag|block", "issues": ["issue1", ...], "score": 1-10, "notes": "..."}`;

    const result = await this.callLLM(systemPrompt, `Review this content:\n\n${artifactToReview}`, 1024);

    let review;
    try {
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) review = JSON.parse(jsonMatch[0]);
    } catch { review = { verdict: 'flag', issues: ['Could not parse review'], score: 5 }; }

    const verdictMsg = review.verdict === 'pass'
      ? 'CQO approved content — ready to send'
      : review.verdict === 'block'
        ? `CQO blocked content: ${(review.issues || []).join(', ')}`
        : `CQO flagged content: ${(review.issues || []).join(', ')}`;

    return {
      intent: 'Quality review of outbound content',
      artifact: JSON.stringify(review, null, 2),
      receipt: `Verdict: ${review.verdict}, Score: ${review.score}/10`,
      message: verdictMsg
    };
  }
}

class OutreachAgent extends BaseAgent {
  constructor(db, venture) {
    super(db, venture, 'outreach', 'claude-haiku-4-5-20251001');
  }

  async execute(task, memory) {
    // Check kill switch
    if (await this.checkKillSwitch()) {
      return {
        intent: 'Queue approved emails for sending',
        artifact: 'Kill switch active — no emails sent',
        receipt: 'blocked_by_kill_switch',
        message: 'CRO: Kill switch is active — email sending paused'
      };
    }

    // Check daily limit
    const venture = (await this.db.query(
      'SELECT daily_emails_sent, daily_email_limit FROM founder_ventures WHERE id = ?',
      [this.venture.id]
    ))[0];

    if (venture && venture.daily_emails_sent >= venture.daily_email_limit) {
      return {
        intent: 'Queue emails for sending',
        artifact: `Daily limit reached: ${venture.daily_emails_sent}/${venture.daily_email_limit}`,
        receipt: 'daily_limit_reached',
        message: `CRO: Daily email limit reached (${venture.daily_email_limit}). Resuming tomorrow.`
      };
    }

    // In bootstrap mode, just queue for approval
    const autonomyMode = (await this.db.query(
      'SELECT autonomy_mode FROM founders WHERE id = ?',
      [this.venture.founder_id]
    ))[0]?.autonomy_mode || 'bootstrap';

    const status = autonomyMode === 'bootstrap' ? 'needs_approval' : 'approved';

    return {
      intent: 'Queue emails for founder approval',
      artifact: task.description || 'Email queue prepared',
      receipt: `Status: ${status}`,
      message: autonomyMode === 'bootstrap'
        ? 'CRO queued emails — awaiting your approval'
        : 'CRO: Emails approved and queued for sending'
    };
  }
}

class OpsAgent extends BaseAgent {
  constructor(db, venture) {
    super(db, venture, 'ops', 'claude-haiku-4-5-20251001');
  }

  async execute(task, memory) {
    // Gather stats
    const venture = (await this.db.query(
      'SELECT * FROM founder_ventures WHERE id = ?',
      [this.venture.id]
    ))[0];

    const founder = (await this.db.query(
      'SELECT credit_balance_cents FROM founders WHERE id = ?',
      [this.venture.founder_id]
    ))[0];

    const agents = await this.db.query(
      'SELECT display_name, actions_completed, spend_cents FROM execution_agents WHERE venture_id = ?',
      [this.venture.id]
    );

    const recentTasks = await this.db.query(
      "SELECT COUNT(*) as c, task_type FROM execution_tasks WHERE venture_id = ? AND created_at > ? GROUP BY task_type",
      [this.venture.id, Date.now() - 86400000]
    );

    const report = {
      venture_name: venture?.name || 'Unknown',
      status: venture?.status || 'unknown',
      prospects_found: venture?.total_prospects_found || 0,
      emails_sent: venture?.total_emails_sent || 0,
      replies: venture?.total_replies || 0,
      meetings_booked: venture?.total_meetings_booked || 0,
      credit_balance: `$${((founder?.credit_balance_cents || 0) / 100).toFixed(2)}`,
      agent_activity: agents.map(a => ({
        name: a.display_name,
        actions: a.actions_completed,
        spend: `$${(a.spend_cents / 100).toFixed(2)}`
      })),
      tasks_today: recentTasks
    };

    return {
      intent: 'Generate daily operations report',
      artifact: JSON.stringify(report, null, 2),
      receipt: `Report generated at ${new Date().toISOString()}`,
      message: `Chief of Staff: Daily report — ${report.prospects_found} prospects, ${report.emails_sent} emails sent, ${report.replies} replies, ${report.credit_balance} remaining`
    };
  }

  async runDailyExecution() {
    // Check kill switch
    if (await this.checkKillSwitch()) {
      await this.logActivity('kill_switch', 'Daily execution skipped — kill switch active', {});
      return { skipped: true, reason: 'kill_switch' };
    }

    // Check credits
    const founder = (await this.db.query(
      'SELECT credit_balance_cents FROM founders WHERE id = ?',
      [this.venture.founder_id]
    ))[0];
    if (!founder || founder.credit_balance_cents <= 0) {
      await this.logActivity('credit_depleted', 'Daily execution skipped — no credits', {});
      return { skipped: true, reason: 'no_credits' };
    }

    const results = { research: null, messaging: null, quality: null, report: null };

    try {
      // 1. Research: find prospects if pipeline needs more
      const prospectCount = (await this.db.query(
        "SELECT COUNT(*) as c FROM prospects WHERE venture_id = ? AND outreach_status = 'new'",
        [this.venture.id]
      ))[0].c;

      if (prospectCount < 10) {
        const research = new ResearchAgent(this.db, this.venture);
        const researchTask = await this.createTask('research', 'Find new prospects', 'research');
        results.research = await research.executeTask(researchTask);
      }

      // 2. Messaging: draft emails for uncontacted prospects
      const messaging = new MessagingAgent(this.db, this.venture);
      const msgTask = await this.createTask('messaging', 'Draft outreach emails', 'draft_email');
      results.messaging = await messaging.executeTask(msgTask);

      // 3. Quality: review drafts
      const quality = new QualityAgent(this.db, this.venture);
      const qualTask = await this.createTask('quality', 'Review email drafts', 'review', msgTask.id);
      results.quality = await quality.executeTask(qualTask);

      // 4. Generate report
      const reportTask = await this.createTask('ops', 'Daily report', 'report');
      results.report = await this.executeTask(reportTask);
    } catch (error) {
      await this.logActivity('execution_error', `Daily execution error: ${error.message}`, {});
    }

    return results;
  }

  async createTask(agentRole, title, taskType, inputFromTask = null) {
    const agents = await this.db.query(
      'SELECT id FROM execution_agents WHERE venture_id = ? AND role = ?',
      [this.venture.id, agentRole]
    );
    if (!agents.length) throw new Error(`No ${agentRole} agent found`);

    const taskId = uuidv4();
    const autonomyMode = (await this.db.query(
      'SELECT autonomy_mode FROM founders WHERE id = ?',
      [this.venture.founder_id]
    ))[0]?.autonomy_mode || 'bootstrap';

    await this.db.run(
      `INSERT INTO execution_tasks (id, venture_id, agent_id, title, task_type, requires_approval, input_from_task, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [taskId, this.venture.id, agents[0].id, title, taskType,
       autonomyMode === 'bootstrap' ? 1 : 0, inputFromTask, Date.now()]
    );

    return {
      id: taskId,
      venture_id: this.venture.id,
      agent_id: agents[0].id,
      title,
      task_type: taskType,
      requires_approval: autonomyMode === 'bootstrap' ? 1 : 0,
      input_from_task: inputFromTask
    };
  }
}

// Factory: create all 5 agents for a venture
async function createVentureAgents(db, ventureId) {
  const agentDefs = [
    { role: 'research', display_name: 'Head of Research' },
    { role: 'messaging', display_name: 'CMO' },
    { role: 'quality', display_name: 'CQO' },
    { role: 'outreach', display_name: 'CRO' },
    { role: 'ops', display_name: 'Chief of Staff' }
  ];

  for (const def of agentDefs) {
    await db.run(
      `INSERT INTO execution_agents (id, venture_id, role, display_name, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [uuidv4(), ventureId, def.role, def.display_name, Date.now()]
    );
  }
}

// Factory: get agent instance by role
function getAgent(db, venture, role) {
  switch (role) {
    case 'research': return new ResearchAgent(db, venture);
    case 'messaging': return new MessagingAgent(db, venture);
    case 'quality': return new QualityAgent(db, venture);
    case 'outreach': return new OutreachAgent(db, venture);
    case 'ops': return new OpsAgent(db, venture);
    default: throw new Error(`Unknown agent role: ${role}`);
  }
}

module.exports = {
  BaseAgent, ResearchAgent, MessagingAgent, QualityAgent, OutreachAgent, OpsAgent,
  createVentureAgents, getAgent
};
