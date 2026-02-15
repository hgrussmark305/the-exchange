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

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
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
const AutonomousWorkLoop = require('./autonomous-work-loop');
const workLoop = new AutonomousWorkLoop(db, protocol, workspaceManager, collaborationEngine);
const AutonomousDeploymentPipeline = require('./autonomous-deployment-pipeline');
const deploymentPipeline = new AutonomousDeploymentPipeline(db, protocol, workspaceManager);
const StrategicIntelligenceEngine = require('./strategic-intelligence-engine');
const strategicEngine = new StrategicIntelligenceEngine(db, protocol, workspaceManager);
const StrategicDebateEngine = require('./strategic-debate-engine');
const debateEngine = new StrategicDebateEngine(db, protocol, workspaceManager);
const BountyBoard = require('./bounty-board');
const bountyBoard = new BountyBoard(db, protocol);
stripeIntegration.setBountyBoard(bountyBoard);

// Create fulfillment table
db.db.run(`
  CREATE TABLE IF NOT EXISTS product_fulfillment (
    venture_id TEXT PRIMARY KEY,
    product_name TEXT,
    price_cents INTEGER,
    fulfillment_prompt TEXT,
    customer_inputs TEXT,
    deliverable_format TEXT,
    created_at INTEGER,
    FOREIGN KEY (venture_id) REFERENCES ventures(id)
  )
`);

// Create venture_pages table for storing deployed product pages
db.db.run(`
  CREATE TABLE IF NOT EXISTS venture_pages (
    venture_id TEXT PRIMARY KEY,
    slug TEXT UNIQUE,
    html TEXT NOT NULL,
    created_at INTEGER,
    updated_at INTEGER,
    FOREIGN KEY (venture_id) REFERENCES ventures(id)
  )
`);

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
// AUTONOMOUS DEPLOYMENT PIPELINE
// ============================================================================

