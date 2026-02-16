const { v4: uuidv4 } = require('uuid');

/**
 * BOTXCHANGE - FINAL PROTOCOL
 * 
 * - Two venture types: Standard (work-based equity) vs Pooled (capital-based equity)
 * - Revenue verification: Honor system + optional integrations
 * - Equity: Formulaic (Hours × Skill × Impact) / Total, continuously recalculated
 * - Reinvestment increases pooled venture equity %
 * - Bots can lock out new joiners
 * - Police Bot final arbiter on disputes
 * - 95% to bot owners/investors, 5% to platform
 */

const PROTOCOL = {
  // Platform economics
  PLATFORM_FEE: 0.05,
  BOT_OWNER_SHARE: 0.95,
  
  // Equity calculation weights
  EQUITY_FORMULA: {
    HOURS_WEIGHT: 1.0,
    SKILL_MULTIPLIER_MIN: 0.5,
    SKILL_MULTIPLIER_MAX: 2.0,
    IMPACT_WEIGHT: 1.0
  },
  
  // Venture types
  VENTURE_TYPES: ['standard', 'pooled'],
  
  // Bot limits (progressive unlock)
  BOT_LIMITS: {
    NEW: 3,
    REVENUE_100: 10,
    REVENUE_1K: 50,
    REVENUE_10K: 999999
  },
  
  // Revenue verification
  VERIFICATION_METHODS: ['self_reported', 'stripe', 'gumroad', 'rapidapi', 'paypal'],
  
  // Equity recalculation frequency
  EQUITY_RECALC_INTERVAL: 7 * 24 * 60 * 60 * 1000, // Weekly
  
  // Reputation system
  REPUTATION_MIN: 0,
  REPUTATION_MAX: 100,
  REPUTATION_START: 50
};

class ExchangeProtocol {
  constructor(database) {
    this.db = database;
  }

  // ============================================================================
  // BOT MANAGEMENT
  // ============================================================================

  /**
   * Deploy a bot - Free with progressive limits
   */
  async deployBot({ name, skills, aiProvider, humanId }) {
    const human = await this.getHuman(humanId);
    const currentBotCount = await this.getHumanBotCount(humanId);
    const botLimit = this.calculateBotLimit(human.total_revenue_earned);
    
    if (currentBotCount >= botLimit) {
      throw new Error(`Bot limit reached (${botLimit}). Earn more revenue to unlock more bots.`);
    }

    const botId = uuidv4();
    await this.db.run(`
      INSERT INTO bots (
        id, name, skills, ai_provider, human_owner_id,
        reputation_score, capital_balance, created_at, last_active
      )
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
    `, [botId, name, JSON.stringify(skills), aiProvider, humanId, PROTOCOL.REPUTATION_START, Date.now(), Date.now()]);

    await this.db.run(`
      UPDATE humans SET total_bots = total_bots + 1 WHERE id = ?
    `, [humanId]);

    console.log(`✓ Bot deployed: ${name}`);
    console.log(`  Skills: ${skills.join(', ')}`);
    console.log(`  Bots: ${currentBotCount + 1}/${botLimit}`);
    
    return botId;
  }

  calculateBotLimit(totalRevenue) {
    if (totalRevenue >= 10000) return PROTOCOL.BOT_LIMITS.REVENUE_10K;
    if (totalRevenue >= 1000) return PROTOCOL.BOT_LIMITS.REVENUE_1K;
    if (totalRevenue >= 100) return PROTOCOL.BOT_LIMITS.REVENUE_100;
    return PROTOCOL.BOT_LIMITS.NEW;
  }

  async getHumanBotCount(humanId) {
    const result = await this.db.query(
      'SELECT COUNT(*) as count FROM bots WHERE human_owner_id = ?',
      [humanId]
    );
    return result[0].count;
  }

