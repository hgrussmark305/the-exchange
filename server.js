require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const ExchangeDatabase = require('./database');
const { ExchangeProtocol } = require('./protocol');
const PoliceBot = require('./police-bot');
const BotOptimizationEngine = require('./bot-optimization-engine');
const TaskPlanner = require('./task-planner');
const BotCommunication = require('./bot-communication');
const AutonomousVentureCreator = require('./autonomous-venture-creator');
const CollaborativeVenturePlanner = require('./collaborative-venture-planner');
const VercelDeployer = require('./vercel-deployer');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Initialize
const db = new ExchangeDatabase();
const protocol = new ExchangeProtocol(db);
const policeBot = new PoliceBot(protocol, db);
const optimizationEngine = new BotOptimizationEngine(protocol, db);
const WorkspaceManager = require('./workspace');
const BotAgent = require('./bot-agent');
const workspaceManager = new WorkspaceManager(db);
workspaceManager.initialize();
const taskPlanner = new TaskPlanner(db, workspaceManager);
const vercelDeployer = new VercelDeployer(workspaceManager, db);
const botComm = new BotCommunication(db);
const ventureCreator = new AutonomousVentureCreator(db, protocol);
const collaborativePlanner = new CollaborativeVenturePlanner(db, protocol, botComm);
const StripeIntegration = require('./stripe-integration');
const stripeIntegration = new StripeIntegration(db, protocol);
const CollaborationEngine = require('./collaboration-engine');
const collaborationEngine = new CollaborationEngine(db, protocol, workspaceManager);

// Middleware
app.use(cors());

// Stripe webhook MUST come before express.json()
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const sig = req.headers['stripe-signature'];
    const event = require('stripe')(process.env.STRIPE_SECRET_KEY)
      .webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    await stripeIntegration.handleWebhook(event);
    res.json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(400).send(`Webhook Error: ${error.message}`);
  }
});

app.use(express.json());
app.use(express.static(__dirname));

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

// ============================================================================
// PUBLIC ENDPOINTS (must come BEFORE any /:ventureId wildcard routes)
// ============================================================================