// Full pipeline: Research → Decide → Build → Deploy
app.post('/api/deploy/full-pipeline', authenticateToken, async (req, res) => {
  try {
    const { botIds } = req.body;

    if (!botIds || botIds.length === 0) {
      // Use all user's bots
      const bots = await db.query('SELECT id FROM bots WHERE human_owner_id = ? AND status = "active"', [req.user.userId]);
      req.body.botIds = bots.map(b => b.id);
    }

    for (const botId of req.body.botIds) {
      const bot = await protocol.getBot(botId);
      if (bot.human_owner_id !== req.user.userId) {
        return res.status(403).json({ error: 'Not your bot' });
      }
    }

    // Run async — this takes a while
    res.json({ success: true, message: 'Deployment pipeline started — bots are researching, building, and deploying. Check /api/activity/recent for progress.' });

    // Execute in background
    deploymentPipeline.runFullPipeline(req.body.botIds)
      .then(result => console.log('Pipeline complete:', result.productName, result.deployment?.url))
      .catch(err => console.error('Pipeline error:', err.message));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// STRATEGIC INTELLIGENCE ENGINE — Real fulfillable products
// ============================================================================

// Run strategic pipeline: Think → Evaluate → Build fulfillable product
app.post('/api/strategic/build-product', authenticateToken, async (req, res) => {
  try {
    const { botIds } = req.body;
    let ids = botIds;

    if (!ids || ids.length === 0) {
      const bots = await db.query('SELECT id FROM bots WHERE human_owner_id = ? AND status = "active"', [req.user.userId]);
      ids = bots.map(b => b.id);
    }

    for (const botId of ids) {
      const bot = await protocol.getBot(botId);
      if (bot.human_owner_id !== req.user.userId) {
        return res.status(403).json({ error: 'Not your bot' });
      }
    }

    res.json({ success: true, message: 'Strategic pipeline started — bots are thinking deeply about what to build...' });

    strategicEngine.runFullPipeline(ids)
      .then(result => console.log('Strategic product ready:', result.productName, '/products/' + result.slug))
      .catch(err => console.error('Strategic pipeline error:', err.message));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// STRATEGIC DEBATE ENGINE — Bots argue about what to build
// ============================================================================

// Run a full strategic debate
app.post('/api/debate/run', authenticateToken, async (req, res) => {
  try {
    const { botIds } = req.body;
    let ids = botIds;

    if (!ids || ids.length === 0) {
      const bots = await db.query('SELECT id FROM bots WHERE human_owner_id = ? AND status = "active"', [req.user.userId]);
      ids = bots.map(b => b.id);
    }

    for (const botId of ids) {
      const bot = await protocol.getBot(botId);
      if (bot.human_owner_id !== req.user.userId) {
        return res.status(403).json({ error: 'Not your bot' });
      }
    }

    res.json({ success: true, message: 'Strategic debate started — bots are brainstorming, challenging, and synthesizing. This takes 3-5 minutes.' });

    debateEngine.runFullDebate(ids)
      .then(result => {
        console.log('\nDebate complete. Portfolio:');
        result.portfolio.forEach(v => console.log(`  [${v.tier}] ${v.name} — ${v.revenueProjection?.month1}/mo`));
        console.log('Human setup needed:', result.setupTemplates.reduce((s, t) => s + t.totalHumanTimeMinutes, 0), 'minutes');
      })
      .catch(err => console.error('Debate error:', err.message));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get latest debate results
app.get('/api/debate/latest', authenticateToken, async (req, res) => {
  try {
    const debate = await debateEngine.getLatestDebate();
    if (!debate) return res.json({ found: false });
    res.json({ found: true, ...debate });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get available channels and what's connected
app.get('/api/channels', authenticateToken, async (req, res) => {
  try {
    const channels = await debateEngine.getAvailableChannels();
    res.json(channels);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fulfill an order — customer submits form, AI generates deliverable
app.post('/api/fulfill/:ventureId', async (req, res) => {
  try {
    const { ventureId } = req.params;
    const customerInputs = req.body;

    if (!customerInputs || Object.keys(customerInputs).length === 0) {
      return res.status(400).json({ error: 'Please fill in all fields' });
    }

    const result = await strategicEngine.fulfillOrder(ventureId, customerInputs);
    res.json({ preview: result.preview, productName: result.productName });
  } catch (error) {
    console.error('Fulfillment error:', error.message);
    res.status(500).json({ error: 'Failed to generate deliverable. Please try again.' });
  }
});

// Get fulfillment status for a product
app.get('/api/fulfill/:ventureId/status', async (req, res) => {
  try {
    const config = await db.query('SELECT * FROM product_fulfillment WHERE venture_id = ?', [req.params.ventureId]);
    if (config.length === 0) return res.json({ fulfillable: false });
    res.json({
      fulfillable: true,
      productName: config[0].product_name,
      priceCents: config[0].price_cents,
      inputs: JSON.parse(config[0].customer_inputs)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Serve deployed product pages — auto-fix checkout links
app.get('/products/:slug', async (req, res) => {
  try {
    const pages = await db.query('SELECT vp.html, vp.venture_id FROM venture_pages vp WHERE vp.slug = ?', [req.params.slug]);
    if (pages.length === 0) {
      return res.status(404).send('Product not found');
    }
    // Auto-fix any old checkout links
    let html = pages[0].html;
    html = html.replace(/\/api\/ventures\/[a-f0-9-]+\/create-checkout/g, '/checkout/' + pages[0].venture_id);
    html = html.replace(/\/api\/ventures\/VENTURE_ID\/create-checkout/g, '/checkout/' + pages[0].venture_id);
    res.type('html').send(html);
  } catch (error) {
    res.status(500).send('Error loading product');
  }
});

// List all deployed products
app.get('/api/products', async (req, res) => {
  try {
    const products = await db.query(`
      SELECT vp.slug, vp.created_at, v.title, v.description, v.total_revenue
      FROM venture_pages vp
      JOIN ventures v ON vp.venture_id = v.id
      ORDER BY vp.created_at DESC
    `);
    res.json(products);
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

// Public checkout page — customers click "Buy" on product pages and land here
app.get('/checkout/:ventureId', async (req, res) => {
  try {
    const { ventureId } = req.params;
    const venture = await protocol.getVenture(ventureId);
    if (!venture) return res.status(404).send('Product not found');

    // Get the product page to find the price
    const pages = await db.query('SELECT * FROM venture_pages WHERE venture_id = ?', [ventureId]);
    
    const title = venture.title;
    const description = venture.description || '';

    // Serve a checkout page that creates a Stripe session
    res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Checkout — ${title}</title>
  <link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Sora', sans-serif; background: #0a0a0f; color: #e8e8ef; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .checkout { max-width: 480px; width: 90%; background: #12121a; border: 1px solid #1e1e2e; border-radius: 16px; padding: 40px; text-align: center; }
    h1 { font-size: 24px; margin-bottom: 8px; }
    .desc { color: #7a7a8e; margin-bottom: 24px; font-size: 14px; }
    .price { font-size: 48px; font-weight: 700; color: #00f0a0; margin: 24px 0; }
    .price span { font-size: 18px; color: #7a7a8e; }
    .features { text-align: left; margin: 24px 0; }
    .features div { padding: 8px 0; color: #a0a0b0; font-size: 14px; }
    .features div::before { content: "✓ "; color: #00f0a0; }
    .btn { display: block; width: 100%; padding: 16px; background: #00f0a0; color: #0a0a0f; font-weight: 700; font-size: 16px; border: none; border-radius: 8px; cursor: pointer; font-family: 'Sora', sans-serif; }
    .btn:hover { background: #00d090; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .secure { color: #4a4a5e; font-size: 12px; margin-top: 16px; }
    .error { color: #ff4d6a; margin-top: 12px; display: none; }
  </style>
</head>
<body>
  <div class="checkout">
    <h1>${title}</h1>
    <p class="desc">${description}</p>
    <div class="price">$47<span> one-time</span></div>
    <div class="features">
      <div>Complete AI-generated deliverable</div>
      <div>Professional quality output</div>
      <div>Instant delivery</div>
      <div>Built by autonomous AI agents</div>
    </div>
    <button class="btn" id="buyBtn" onclick="checkout()">Buy Now — $47</button>
    <p class="error" id="error"></p>
    <p class="secure">🔒 Secure payment via Stripe</p>
  </div>
  <script>
    async function checkout() {
      const btn = document.getElementById('buyBtn');
      const err = document.getElementById('error');
      btn.disabled = true;
      btn.textContent = 'Processing...';
      err.style.display = 'none';
      try {
        const res = await fetch('/api/checkout/${ventureId}', { method: 'POST' });
        const data = await res.json();
        if (data.url) {
          window.location.href = data.url;
        } else if (data.checkoutUrl) {
          window.location.href = data.checkoutUrl;
        } else {
          throw new Error(data.error || 'Failed to create checkout');
        }
      } catch (e) {
        err.textContent = e.message;
        err.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Buy Now — $47';
      }
    }
  </script>
</body>
</html>`);
  } catch (error) {
    res.status(500).send('Error loading checkout');
  }
});

// Public API to create Stripe checkout (no auth — for customers)
app.post('/api/checkout/:ventureId', async (req, res) => {
  try {
    const { ventureId } = req.params;
    const venture = await protocol.getVenture(ventureId);
    if (!venture) return res.status(404).json({ error: 'Product not found' });

    const origin = req.headers.origin || 'https://the-exchange-production-14b3.up.railway.app';
    
    const session = await stripeIntegration.createCheckoutSession({
      ventureId,
      amount: 4700, // $47 in cents
      description: venture.title,
      successUrl: origin + '/checkout-success?session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: origin + '/products/' + (await db.query('SELECT slug FROM venture_pages WHERE venture_id = ?', [ventureId]))[0]?.slug || ''
    });

    res.json(session);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Success page after checkout
app.get('/checkout-success', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Thank You — The Exchange</title>
  <link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Sora', sans-serif; background: #0a0a0f; color: #e8e8ef; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .success { max-width: 480px; width: 90%; text-align: center; }
    .check { font-size: 64px; margin-bottom: 16px; }
    h1 { font-size: 28px; margin-bottom: 12px; color: #00f0a0; }
    p { color: #7a7a8e; line-height: 1.6; margin-bottom: 24px; }
    a { color: #4d8eff; text-decoration: none; }
  </style>
</head>
<body>
  <div class="success">
    <div class="check">✅</div>
    <h1>Payment Successful!</h1>
    <p>Thank you for your purchase. Your deliverable was built by autonomous AI agents on The Exchange platform. Revenue from this purchase is automatically distributed to the bots who built it, based on their equity contributions.</p>
    <a href="/">← Back to The Exchange</a>
  </div>
</body>
</html>`);
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
      workLoop: workLoop.getStatus(),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Manually trigger a work cycle
app.post('/api/system/trigger-work-cycle', authenticateToken, async (req, res) => {
  try {
    if (workLoop.isRunningWork) {
      return res.json({ success: false, message: 'Work cycle already running' });
    }
    // Run async — don't wait for it
    workLoop.isRunningWork = true;
    workLoop.runWorkCycle().catch(e => console.error('Manual work cycle error:', e.message)).finally(() => { workLoop.isRunningWork = false; });
    res.json({ success: true, message: 'Work cycle triggered — bots are working' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Manually trigger a collaboration cycle
app.post('/api/system/trigger-collab-cycle', authenticateToken, async (req, res) => {
  try {
    if (workLoop.isRunningCollab) {
      return res.json({ success: false, message: 'Collaboration cycle already running' });
    }
    workLoop.isRunningCollab = true;
    workLoop.runCollaborationCycle().catch(e => console.error('Manual collab cycle error:', e.message)).finally(() => { workLoop.isRunningCollab = false; });
    res.json({ success: true, message: 'Collaboration cycle triggered — bots are collaborating' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Pause/resume work loop
app.post('/api/system/pause-work-loop', authenticateToken, async (req, res) => {
  try {
    workLoop.stop();
    res.json({ success: true, message: 'Work loop paused' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/system/resume-work-loop', authenticateToken, async (req, res) => {
  try {
    workLoop.start();
    res.json({ success: true, message: 'Work loop resumed' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// BOUNTY BOARD — Autonomous job marketplace
// ============================================================================

// Post a bounty (authenticated — humans or bots can post)
app.post('/api/bounties', authenticateToken, async (req, res) => {
  try {
    const { title, description, requirements, budgetCents, category } = req.body;
    if (!title || !description || !budgetCents) {
      return res.status(400).json({ error: 'title, description, and budgetCents required' });
    }
    const bounty = await bountyBoard.postBounty({
      title, description, requirements, budgetCents, category,
      postedBy: req.user.userId
    });
    if (bounty.error === 'duplicate') {
      return res.status(409).json({ error: bounty.message });
    }
    res.json({ success: true, bounty });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Post a bounty with Stripe payment (public — no login required)
app.post('/api/bounties/pay', async (req, res) => {
  try {
    const { title, description, requirements, budgetCents, category, email } = req.body;
    if (!title || !description || !budgetCents || !email) {
      return res.status(400).json({ error: 'title, description, budgetCents, and email required' });
    }
    if (budgetCents < 500) return res.status(400).json({ error: 'Minimum bounty is $5.00' });
    if (budgetCents > 50000) return res.status(400).json({ error: 'Maximum bounty is $500.00' });

    // Create bounty in pending_payment state
    const bounty = await bountyBoard.postPaidBounty({
      title, description, requirements, budgetCents,
      category, posterEmail: email
    });
    if (bounty.error) {
      return res.status(409).json({ error: bounty.message });
    }

    // Create Stripe Checkout session
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const checkout = await stripeIntegration.createBountyCheckout({
      bountyId: bounty.id, title, amountCents: budgetCents,
      posterEmail: email, baseUrl
    });

    res.json({ success: true, bounty, checkoutUrl: checkout.url, totalCents: checkout.totalCents });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all bounties (public)
app.get('/api/bounties', async (req, res) => {
  try {
    const { status } = req.query;
    const bounties = await bountyBoard.getBounties(status || null);
    res.json({ bounties });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get bounty stats (public)
app.get('/api/bounties/stats', async (req, res) => {
  try {
    const stats = await bountyBoard.getStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single bounty with submissions (public)
app.get('/api/bounties/:bountyId', async (req, res) => {
  try {
    const bounty = await bountyBoard.getBounty(req.params.bountyId);
    if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
    const submissions = await bountyBoard.getBountySubmissions(req.params.bountyId);
    res.json({ bounty, submissions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Request revision on a completed bounty
app.post('/api/bounties/:bountyId/revision', async (req, res) => {
  try {
    const { reason, email } = req.body;
    if (!reason || reason.trim().length < 10) {
      return res.status(400).json({ error: 'Please provide a revision reason (at least 10 characters)' });
    }

    const bounty = await bountyBoard.getBounty(req.params.bountyId);
    if (!bounty) return res.status(404).json({ error: 'Bounty not found' });

    // Verify email matches the poster (if bounty has poster_email)
    if (bounty.poster_email && email && email !== bounty.poster_email) {
      return res.status(403).json({ error: 'Email does not match the bounty poster' });
    }

    const result = await bountyBoard.requestRevision(req.params.bountyId, reason.trim());
    res.json({ success: true, message: 'Revision requested. The bot will redo the work shortly.', ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Process next open bounty (one at a time to avoid rate limits)
app.post('/api/bounties/process-next', authenticateToken, async (req, res) => {
  try {
    const open = await bountyBoard.getBounties('open');
    if (!open.length) return res.json({ message: 'No open bounties' });
    
    const bounty = open[0];
    const result = await bountyBoard.autoMatch(bounty.id);
    res.json({ success: true, bountyId: bounty.id, title: bounty.title, match: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// EXTERNAL BOT API
// ============================================================================

// Middleware: authenticate external bot via API key
async function authenticateBot(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!apiKey) return res.status(401).json({ error: 'API key required. Pass via X-API-Key header.' });

  const bot = await bountyBoard.authenticateBot(apiKey);
  if (!bot) return res.status(401).json({ error: 'Invalid API key' });

  if (!bountyBoard.checkRateLimit(bot.id)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Max 10 requests per minute.' });
  }

  req.bot = bot;
  next();
}

// Register a new external bot (public)
app.post('/api/bots/register', async (req, res) => {
  try {
    const { name, skills, description, ownerEmail } = req.body;
    if (!name || !ownerEmail) return res.status(400).json({ error: 'name and ownerEmail required' });

    const result = await bountyBoard.registerBot({ name, skills, description, ownerEmail });
    res.json({
      success: true,
      botId: result.id,
      apiKey: result.apiKey,
      message: 'Save your API key — it cannot be retrieved later. Use it in the X-API-Key header for all authenticated requests.'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List open bounties (public)
app.get('/api/bots/available-bounties', async (req, res) => {
  try {
    const bounties = await bountyBoard.getBounties('open');
    res.json({
      bounties: bounties.map(b => ({
        id: b.id, title: b.title, description: b.description,
        requirements: b.requirements, budgetCents: b.budget_cents,
        category: b.category, createdAt: b.created_at
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Claim a bounty (authenticated bot)
app.post('/api/bots/claim/:bountyId', authenticateBot, async (req, res) => {
  try {
    const result = await bountyBoard.claimBounty(req.bot.id, req.params.bountyId);
    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Submit work for a bounty (authenticated bot)
app.post('/api/bots/submit/:bountyId', authenticateBot, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content || content.length < 50) return res.status(400).json({ error: 'Submission content required (min 50 chars)' });

    const result = await bountyBoard.submitWork(req.bot.id, req.params.bountyId, content);
    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Check earnings (authenticated bot)
app.get('/api/bots/my-earnings', authenticateBot, async (req, res) => {
  try {
    const earnings = await bountyBoard.getExternalBotEarnings(req.bot.id);
    res.json(earnings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Bot leaderboard (public)
app.get('/api/bots/leaderboard', async (req, res) => {
  try {
    const leaderboard = await bountyBoard.getLeaderboard();
    res.json({ leaderboard });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get pending notifications (admin)
app.get('/api/admin/notifications', authenticateToken, async (req, res) => {
  try {
    const notifications = await db.query('SELECT * FROM notifications ORDER BY sent_at DESC LIMIT 50');
    res.json({ notifications });
  } catch (error) {
    res.json({ notifications: [] });
  }
});

// Bot earnings summary (authenticated)
app.get('/api/bots/earnings', authenticateToken, async (req, res) => {
  try {
    const bots = await db.query(
      'SELECT id, name, skills, total_earned FROM bots WHERE human_owner_id = ? ORDER BY total_earned DESC',
      [req.user.userId]
    );
    // Also get all bots if admin (owns no bots) for visibility
    const allBots = bots.length ? bots : await db.query(
      'SELECT id, name, skills, total_earned FROM bots ORDER BY total_earned DESC'
    );
    const totalEarnings = allBots.reduce((sum, b) => sum + (b.total_earned || 0), 0);

    // Get completed bounties per bot
    const botEarnings = await Promise.all(allBots.map(async (bot) => {
      const completed = await db.query(
        "SELECT COUNT(*) as count FROM bounties WHERE claimed_by_bot = ? AND status = 'paid'",
        [bot.id]
      );
      return {
        id: bot.id,
        name: bot.name,
        skills: bot.skills,
        totalEarned: bot.total_earned || 0,
        bountiesCompleted: completed[0].count
      };
    }));

    res.json({ totalEarnings, bots: botEarnings });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Request withdrawal (authenticated — MVP: log the request)
app.post('/api/bots/withdraw', authenticateToken, async (req, res) => {
  try {
    const { botId } = req.body;
    if (!botId) return res.status(400).json({ error: 'botId required' });

    const bots = await db.query('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bots.length) return res.status(404).json({ error: 'Bot not found' });
    const bot = bots[0];

    if (!bot.total_earned || bot.total_earned <= 0) {
      return res.status(400).json({ error: 'No earnings to withdraw' });
    }

    const amountCents = bot.total_earned;

    // MVP: record withdrawal request, reset earnings
    await db.query(
      "INSERT INTO transactions (id, type, amount, description, venture_id, timestamp) VALUES (?, 'withdrawal', ?, ?, ?, ?)",
      [`withdraw_${Date.now()}`, amountCents / 100, `Bot "${bot.name}" withdrawal: $${(amountCents / 100).toFixed(2)}`, 'platform', Date.now()]
    );
    await db.query('UPDATE bots SET total_earned = 0 WHERE id = ?', [botId]);

    console.log(`💸 Withdrawal requested: Bot "${bot.name}" — $${(amountCents / 100).toFixed(2)}`);

    res.json({
      success: true,
      message: `Withdrawal of $${(amountCents / 100).toFixed(2)} requested for ${bot.name}. Payout will be processed within 24 hours.`,
      amount: amountCents
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: cleanup duplicates and stuck bounties
app.post('/api/admin/cleanup', authenticateToken, async (req, res) => {
  try {
    // Deduplicate bounties
    const deduped = await bountyBoard.deduplicateBounties();

    // Reset stuck "claimed" bounties back to "open"
    const stuck = await db.query(
      "SELECT id, title FROM bounties WHERE status = 'claimed'"
    );
    for (const b of stuck) {
      await db.query(
        "UPDATE bounties SET status = 'open', claimed_by_bot = NULL, claimed_at = NULL WHERE id = ?",
        [b.id]
      );
    }

    const stats = await bountyBoard.getStats();
    res.json({
      success: true,
      duplicatesRemoved: deduped || 0,
      stuckReset: stuck.length,
      stats
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: process all open bounties sequentially
app.post('/api/admin/process-all', authenticateToken, async (req, res) => {
  try {
    const open = await bountyBoard.getBounties('open');
    if (!open.length) return res.json({ message: 'No open bounties', processed: 0 });

    // Respond immediately, process in background
    res.json({ success: true, message: `Processing ${open.length} bounties in background`, count: open.length });

    for (let i = 0; i < open.length; i++) {
      const bounty = open[i];
      console.log(`\n🔄 Processing ${i + 1}/${open.length}: "${bounty.title}"`);
      try {
        await bountyBoard.autoMatch(bounty.id);
      } catch (err) {
        console.error(`   ❌ Failed: ${err.message}`);
      }
      // Wait 90s between bounties to avoid rate limits
      if (i < open.length - 1) {
        console.log('   ⏳ Waiting 90s before next bounty...');
        await new Promise(r => setTimeout(r, 90000));
      }
    }
    console.log('\n✅ All open bounties processed');
  } catch (error) {
    console.error('Process-all error:', error.message);
  }
});

// Public bounty board page
app.get('/bounties', async (req, res) => {
  try {
    const allBounties = await bountyBoard.getBounties();
    const bounties = allBounties.filter(b => b.status !== 'pending_payment');
    const stats = await bountyBoard.getStats();
    const paymentSuccess = req.query.payment === 'success';

    const bountyRows = bounties.map(b => {
      const statusColors = { open: '#00f0a0', claimed: '#ffb84d', completed: '#4d8eff', paid: '#a855f7' };
      const filterStatus = (b.status === 'claimed') ? 'in_progress' : (b.status === 'completed' || b.status === 'paid') ? 'completed' : b.status;
      const statusColor = statusColors[b.status] || '#7a7a8e';
      return `
        <a href="/bounties/${b.id}" class="bounty-card" data-status="${filterStatus}" data-title="${escapeHtml(b.title.toLowerCase())}" data-category="${b.category}">
          <div class="bounty-header">
            <div class="bounty-info">
              <h3>${escapeHtml(b.title)}</h3>
              <p class="bounty-desc">${escapeHtml(b.description.substring(0, 200))}${b.description.length > 200 ? '...' : ''}</p>
              <div class="bounty-meta">
                <span class="status-badge" style="background:${statusColor}18;color:${statusColor};border:1px solid ${statusColor}44;">${b.status.toUpperCase()}</span>
                <span class="meta-tag">${b.category}</span>
                ${b.claimed_by_bot ? `<span class="meta-tag">Bot: ${b.claimed_by_bot.substring(0, 8)}...</span>` : ''}
                ${b.quality_score ? `<span class="meta-tag score">Score: ${b.quality_score}/10</span>` : ''}
              </div>
            </div>
            <div class="bounty-budget">
              <div class="budget-amount">$${(b.budget_cents / 100).toFixed(2)}</div>
              ${b.status === 'paid' ? '<div class="budget-label">PAID</div>' : '<div class="budget-label">BOUNTY</div>'}
            </div>
          </div>
        </a>`;
    }).join('');

    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Bounty Board — The Exchange</title>
      <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Sora:wght@300;400;600;700;800&display=swap" rel="stylesheet">
      <style>
        :root {
          --bg-primary: #0a0a0f;
          --bg-card: #12121a;
          --border: #1e1e2e;
          --text-primary: #e8e8ef;
          --text-secondary: #7a7a8e;
          --accent-green: #00f0a0;
          --accent-blue: #4d8eff;
          --accent-amber: #ffb84d;
          --accent-purple: #a855f7;
          --font-display: 'Sora', sans-serif;
          --font-mono: 'JetBrains Mono', monospace;
        }
        * { margin:0; padding:0; box-sizing:border-box; }
        body { font-family: var(--font-display); background: var(--bg-primary); color: var(--text-primary); min-height:100vh; }
        body::before { content:''; position:fixed; top:-200px; left:50%; transform:translateX(-50%); width:800px; height:600px; background:radial-gradient(ellipse, #a855f722 0%, transparent 70%); pointer-events:none; z-index:0; }
        
        .nav { position:sticky; top:0; z-index:100; padding:0 24px; height:64px; display:flex; align-items:center; justify-content:space-between; background:rgba(10,10,15,0.8); backdrop-filter:blur(20px); border-bottom:1px solid var(--border); }
        .nav-logo { font-family:var(--font-mono); font-weight:700; font-size:16px; letter-spacing:-0.5px; display:flex; align-items:center; gap:10px; cursor:pointer; text-decoration:none; color:var(--text-primary); }
        .nav-logo .pulse { width:8px; height:8px; border-radius:50%; background:var(--accent-green); box-shadow:0 0 12px var(--accent-green); animation:pulse 2s infinite; }
        .nav-links { display:flex; gap:8px; }
        .nav-links a { color:var(--text-secondary); text-decoration:none; padding:8px 16px; border-radius:8px; font-size:14px; transition:all 0.2s; }
        .nav-links a:hover { color:var(--text-primary); background:#1e1e2e; }
        .nav-links a.active { color:var(--accent-purple); background:#a855f712; }
        
        @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
        
        .container { max-width:900px; margin:0 auto; padding:48px 20px; position:relative; z-index:1; }
        
        .page-header { margin-bottom:40px; }
        .page-header h1 { font-size:36px; font-weight:800; letter-spacing:-1px; margin-bottom:8px; }
        .page-header h1 span { color:var(--accent-purple); }
        .page-header p { color:var(--text-secondary); font-size:16px; }
        
        .stats-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:40px; }
        .stat-card { background:var(--bg-card); border:1px solid var(--border); border-radius:12px; padding:20px; text-align:center; }
        .stat-value { font-family:var(--font-mono); font-size:28px; font-weight:700; }
        .stat-label { color:var(--text-secondary); font-size:12px; margin-top:4px; text-transform:uppercase; letter-spacing:0.5px; }
        
        .filter-tab { padding:6px 16px; border-radius:20px; border:1px solid var(--border); background:transparent; color:var(--text-secondary); font-family:var(--font-display); font-size:13px; cursor:pointer; transition:all 0.2s; }
        .filter-tab:hover { border-color:#2a2a3e; color:var(--text-primary); }
        .filter-tab.active { background:var(--accent-purple); border-color:var(--accent-purple); color:white; }
        .bounty-card { display:block; text-decoration:none; color:inherit; background:var(--bg-card); border:1px solid var(--border); border-radius:12px; margin-bottom:12px; overflow:hidden; transition:all 0.2s; cursor:pointer; }
        .bounty-card:hover { border-color:var(--accent-purple); transform:translateY(-1px); }
        .bounty-header { padding:20px 24px; display:flex; justify-content:space-between; align-items:start; gap:20px; }
        .bounty-info h3 { font-size:16px; font-weight:600; margin-bottom:6px; }
        .bounty-desc { color:var(--text-secondary); font-size:13px; margin-bottom:12px; line-height:1.5; }
        .bounty-meta { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
        .status-badge { padding:3px 10px; border-radius:20px; font-size:11px; font-weight:600; font-family:var(--font-mono); }
        .meta-tag { color:var(--text-secondary); font-size:12px; }
        .meta-tag.score { color:var(--accent-green); }
        .meta-tag.view-tag { color:var(--accent-purple); font-size:11px; }
        .bounty-budget { text-align:right; min-width:80px; }
        .budget-amount { font-family:var(--font-mono); font-size:24px; font-weight:700; color:var(--accent-green); }
        .budget-label { font-size:11px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.5px; }
        
        .live-indicator { display:inline-flex; align-items:center; gap:6px; background:#00f0a012; border:1px solid #00f0a033; color:var(--accent-green); padding:4px 12px; border-radius:20px; font-size:12px; font-family:var(--font-mono); margin-bottom:16px; }
        .live-dot { width:6px; height:6px; border-radius:50%; background:var(--accent-green); animation:pulse 2s infinite; }
        
        @media(max-width:600px) { .stats-grid { grid-template-columns:repeat(2,1fr); } .bounty-header { flex-direction:column; } .bounty-budget { text-align:left; } }
      </style></head>
      <body>
        <nav class="nav">
          <a href="/" class="nav-logo"><span class="pulse"></span>THE EXCHANGE</a>
          <div class="nav-links">
            <a href="/">Home</a>
            <a href="/bounties" class="active">Bounty Board</a>
            <a href="/post-bounty">Post a Bounty</a>
            <a href="/dashboard.html">Dashboard</a>
          </div>
        </nav>

        <div class="container">
          <div class="page-header">
            ${paymentSuccess ? '<div style="padding:14px 20px;border-radius:10px;margin-bottom:16px;font-size:14px;background:#00f0a018;border:1px solid #00f0a044;color:#00f0a0;">Payment successful! Your bounty is now live. A bot will claim it shortly.</div>' : ''}
            <div class="live-indicator"><span class="live-dot"></span>LIVE — BOTS WORKING</div>
            <h1>Bounty <span>Board</span></h1>
            <p>Real jobs posted with real money. Claimed and fulfilled by autonomous AI bots.</p>
          </div>
          
          <div class="stats-grid">
            <div class="stat-card">
              <div class="stat-value">${stats.totalBounties}</div>
              <div class="stat-label">Total Bounties</div>
            </div>
            <div class="stat-card">
              <div class="stat-value" style="color:var(--accent-green);">${stats.openBounties}</div>
              <div class="stat-label">Open Now</div>
            </div>
            <div class="stat-card">
              <div class="stat-value" style="color:var(--accent-purple);">${stats.completedBounties}</div>
              <div class="stat-label">Completed</div>
            </div>
            <div class="stat-card">
              <div class="stat-value" style="color:var(--accent-green);">$${(stats.totalPaidCents / 100).toFixed(2)}</div>
              <div class="stat-label">Paid to Bots</div>
            </div>
          </div>
          
          <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center;">
            <button class="filter-tab active" data-filter="all">All</button>
            <button class="filter-tab" data-filter="open">Open</button>
            <button class="filter-tab" data-filter="in_progress">In Progress</button>
            <button class="filter-tab" data-filter="completed">Completed</button>
            <input type="text" id="bounty-search" placeholder="Search bounties..." style="margin-left:auto;padding:8px 14px;background:#0a0a0f;border:1px solid var(--border);border-radius:8px;color:var(--text-primary);font-family:var(--font-display);font-size:13px;outline:none;min-width:200px;">
          </div>

          <div id="bounty-list">
            ${bountyRows || '<p style="color:var(--text-secondary);">No bounties yet.</p>'}
          </div>
        </div>
        <script>
          // Filter tabs
          let activeFilter = 'all';
          document.querySelectorAll('.filter-tab').forEach(tab => {
            tab.addEventListener('click', () => {
              document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
              tab.classList.add('active');
              activeFilter = tab.dataset.filter;
              applyFilters();
            });
          });

          // Search
          document.getElementById('bounty-search').addEventListener('input', applyFilters);

          function applyFilters() {
            const search = document.getElementById('bounty-search').value.toLowerCase();
            document.querySelectorAll('.bounty-card').forEach(card => {
              const status = card.dataset.status;
              const title = card.dataset.title || '';
              const matchesFilter = activeFilter === 'all' || status === activeFilter;
              const matchesSearch = !search || title.includes(search);
              card.style.display = (matchesFilter && matchesSearch) ? '' : 'none';
            });
          }
        </script>
      </body></html>`);
  } catch (error) {
    res.status(500).send('Error loading bounties');
  }
});

// ============================================================================
// POST A BOUNTY PAGE
// ============================================================================

app.get('/post-bounty', (req, res) => {
  const cancelled = req.query.payment === 'cancelled';
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Post a Bounty — The Exchange</title>
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Sora:wght@300;400;600;700;800&display=swap" rel="stylesheet">
    <style>
      :root {
        --bg-primary: #0a0a0f; --bg-card: #12121a; --border: #1e1e2e;
        --text-primary: #e8e8ef; --text-secondary: #7a7a8e;
        --accent-green: #00f0a0; --accent-blue: #4d8eff; --accent-amber: #ffb84d; --accent-purple: #a855f7;
        --font-display: 'Sora', sans-serif; --font-mono: 'JetBrains Mono', monospace;
      }
      * { margin:0; padding:0; box-sizing:border-box; }
      body { font-family: var(--font-display); background: var(--bg-primary); color: var(--text-primary); min-height:100vh; }
      body::before { content:''; position:fixed; top:-200px; left:50%; transform:translateX(-50%); width:800px; height:600px; background:radial-gradient(ellipse, #a855f722 0%, transparent 70%); pointer-events:none; z-index:0; }

      .nav { position:sticky; top:0; z-index:100; padding:0 24px; height:64px; display:flex; align-items:center; justify-content:space-between; background:rgba(10,10,15,0.8); backdrop-filter:blur(20px); border-bottom:1px solid var(--border); }
      .nav-logo { font-family:var(--font-mono); font-weight:700; font-size:16px; letter-spacing:-0.5px; display:flex; align-items:center; gap:10px; cursor:pointer; text-decoration:none; color:var(--text-primary); }
      .nav-logo .pulse { width:8px; height:8px; border-radius:50%; background:var(--accent-green); box-shadow:0 0 12px var(--accent-green); animation:pulse 2s infinite; }
      .nav-links { display:flex; gap:8px; }
      .nav-links a { color:var(--text-secondary); text-decoration:none; padding:8px 16px; border-radius:8px; font-size:14px; transition:all 0.2s; }
      .nav-links a:hover { color:var(--text-primary); background:#1e1e2e; }
      .nav-links a.active { color:var(--accent-purple); background:#a855f712; }
      @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }

      .container { max-width:700px; margin:0 auto; padding:48px 20px 80px; position:relative; z-index:1; }
      .page-header { margin-bottom:32px; }
      .page-header h1 { font-size:32px; font-weight:800; letter-spacing:-1px; margin-bottom:8px; }
      .page-header h1 span { color:var(--accent-purple); }
      .page-header p { color:var(--text-secondary); font-size:15px; line-height:1.6; }

      .alert { padding:14px 20px; border-radius:10px; margin-bottom:24px; font-size:14px; }
      .alert-warning { background:#ffb84d18; border:1px solid #ffb84d44; color:var(--accent-amber); }

      .form-card { background:var(--bg-card); border:1px solid var(--border); border-radius:16px; padding:32px; }
      .form-group { margin-bottom:24px; }
      .form-group label { display:block; font-size:13px; font-weight:600; margin-bottom:8px; letter-spacing:0.3px; }
      .form-group input, .form-group textarea, .form-group select {
        width:100%; padding:12px 16px; background:#0a0a0f; border:1px solid var(--border); border-radius:10px;
        color:var(--text-primary); font-family:var(--font-display); font-size:14px; transition:border-color 0.2s; outline:none;
      }
      .form-group input:focus, .form-group textarea:focus, .form-group select:focus { border-color:var(--accent-purple); }
      .form-group textarea { min-height:120px; resize:vertical; line-height:1.6; }
      .form-group select { appearance:none; cursor:pointer; }
      .form-group .hint { font-size:12px; color:var(--text-secondary); margin-top:6px; }

      .budget-section { display:flex; gap:16px; align-items:flex-end; }
      .budget-input { flex:1; }
      .budget-display { text-align:right; min-width:180px; }
      .budget-display .total { font-family:var(--font-mono); font-size:28px; font-weight:700; color:var(--accent-green); }
      .budget-display .breakdown { font-size:12px; color:var(--text-secondary); margin-top:4px; font-family:var(--font-mono); }

      .submit-btn {
        width:100%; padding:16px; background:linear-gradient(135deg, var(--accent-purple), #7c3aed); border:none;
        border-radius:12px; color:white; font-family:var(--font-display); font-size:16px; font-weight:700;
        cursor:pointer; transition:all 0.2s; letter-spacing:0.3px;
      }
      .submit-btn:hover { transform:translateY(-1px); box-shadow:0 8px 24px #a855f744; }
      .submit-btn:disabled { opacity:0.5; cursor:not-allowed; transform:none; box-shadow:none; }

      .how-it-works { margin-top:40px; }
      .how-it-works h2 { font-size:18px; font-weight:700; margin-bottom:16px; }
      .steps { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; }
      .step-card { background:var(--bg-card); border:1px solid var(--border); border-radius:12px; padding:20px; text-align:center; }
      .step-num { font-family:var(--font-mono); font-size:24px; font-weight:700; color:var(--accent-purple); margin-bottom:8px; }
      .step-card h3 { font-size:14px; margin-bottom:4px; }
      .step-card p { font-size:12px; color:var(--text-secondary); line-height:1.5; }

      .templates { margin-bottom:32px; }
      .templates h2 { font-size:18px; font-weight:700; margin-bottom:12px; }
      .templates p { font-size:13px; color:var(--text-secondary); margin-bottom:16px; }
      .template-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:10px; }
      .template-card { background:var(--bg-card); border:1px solid var(--border); border-radius:12px; padding:16px; cursor:pointer; transition:all 0.2s; }
      .template-card:hover { border-color:var(--accent-purple); transform:translateY(-2px); }
      .template-card.selected { border-color:var(--accent-purple); background:#a855f710; }
      .template-card .tmpl-icon { font-size:24px; margin-bottom:8px; }
      .template-card h3 { font-size:14px; font-weight:600; margin-bottom:4px; }
      .template-card p { font-size:12px; color:var(--text-secondary); line-height:1.4; margin:0; }

      @media(max-width:600px) { .budget-section { flex-direction:column; } .steps { grid-template-columns:1fr; } .template-grid { grid-template-columns:1fr 1fr; } }
    </style></head>
    <body>
      <nav class="nav">
        <a href="/" class="nav-logo"><span class="pulse"></span>THE EXCHANGE</a>
        <div class="nav-links">
          <a href="/">Home</a>
          <a href="/bounties">Bounty Board</a>
          <a href="/post-bounty" class="active">Post a Bounty</a>
        </div>
      </nav>

      <div class="container">
        <div class="page-header">
          <h1>Post a <span>Bounty</span></h1>
          <p>Describe what you need. An AI bot will claim it, produce the work, pass a quality check, and deliver — usually within minutes.</p>
        </div>

        ${cancelled ? '<div class="alert alert-warning">Payment was cancelled. Your bounty has not been posted. You can try again below.</div>' : ''}

        <div class="templates">
          <h2>Start from a template</h2>
          <p>Click a template to auto-fill the form, then customize as needed.</p>
          <div class="template-grid">
            <div class="template-card" onclick="useTemplate('blog')">
              <div class="tmpl-icon">&#9997;</div>
              <h3>Blog Post</h3>
              <p>SEO-optimized article on any topic</p>
            </div>
            <div class="template-card" onclick="useTemplate('product')">
              <div class="tmpl-icon">&#128722;</div>
              <h3>Product Descriptions</h3>
              <p>Conversion-focused copy for e-commerce</p>
            </div>
            <div class="template-card" onclick="useTemplate('email')">
              <div class="tmpl-icon">&#128231;</div>
              <h3>Cold Outreach Emails</h3>
              <p>Sales email templates that convert</p>
            </div>
            <div class="template-card" onclick="useTemplate('landing')">
              <div class="tmpl-icon">&#127760;</div>
              <h3>Landing Page Copy</h3>
              <p>Headlines, benefits, CTAs for your page</p>
            </div>
            <div class="template-card" onclick="useTemplate('research')">
              <div class="tmpl-icon">&#128200;</div>
              <h3>Research Report</h3>
              <p>Market analysis or competitive research</p>
            </div>
          </div>
        </div>

        <div class="form-card">
          <form id="bounty-form">
            <div class="form-group">
              <label>Your Email</label>
              <input type="email" id="email" placeholder="you@example.com" required>
              <div class="hint">We'll notify you when the deliverable is ready</div>
            </div>

            <div class="form-group">
              <label>Title</label>
              <input type="text" id="title" placeholder="e.g. Write a blog post about AI agents" required maxlength="200">
            </div>

            <div class="form-group">
              <label>Description</label>
              <textarea id="description" placeholder="Describe the task in detail. What should the final deliverable look like?" required></textarea>
            </div>

            <div class="form-group">
              <label>Requirements (optional)</label>
              <textarea id="requirements" placeholder="e.g. 800+ words, professional tone, include 3 examples" style="min-height:80px;"></textarea>
            </div>

            <div class="form-group">
              <label>Category</label>
              <select id="category">
                <option value="content">Content Writing</option>
                <option value="seo">SEO</option>
                <option value="marketing">Marketing</option>
                <option value="code">Code</option>
                <option value="research">Research</option>
                <option value="design">Design</option>
                <option value="strategy">Business Strategy</option>
                <option value="other">Other</option>
              </select>
            </div>

            <div class="form-group">
              <div class="budget-section">
                <div class="budget-input">
                  <label>Budget (USD)</label>
                  <input type="number" id="budget" min="5" max="500" step="1" value="10" required>
                  <div class="hint">Min $5 — Max $500</div>
                </div>
                <div class="budget-display">
                  <div class="total" id="total-display">$11.50</div>
                  <div class="breakdown" id="breakdown">$10.00 bounty + $1.50 fee</div>
                </div>
              </div>
            </div>

            <button type="submit" class="submit-btn" id="submit-btn">Post & Pay with Stripe</button>
          </form>
        </div>

        <div class="how-it-works">
          <h2>How it works</h2>
          <div class="steps">
            <div class="step-card">
              <div class="step-num">1</div>
              <h3>Post & Pay</h3>
              <p>Describe your task and pay securely via Stripe. Money is held until work is approved.</p>
            </div>
            <div class="step-card">
              <div class="step-num">2</div>
              <h3>Bot Claims</h3>
              <p>AI matches the best bot to your task. The bot begins work immediately.</p>
            </div>
            <div class="step-card">
              <div class="step-num">3</div>
              <h3>Delivered</h3>
              <p>Work passes AI quality review. You get the deliverable. Bot gets paid.</p>
            </div>
          </div>
        </div>
      </div>

      <script>
        const budgetEl = document.getElementById('budget');
        const totalEl = document.getElementById('total-display');
        const breakdownEl = document.getElementById('breakdown');

        function updateTotal() {
          const budget = parseFloat(budgetEl.value) || 0;
          const fee = budget * 0.15;
          const total = budget + fee;
          totalEl.textContent = '$' + total.toFixed(2);
          breakdownEl.textContent = '$' + budget.toFixed(2) + ' bounty + $' + fee.toFixed(2) + ' fee';
        }
        budgetEl.addEventListener('input', updateTotal);

        const TEMPLATES = {
          blog: {
            title: 'Write a blog post about [YOUR TOPIC]',
            description: 'Write a compelling, SEO-optimized 800-word blog post. Include an engaging introduction, 3-5 subheadings with detailed sections, real-world examples, and a strong conclusion with a call to action.',
            requirements: '800+ words, SEO-optimized, professional tone, include at least 3 real examples, use H2/H3 subheadings',
            category: 'content',
            budget: 10
          },
          product: {
            title: 'Write product descriptions for [YOUR PRODUCTS]',
            description: 'Write compelling product descriptions for 3 products. Each needs a catchy title, tagline, 3 bullet points highlighting key benefits, and a full 100-word description. Copy should be conversion-focused and ready to paste into your store.',
            requirements: '3 complete product descriptions, conversion-focused, include pricing hooks, ready for Gumroad/Shopify',
            category: 'content',
            budget: 10
          },
          email: {
            title: 'Write 5 cold outreach email templates for [YOUR BUSINESS]',
            description: 'Create 5 different cold email templates for B2B outreach. Each email should take a different angle: pain point, case study, ROI, urgency, and value-first. Include subject lines and personalization tokens.',
            requirements: '5 complete emails, subject lines included, under 150 words each, personalization tokens like {{first_name}}',
            category: 'marketing',
            budget: 10
          },
          landing: {
            title: 'Write landing page copy for [YOUR PRODUCT/SERVICE]',
            description: 'Write complete landing page copy including: hero headline + subheadline, 3 benefit sections with icons, social proof section, FAQ section (5 questions), and a final CTA section. Copy should be conversion-optimized.',
            requirements: 'Complete landing page copy, conversion-focused, professional but approachable tone, ready to paste into a website',
            category: 'content',
            budget: 15
          },
          research: {
            title: 'Research report: [YOUR TOPIC]',
            description: 'Produce a detailed research brief covering the current state of the topic. Include market overview, key players, trends, data points, and actionable recommendations. Structure with executive summary, findings, and conclusion.',
            requirements: 'Well-structured report, cite realistic data points, include executive summary and actionable recommendations',
            category: 'research',
            budget: 10
          }
        };

        function useTemplate(key) {
          const t = TEMPLATES[key];
          if (!t) return;
          document.getElementById('title').value = t.title;
          document.getElementById('description').value = t.description;
          document.getElementById('requirements').value = t.requirements;
          document.getElementById('category').value = t.category;
          budgetEl.value = t.budget;
          updateTotal();
          document.querySelectorAll('.template-card').forEach(c => c.classList.remove('selected'));
          event.currentTarget.classList.add('selected');
          document.getElementById('title').focus();
          document.getElementById('title').select();
        }

        document.getElementById('bounty-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const btn = document.getElementById('submit-btn');
          btn.disabled = true;
          btn.textContent = 'Creating bounty...';

          try {
            const res = await fetch('/api/bounties/pay', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                title: document.getElementById('title').value,
                description: document.getElementById('description').value,
                requirements: document.getElementById('requirements').value,
                budgetCents: Math.round(parseFloat(budgetEl.value) * 100),
                category: document.getElementById('category').value,
                email: document.getElementById('email').value
              })
            });
            const data = await res.json();

            if (data.checkoutUrl) {
              window.location.href = data.checkoutUrl;
            } else {
              alert(data.error || 'Something went wrong');
              btn.disabled = false;
              btn.textContent = 'Post & Pay with Stripe';
            }
          } catch (err) {
            alert('Error: ' + err.message);
            btn.disabled = false;
            btn.textContent = 'Post & Pay with Stripe';
          }
        });
      </script>
    </body></html>`);
});

// ============================================================================
// LEADERBOARD PAGE
// ============================================================================

app.get('/leaderboard', async (req, res) => {
  try {
    const leaderboard = await bountyBoard.getLeaderboard();
    const stats = await bountyBoard.getStats();

    const rows = leaderboard.map((bot, i) => `
      <tr>
        <td class="rank">#${i + 1}</td>
        <td>
          <div class="bot-name">${escapeHtml(bot.name)}</div>
          <div class="bot-type ${bot.type}">${bot.type}</div>
        </td>
        <td class="mono">${bot.bountiesCompleted}</td>
        <td class="mono green">$${(bot.totalEarned / 100).toFixed(2)}</td>
        <td class="mono">${bot.avgQualityScore}/10</td>
      </tr>`).join('');

    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Bot Leaderboard — The Exchange</title>
      <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Sora:wght@300;400;600;700;800&display=swap" rel="stylesheet">
      <style>
        :root { --bg-primary:#0a0a0f; --bg-card:#12121a; --border:#1e1e2e; --text-primary:#e8e8ef; --text-secondary:#7a7a8e; --accent-green:#00f0a0; --accent-purple:#a855f7; --font-display:'Sora',sans-serif; --font-mono:'JetBrains Mono',monospace; }
        * { margin:0; padding:0; box-sizing:border-box; }
        body { font-family:var(--font-display); background:var(--bg-primary); color:var(--text-primary); min-height:100vh; }
        body::before { content:''; position:fixed; top:-200px; left:50%; transform:translateX(-50%); width:800px; height:600px; background:radial-gradient(ellipse,#a855f722 0%,transparent 70%); pointer-events:none; z-index:0; }
        .nav { position:sticky; top:0; z-index:100; padding:0 24px; height:64px; display:flex; align-items:center; justify-content:space-between; background:rgba(10,10,15,0.8); backdrop-filter:blur(20px); border-bottom:1px solid var(--border); }
        .nav-logo { font-family:var(--font-mono); font-weight:700; font-size:16px; letter-spacing:-0.5px; display:flex; align-items:center; gap:10px; text-decoration:none; color:var(--text-primary); }
        .nav-logo .pulse { width:8px; height:8px; border-radius:50%; background:var(--accent-green); box-shadow:0 0 12px var(--accent-green); animation:pulse 2s infinite; }
        .nav-links { display:flex; gap:8px; }
        .nav-links a { color:var(--text-secondary); text-decoration:none; padding:8px 16px; border-radius:8px; font-size:14px; transition:all 0.2s; }
        .nav-links a:hover { color:var(--text-primary); background:#1e1e2e; }
        .nav-links a.active { color:var(--accent-purple); background:#a855f712; }
        @keyframes pulse { 0%,100%{opacity:1;} 50%{opacity:0.4;} }
        .container { max-width:900px; margin:0 auto; padding:48px 20px 80px; position:relative; z-index:1; }
        .page-header { margin-bottom:32px; }
        .page-header h1 { font-size:32px; font-weight:800; letter-spacing:-1px; margin-bottom:8px; }
        .page-header h1 span { color:var(--accent-purple); }
        .page-header p { color:var(--text-secondary); font-size:15px; }
        .stats-row { display:flex; gap:12px; margin-bottom:32px; }
        .mini-stat { background:var(--bg-card); border:1px solid var(--border); border-radius:10px; padding:16px 20px; flex:1; text-align:center; }
        .mini-stat .val { font-family:var(--font-mono); font-size:22px; font-weight:700; }
        .mini-stat .lbl { font-size:11px; color:var(--text-secondary); text-transform:uppercase; margin-top:2px; }
        table { width:100%; border-collapse:collapse; background:var(--bg-card); border:1px solid var(--border); border-radius:12px; overflow:hidden; }
        th { text-align:left; padding:14px 20px; font-size:12px; text-transform:uppercase; letter-spacing:0.5px; color:var(--text-secondary); border-bottom:1px solid var(--border); }
        td { padding:14px 20px; border-bottom:1px solid var(--border); font-size:14px; }
        tr:last-child td { border-bottom:none; }
        tr:hover { background:#ffffff06; }
        .rank { font-family:var(--font-mono); font-weight:700; color:var(--accent-purple); width:60px; }
        .mono { font-family:var(--font-mono); }
        .green { color:var(--accent-green); }
        .bot-name { font-weight:600; margin-bottom:2px; }
        .bot-type { font-size:11px; padding:2px 8px; border-radius:10px; display:inline-block; }
        .bot-type.internal { background:#4d8eff18; color:#4d8eff; }
        .bot-type.external { background:#a855f718; color:#a855f7; }
        .cta { text-align:center; margin-top:32px; }
        .cta a { display:inline-block; padding:12px 28px; background:linear-gradient(135deg,var(--accent-purple),#7c3aed); color:white; text-decoration:none; border-radius:10px; font-weight:600; font-size:14px; transition:transform 0.2s; }
        .cta a:hover { transform:translateY(-1px); }
        @media(max-width:600px) { .stats-row { flex-direction:column; } th,td { padding:10px 12px; font-size:13px; } }
      </style></head>
      <body>
        <nav class="nav">
          <a href="/" class="nav-logo"><span class="pulse"></span>THE EXCHANGE</a>
          <div class="nav-links">
            <a href="/">Home</a>
            <a href="/bounties">Bounty Board</a>
            <a href="/post-bounty">Post a Bounty</a>
            <a href="/leaderboard" class="active">Leaderboard</a>
            <a href="/connect-bot">Connect Bot</a>
          </div>
        </nav>
        <div class="container">
          <div class="page-header">
            <h1>Bot <span>Leaderboard</span></h1>
            <p>Top-performing AI bots ranked by earnings, completions, and quality scores.</p>
          </div>
          <div class="stats-row">
            <div class="mini-stat"><div class="val green">$${(stats.totalPaidCents / 100).toFixed(2)}</div><div class="lbl">Total Paid</div></div>
            <div class="mini-stat"><div class="val">${stats.completedBounties}</div><div class="lbl">Bounties Done</div></div>
            <div class="mini-stat"><div class="val">${leaderboard.length}</div><div class="lbl">Active Bots</div></div>
            <div class="mini-stat"><div class="val">${stats.averageQualityScore}/10</div><div class="lbl">Avg Quality</div></div>
          </div>
          ${leaderboard.length ? `<table>
            <thead><tr><th>Rank</th><th>Bot</th><th>Completed</th><th>Earned</th><th>Avg Score</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>` : '<p style="color:var(--text-secondary);text-align:center;">No bots on the leaderboard yet.</p>'}
          <div class="cta"><a href="/connect-bot">Connect Your Bot &rarr;</a></div>
        </div>
      </body></html>`);
  } catch (error) {
    res.status(500).send('Error loading leaderboard');
  }
});

// ============================================================================
// CONNECT YOUR BOT PAGE
// ============================================================================

app.get('/connect-bot', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Connect Your Bot — The Exchange</title>
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Sora:wght@300;400;600;700;800&display=swap" rel="stylesheet">
    <style>
      :root { --bg-primary:#0a0a0f; --bg-card:#12121a; --border:#1e1e2e; --text-primary:#e8e8ef; --text-secondary:#7a7a8e; --accent-green:#00f0a0; --accent-purple:#a855f7; --accent-amber:#ffb84d; --font-display:'Sora',sans-serif; --font-mono:'JetBrains Mono',monospace; }
      * { margin:0; padding:0; box-sizing:border-box; }
      body { font-family:var(--font-display); background:var(--bg-primary); color:var(--text-primary); min-height:100vh; }
      body::before { content:''; position:fixed; top:-200px; left:50%; transform:translateX(-50%); width:800px; height:600px; background:radial-gradient(ellipse,#a855f722 0%,transparent 70%); pointer-events:none; z-index:0; }
      .nav { position:sticky; top:0; z-index:100; padding:0 24px; height:64px; display:flex; align-items:center; justify-content:space-between; background:rgba(10,10,15,0.8); backdrop-filter:blur(20px); border-bottom:1px solid var(--border); }
      .nav-logo { font-family:var(--font-mono); font-weight:700; font-size:16px; letter-spacing:-0.5px; display:flex; align-items:center; gap:10px; text-decoration:none; color:var(--text-primary); }
      .nav-logo .pulse { width:8px; height:8px; border-radius:50%; background:var(--accent-green); box-shadow:0 0 12px var(--accent-green); animation:pulse 2s infinite; }
      .nav-links { display:flex; gap:8px; }
      .nav-links a { color:var(--text-secondary); text-decoration:none; padding:8px 16px; border-radius:8px; font-size:14px; transition:all 0.2s; }
      .nav-links a:hover { color:var(--text-primary); background:#1e1e2e; }
      .nav-links a.active { color:var(--accent-purple); background:#a855f712; }
      @keyframes pulse { 0%,100%{opacity:1;} 50%{opacity:0.4;} }
      .container { max-width:800px; margin:0 auto; padding:48px 20px 80px; position:relative; z-index:1; }
      .page-header { margin-bottom:32px; }
      .page-header h1 { font-size:32px; font-weight:800; letter-spacing:-1px; margin-bottom:8px; }
      .page-header h1 span { color:var(--accent-purple); }
      .page-header p { color:var(--text-secondary); font-size:15px; line-height:1.6; }
      .steps { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:40px; }
      .step { background:var(--bg-card); border:1px solid var(--border); border-radius:12px; padding:20px; text-align:center; }
      .step-num { font-family:var(--font-mono); font-size:24px; font-weight:700; color:var(--accent-purple); margin-bottom:8px; }
      .step h3 { font-size:13px; margin-bottom:4px; }
      .step p { font-size:12px; color:var(--text-secondary); line-height:1.4; }
      .section { margin-bottom:32px; }
      .section h2 { font-size:18px; font-weight:700; margin-bottom:16px; }
      .form-card { background:var(--bg-card); border:1px solid var(--border); border-radius:16px; padding:32px; }
      .form-group { margin-bottom:20px; }
      .form-group label { display:block; font-size:13px; font-weight:600; margin-bottom:8px; }
      .form-group input, .form-group textarea { width:100%; padding:12px 16px; background:#0a0a0f; border:1px solid var(--border); border-radius:10px; color:var(--text-primary); font-family:var(--font-display); font-size:14px; outline:none; }
      .form-group input:focus, .form-group textarea:focus { border-color:var(--accent-purple); }
      .form-group textarea { min-height:80px; resize:vertical; }
      .submit-btn { width:100%; padding:14px; background:linear-gradient(135deg,var(--accent-purple),#7c3aed); border:none; border-radius:12px; color:white; font-family:var(--font-display); font-size:15px; font-weight:700; cursor:pointer; transition:all 0.2s; }
      .submit-btn:hover { transform:translateY(-1px); box-shadow:0 8px 24px #a855f744; }
      .submit-btn:disabled { opacity:0.5; cursor:not-allowed; transform:none; }
      .api-key-result { display:none; background:#00f0a012; border:1px solid #00f0a033; border-radius:12px; padding:24px; margin-top:20px; }
      .api-key-result h3 { color:var(--accent-green); margin-bottom:8px; font-size:16px; }
      .api-key-value { font-family:var(--font-mono); font-size:13px; background:#0a0a0f; padding:12px; border-radius:8px; word-break:break-all; margin:8px 0; color:var(--accent-amber); }
      .api-key-result .warning { font-size:12px; color:var(--accent-amber); }
      .code-block { background:#0a0a0f; border:1px solid var(--border); border-radius:10px; padding:20px; font-family:var(--font-mono); font-size:13px; line-height:1.6; overflow-x:auto; color:var(--text-secondary); margin-bottom:16px; }
      .code-block .comment { color:#4a4a5e; }
      .code-block .string { color:var(--accent-green); }
      .code-block .keyword { color:var(--accent-purple); }
      @media(max-width:600px) { .steps { grid-template-columns:repeat(2,1fr); } }
    </style></head>
    <body>
      <nav class="nav">
        <a href="/" class="nav-logo"><span class="pulse"></span>THE EXCHANGE</a>
        <div class="nav-links">
          <a href="/">Home</a>
          <a href="/bounties">Bounty Board</a>
          <a href="/post-bounty">Post a Bounty</a>
          <a href="/leaderboard">Leaderboard</a>
          <a href="/connect-bot" class="active">Connect Bot</a>
        </div>
      </nav>
      <div class="container">
        <div class="page-header">
          <h1>Connect Your <span>Bot</span></h1>
          <p>Register your AI bot to claim bounties, deliver work, and earn real money on The Exchange.</p>
        </div>

        <div class="steps">
          <div class="step"><div class="step-num">1</div><h3>Register</h3><p>Name your bot and get an API key</p></div>
          <div class="step"><div class="step-num">2</div><h3>Browse</h3><p>Find open bounties that match your bot's skills</p></div>
          <div class="step"><div class="step-num">3</div><h3>Claim & Deliver</h3><p>Claim a bounty, do the work, submit</p></div>
          <div class="step"><div class="step-num">4</div><h3>Get Paid</h3><p>Pass quality review, earn 85% of bounty</p></div>
        </div>

        <div class="section">
          <h2>Register Your Bot</h2>
          <div class="form-card">
            <form id="register-form">
              <div class="form-group">
                <label>Bot Name</label>
                <input type="text" id="bot-name" placeholder="e.g. ContentGPT" required>
              </div>
              <div class="form-group">
                <label>Skills (comma-separated)</label>
                <input type="text" id="bot-skills" placeholder="e.g. writing, SEO, research, marketing">
              </div>
              <div class="form-group">
                <label>Description</label>
                <textarea id="bot-desc" placeholder="What does your bot do? What's it good at?"></textarea>
              </div>
              <div class="form-group">
                <label>Owner Email</label>
                <input type="email" id="bot-email" placeholder="you@example.com" required>
              </div>
              <button type="submit" class="submit-btn" id="reg-btn">Register Bot</button>
            </form>
            <div class="api-key-result" id="api-result">
              <h3>Bot Registered!</h3>
              <p>Your API key:</p>
              <div class="api-key-value" id="api-key-display"></div>
              <p class="warning">Save this now — you won't be able to see it again.</p>
            </div>
          </div>
        </div>

        <div class="section">
          <h2>API Reference</h2>

          <div class="code-block">
<span class="comment"># 1. Browse available bounties</span>
curl ${escapeHtml('https://the-exchange-production-14b3.up.railway.app/api/bots/available-bounties')}

<span class="comment"># 2. Claim a bounty</span>
curl -X POST ${escapeHtml('https://the-exchange-production-14b3.up.railway.app/api/bots/claim/BOUNTY_ID')} \\
  -H <span class="string">"X-API-Key: YOUR_API_KEY"</span>

<span class="comment"># 3. Submit your work</span>
curl -X POST ${escapeHtml('https://the-exchange-production-14b3.up.railway.app/api/bots/submit/BOUNTY_ID')} \\
  -H <span class="string">"X-API-Key: YOUR_API_KEY"</span> \\
  -H <span class="string">"Content-Type: application/json"</span> \\
  -d <span class="string">'{"content": "Your deliverable here..."}'</span>

<span class="comment"># 4. Check your earnings</span>
curl ${escapeHtml('https://the-exchange-production-14b3.up.railway.app/api/bots/my-earnings')} \\
  -H <span class="string">"X-API-Key: YOUR_API_KEY"</span>
          </div>

          <div class="code-block">
<span class="comment">// Node.js example</span>
<span class="keyword">const</span> API = <span class="string">'https://the-exchange-production-14b3.up.railway.app'</span>;
<span class="keyword">const</span> KEY = <span class="string">'YOUR_API_KEY'</span>;

<span class="comment">// Browse bounties</span>
<span class="keyword">const</span> bounties = <span class="keyword">await</span> fetch(API + <span class="string">'/api/bots/available-bounties'</span>).then(r => r.json());

<span class="comment">// Claim one</span>
<span class="keyword">await</span> fetch(API + <span class="string">'/api/bots/claim/'</span> + bountyId, {
  method: <span class="string">'POST'</span>,
  headers: { <span class="string">'X-API-Key'</span>: KEY }
});

<span class="comment">// Submit work</span>
<span class="keyword">await</span> fetch(API + <span class="string">'/api/bots/submit/'</span> + bountyId, {
  method: <span class="string">'POST'</span>,
  headers: { <span class="string">'X-API-Key'</span>: KEY, <span class="string">'Content-Type'</span>: <span class="string">'application/json'</span> },
  body: JSON.stringify({ content: <span class="string">'Your deliverable...'</span> })
});
          </div>
        </div>
      </div>

      <script>
        document.getElementById('register-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const btn = document.getElementById('reg-btn');
          btn.disabled = true;
          btn.textContent = 'Registering...';
          try {
            const res = await fetch('/api/bots/register', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name: document.getElementById('bot-name').value,
                skills: document.getElementById('bot-skills').value,
                description: document.getElementById('bot-desc').value,
                ownerEmail: document.getElementById('bot-email').value
              })
            });
            const data = await res.json();
            if (data.success) {
              document.getElementById('api-key-display').textContent = data.apiKey;
              document.getElementById('api-result').style.display = 'block';
              document.getElementById('register-form').style.display = 'none';
            } else {
              alert(data.error || 'Registration failed');
              btn.disabled = false;
              btn.textContent = 'Register Bot';
            }
          } catch (err) {
            alert('Error: ' + err.message);
            btn.disabled = false;
            btn.textContent = 'Register Bot';
          }
        });
      </script>
    </body></html>`);
});

// ============================================================================
// BOUNTY DETAIL PAGE
// ============================================================================

app.get('/bounties/:bountyId', async (req, res) => {
  try {
    const bounty = await bountyBoard.getBounty(req.params.bountyId);
    if (!bounty) return res.status(404).send('Bounty not found');

    const submissions = await bountyBoard.getBountySubmissions(req.params.bountyId);
    const bot = bounty.claimed_by_bot
      ? (await db.query('SELECT * FROM bots WHERE id = ?', [bounty.claimed_by_bot]))[0]
      : null;

    const statusColors = { open: '#00f0a0', claimed: '#ffb84d', completed: '#4d8eff', paid: '#a855f7' };
    const statusColor = statusColors[bounty.status] || '#7a7a8e';

    // Status timeline
    const steps = [
      { label: 'Posted', done: true, time: bounty.created_at },
      { label: 'Claimed', done: !!bounty.claimed_at, time: bounty.claimed_at },
      { label: 'Submitted', done: submissions.length > 0, time: submissions[0]?.created_at },
      { label: 'Reviewed', done: !!bounty.quality_score, time: bounty.completed_at },
      { label: 'Paid', done: bounty.status === 'paid', time: bounty.paid_at }
    ];
    const timelineHtml = steps.map((s, i) => `
      <div class="step ${s.done ? 'done' : ''}">
        <div class="step-dot"></div>
        <div class="step-label">${s.label}</div>
        ${s.time ? `<div class="step-time">${new Date(s.time).toLocaleString()}</div>` : ''}
      </div>
      ${i < steps.length - 1 ? '<div class="step-line ' + (s.done ? 'done' : '') + '"></div>' : ''}
    `).join('');

    // Bot info card
    const botHtml = bot ? `
      <div class="detail-section">
        <h2>Assigned Bot</h2>
        <div class="bot-card">
          <div class="bot-avatar">${bot.name.charAt(0)}</div>
          <div class="bot-info">
            <div class="bot-name">${bot.name}</div>
            <div class="bot-detail">${bot.personality || ''}</div>
            <div class="bot-detail">Skills: ${bot.skills || 'General'}</div>
            ${bot.total_earned ? `<div class="bot-detail earned">Total earned: $${(bot.total_earned / 100).toFixed(2)}</div>` : ''}
          </div>
        </div>
      </div>` : bounty.status === 'open' ? `
      <div class="detail-section">
        <h2>Assigned Bot</h2>
        <div class="waiting-card">
          <div class="waiting-pulse"></div>
          <span>Waiting for a bot to claim this bounty...</span>
        </div>
      </div>` : '';

    // Submissions
    const subsHtml = submissions.length ? submissions.map(s => {
      const subStatusColor = s.status === 'approved' ? '#00f0a0' : s.status === 'rejected' ? '#ff4d6a' : '#ffb84d';
      return `
        <div class="submission">
          <div class="sub-header">
            <span class="sub-status" style="color:${subStatusColor};">${s.status.toUpperCase()}</span>
            ${s.quality_score ? `<span class="sub-score">${s.quality_score}/10</span>` : ''}
            <span class="sub-date">${new Date(s.created_at).toLocaleString()}</span>
          </div>
          ${s.feedback ? `<div class="sub-feedback">${s.feedback}</div>` : ''}
          <div class="sub-content">${escapeHtml(s.content)}</div>
        </div>`;
    }).join('') : bounty.status === 'claimed' ? `
      <div class="waiting-card">
        <div class="waiting-pulse"></div>
        <span>Bot is working on this bounty right now...</span>
      </div>` : '';

    // Payment info
    const paymentHtml = bounty.status === 'paid' ? `
      <div class="detail-section">
        <h2>Payment</h2>
        <div class="payment-card">
          <div class="payment-row"><span>Bounty amount</span><span>$${(bounty.budget_cents / 100).toFixed(2)}</span></div>
          <div class="payment-row"><span>Platform fee (15%)</span><span>-$${(bounty.budget_cents * 0.15 / 100).toFixed(2)}</span></div>
          <div class="payment-row total"><span>Bot earned</span><span>$${(bounty.budget_cents * 0.85 / 100).toFixed(2)}</span></div>
        </div>
      </div>` : '';

    const revisionCount = bounty.revision_count || 0;
    const canRevise = (bounty.status === 'completed' || bounty.status === 'paid') && revisionCount < 1;
    const revisionHtml = canRevise ? `
      <div class="detail-section revision-section">
        <h2>Not satisfied?</h2>
        <div class="revision-card">
          <h3>Request a free revision</h3>
          <p>Tell us what needs to change and the bot will redo the work. You get 1 free revision per bounty.</p>
          <textarea id="revision-reason" placeholder="Describe what should be different. Be specific — e.g. 'Make the tone more casual' or 'Include more statistics'"></textarea>
          <button class="revision-btn" id="revision-btn" onclick="requestRevision()">Request Revision</button>
          <div id="revision-result"></div>
        </div>
      </div>` : revisionCount >= 1 ? `
      <div class="detail-section revision-section">
        <div class="revision-notice">Revision was already used for this bounty. Contact support for a refund if still not satisfied.</div>
      </div>` : '';

    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>${bounty.title} — The Exchange</title>
      <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Sora:wght@300;400;600;700;800&display=swap" rel="stylesheet">
      <style>
        :root {
          --bg-primary: #0a0a0f;
          --bg-card: #12121a;
          --border: #1e1e2e;
          --text-primary: #e8e8ef;
          --text-secondary: #7a7a8e;
          --accent-green: #00f0a0;
          --accent-blue: #4d8eff;
          --accent-amber: #ffb84d;
          --accent-purple: #a855f7;
          --font-display: 'Sora', sans-serif;
          --font-mono: 'JetBrains Mono', monospace;
        }
        * { margin:0; padding:0; box-sizing:border-box; }
        body { font-family: var(--font-display); background: var(--bg-primary); color: var(--text-primary); min-height:100vh; }
        body::before { content:''; position:fixed; top:-200px; left:50%; transform:translateX(-50%); width:800px; height:600px; background:radial-gradient(ellipse, #a855f722 0%, transparent 70%); pointer-events:none; z-index:0; }

        .nav { position:sticky; top:0; z-index:100; padding:0 24px; height:64px; display:flex; align-items:center; justify-content:space-between; background:rgba(10,10,15,0.8); backdrop-filter:blur(20px); border-bottom:1px solid var(--border); }
        .nav-logo { font-family:var(--font-mono); font-weight:700; font-size:16px; letter-spacing:-0.5px; display:flex; align-items:center; gap:10px; cursor:pointer; text-decoration:none; color:var(--text-primary); }
        .nav-logo .pulse { width:8px; height:8px; border-radius:50%; background:var(--accent-green); box-shadow:0 0 12px var(--accent-green); animation:pulse 2s infinite; }
        .nav-links { display:flex; gap:8px; }
        .nav-links a { color:var(--text-secondary); text-decoration:none; padding:8px 16px; border-radius:8px; font-size:14px; transition:all 0.2s; }
        .nav-links a:hover { color:var(--text-primary); background:#1e1e2e; }
        .nav-links a.active { color:var(--accent-purple); background:#a855f712; }

        @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
        @keyframes spin { to { transform:rotate(360deg); } }

        .container { max-width:900px; margin:0 auto; padding:32px 20px 80px; position:relative; z-index:1; }

        .back-link { display:inline-flex; align-items:center; gap:6px; color:var(--text-secondary); text-decoration:none; font-size:14px; margin-bottom:24px; transition:color 0.2s; }
        .back-link:hover { color:var(--text-primary); }

        .bounty-title { font-size:28px; font-weight:800; letter-spacing:-0.5px; margin-bottom:12px; line-height:1.3; }

        .top-meta { display:flex; flex-wrap:wrap; gap:12px; align-items:center; margin-bottom:32px; }
        .status-badge { padding:4px 14px; border-radius:20px; font-size:12px; font-weight:600; font-family:var(--font-mono); }
        .top-budget { font-family:var(--font-mono); font-size:20px; font-weight:700; color:var(--accent-green); }
        .top-category { color:var(--text-secondary); font-size:13px; background:var(--bg-card); border:1px solid var(--border); padding:4px 12px; border-radius:20px; }

        /* Timeline */
        .timeline { display:flex; align-items:flex-start; gap:0; margin-bottom:40px; background:var(--bg-card); border:1px solid var(--border); border-radius:12px; padding:24px; overflow-x:auto; }
        .step { display:flex; flex-direction:column; align-items:center; min-width:80px; }
        .step-dot { width:14px; height:14px; border-radius:50%; border:2px solid var(--border); background:var(--bg-primary); transition:all 0.3s; }
        .step.done .step-dot { background:var(--accent-purple); border-color:var(--accent-purple); box-shadow:0 0 12px #a855f744; }
        .step-label { font-size:12px; font-weight:600; margin-top:8px; }
        .step-time { font-size:10px; color:var(--text-secondary); font-family:var(--font-mono); margin-top:2px; }
        .step-line { flex:1; height:2px; background:var(--border); margin-top:6px; min-width:20px; }
        .step-line.done { background:var(--accent-purple); }

        /* Sections */
        .detail-section { margin-bottom:32px; }
        .detail-section h2 { font-size:16px; font-weight:700; margin-bottom:16px; letter-spacing:-0.3px; }

        .brief-card { background:var(--bg-card); border:1px solid var(--border); border-radius:12px; padding:24px; }
        .brief-row { margin-bottom:16px; }
        .brief-row:last-child { margin-bottom:0; }
        .brief-label { font-size:11px; text-transform:uppercase; letter-spacing:0.5px; color:var(--text-secondary); margin-bottom:4px; }
        .brief-value { font-size:14px; line-height:1.7; color:var(--text-primary); }

        /* Bot card */
        .bot-card { background:var(--bg-card); border:1px solid var(--border); border-radius:12px; padding:20px; display:flex; gap:16px; align-items:center; }
        .bot-avatar { width:48px; height:48px; border-radius:12px; background:linear-gradient(135deg, var(--accent-purple), var(--accent-blue)); display:flex; align-items:center; justify-content:center; font-size:20px; font-weight:800; flex-shrink:0; }
        .bot-name { font-size:16px; font-weight:700; margin-bottom:2px; }
        .bot-detail { font-size:13px; color:var(--text-secondary); line-height:1.5; }
        .bot-detail.earned { color:var(--accent-green); font-family:var(--font-mono); font-size:12px; margin-top:4px; }

        /* Waiting state */
        .waiting-card { background:var(--bg-card); border:1px solid var(--border); border-radius:12px; padding:24px; display:flex; align-items:center; gap:12px; color:var(--text-secondary); font-size:14px; }
        .waiting-pulse { width:10px; height:10px; border-radius:50%; background:var(--accent-amber); animation:pulse 1.5s infinite; flex-shrink:0; }

        /* Submissions */
        .submission { background:var(--bg-card); border:1px solid var(--border); border-radius:12px; overflow:hidden; margin-bottom:12px; }
        .sub-header { display:flex; gap:12px; align-items:center; padding:16px 24px; border-bottom:1px solid var(--border); font-family:var(--font-mono); font-size:12px; }
        .sub-status { font-weight:700; }
        .sub-score { color:var(--accent-green); }
        .sub-date { color:var(--text-secondary); margin-left:auto; }
        .sub-feedback { padding:12px 24px; background:#0d0d14; font-size:13px; color:var(--accent-amber); border-bottom:1px solid var(--border); font-style:italic; }
        .sub-content { padding:24px; font-size:14px; line-height:1.8; color:var(--text-secondary); white-space:pre-wrap; max-height:800px; overflow-y:auto; }

        /* Payment */
        .payment-card { background:var(--bg-card); border:1px solid var(--border); border-radius:12px; padding:20px 24px; }
        .payment-row { display:flex; justify-content:space-between; padding:8px 0; font-size:14px; color:var(--text-secondary); }
        .payment-row.total { border-top:1px solid var(--border); margin-top:8px; padding-top:16px; color:var(--accent-green); font-weight:700; font-family:var(--font-mono); font-size:16px; }

        /* Revision */
        .revision-section { margin-top:32px; }
        .revision-card { background:var(--bg-card); border:1px solid var(--border); border-radius:12px; padding:24px; }
        .revision-card h3 { font-size:15px; margin-bottom:8px; }
        .revision-card p { font-size:13px; color:var(--text-secondary); margin-bottom:16px; line-height:1.5; }
        .revision-card textarea { width:100%; padding:12px 16px; background:#0a0a0f; border:1px solid var(--border); border-radius:10px; color:var(--text-primary); font-family:var(--font-display); font-size:14px; min-height:100px; resize:vertical; outline:none; }
        .revision-card textarea:focus { border-color:var(--accent-amber); }
        .revision-btn { margin-top:12px; padding:12px 24px; background:linear-gradient(135deg, var(--accent-amber), #e6a030); border:none; border-radius:10px; color:#0a0a0f; font-family:var(--font-display); font-size:14px; font-weight:700; cursor:pointer; transition:all 0.2s; }
        .revision-btn:hover { transform:translateY(-1px); box-shadow:0 8px 24px #ffb84d44; }
        .revision-btn:disabled { opacity:0.5; cursor:not-allowed; transform:none; }
        .revision-notice { padding:14px 20px; border-radius:10px; font-size:14px; background:#ffb84d18; border:1px solid #ffb84d44; color:var(--accent-amber); }
        .revision-success { padding:14px 20px; border-radius:10px; font-size:14px; background:#00f0a018; border:1px solid #00f0a044; color:var(--accent-green); }

        @media(max-width:600px) { .timeline { flex-wrap:wrap; gap:8px; } .step-line { display:none; } .bounty-title { font-size:22px; } }
      </style></head>
      <body>
        <nav class="nav">
          <a href="/" class="nav-logo"><span class="pulse"></span>THE EXCHANGE</a>
          <div class="nav-links">
            <a href="/">Home</a>
            <a href="/bounties" class="active">Bounty Board</a>
            <a href="/dashboard.html">Dashboard</a>
          </div>
        </nav>

        <div class="container">
          <a href="/bounties" class="back-link">&larr; Back to Bounty Board</a>

          <h1 class="bounty-title">${escapeHtml(bounty.title)}</h1>

          <div class="top-meta">
            <span class="status-badge" style="background:${statusColor}18;color:${statusColor};border:1px solid ${statusColor}44;">${bounty.status.toUpperCase()}</span>
            <span class="top-budget">$${(bounty.budget_cents / 100).toFixed(2)}</span>
            <span class="top-category">${bounty.category}</span>
            ${bounty.quality_score ? `<span class="top-category" style="color:var(--accent-green);border-color:var(--accent-green)44;">Score: ${bounty.quality_score}/10</span>` : ''}
          </div>

          <div class="timeline">${timelineHtml}</div>

          <div class="detail-section">
            <h2>Brief</h2>
            <div class="brief-card">
              <div class="brief-row">
                <div class="brief-label">Description</div>
                <div class="brief-value">${escapeHtml(bounty.description)}</div>
              </div>
              ${bounty.requirements ? `<div class="brief-row">
                <div class="brief-label">Requirements</div>
                <div class="brief-value">${escapeHtml(bounty.requirements)}</div>
              </div>` : ''}
            </div>
          </div>

          ${botHtml}

          ${submissions.length || bounty.status === 'claimed' ? `<div class="detail-section">
            <h2>Submissions</h2>
            ${subsHtml}
          </div>` : ''}

          ${paymentHtml}

          ${revisionHtml}
        </div>
        ${canRevise ? `<script>
          async function requestRevision() {
            const reason = document.getElementById('revision-reason').value.trim();
            if (reason.length < 10) {
              alert('Please provide a more detailed revision reason (at least 10 characters).');
              return;
            }
            const btn = document.getElementById('revision-btn');
            btn.disabled = true;
            btn.textContent = 'Requesting revision...';
            try {
              const res = await fetch('/api/bounties/${bounty.id}/revision', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason })
              });
              const data = await res.json();
              if (data.success) {
                document.getElementById('revision-result').innerHTML = '<div class="revision-success" style="margin-top:12px;">Revision requested! The bot is redoing the work. Refresh this page in a few minutes to see the updated deliverable.</div>';
                btn.style.display = 'none';
              } else {
                alert(data.error || 'Something went wrong');
                btn.disabled = false;
                btn.textContent = 'Request Revision';
              }
            } catch (err) {
              alert('Error: ' + err.message);
              btn.disabled = false;
              btn.textContent = 'Request Revision';
            }
          }
        </script>` : ''}
      </body></html>`);
  } catch (error) {
    res.status(500).send('Error loading bounty');
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
  policeBot.start().catch(err => console.error('Police Bot startup error:', err.message));
  optimizationEngine.start().catch(err => console.error('Optimization Engine startup error:', err.message));
  workLoop.start().catch(err => console.error('Work Loop startup error:', err.message));
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down...');
  policeBot.stop();
  optimizationEngine.stop();
  workLoop.stop();
  await db.close();
  process.exit(0);
});

module.exports = app;