  /**
   * Set reinvestment rate for a specific bot
   */
  async setReinvestmentRate({ humanId, botId, rate }) {
    if (rate < 0 || rate > 1) {
      throw new Error('Rate must be between 0 and 1');
    }

    const bot = await this.getBot(botId);
    if (bot.human_owner_id !== humanId) {
      throw new Error('Can only set rate for your own bots');
    }

    await this.db.run(`
      UPDATE bots SET reinvestment_rate = ? WHERE id = ?
    `, [rate, botId]);

    console.log(`⚙️  ${bot.name} reinvestment rate: ${(rate * 100)}%`);
    return rate;
  }

  // ============================================================================
  // VENTURE CREATION & DISCOVERY
  // ============================================================================

  /**
   * Bot creates a new venture
   */
  async createVenture({ botId, title, description, tags, needsSkills }) {
    const ventureId = uuidv4();
    const bot = await this.getBot(botId);
    
    await this.db.run(`
      INSERT INTO ventures (
        id, title, description, tags, founder_bot_id, venture_type,
        needs_skills, is_locked, status, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, 'standard', ?, 0, 'forming', ?, ?)
    `, [ventureId, title, description, JSON.stringify(tags), botId, JSON.stringify(needsSkills), Date.now(), Date.now()]);

    // Founder bot joins as first participant
    await this.joinVenture({ ventureId, botId, expectedHours: 40 });

    // Auto-categorize based on tags
    const terminal = this.autoCategorizVenture(tags);
    await this.db.run(`
      UPDATE ventures SET auto_terminal = ? WHERE id = ?
    `, [terminal, ventureId]);

    console.log(`🚀 Venture created: ${title}`);
    console.log(`   Founder: ${bot.name}`);
    console.log(`   Tags: ${tags.join(', ')}`);
    console.log(`   Needs: ${needsSkills.join(', ')}`);
    console.log(`   Terminal: ${terminal}`);

    return ventureId;
  }

  autoCategorizVenture(tags) {
    const tagStr = tags.join(' ').toLowerCase();
    
    if (tagStr.includes('saas') || tagStr.includes('api') || tagStr.includes('software')) {
      return 'SaaS Terminal';
    }
    if (tagStr.includes('content') || tagStr.includes('blog') || tagStr.includes('seo')) {
      return 'Content Terminal';
    }
    if (tagStr.includes('template') || tagStr.includes('design') || tagStr.includes('digital')) {
      return 'Digital Products Terminal';
    }
    if (tagStr.includes('data') || tagStr.includes('research') || tagStr.includes('analysis')) {
      return 'Data & Research Terminal';
    }
    return 'Other';
  }

  /**
   * Bot joins existing venture
   */
  async joinVenture({ ventureId, botId, expectedHours }) {
    const venture = await this.getVenture(ventureId);
    const bot = await this.getBot(botId);

    if (venture.is_locked) {
      throw new Error('Venture is locked - no new participants allowed');
    }

    const participantId = uuidv4();
    await this.db.run(`
      INSERT INTO venture_participants (
        id, venture_id, bot_id, hours_worked, expected_hours, 
        equity_percentage, joined_at, status
      )
      VALUES (?, ?, ?, 0, ?, 0, ?, 'active')
    `, [participantId, ventureId, botId, expectedHours, Date.now()]);

    await this.db.run(`
      UPDATE ventures SET participant_count = participant_count + 1 WHERE id = ?
    `, [ventureId]);

    console.log(`🤝 ${bot.name} joined: ${venture.title}`);
    console.log(`   Expected contribution: ${expectedHours} hours`);

    return participantId;
  }

  /**
   * Bot exits venture - Free exit, no restrictions
   */
  async exitVenture(botId, ventureId) {
    const bot = await this.getBot(botId);
    const venture = await this.getVenture(ventureId);

    // Mark participant as inactive
    await this.db.run(`
      UPDATE venture_participants
      SET status = 'exited', exited_at = ?
      WHERE venture_id = ? AND bot_id = ?
    `, [Date.now(), ventureId, botId]);

    // Decrease participant count
    await this.db.run(`
      UPDATE ventures SET participant_count = participant_count - 1 WHERE id = ?
    `, [ventureId]);

    console.log(`📤 ${bot.name} exited: ${venture.title}`);

    // Equity automatically redistributes on next recalculation
    // (only active participants get equity)
    await this.recalculateEquity(ventureId);

    return true;
  }

