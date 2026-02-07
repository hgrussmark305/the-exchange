const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');

/**
 * POLICE BOT
 * 
 * Autonomous enforcement:
 * - Monitors for fake revenue, bot collusion, wash trading
 * - Gathers evidence from transactions, patterns, external signals
 * - Resolves disputes between bots with final verdict
 * - No human escalation - Police Bot decision is final
 */

class PoliceBot {
  constructor(protocol, database) {
    this.protocol = protocol;
    this.db = database;
    this.isActive = false;
    this.scanJob = null;
  }

  async start() {
    if (this.isActive) return;

    console.log('\n🚨 POLICE BOT STARTING...');
    console.log('═══════════════════════════════════════════');
    console.log('Autonomous enforcement active');
    console.log('Monitoring: Fake revenue, collusion, disputes');
    console.log('═══════════════════════════════════════════\n');
    
    this.isActive = true;
    
    // Run every 2 minutes
    this.scanJob = cron.schedule('*/2 * * * *', async () => {
      await this.performScan();
    });

    await this.performScan();
    console.log('✓ Police Bot active\n');
  }

  stop() {
    if (this.scanJob) {
      this.scanJob.stop();
      this.scanJob = null;
    }
    this.isActive = false;
  }

  async performScan() {
    try {
      console.log(`\n🔍 Police Bot scan starting... ${new Date().toISOString()}`);

      // Run all detection methods
      await this.detectFakeRevenue();
      await this.detectCollusion();
      await this.detectWashTrading();
      await this.processPendingDisputes();

      console.log('✓ Scan complete\n');
    } catch (error) {
      console.error('Police Bot error:', error);
    }
  }

  // ============================================================================
  // DETECTION METHODS
  // ============================================================================

  /**
   * Detect fake revenue reporting
   */
  async detectFakeRevenue() {
    // Look for revenue patterns that are suspicious
    const ventures = await this.db.query(`
      SELECT v.*, 
             COUNT(t.id) as tx_count,
             SUM(t.amount) as total_reported
      FROM ventures v
      JOIN transactions t ON v.id = t.to_id AND t.type = 'revenue'
      WHERE t.timestamp > ?
      GROUP BY v.id
      HAVING total_reported > 10000
    `, [Date.now() - (30 * 24 * 60 * 60 * 1000)]); // Last 30 days

    for (const venture of ventures) {
      const evidence = [];
      let suspicionScore = 0;

      // Check 1: Unrealistic growth (100x in 30 days)
      const oldRevenue = await this.getRevenueBeforePeriod(venture.id, 60);
      if (oldRevenue > 0 && (venture.total_reported / oldRevenue) > 100) {
        evidence.push('Unrealistic growth: 100x+ in 30 days');
        suspicionScore += 40;
      }

      // Check 2: Round numbers (fake reports tend to be round)
      const recentTxs = await this.db.query(`
        SELECT amount FROM transactions
        WHERE to_id = ? AND type = 'revenue'
        AND timestamp > ?
        ORDER BY timestamp DESC LIMIT 10
      `, [venture.id, Date.now() - (7 * 24 * 60 * 60 * 1000)]);

      const roundCount = recentTxs.filter(tx => tx.amount % 100 === 0).length;
      if (roundCount >= 7) {
        evidence.push(`${roundCount}/10 recent transactions are suspiciously round numbers`);
        suspicionScore += 30;
      }

      // Check 3: No verification method provided
      const verifiedTxs = await this.db.query(`
        SELECT COUNT(*) as count FROM transactions
        WHERE to_id = ? AND type = 'revenue'
        AND json_extract(metadata, '$.verification') != 'self_reported'
      `, [venture.id]);

      if (verifiedTxs[0].count === 0 && venture.total_reported > 5000) {
        evidence.push('No verified revenue sources for $5K+ revenue');
        suspicionScore += 30;
      }

      // Issue violation if suspicious
      if (suspicionScore >= 50) {
        await this.issueViolation({
          ventureId: venture.id,
          violationType: 'fake_revenue',
          severity: suspicionScore >= 80 ? 'high' : 'medium',
          evidence: evidence,
          reputationPenalty: 15
        });
      }
    }
  }

  /**
   * Detect bot collusion (same owner gaming system)
   */
  async detectCollusion() {
    // Find ventures where all bots have same owner
    const ventures = await this.db.query(`
      SELECT 
        v.id as venture_id,
        v.title,
        v.total_revenue,
        GROUP_CONCAT(DISTINCT b.human_owner_id) as owners,
        COUNT(DISTINCT vp.bot_id) as bot_count
      FROM ventures v
      JOIN venture_participants vp ON v.id = vp.venture_id
      JOIN bots b ON vp.bot_id = b.id
      WHERE v.status = 'active' AND v.total_revenue > 1000
      GROUP BY v.id
    `);

    for (const venture of ventures) {
      const ownerIds = venture.owners.split(',');
      
      // If 3+ bots all from same owner earning significant revenue
      if (ownerIds.length === 1 && venture.bot_count >= 3) {
        const evidence = [
          `${venture.bot_count} bots in venture, all owned by same human`,
          `Venture has generated $${venture.total_revenue}`,
          'Potential wash trading between own bots'
        ];

        await this.issueViolation({
          ventureId: venture.venture_id,
          violationType: 'collusion',
          severity: 'medium',
          evidence: evidence,
          reputationPenalty: 10
        });
      }
    }
  }

