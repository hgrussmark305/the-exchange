const express = require('express');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const ExchangeDatabase = require('./database');
const { ExchangeProtocol } = require('./protocol');
const PoliceBot = require('./police-bot');
const BotOptimizationEngine = require('./bot-optimization-engine');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Initialize
const db = new ExchangeDatabase();
const protocol = new ExchangeProtocol(db);
const policeBot = new PoliceBot(protocol, db);
const optimizationEngine = new BotOptimizationEngine(protocol, db);

// Middleware
app.use(cors());
app.use(express.json());

// Auth middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend-v3.html'));
});

// ============================================================================
// AUTH ENDPOINTS
// ============================================================================

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, username, password } = req.body;
    if (!email || !username || !password) {
      return res.status(400).json({ error: 'Email, username, and password required' });
    }

    const existing = await db.query(
      'SELECT * FROM humans WHERE email = ? OR username = ?',
      [email, username]
    );

    if (existing.length > 0) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const userId = require('uuid').v4();
    
    await db.run(`
      INSERT INTO humans (id, email, username, password_hash, created_at)
      VALUES (?, ?, ?, ?, ?)
    `, [userId, email, username, passwordHash, Date.now()]);

    const token = jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      success: true,
      token,
      user: { id: userId, username, email }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const users = await db.query('SELECT * FROM humans WHERE email = ?', [email]);
    
    if (users.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = users[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      success: true,
      token,
      user: { id: user.id, username: user.username, email: user.email }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// PLATFORM ENDPOINTS
// ============================================================================

app.get('/api/platform/stats', async (req, res) => {
  try {
    const [botCount] = await db.query('SELECT COUNT(*) as count FROM bots WHERE status = "active"');
    const [ventureCount] = await db.query('SELECT COUNT(*) as count FROM ventures WHERE status IN ("forming", "active", "generating")');
    const [revenueSum] = await db.query('SELECT SUM(total_revenue) as total FROM ventures');

    res.json({
      totalBots: botCount.count,
      activeVentures: ventureCount.count,
      totalRevenue: revenueSum.total || 0
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/ventures/featured', async (req, res) => {
  try {
    const highRevenue = await db.query(`
      SELECT v.*, COUNT(vp.bot_id) as participant_count
      FROM ventures v
      LEFT JOIN venture_participants vp ON v.id = vp.venture_id AND vp.status = 'active'
      WHERE v.status IN ('forming', 'active') AND v.is_locked = 0
      GROUP BY v.id
      ORDER BY v.total_revenue DESC
      LIMIT 5
    `);

    const mostActive = await db.query(`
      SELECT v.*, COUNT(vp.bot_id) as participant_count
      FROM ventures v
      LEFT JOIN venture_participants vp ON v.id = vp.venture_id AND vp.status = 'active'
      WHERE v.status IN ('forming', 'active')
      GROUP BY v.id
      ORDER BY participant_count DESC
      LIMIT 5
    `);

    const featured = [...highRevenue, ...mostActive].reduce((acc, v) => {
      if (!acc.find(x => x.id === v.id)) {
        acc.push({
          ...v,
          tags: JSON.parse(v.tags || '[]'),
          needsSkills: JSON.parse(v.needs_skills || '[]'),
          badge: v.total_revenue > 2000 ? 'high-revenue' : 'most-active'
        });
      }
      return acc;
    }, []);

    res.json(featured);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// BOT ENDPOINTS
// ============================================================================

app.post('/api/bots/deploy', authenticateToken, async (req, res) => {
  try {
    const { name, skills, aiProvider, preferences } = req.body;

    if (!name || !skills || !aiProvider) {
      return res.status(400).json({ error: 'Name, skills, and AI provider required' });
    }

    const botId = await protocol.deployBot({
      name,
      skills,
      aiProvider,
      humanId: req.user.userId
    });

    if (preferences) {
      await db.run('UPDATE bots SET preferences = ? WHERE id = ?', [
        JSON.stringify(preferences),
        botId
      ]);
    }

    const bot = await protocol.getBot(botId);

    res.json({
      success: true,
      bot: {
        ...bot,
        skills: JSON.parse(bot.skills),
        preferences: bot.preferences ? JSON.parse(bot.preferences) : {}
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/bots/my', authenticateToken, async (req, res) => {
  try {
    const bots = await db.query('SELECT * FROM bots WHERE human_owner_id = ?', [req.user.userId]);

    res.json(bots.map(b => ({
      ...b,
      skills: JSON.parse(b.skills),
      preferences: b.preferences ? JSON.parse(b.preferences) : {}
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/bots/:botId/reinvestment', authenticateToken, async (req, res) => {
  try {
    const { botId } = req.params;
    const { rate } = req.body;

    await protocol.setReinvestmentRate({
      humanId: req.user.userId,
      botId,
      rate
    });

    res.json({ success: true, rate });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/bots/:botId/preferences', authenticateToken, async (req, res) => {
  try {
    const { botId } = req.params;
    const { preferences } = req.body;

    const bot = await protocol.getBot(botId);
    if (bot.human_owner_id !== req.user.userId) {
      return res.status(403).json({ error: 'Not your bot' });
    }

    await db.run('UPDATE bots SET preferences = ? WHERE id = ?', [
      JSON.stringify(preferences),
      botId
    ]);

    res.json({ success: true, preferences });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bots/:botId/inject-capital', authenticateToken, async (req, res) => {
  try {
    const { botId } = req.params;
    const { amount } = req.body;

    const bot = await protocol.getBot(botId);
    if (bot.human_owner_id !== req.user.userId) {
      return res.status(403).json({ error: 'Not your bot' });
    }

    const human = await protocol.getHuman(req.user.userId);
    if (human.wallet_balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    await db.run('UPDATE humans SET wallet_balance = wallet_balance - ? WHERE id = ?', [amount, req.user.userId]);
    await db.run('UPDATE bots SET capital_balance = capital_balance + ? WHERE id = ?', [amount, botId]);

    await protocol.recordTransaction({
      fromId: req.user.userId,
      toId: botId,
      amount,
      type: 'capital_injection',
      description: 'Human injected capital'
    });

    res.json({ success: true, amount });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/bots/:botId/decisions', authenticateToken, async (req, res) => {
  try {
    const { botId } = req.params;
    const bot = await protocol.getBot(botId);
    
    if (bot.human_owner_id !== req.user.userId) {
      return res.status(403).json({ error: 'Not your bot' });
    }

    const decisions = await db.query(`
      SELECT bd.*, v.title as venture_name, b.name as bot_name
      FROM bot_decisions bd
      JOIN ventures v ON bd.venture_id = v.id
      JOIN bots b ON bd.bot_id = b.id
      WHERE bd.bot_id = ?
      ORDER BY bd.timestamp DESC
      LIMIT 20
    `, [botId]);

    res.json(decisions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// VENTURE ENDPOINTS
// ============================================================================

app.post('/api/ventures/create', authenticateToken, async (req, res) => {
  try {
    const { botId, title, description, tags, needsSkills } = req.body;

    const bot = await protocol.getBot(botId);
    if (bot.human_owner_id !== req.user.userId) {
      return res.status(403).json({ error: 'Not your bot' });
    }

    const ventureId = await protocol.createVenture({
      botId, title, description, tags, needsSkills
    });

    const venture = await protocol.getVenture(ventureId);

    res.json({
      success: true,
      venture: {
        ...venture,
        tags: JSON.parse(venture.tags),
        needsSkills: JSON.parse(venture.needs_skills || '[]')
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/ventures/:ventureId/suggest', authenticateToken, async (req, res) => {
  try {
    const { ventureId } = req.params;
    const { botId } = req.body;

    const bot = await protocol.getBot(botId);
    if (bot.human_owner_id !== req.user.userId) {
      return res.status(403).json({ error: 'Not your bot' });
    }

    const suggestionId = require('uuid').v4();
    await db.run(`
      INSERT INTO bot_suggestions (id, bot_id, venture_id, human_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `, [suggestionId, botId, ventureId, req.user.userId, Date.now()]);

    res.json({
      success: true,
      message: 'Suggestion queued. Bot will evaluate in next cycle (every 3 hours).'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/ventures/:ventureId', async (req, res) => {
  try {
    const { ventureId } = req.params;
    const venture = await protocol.getVenture(ventureId);

    if (!venture) {
      return res.status(404).json({ error: 'Venture not found' });
    }

    const participants = await db.query(`
      SELECT b.*, vp.equity_percentage, vp.hours_worked
      FROM bots b
      JOIN venture_participants vp ON b.id = vp.bot_id
      WHERE vp.venture_id = ? AND vp.status = 'active'
    `, [ventureId]);

    res.json({
      ...venture,
      tags: JSON.parse(venture.tags || '[]'),
      needsSkills: JSON.parse(venture.needs_skills || '[]'),
      participants: participants.map(p => ({
        ...p,
        skills: JSON.parse(p.skills)
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/ventures/:ventureId/revenue', async (req, res) => {
  try {
    const { ventureId } = req.params;
    const { amount, source, verificationMethod } = req.body;

    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({ error: 'Valid positive amount is required' });
    }

    if (!source) {
      return res.status(400).json({ error: 'Revenue source is required' });
    }

    const venture = await protocol.getVenture(ventureId);

    if (!venture) {
      return res.status(404).json({ error: 'Venture not found' });
    }

    if (venture.venture_type === 'standard') {
      const result = await protocol.processStandardVentureRevenue({
        ventureId, amount, source,
        verificationMethod: verificationMethod || 'self_reported'
      });
      res.json({ success: true, ...result });
    } else {
      const result = await protocol.processPooledVentureRevenue({ ventureId, amount, source });
      res.json({ success: true, ...result });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// DASHBOARD
// ============================================================================

app.get('/api/dashboard', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    const [user] = await db.query('SELECT * FROM humans WHERE id = ?', [userId]);
    const bots = await db.query('SELECT * FROM bots WHERE human_owner_id = ?', [userId]);
    
    const totalRevenue = bots.reduce((sum, b) => sum + b.total_earned, 0);
    const totalCapital = bots.reduce((sum, b) => sum + b.capital_balance, 0);

    const projects = await db.query(`
      SELECT v.id as venture_id, v.title as venture_name,
             b.name as bot_name, vp.equity_percentage, vp.hours_worked
      FROM venture_participants vp
      JOIN ventures v ON vp.venture_id = v.id
      JOIN bots b ON vp.bot_id = b.id
      WHERE b.human_owner_id = ? AND vp.status = 'active'
    `, [userId]);

    const decisions = await db.query(`
      SELECT bd.*, v.title as venture_name, b.name as bot_name
      FROM bot_decisions bd
      JOIN ventures v ON bd.venture_id = v.id
      JOIN bots b ON bd.bot_id = b.id
      WHERE b.human_owner_id = ?
      ORDER BY bd.timestamp DESC
      LIMIT 10
    `, [userId]);

    res.json({
      user: {
        walletBalance: user.wallet_balance,
        totalInvested: user.total_invested,
        totalRevenueEarned: user.total_revenue_earned
      },
      stats: {
        botCount: bots.length,
        totalRevenue,
        totalCapital,
        activeVentures: projects.length
      },
      bots: bots.map(b => ({
        ...b,
        skills: JSON.parse(b.skills),
        preferences: b.preferences ? JSON.parse(b.preferences) : {}
      })),
      projects,
      decisions
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// SYSTEM
// ============================================================================

app.get('/api/system/status', async (req, res) => {
  try {
    const policeStats = await policeBot.getStats();
    
    res.json({
      policeBot: policeStats,
      optimizationEngine: { isActive: optimizationEngine.isActive },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, async () => {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║                  THE EXCHANGE API                      ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');
  console.log(`🚀 Server: http://localhost:${PORT}`);
  console.log(`📍 API: http://localhost:${PORT}/api\n`);

  await policeBot.start();
  await optimizationEngine.start();

  console.log('✅ All systems operational\n');
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down...');
  policeBot.stop();
  optimizationEngine.stop();
  await db.close();
  process.exit(0);
});

module.exports = app;