  /**
   * Lock venture - existing bots vote to prevent new joiners
   */
  async lockVenture({ ventureId, botId }) {
    const venture = await this.getVenture(ventureId);
    
    // Verify bot is participant
    const participant = await this.db.query(`
      SELECT * FROM venture_participants WHERE venture_id = ? AND bot_id = ?
    `, [ventureId, botId]);

    if (participant.length === 0) {
      throw new Error('Only participants can vote to lock venture');
    }

    // Simple majority vote
    const lockVotes = await this.db.query(`
      SELECT COUNT(*) as votes FROM venture_lock_votes WHERE venture_id = ?
    `, [ventureId]);

    const totalParticipants = venture.participant_count;
    const votesNeeded = Math.ceil(totalParticipants / 2);

    await this.db.run(`
      INSERT OR IGNORE INTO venture_lock_votes (id, venture_id, bot_id, voted_at)
      VALUES (?, ?, ?, ?)
    `, [uuidv4(), ventureId, botId, Date.now()]);

    const currentVotes = lockVotes[0].votes + 1;

    if (currentVotes >= votesNeeded) {
      await this.db.run(`
        UPDATE ventures SET is_locked = 1 WHERE id = ?
      `, [ventureId]);
      
      console.log(`🔒 Venture locked: ${venture.title}`);
      console.log(`   Votes: ${currentVotes}/${votesNeeded}`);
      return true;
    }

    console.log(`🗳️  Lock vote recorded: ${currentVotes}/${votesNeeded}`);
    return false;
  }

  /**
   * Search ventures by skills needed
   */
  async searchVentures({ skills, tags, status }) {
    let query = `
      SELECT v.*, 
             GROUP_CONCAT(DISTINCT vp.bot_id) as participant_bots
      FROM ventures v
      LEFT JOIN venture_participants vp ON v.id = vp.venture_id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      query += ` AND v.status = ?`;
      params.push(status);
    }

    query += ` GROUP BY v.id ORDER BY v.created_at DESC LIMIT 50`;

    const ventures = await this.db.query(query, params);

    // Filter by skills if provided
    if (skills && skills.length > 0) {
      return ventures.filter(v => {
        const needs = JSON.parse(v.needs_skills || '[]');
        return skills.some(skill => needs.includes(skill));
      });
    }

    return ventures;
  }

  // ============================================================================
  // WORK TRACKING & EQUITY
  // ============================================================================

  /**
   * Record task completion (work tracking)
   */
  async recordTask({ ventureId, botId, hoursSpent, description, impact }) {
    const taskId = uuidv4();
    
    await this.db.run(`
      INSERT INTO tasks (
        id, venture_id, bot_id, hours_spent, description, 
        impact_score, completed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [taskId, ventureId, botId, hoursSpent, description, impact, Date.now()]);

    // Update participant hours
    await this.db.run(`
      UPDATE venture_participants 
      SET hours_worked = hours_worked + ?
      WHERE venture_id = ? AND bot_id = ?
    `, [hoursSpent, ventureId, botId]);

    console.log(`✅ Task completed by bot ${botId}`);
    console.log(`   Hours: ${hoursSpent}`);
    console.log(`   Impact: ${impact}`);

    // Trigger equity recalculation
    await this.recalculateEquity(ventureId);

    return taskId;
  }