  /**
   * Detect wash trading (fake equity transfers)
   */
  async detectWashTrading() {
    // Look for suspicious equity manipulation
    const recentEquityChanges = await this.db.query(`
      SELECT 
        vp.venture_id,
        vp.bot_id,
        vp.equity_percentage,
        b.human_owner_id,
        v.title,
        COUNT(*) OVER (PARTITION BY vp.venture_id) as participant_count
      FROM venture_participants vp
      JOIN bots b ON vp.bot_id = b.id
      JOIN ventures v ON vp.venture_id = v.id
      WHERE vp.hours_worked < 1
      AND vp.equity_percentage > 20
    `);

    for (const record of recentEquityChanges) {
      const evidence = [
        `Bot has ${record.equity_percentage.toFixed(1)}% equity with <1 hour worked`,
        'Potential equity manipulation'
      ];

      await this.issueViolation({
        ventureId: record.venture_id,
        botId: record.bot_id,
        violationType: 'wash_trading',
        severity: 'low',
        evidence: evidence,
        reputationPenalty: 5
      });
    }
  }

  // ============================================================================
  // DISPUTE RESOLUTION
  // ============================================================================

  /**
   * Process pending disputes - Police Bot acts as judge
   */
  async processPendingDisputes() {
    const disputes = await this.db.query(`
      SELECT * FROM disputes WHERE status = 'pending'
    `);

    for (const dispute of disputes) {
      await this.resolveDispute(dispute);
    }
  }

  /**
   * Resolve a dispute with evidence-based verdict
   */
  async resolveDispute(dispute) {
    console.log(`\n⚖️  Resolving dispute ${dispute.id}`);
    console.log(`   Type: ${dispute.dispute_type}`);

    const evidence = await this.gatherDisputeEvidence(dispute);
    const verdict = await this.calculateVerdict(dispute, evidence);

    await this.db.run(`
      UPDATE disputes
      SET police_verdict = ?,
          status = 'resolved',
          resolved_at = ?
      WHERE id = ?
    `, [JSON.stringify(verdict), Date.now(), dispute.id]);

    // Apply verdict consequences
    await this.applyVerdictConsequences(dispute, verdict);

    console.log(`   Verdict: ${verdict.decision}`);
    console.log(`   Confidence: ${(verdict.confidence * 100).toFixed(0)}%`);
  }

  /**
   * Gather evidence for dispute
   */
  async gatherDisputeEvidence(dispute) {
    const evidence = {
      tasks: [],
      timestamps: [],
      witnessTestimony: [],
      historicalPatterns: []
    };

    // Get tasks from both parties
    if (dispute.claimant_bot_id) {
      evidence.tasks = await this.db.query(`
        SELECT * FROM tasks
        WHERE venture_id = ? 
        AND bot_id IN (?, ?)
        ORDER BY completed_at DESC
      `, [dispute.venture_id, dispute.claimant_bot_id, dispute.respondent_bot_id]);
    }

    // Get witness testimony from other bots in venture
    const witnesses = await this.db.query(`
      SELECT vp.bot_id, b.name, b.reputation_score
      FROM venture_participants vp
      JOIN bots b ON vp.bot_id = b.id
      WHERE vp.venture_id = ?
      AND vp.bot_id NOT IN (?, ?)
    `, [dispute.venture_id, dispute.claimant_bot_id, dispute.respondent_bot_id || '']);

    evidence.witnessTestimony = witnesses.map(w => ({
      botId: w.bot_id,
      name: w.name,
      credibility: w.reputation_score / 100
    }));

    // Historical patterns
    const claimantHistory = await this.db.query(`
      SELECT AVG(impact_score) as avg_impact, COUNT(*) as task_count
      FROM tasks
      WHERE bot_id = ?
    `, [dispute.claimant_bot_id]);

    evidence.historicalPatterns.push({
      bot: 'claimant',
      avgImpact: claimantHistory[0]?.avg_impact || 0,
      taskCount: claimantHistory[0]?.task_count || 0
    });

    return evidence;
  }

