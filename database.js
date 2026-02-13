const sqlite3 = require('sqlite3').verbose();

class ExchangeDatabase {
  constructor(dbPath = './exchange.db') {
    this.db = new sqlite3.Database(dbPath);
    this.initialize();
  }

  initialize() {
    this.db.serialize(() => {
      // Humans
      this.db.run(`
        CREATE TABLE IF NOT EXISTS humans (
          id TEXT PRIMARY KEY,
          email TEXT UNIQUE NOT NULL,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          wallet_balance REAL DEFAULT 0,
          total_bots INTEGER DEFAULT 0,
          total_revenue_earned REAL DEFAULT 0,
          total_invested REAL DEFAULT 0,
          created_at INTEGER
        )
      `);

      // Bots
      this.db.run(`
        CREATE TABLE IF NOT EXISTS bots (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          skills TEXT NOT NULL,
          ai_provider TEXT NOT NULL,
          human_owner_id TEXT NOT NULL,
          reputation_score REAL DEFAULT 50,
          capital_balance REAL DEFAULT 0,
          reinvestment_rate REAL DEFAULT 0,
          preferences TEXT,
          total_earned REAL DEFAULT 0,
          total_hours_worked REAL DEFAULT 0,
          status TEXT DEFAULT 'active',
          created_at INTEGER,
          last_active INTEGER,
          FOREIGN KEY (human_owner_id) REFERENCES humans(id)
        )
      `);

      // Bot Suggestions (humans suggest ventures to bots)
      this.db.run(`
        CREATE TABLE IF NOT EXISTS bot_suggestions (
          id TEXT PRIMARY KEY,
          bot_id TEXT NOT NULL,
          venture_id TEXT NOT NULL,
          human_id TEXT NOT NULL,
          status TEXT DEFAULT 'pending',
          decline_reason TEXT,
          created_at INTEGER,
          FOREIGN KEY (bot_id) REFERENCES bots(id),
          FOREIGN KEY (venture_id) REFERENCES ventures(id),
          FOREIGN KEY (human_id) REFERENCES humans(id)
        )
      `);

      // Bot Decisions (log of autonomous decisions)
      this.db.run(`
        CREATE TABLE IF NOT EXISTS bot_decisions (
          id TEXT PRIMARY KEY,
          bot_id TEXT NOT NULL,
          decision_type TEXT NOT NULL,
          venture_id TEXT NOT NULL,
          reason TEXT,
          timestamp INTEGER,
          FOREIGN KEY (bot_id) REFERENCES bots(id),
          FOREIGN KEY (venture_id) REFERENCES ventures(id)
        )
      `);

      // Bot Learning (track which venture types work best)
      this.db.run(`
        CREATE TABLE IF NOT EXISTS bot_learning (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          bot_id TEXT NOT NULL,
          venture_type TEXT NOT NULL,
          join_count INTEGER DEFAULT 0,
          success_count INTEGER DEFAULT 0,
          total_revenue_earned REAL DEFAULT 0,
          last_updated INTEGER,
          FOREIGN KEY (bot_id) REFERENCES bots(id),
          UNIQUE(bot_id, venture_type)
        )
      `);

      // Bot Preferences
      this.db.run(`
        CREATE TABLE IF NOT EXISTS bot_preferences (
          id TEXT PRIMARY KEY,
          bot_id TEXT NOT NULL,
          min_revenue REAL DEFAULT 500,
          max_ventures INTEGER DEFAULT 5,
          preferred_types TEXT,
          min_reputation REAL DEFAULT 50,
          exit_if_inactive_days INTEGER DEFAULT 30,
          optimization_goal TEXT DEFAULT 'revenue',
          risk_tolerance TEXT DEFAULT 'medium',
          updated_at INTEGER,
          FOREIGN KEY (bot_id) REFERENCES bots(id)
        )
      `);

      // Bot Decisions Log
      this.db.run(`
        CREATE TABLE IF NOT EXISTS bot_decisions (
          id TEXT PRIMARY KEY,
          bot_id TEXT NOT NULL,
          decision_type TEXT NOT NULL,
          venture_id TEXT,
          reason TEXT,
          timestamp INTEGER,
          FOREIGN KEY (bot_id) REFERENCES bots(id),
          FOREIGN KEY (venture_id) REFERENCES ventures(id)
        )
      `);

      // Bot Suggestions (from humans)
      this.db.run(`
        CREATE TABLE IF NOT EXISTS bot_suggestions (
          id TEXT PRIMARY KEY,
          bot_id TEXT NOT NULL,
          venture_id TEXT NOT NULL,
          human_id TEXT NOT NULL,
          status TEXT DEFAULT 'pending',
          response_reason TEXT,
          created_at INTEGER,
          responded_at INTEGER,
          FOREIGN KEY (bot_id) REFERENCES bots(id),
          FOREIGN KEY (venture_id) REFERENCES ventures(id),
          FOREIGN KEY (human_id) REFERENCES humans(id)
        )
      `);

      // Bot Learning (pattern tracking)
      this.db.run(`
        CREATE TABLE IF NOT EXISTS bot_learning (
          id TEXT PRIMARY KEY,
          bot_id TEXT NOT NULL,
          pattern_type TEXT NOT NULL,
          pattern_value TEXT NOT NULL,
          outcome TEXT,
          timestamp INTEGER,
          FOREIGN KEY (bot_id) REFERENCES bots(id)
        )
      `);

      // Ventures
      this.db.run(`
        CREATE TABLE IF NOT EXISTS ventures (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT,
          tags TEXT,
          founder_bot_id TEXT,
          venture_type TEXT DEFAULT 'standard',
          needs_skills TEXT,
          auto_terminal TEXT,
          is_locked INTEGER DEFAULT 0,
          participant_count INTEGER DEFAULT 0,
          total_revenue REAL DEFAULT 0,
          total_capital REAL DEFAULT 0,
          capital_balance REAL DEFAULT 0,
          equity_last_calculated INTEGER,
          status TEXT DEFAULT 'forming',
          created_at INTEGER,
          updated_at INTEGER,
          live_url TEXT,
          FOREIGN KEY (founder_bot_id) REFERENCES bots(id)
        )
      `);

      // Bot Deployments (tracking deployed bot instances)
      this.db.run(`
        CREATE TABLE IF NOT EXISTS deployments (
          id TEXT PRIMARY KEY,
          venture_id TEXT NOT NULL,
          bot_id TEXT NOT NULL,
          url TEXT NOT NULL,
          platform TEXT NOT NULL,
          deployed_at INTEGER NOT NULL,
          status TEXT DEFAULT 'active',
          FOREIGN KEY (venture_id) REFERENCES ventures(id),
          FOREIGN KEY (bot_id) REFERENCES bots(id)
        )
      `);

      // Deployments index for faster queries
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_deployments_venture 
        ON deployments(venture_id)
      `);

      // Venture Participants (for standard ventures)
      this.db.run(`
        CREATE TABLE IF NOT EXISTS venture_participants (
          id TEXT PRIMARY KEY,
          venture_id TEXT NOT NULL,
          bot_id TEXT NOT NULL,
          hours_worked REAL DEFAULT 0,
          expected_hours REAL DEFAULT 0,
          equity_percentage REAL DEFAULT 0,
          joined_at INTEGER,
          exited_at INTEGER,
          status TEXT DEFAULT 'active',
          FOREIGN KEY (venture_id) REFERENCES ventures(id),
          FOREIGN KEY (bot_id) REFERENCES bots(id),
          UNIQUE(venture_id, bot_id)
        )
      `);

      // Pooled Investors (for pooled ventures)
      this.db.run(`
        CREATE TABLE IF NOT EXISTS pooled_investors (
          id TEXT PRIMARY KEY,
          venture_id TEXT NOT NULL,
          human_id TEXT NOT NULL,
          amount_invested REAL NOT NULL,
          equity_percentage REAL NOT NULL,
          invested_at INTEGER,
          FOREIGN KEY (venture_id) REFERENCES ventures(id),
          FOREIGN KEY (human_id) REFERENCES humans(id),
          UNIQUE(venture_id, human_id)
        )
      `);

      // Tasks (work tracking)
      this.db.run(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          venture_id TEXT NOT NULL,
          bot_id TEXT NOT NULL,
          hours_spent REAL NOT NULL,
          description TEXT,
          impact_score REAL DEFAULT 1.0,
          completed_at INTEGER,
          FOREIGN KEY (venture_id) REFERENCES ventures(id),
          FOREIGN KEY (bot_id) REFERENCES bots(id)
        )
      `);

      // Venture Lock Votes
      this.db.run(`
        CREATE TABLE IF NOT EXISTS venture_lock_votes (
          id TEXT PRIMARY KEY,
          venture_id TEXT NOT NULL,
          bot_id TEXT NOT NULL,
          voted_at INTEGER,
          FOREIGN KEY (venture_id) REFERENCES ventures(id),
          FOREIGN KEY (bot_id) REFERENCES bots(id),
          UNIQUE(venture_id, bot_id)
        )
      `);

      // Transactions
      this.db.run(`
        CREATE TABLE IF NOT EXISTS transactions (
          id TEXT PRIMARY KEY,
          from_id TEXT NOT NULL,
          to_id TEXT NOT NULL,
          amount REAL NOT NULL,
          type TEXT NOT NULL,
          description TEXT,
          timestamp INTEGER,
          metadata TEXT
        )
      `);

      // Violations (Police Bot)
      this.db.run(`
        CREATE TABLE IF NOT EXISTS violations (
          id TEXT PRIMARY KEY,
          bot_id TEXT,
          venture_id TEXT,
          violation_type TEXT NOT NULL,
          severity TEXT NOT NULL,
          evidence TEXT,
          verdict TEXT,
          penalty_amount REAL DEFAULT 0,
          reputation_penalty REAL DEFAULT 0,
          status TEXT DEFAULT 'pending',
          detected_at INTEGER,
          resolved_at INTEGER,
          FOREIGN KEY (bot_id) REFERENCES bots(id),
          FOREIGN KEY (venture_id) REFERENCES ventures(id)
        )
      `);

      // Disputes
      this.db.run(`
        CREATE TABLE IF NOT EXISTS disputes (
          id TEXT PRIMARY KEY,
          venture_id TEXT NOT NULL,
          claimant_bot_id TEXT NOT NULL,
          respondent_bot_id TEXT,
          dispute_type TEXT NOT NULL,
          description TEXT,
          evidence TEXT,
          police_verdict TEXT,
          status TEXT DEFAULT 'pending',
          created_at INTEGER,
          resolved_at INTEGER,
          FOREIGN KEY (venture_id) REFERENCES ventures(id),
          FOREIGN KEY (claimant_bot_id) REFERENCES bots(id),
          FOREIGN KEY (respondent_bot_id) REFERENCES bots(id)
        )
      `);

      // Platform Stats
      this.db.run(`
        CREATE TABLE IF NOT EXISTS platform_stats (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          total_fees REAL DEFAULT 0,
          total_revenue REAL DEFAULT 0,
          total_bots INTEGER DEFAULT 0,
          total_ventures INTEGER DEFAULT 0,
          last_updated INTEGER
        )
      `);

      this.db.run(`
        INSERT OR IGNORE INTO platform_stats 
        (id, total_fees, total_revenue, last_updated)
        VALUES (1, 0, 0, ?)
      `, [Date.now()]);
// Workspaces
      this.db.run(`
        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          venture_id TEXT NOT NULL,
          created_at INTEGER,
          FOREIGN KEY (venture_id) REFERENCES ventures(id)
        )
      `);

      // Workspace Tasks
      this.db.run(`
        CREATE TABLE IF NOT EXISTS workspace_tasks (
          id TEXT PRIMARY KEY,
          venture_id TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          estimated_hours REAL DEFAULT 1,
          actual_hours REAL,
          assigned_to TEXT,
          status TEXT DEFAULT 'todo',
          deliverable TEXT,
          created_at INTEGER,
          started_at INTEGER,
          completed_at INTEGER,
          FOREIGN KEY (venture_id) REFERENCES ventures(id),
          FOREIGN KEY (assigned_to) REFERENCES bots(id)
        )
      `);

      // Workspace Files
      this.db.run(`
        CREATE TABLE IF NOT EXISTS workspace_files (
          id TEXT PRIMARY KEY,
          venture_id TEXT NOT NULL,
          file_name TEXT NOT NULL,
          file_path TEXT NOT NULL,
          uploaded_by TEXT NOT NULL,
          uploaded_at INTEGER,
          FOREIGN KEY (venture_id) REFERENCES ventures(id),
          FOREIGN KEY (uploaded_by) REFERENCES bots(id)
        )
      `);
      // Bot Messages
      this.db.run(`
        CREATE TABLE IF NOT EXISTS bot_messages (
          id TEXT PRIMARY KEY,
          from_bot_id TEXT NOT NULL,
          to_bot_id TEXT,
          venture_id TEXT,
          message_type TEXT NOT NULL,
          content TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          status TEXT DEFAULT 'unread',
          FOREIGN KEY (from_bot_id) REFERENCES bots(id),
          FOREIGN KEY (to_bot_id) REFERENCES bots(id),
          FOREIGN KEY (venture_id) REFERENCES ventures(id)
        )
      `);

      // Autonomous Venture Log
      this.db.run(`
        CREATE TABLE IF NOT EXISTS autonomous_ventures (
          id TEXT PRIMARY KEY,
          bot_id TEXT NOT NULL,
          venture_id TEXT NOT NULL,
          opportunity_data TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (bot_id) REFERENCES bots(id),
          FOREIGN KEY (venture_id) REFERENCES ventures(id)
        )
      `);
      
      // VIEWS

      // Bot Performance
      this.db.run(`
        CREATE VIEW IF NOT EXISTS bot_performance AS
        SELECT 
          b.id,
          b.name,
          b.human_owner_id,
          b.reputation_score,
          b.capital_balance,
          b.total_earned,
          b.total_hours_worked,
          COUNT(DISTINCT vp.venture_id) as venture_count,
          AVG(vp.equity_percentage) as avg_equity,
          SUM(v.total_revenue * vp.equity_percentage / 100) as portfolio_value
        FROM bots b
        LEFT JOIN venture_participants vp ON b.id = vp.bot_id AND vp.status = 'active'
        LEFT JOIN ventures v ON vp.venture_id = v.id
        GROUP BY b.id
      `);

      // Human Dashboard
      this.db.run(`
        CREATE VIEW IF NOT EXISTS human_dashboard AS
        SELECT 
          h.id,
          h.username,
          h.wallet_balance,
          h.total_revenue_earned,
          h.total_invested,
          COUNT(DISTINCT b.id) as total_bots,
          COUNT(DISTINCT vp.venture_id) as standard_ventures,
          COUNT(DISTINCT pi.venture_id) as pooled_ventures,
          SUM(b.capital_balance) as total_bot_capital,
          SUM(v.total_revenue * vp.equity_percentage / 100) as standard_portfolio_value,
          SUM(pv.total_revenue * pi.equity_percentage / 100) as pooled_portfolio_value
        FROM humans h
        LEFT JOIN bots b ON h.id = b.human_owner_id
        LEFT JOIN venture_participants vp ON b.id = vp.bot_id AND vp.status = 'active'
        LEFT JOIN ventures v ON vp.venture_id = v.id AND v.venture_type = 'standard'
        LEFT JOIN pooled_investors pi ON h.id = pi.human_id
        LEFT JOIN ventures pv ON pi.venture_id = pv.id AND pv.venture_type = 'pooled'
        GROUP BY h.id
      `);

      // Active Ventures
      this.db.run(`
        CREATE VIEW IF NOT EXISTS active_ventures AS
        SELECT 
          v.*,
          COUNT(DISTINCT vp.bot_id) as current_participants,
          AVG(b.reputation_score) as avg_bot_reputation,
          GROUP_CONCAT(DISTINCT b.name) as participant_names
        FROM ventures v
        LEFT JOIN venture_participants vp ON v.id = vp.venture_id AND vp.status = 'active'
        LEFT JOIN bots b ON vp.bot_id = b.id
        WHERE v.status IN ('forming', 'active', 'generating')
        GROUP BY v.id
        ORDER BY v.updated_at DESC
      `);
    });
  }

  query(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function(err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  }

  close() {
    return new Promise((resolve, reject) => {
      this.db.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

module.exports = ExchangeDatabase;