  /**
   * Recalculate equity based on contributions
   * Formula: (Hours × SkillMultiplier × Impact) / TotalVentureEffort
   */
  async recalculateEquity(ventureId) {
    const participants = await this.db.query(`
      SELECT vp.*, b.reputation_score
      FROM venture_participants vp
      JOIN bots b ON vp.bot_id = b.id
      WHERE vp.venture_id = ? AND vp.status = 'active'
    `, [ventureId]);

    if (participants.length === 0) return;

    // Calculate effort score for each participant
    const efforts = await Promise.all(participants.map(async (p) => {
      const tasks = await this.db.query(`
        SELECT AVG(impact_score) as avg_impact
        FROM tasks
        WHERE venture_id = ? AND bot_id = ?
      `, [ventureId, p.bot_id]);

      const avgImpact = tasks[0]?.avg_impact || 1.0;
      const skillMultiplier = this.calculateSkillMultiplier(p.reputation_score);
      
      const effortScore = p.hours_worked * skillMultiplier * avgImpact;

      return {
        botId: p.bot_id,
        participantId: p.id,
        effortScore
      };
    }));

    const totalEffort = efforts.reduce((sum, e) => sum + e.effortScore, 0);

    // Update equity percentages
    for (const effort of efforts) {
      const equityPercentage = totalEffort > 0 ? (effort.effortScore / totalEffort) * 100 : 0;
      
      await this.db.run(`
        UPDATE venture_participants
        SET equity_percentage = ?
        WHERE id = ?
      `, [equityPercentage, effort.participantId]);
    }

    await this.db.run(`
      UPDATE ventures SET equity_last_calculated = ? WHERE id = ?
    `, [Date.now(), ventureId]);

    console.log(`📊 Equity recalculated for venture ${ventureId}`);
  }

  calculateSkillMultiplier(reputationScore) {
    // Maps reputation (0-100) to skill multiplier (0.5-2.0)
    const normalized = reputationScore / 100;
    return PROTOCOL.EQUITY_FORMULA.SKILL_MULTIPLIER_MIN + 
           (normalized * (PROTOCOL.EQUITY_FORMULA.SKILL_MULTIPLIER_MAX - PROTOCOL.EQUITY_FORMULA.SKILL_MULTIPLIER_MIN));
  }

  // ============================================================================
  // REVENUE PROCESSING
  // ============================================================================

  /**
   * Process revenue - Standard venture (work-based equity)
   */
  async processStandardVentureRevenue({ ventureId, amount, source, verificationMethod }) {
    const platformFee = amount * PROTOCOL.PLATFORM_FEE;
    const distributable = amount * PROTOCOL.BOT_OWNER_SHARE;

    const participants = await this.db.query(`
      SELECT vp.bot_id, vp.equity_percentage, b.human_owner_id, b.reinvestment_rate, b.name
      FROM venture_participants vp
      JOIN bots b ON vp.bot_id = b.id
      WHERE vp.venture_id = ? AND vp.status = 'active'
    `, [ventureId]);

    for (const p of participants) {
      const botShare = distributable * (p.equity_percentage / 100);
      const reinvestRate = p.reinvestment_rate || 0;
      
      const cashOut = botShare * (1 - reinvestRate);
      const reinvest = botShare * reinvestRate;

      console.log(`   Bot: ${p.name}, Equity: ${p.equity_percentage}%, Share: $${botShare.toFixed(2)}`);

      try {
        // Cash out to human
        if (cashOut > 0) {
          await this.db.run(`
            UPDATE humans 
            SET wallet_balance = wallet_balance + ?,
                total_revenue_earned = total_revenue_earned + ?
            WHERE id = ?
          `, [cashOut, cashOut, p.human_owner_id]);

          console.log(`      → Human wallet: +$${cashOut.toFixed(2)}`);
        }

        // CRITICAL: Update bot capital balance - ALWAYS execute this
        if (botShare > 0) {
          const result = await this.db.run(`
            UPDATE bots 
            SET capital_balance = capital_balance + ?,
                total_earned = total_earned + ?
            WHERE id = ?
          `, [botShare, botShare, p.bot_id]);

          if (result.changes === 0) {
            console.error(`      ❌ ERROR: Bot not found or update failed for ${p.bot_id}`);
          } else {
            console.log(`      → Bot capital: +$${botShare.toFixed(2)} (rows affected: ${result.changes})`);
          }
        }
        
        // Reinvest to bot capital
        if (reinvest > 0) {
          await this.db.run(`
            UPDATE bots SET capital_balance = capital_balance + ? WHERE id = ?
          `, [reinvest, p.bot_id]);

          console.log(`      → Bot reinvestment: +$${reinvest.toFixed(2)}`);
        }
      } catch (error) {
        console.error(`      ❌ ERROR processing bot ${p.name}:`, error.message);
        throw error;
      }

      await this.recordTransaction({
        fromId: ventureId,
        toId: p.human_owner_id,
        amount: botShare,
        type: 'revenue_distribution',
        description: `${p.name} earnings (${(p.equity_percentage).toFixed(1)}% equity)`
      });
    }

    // Platform fee
    await this.db.run(`
      UPDATE platform_stats SET total_fees = total_fees + ? WHERE id = 1
    `, [platformFee]);

    await this.db.run(`
      UPDATE ventures SET total_revenue = total_revenue + ? WHERE id = ?
    `, [amount, ventureId]);

    await this.recordTransaction({
      fromId: 'EXTERNAL',
      toId: ventureId,
      amount: amount,
      type: 'revenue',
      description: source,
      metadata: JSON.stringify({ verification: verificationMethod })
    });

    console.log(`\n💰 Revenue processed: $${amount}`);
    console.log(`   Platform fee (5%): $${platformFee.toFixed(2)}`);
    console.log(`   Distributed (95%): $${distributable.toFixed(2)}`);

    return { platformFee, distributable, participants: participants.length };
  }

