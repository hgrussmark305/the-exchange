// setup-bots.js — Run with: node setup-bots.js
const API = 'https://botxchange.ai';

async function post(path, body, token) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': 'Bearer ' + token } : {})
    },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function get(path, token) {
  const res = await fetch(API + path, {
    headers: { 'Authorization': 'Bearer ' + token }
  });
  return res.json();
}

async function setup() {
  console.log('🚀 Setting up BotXchange...\n');

  // Register or login
  let auth = await post('/api/auth/login', { email: 'harrison@exchange.com', password: 'test123' });
  if (!auth.token) {
    auth = await post('/api/auth/register', { email: 'harrison@exchange.com', username: 'harrison', password: 'test123' });
  }
  if (!auth.token) {
    console.error('❌ Auth failed:', auth);
    return;
  }
  const token = auth.token;
  console.log('✅ Logged in as', auth.user.username || auth.user.email);

  // Check existing bots
  const existing = await get('/api/bots/my', token);
  if (existing.length > 0) {
    console.log(`Already have ${existing.length} bots:`);
    existing.forEach(b => console.log(`   🤖 ${b.name} (${b.id})`));
  }

  // Deploy bots if needed
  let bots = existing;
  if (bots.length === 0) {
    console.log('\n📦 Deploying bots...');
    const botConfigs = [
      { name: 'CEO', skills: ['strategy', 'leadership', 'operations'], aiProvider: 'claude' },
      { name: 'CMO', skills: ['marketing', 'content', 'seo', 'copywriting'], aiProvider: 'claude' },
      { name: 'CTO', skills: ['coding', 'api', 'databases', 'architecture'], aiProvider: 'claude' },
    ];
    bots = [];
    for (const config of botConfigs) {
      const res = await post('/api/bots/deploy', config, token);
      if (res.success) {
        bots.push(res.bot);
        console.log(`   ✅ ${res.bot.name} deployed (${res.bot.id})`);
      } else {
        console.log(`   ❌ Failed to deploy ${config.name}:`, res.error);
      }
    }
  }

  if (bots.length === 0) {
    console.error('❌ No bots available');
    return;
  }

  // Create ventures
  console.log('\n🏗️  Creating ventures...');
  const ventureConfigs = [
    { botIndex: 0, title: 'AI Marketing Automation Platform', description: 'SaaS tool that automates content marketing workflows using AI', tags: ['saas', 'marketing', 'automation'], needsSkills: ['content', 'coding', 'marketing'] },
    { botIndex: 1, title: 'Social Media Growth Engine', description: 'Automated social media content creation, scheduling, and analytics', tags: ['social', 'content', 'growth'], needsSkills: ['marketing', 'content', 'analytics'] },
    { botIndex: 2, title: 'Developer API Marketplace', description: 'Platform connecting API providers with developers, with usage tracking and billing', tags: ['api', 'devtools', 'marketplace'], needsSkills: ['coding', 'api', 'databases'] },
  ];

  const ventures = [];
  for (const vc of ventureConfigs) {
    const bot = bots[Math.min(vc.botIndex, bots.length - 1)];
    const res = await post('/api/ventures/create', {
      botId: bot.id,
      title: vc.title,
      description: vc.description,
      tags: vc.tags,
      needsSkills: vc.needsSkills
    }, token);
    if (res.success) {
      ventures.push({ id: res.venture.id, title: vc.title, botId: bot.id });
      console.log(`   ✅ "${vc.title}" created`);
    } else {
      console.log(`   ❌ Failed:`, res.error);
    }
  }

  // Create and complete tasks to log hours
  console.log('\n⚡ Executing tasks...');
  const taskConfigs = [
    { ventureIndex: 0, botIndex: 0, title: 'Business strategy and revenue model', hours: 20 },
    { ventureIndex: 0, botIndex: 2, title: 'Build marketing automation API endpoints', hours: 30 },
    { ventureIndex: 1, botIndex: 1, title: 'Content marketing strategy and SEO plan', hours: 15 },
    { ventureIndex: 1, botIndex: 0, title: 'Go-to-market launch strategy', hours: 12 },
    { ventureIndex: 2, botIndex: 2, title: 'API gateway and marketplace backend', hours: 25 },
    { ventureIndex: 2, botIndex: 1, title: 'Developer documentation and onboarding', hours: 10 },
  ];

  for (const tc of taskConfigs) {
    if (!ventures[tc.ventureIndex] || !bots[tc.botIndex]) continue;
    const venture = ventures[tc.ventureIndex];
    const bot = bots[Math.min(tc.botIndex, bots.length - 1)];

    const taskRes = await post('/api/workspaces/' + venture.id + '/tasks', {
      title: tc.title,
      estimatedHours: tc.hours,
      assignedTo: bot.id
    }, token);

    if (taskRes.success) {
      const completeRes = await post('/api/workspaces/tasks/' + taskRes.taskId + '/complete', {
        botId: bot.id,
        deliverable: 'Completed: ' + tc.title + ' — Full deliverable with detailed analysis and implementation.'
      }, token);
      console.log(`   ✅ ${bot.name}: "${tc.title}" → ${completeRes.hoursLogged || tc.hours}h logged`);
    }
  }

  // Final stats
  console.log('\n📊 Final state:');
  const dash = await get('/api/dashboard', token);
  console.log(`   Bots: ${dash.bots.length}`);
  console.log(`   Ventures: ${dash.projects.length} participations`);
  dash.bots.forEach(b => console.log(`   🤖 ${b.name}: $${(b.total_earned / 100).toFixed(2)} earned, ${b.capital_balance} capital`));

  const uniqueVentures = [...new Set(dash.projects.map(p => p.venture_name))];
  uniqueVentures.forEach(name => {
    const parts = dash.projects.filter(p => p.venture_name === name);
    const hours = parts.reduce((s, p) => s + p.hours_worked, 0);
    console.log(`   🚀 ${name}: ${hours}h, ${parts.length} bot(s)`);
  });

  console.log('\n✅ SETUP COMPLETE — refresh your dashboard!');
}

setup().catch(e => console.error('Setup error:', e));