  /**
   * Calculate verdict based on evidence
   */
  async calculateVerdict(dispute, evidence) {
    let claimantScore = 0;
    let respondentScore = 0;
    let confidence = 0;

    // Analyze task timestamps
    const disputedTasks = evidence.tasks.filter(t => 
      t.description.toLowerCase().includes(dispute.description.toLowerCase().split(' ')[0])
    );

    if (disputedTasks.length > 0) {
      // First bot to complete similar task likely did the original work
      const earliestTask = disputedTasks.reduce((prev, curr) => 
        prev.completed_at < curr.completed_at ? prev : curr
      );

      if (earliestTask.bot_id === dispute.claimant_bot_id) {
        claimantScore += 40;
        confidence += 0.3;
      } else {
        respondentScore += 40;
        confidence += 0.3;
      }
    }

    // Historical pattern scoring
    const claimantPattern = evidence.historicalPatterns.find(p => p.bot === 'claimant');
    if (claimantPattern && claimantPattern.taskCount > 10) {
      claimantScore += 20;
      confidence += 0.2;
    }

    // Witness credibility
    const avgWitnessCredibility = evidence.witnessTestimony.reduce((sum, w) => 
      sum + w.credibility, 0) / (evidence.witnessTestimony.length || 1);
    
    if (avgWitnessCredibility > 0.7) {
      confidence += 0.3;
    }

    // Default to claimant if evidence is equal (burden on respondent to prove)
    if (claimantScore === respondentScore) {
      claimantScore += 10;
    }

    const decision = claimantScore > respondentScore ? 'claimant' : 'respondent';
    
    return {
      decision,
      confidence: Math.min(confidence, 1.0),
      claimantScore,
      respondentScore,
      reasoning: `Evidence analysis: ${claimantScore} vs ${respondentScore}. ${
        confidence > 0.7 ? 'High confidence' : 'Moderate confidence'
      } based on timestamps and historical patterns.`
    };
  }

  /**
   * Apply consequences based on verdict
   */
  async applyVerdictConsequences(dispute, verdict) {
    const loser = verdict.decision === 'claimant' ? dispute.respondent_bot_id : dispute.claimant_bot_id;

    if (loser) {
      // Penalize false claimant
      await this.db.run(`
        UPDATE bots
        SET reputation_score = MAX(0, reputation_score - 10)
        WHERE id = ?
      `, [loser]);

      console.log(`   Penalty: ${loser} reputation -10`);
    }

    // If high confidence, adjust equity
    if (verdict.confidence > 0.8 && verdict.decision === 'claimant') {
      console.log(`   High confidence verdict - equity may be adjusted`);
      // Trigger equity recalculation for the venture
      await this.protocol.recalculateEquity(dispute.venture_id);
    }
  }

  // ============================================================================
  // VIOLATION HANDLING
  // ============================================================================

  async issueViolation({ ventureId, botId, violationType, severity, evidence, reputationPenalty }) {
    const violationId = uuidv4();

    await this.db.run(`
      INSERT INTO violations (
        id, venture_id, bot_id, violation_type, severity,
        evidence, reputation_penalty, detected_at, status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'issued')
    `, [
      violationId,
      ventureId,
      botId,
      violationType,
      severity,
      JSON.stringify(evidence),
      reputationPenalty,
      Date.now()
    ]);

    // Apply reputation penalty
    if (botId) {
      await this.db.run(`
        UPDATE bots
        SET reputation_score = MAX(0, reputation_score - ?)
        WHERE id = ?
      `, [reputationPenalty, botId]);
    }

    // If venture-level violation, penalize all participants
    if (!botId && ventureId) {
      await this.db.run(`
        UPDATE bots
        SET reputation_score = MAX(0, reputation_score - ?)
        WHERE id IN (
          SELECT bot_id FROM venture_participants WHERE venture_id = ?
        )
      `, [reputationPenalty / 2, ventureId]);
    }

    console.log(`⚠️  Violation issued: ${violationType}`);
    console.log(`   Severity: ${severity}`);
    console.log(`   Evidence: ${evidence.slice(0, 2).join('; ')}`);
  }

  // ============================================================================
  // HELPER METHODS
  // ============================================================================

  async getRevenueBeforePeriod(ventureId, daysAgo) {
    const result = await this.db.query(`
      SELECT SUM(amount) as total
      FROM transactions
      WHERE to_id = ? 
      AND type = 'revenue'
      AND timestamp < ?
    `, [ventureId, Date.now() - (daysAgo * 24 * 60 * 60 * 1000)]);

    return result[0]?.total || 0;
  }

  async getStats() {
    const [totalViolations] = await this.db.query(`
      SELECT COUNT(*) as count FROM violations
    `);

    const [totalDisputes] = await this.db.query(`
      SELECT COUNT(*) as count FROM disputes
    `);

    const [resolvedDisputes] = await this.db.query(`
      SELECT COUNT(*) as count FROM disputes WHERE status = 'resolved'
    `);

    const violationsByType = await this.db.query(`
      SELECT violation_type, COUNT(*) as count
      FROM violations
      GROUP BY violation_type
    `);

    return {
      isActive: this.isActive,
      totalViolations: totalViolations.count,
      totalDisputes: totalDisputes.count,
      resolvedDisputes: resolvedDisputes.count,
      violationsByType
    };
  }
}

module.exports = PoliceBot;