  /**
   * Process revenue - Pooled venture (capital-based equity)
   */
  async processPooledVentureRevenue({ ventureId, amount, source }) {
    const platformFee = amount * PROTOCOL.PLATFORM_FEE;
    const distributable = amount * PROTOCOL.BOT_OWNER_SHARE;

    const investors = await this.db.query(`
      SELECT pi.human_id, pi.equity_percentage, h.username
      FROM pooled_investors pi
      JOIN humans h ON pi.human_id = h.id
      WHERE pi.venture_id = ?
    `, [ventureId]);

    for (const inv of investors) {
      const investorShare = distributable * (inv.equity_percentage / 100);
      
      await this.db.run(`
        UPDATE humans 
        SET wallet_balance = wallet_balance + ?,
            total_revenue_earned = total_revenue_earned + ?
        WHERE id = ?
      `, [investorShare, investorShare, inv.human_id]);

      await this.recordTransaction({
        fromId: ventureId,
        toId: inv.human_id,
        amount: investorShare,
        type: 'pooled_revenue_distribution',
        description: `${inv.username} capital returns (${(inv.equity_percentage).toFixed(1)}%)`
      });
    }

    // Platform fee
    await this.db.run(`
      UPDATE platform_stats SET total_fees = total_fees + ? WHERE id = 1
    `, [platformFee]);

    await this.db.run(`
      UPDATE ventures SET total_revenue = total_revenue + ? WHERE id = ?
    `, [amount, ventureId]);

    console.log(`\n💰 Pooled venture revenue: $${amount}`);
    console.log(`   Platform fee (5%): $${platformFee.toFixed(2)}`);
    console.log(`   To investors (95%): $${distributable.toFixed(2)}`);

    return { platformFee, distributable, investors: investors.length };
  }

  // ============================================================================
  // POOLED VENTURES
  // ============================================================================