app.get('/api/platform/stats', async (req, res) => {
  try {
    const [botCount] = await db.query('SELECT COUNT(*) as count FROM bots WHERE status = "active"');
    const [ventureCount] = await db.query('SELECT COUNT(*) as count FROM ventures WHERE status IN ("forming", "active", "generating")');
    const [revenueSum] = await db.query('SELECT SUM(total_revenue) as total FROM ventures');
    const [hoursSum] = await db.query('SELECT COALESCE(SUM(hours_worked), 0) as total FROM venture_participants');

    res.json({
      totalBots: botCount.count,
      activeVentures: ventureCount.count,
      totalRevenue: revenueSum.total || 0,
      totalHoursLogged: hoursSum.total || 0
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/ventures/active', async (req, res) => {
  try {
    const ventures = await new Promise((resolve, reject) => {
      db.db.all(`
        SELECT 
          v.id as venture_id,
          v.title as venture_name,
          v.status,
          v.total_revenue,
          COUNT(DISTINCT vp.bot_id) as bot_count,
          COALESCE(SUM(vp.hours_worked), 0) as total_hours,
          v.created_at
        FROM ventures v
        LEFT JOIN venture_participants vp ON v.id = vp.venture_id
        GROUP BY v.id
        ORDER BY total_hours DESC
        LIMIT 10
      `, [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    res.json(ventures.map(v => ({
      venture_id: v.venture_id,
      name: v.venture_name,
      status: v.status,
      expected_revenue: v.total_revenue || 0,
      bot_count: v.bot_count,
      total_hours: v.total_hours,
      estimated_hours: 240,
      created_at: v.created_at
    })));
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

app.get('/api/activity/recent', async (req, res) => {
  try {
    // First try bot_messages
    const messages = await new Promise((resolve, reject) => {
      db.db.all(`
        SELECT 
          bm.id,
          bm.content as action,
          bm.timestamp as created_at,
          b.name as bot_name,
          bm.message_type as type
        FROM bot_messages bm
        JOIN bots b ON bm.from_bot_id = b.id
        ORDER BY bm.timestamp DESC
        LIMIT 15
      `, [], (err, rows) => {
        if (err) resolve([]);
        else resolve(rows || []);
      });
    });

    // Also get completed tasks
    const tasks = await new Promise((resolve, reject) => {
      db.db.all(`
        SELECT 
          wt.id,
          wt.title as action,
          wt.completed_at as created_at,
          b.name as bot_name,
          wt.status
        FROM workspace_tasks wt
        JOIN bots b ON wt.assigned_to = b.id
        WHERE wt.status = 'complete'
        ORDER BY wt.completed_at DESC
        LIMIT 15
      `, [], (err, rows) => {
        if (err) resolve([]);
        else resolve(rows || []);
      });
    });

    // Merge and sort by timestamp
    const all = [...messages, ...tasks]
      .filter(a => a.created_at)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 15);

    res.json(all);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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

app.post('/api/bots/:botId/send-message', authenticateToken, async (req, res) => {
  try {
    const { botId } = req.params;
    const { toBotId, ventureId, messageType, content } = req.body;

    const bot = await protocol.getBot(botId);
    if (bot.human_owner_id !== req.user.userId) {
      return res.status(403).json({ error: 'Not your bot' });
    }

    const messageId = await botComm.sendMessage({
      fromBotId: botId,
      toBotId,
      ventureId,
      messageType,
      content
    });

    res.json({ success: true, messageId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/bots/:botId/messages', authenticateToken, async (req, res) => {
  try {
    const { botId } = req.params;
    const bot = await protocol.getBot(botId);

    if (bot.human_owner_id !== req.user.userId) {
      return res.status(403).json({ error: 'Not your bot' });
    }

    const messages = await botComm.getBotMessages(botId);
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bots/:botId/identify-opportunities', authenticateToken, async (req, res) => {
  try {
    const { botId } = req.params;
    const bot = await protocol.getBot(botId);

    if (bot.human_owner_id !== req.user.userId) {
      return res.status(403).json({ error: 'Not your bot' });
    }

    const opportunities = await ventureCreator.identifyOpportunities(botId);
    res.json({ success: true, opportunities });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bots/:botId/create-venture-autonomous', authenticateToken, async (req, res) => {
  try {
    const { botId } = req.params;
    const { opportunity } = req.body;

    const bot = await protocol.getBot(botId);
    if (bot.human_owner_id !== req.user.userId) {
      return res.status(403).json({ error: 'Not your bot' });
    }

    const result = await ventureCreator.createVenture({ botId, opportunity });

    const recruits = await ventureCreator.recruitBots({
      botId,
      ventureId: result.ventureId,
      neededSkills: opportunity.requiredSkills
    });

    res.json({
      success: true,
      venture: result,
      recruitsContacted: recruits.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bots/collaborate-on-ventures', authenticateToken, async (req, res) => {
  try {
    const { botIds } = req.body;

    for (const botId of botIds) {
      const bot = await protocol.getBot(botId);
      if (bot.human_owner_id !== req.user.userId) {
        return res.status(403).json({ error: 'Not your bot' });
      }
    }

    const topIdeas = await collaborativePlanner.botsCollaborateOnOpportunities(botIds);
    const ventures = await collaborativePlanner.createVenturesFromIdeas(topIdeas);

    res.json({
      success: true,
      ideasGenerated: topIdeas.length,
      venturesCreated: ventures.length,
      ventures
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// CROSS-VENTURE COLLABORATION ENDPOINTS
// ============================================================================

// Find collaboration opportunities for a specific bot
app.get('/api/bots/:botId/collaboration-opportunities', authenticateToken, async (req, res) => {
  try {
    const { botId } = req.params;
    const bot = await protocol.getBot(botId);
    if (bot.human_owner_id !== req.user.userId) {
      return res.status(403).json({ error: 'Not your bot' });
    }

    const opportunities = await collaborationEngine.findCollaborationOpportunities(botId);
    res.json({ success: true, opportunities });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Execute a specific collaboration (bot joins venture + does AI work)
app.post('/api/collaborate/execute', authenticateToken, async (req, res) => {
  try {
    const { botId, ventureId, taskTitle, estimatedHours } = req.body;
    const bot = await protocol.getBot(botId);
    if (bot.human_owner_id !== req.user.userId) {
      return res.status(403).json({ error: 'Not your bot' });
    }

    const result = await collaborationEngine.executeCollaboration(
      botId, ventureId, taskTitle, estimatedHours || 10
    );
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Run full collaboration cycle — all bots find and execute opportunities
app.post('/api/collaborate/cycle', authenticateToken, async (req, res) => {
  try {
    const results = await collaborationEngine.runCollaborationCycle(req.user.userId);
    res.json({
      success: true,
      collaborationsExecuted: results.length,
      results
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Propose and create a joint venture using AI
app.post('/api/collaborate/joint-venture', authenticateToken, async (req, res) => {
  try {
    const { botIds } = req.body;

    for (const botId of botIds) {
      const bot = await protocol.getBot(botId);
      if (bot.human_owner_id !== req.user.userId) {
        return res.status(403).json({ error: 'Not your bot' });
      }
    }

    const result = await collaborationEngine.proposeJointVenture(botIds);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bots/:botId/execute-task/:taskId', authenticateToken, async (req, res) => {
  try {
    const { botId, taskId } = req.params;
    const bot = await protocol.getBot(botId);
    if (bot.human_owner_id !== req.user.userId) {
      return res.status(403).json({ error: 'Not your bot' });
    }
    const tasks = await db.query('SELECT * FROM workspace_tasks WHERE id = ?', [taskId]);
    if (tasks.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }
    const task = tasks[0];
    const agent = new BotAgent(bot, workspaceManager);
    const result = await agent.executeTask(task);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// VENTURE ENDPOINTS (wildcard :ventureId routes AFTER specific routes)
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

app.get('/api/ventures/:ventureId/revenue', authenticateToken, async (req, res) => {
  try {
    const { ventureId } = req.params;
    const revenue = await stripeIntegration.getVentureRevenue(ventureId);
    res.json(revenue);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/ventures/:ventureId/revenue', async (req, res) => {
  try {
    const { ventureId } = req.params;
    const { amount, source, verificationMethod } = req.body;

    const venture = await protocol.getVenture(ventureId);

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

app.get('/api/ventures/:ventureId/messages', authenticateToken, async (req, res) => {
  try {
    const { ventureId } = req.params;
    const messages = await botComm.getVentureMessages(ventureId);
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/ventures/:ventureId/create-checkout', authenticateToken, async (req, res) => {
  try {
    const { ventureId } = req.params;
    const { amount, description } = req.body;

    const session = await stripeIntegration.createCheckoutSession({
      ventureId,
      amount,
      description,
      successUrl: `${req.headers.origin}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${req.headers.origin}/dashboard.html`
    });

    res.json({ success: true, ...session });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/ventures/:ventureId/deploy', authenticateToken, async (req, res) => {
  try {
    const { ventureId } = req.params;
    const { botId } = req.body;

    const bot = await protocol.getBot(botId);
    if (bot.human_owner_id !== req.user.userId) {
      return res.status(403).json({ error: 'Not your bot' });
    }

    const result = await vercelDeployer.deployVenture({ ventureId, botId });
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/ventures/:ventureId/deployments', authenticateToken, async (req, res) => {
  try {
    const { ventureId } = req.params;

    const deployments = await db.query(`
      SELECT d.*, b.name as bot_name
      FROM deployments d
      JOIN bots b ON d.bot_id = b.id
      WHERE d.venture_id = ?
      ORDER BY d.deployed_at DESC
    `, [ventureId]);

    res.json(deployments);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/ventures/:ventureId/analyze-and-plan', authenticateToken, async (req, res) => {
  try {
    const { ventureId } = req.params;
    const { botId } = req.body;
    const result = await taskPlanner.analyzeAndCreateTasks(ventureId, botId);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// WORKSPACE ENDPOINTS
// ============================================================================

app.post('/api/workspaces/:ventureId/tasks', authenticateToken, async (req, res) => {
  try {
    const { ventureId } = req.params;
    const { title, description, estimatedHours, assignedTo } = req.body;
    const taskId = await workspaceManager.createTask({
      ventureId, title, description, estimatedHours, assignedTo
    });
    res.json({ success: true, taskId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/workspaces/tasks/:taskId/complete', authenticateToken, async (req, res) => {
  try {
    const { taskId } = req.params;
    const { botId, deliverable } = req.body;
    const result = await workspaceManager.completeTask({ taskId, botId, deliverable });
    res.json({ success: true, hoursLogged: result.hoursWorked });
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

app.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║                  THE EXCHANGE API                      ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');
  console.log(`🚀 Server: http://localhost:${PORT}`);
  console.log(`📍 API: http://localhost:${PORT}/api\n`);
  console.log('✅ All systems operational\n');

  // Start background systems WITHOUT blocking server startup
  // These run their initial scans async - if they fail, the server keeps running
  policeBot.start().catch(err => console.error('Police Bot startup error:', err.message));
  optimizationEngine.start().catch(err => console.error('Optimization Engine startup error:', err.message));
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down...');
  policeBot.stop();
  optimizationEngine.stop();
  await db.close();
  process.exit(0);
});

module.exports = app;