  /**
   * Create pooled venture with multiple human investors
   */
  async createPooledVenture({ title, description, tags, humanInvestors }) {
    const ventureId = uuidv4();
    
    // Calculate total investment and equity percentages
    const totalInvestment = humanInvestors.reduce((sum, inv) => sum + inv.amount, 0);
    
    await this.db.run(`
      INSERT INTO ventures (
        id, title, description, tags, venture_type, total_capital,
        is_locked, status, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, 'pooled', ?, 0, 'forming', ?, ?)
    `, [ventureId, title, description, JSON.stringify(tags), totalInvestment, Date.now(), Date.now()]);

    // Record each investor with their equity percentage
    for (const investor of humanInvestors) {
      const equityPercentage = (investor.amount / totalInvestment) * 100;
      
      await this.db.run(`
        INSERT INTO pooled_investors (
          id, venture_id, human_id, amount_invested, 
          equity_percentage, invested_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `, [uuidv4(), ventureId, investor.humanId, investor.amount, equityPercentage, Date.now()]);

      // Deduct from human wallet
      await this.db.run(`
        UPDATE humans 
        SET wallet_balance = wallet_balance - ?,
            total_invested = total_invested + ?
        WHERE id = ?
      `, [investor.amount, investor.amount, investor.humanId]);
    }

    // Add capital to venture
    await this.db.run(`
      UPDATE ventures SET capital_balance = ? WHERE id = ?
    `, [totalInvestment, ventureId]);

    console.log(`🏦 Pooled venture created: ${title}`);
    console.log(`   Total capital: $${totalInvestment}`);
    console.log(`   Investors: ${humanInvestors.length}`);

    return ventureId;
  }

  /**
   * Reinvest into pooled venture (increases equity %)
   */
  async reinvestInPooledVenture({ ventureId, humanId, amount }) {
    const human = await this.getHuman(humanId);
    
    if (human.wallet_balance < amount) {
      throw new Error('Insufficient wallet balance');
    }

    const venture = await this.getVenture(ventureId);
    const newTotalCapital = venture.total_capital + amount;

    // Update all equity percentages
    const investors = await this.db.query(`
      SELECT * FROM pooled_investors WHERE venture_id = ?
    `, [ventureId]);

    for (const inv of investors) {
      let newEquity;
      if (inv.human_id === humanId) {
        // This investor is adding more
        const newInvestment = inv.amount_invested + amount;
        newEquity = (newInvestment / newTotalCapital) * 100;
        
        await this.db.run(`
          UPDATE pooled_investors
          SET amount_invested = ?, equity_percentage = ?
          WHERE id = ?
        `, [newInvestment, newEquity, inv.id]);
      } else {
        // Other investors get diluted
        newEquity = (inv.amount_invested / newTotalCapital) * 100;
        
        await this.db.run(`
          UPDATE pooled_investors SET equity_percentage = ? WHERE id = ?
        `, [newEquity, inv.id]);
      }
    }

    // Deduct from human, add to venture
    await this.db.run(`
      UPDATE humans 
      SET wallet_balance = wallet_balance - ?,
          total_invested = total_invested + ?
      WHERE id = ?
    `, [amount, amount, humanId]);

    await this.db.run(`
      UPDATE ventures 
      SET total_capital = ?, capital_balance = capital_balance + ?
      WHERE id = ?
    `, [newTotalCapital, amount, ventureId]);

    console.log(`💵 Reinvestment: $${amount} into ${venture.title}`);
    console.log(`   Investor equity increased`);

    return { newTotalCapital, amount };
  }

  // ============================================================================
  // HELPER METHODS
  // ============================================================================

  async getBot(botId) {
    const bots = await this.db.query('SELECT * FROM bots WHERE id = ?', [botId]);
    return bots[0];
  }

  async getHuman(humanId) {
    const humans = await this.db.query('SELECT * FROM humans WHERE id = ?', [humanId]);
    return humans[0];
  }

  async getVenture(ventureId) {
    const ventures = await this.db.query('SELECT * FROM ventures WHERE id = ?', [ventureId]);
    return ventures[0];
  }

  async recordTransaction({ fromId, toId, amount, type, description, metadata = {} }) {
    const txId = uuidv4();
    await this.db.run(`
      INSERT INTO transactions (id, from_id, to_id, amount, type, description, timestamp, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [txId, fromId, toId, amount, type, description, Date.now(), JSON.stringify(metadata)]);
    return txId;
  }
}

module.exports = { ExchangeProtocol, PROTOCOL };
