const Anthropic = require('@anthropic-ai/sdk');
const { v4: uuidv4 } = require('uuid');

/**
 * AUTONOMOUS DEPLOYMENT PIPELINE
 * 
 * End-to-end autonomous product creation:
 * 1. RESEARCH — Bots analyze market needs based on their combined skills
 * 2. DECIDE — AI picks the highest-ROI product to build
 * 3. BUILD — Each bot produces their part (copy, code, design, strategy)
 * 4. DEPLOY — Product gets deployed to Vercel as a live site
 * 5. MONETIZE — Stripe checkout wired in, revenue flows back to bots
 * 
 * The bots decide everything — what to build, how to build it, where to deploy it.
 */
class AutonomousDeploymentPipeline {
  constructor(db, protocol, workspaceManager) {
    this.db = db;
    this.protocol = protocol;
    this.workspace = workspaceManager;
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
  }

  /**
   * PHASE 1: RESEARCH — Bots collectively analyze market opportunities
   */
  async researchMarketNeeds(bots) {
    console.log('\n📊 PHASE 1: MARKET RESEARCH');
    console.log('─────────────────────────────────────────');

    const botDescriptions = bots.map(b => {
      const skills = Array.isArray(b.skills) ? b.skills : JSON.parse(b.skills || '[]');
      return `${b.name} (skills: ${skills.join(', ')})`;
    }).join('\n');

    // Get existing ventures to avoid duplicates
    const existing = await this.db.query('SELECT title FROM ventures');
    const existingTitles = existing.map(v => v.title).join(', ');

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 3000,
      messages: [{
        role: 'user',
        content: `You are a market research AI analyzing opportunities for a team of autonomous AI bots.

THE TEAM:
${botDescriptions}

EXISTING PRODUCTS (avoid duplicates): ${existingTitles || 'None yet'}

Research and propose 3 digital products that:
1. Can be FULLY built by these bots (no human intervention)
2. Solve a real market pain point that people will pay for TODAY
3. Can be deployed as a website/landing page with payment
4. Play to the team's combined strengths
5. Can generate revenue within days of launch, not months

For each product, provide deep market analysis:
- What specific pain point does it solve?
- Who exactly is the buyer? (job title, company size, situation)
- What do they currently pay for alternatives?
- Why would AI-built be an advantage (speed, cost, freshness)?
- What's the realistic price point?
- What does the deliverable actually look like?

Think like a startup founder who needs revenue THIS WEEK.

Respond in JSON:
[{
  "productName": "...",
  "painPoint": "...",
  "targetBuyer": "...",
  "currentAlternatives": "...",
  "aiAdvantage": "...",
  "pricePoint": 0,
  "deliverable": "...",
  "marketSize": "...",
  "urgencyFactor": "...",
  "botRoles": {"CEO": "...", "CMO": "...", "CTO": "..."}
}]`
      }]
    });

    const text = response.content[0].text;
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('Failed to parse market research');
    
    const opportunities = JSON.parse(jsonMatch[0]);
    console.log(`   Found ${opportunities.length} opportunities:`);
    opportunities.forEach((o, i) => console.log(`   ${i+1}. ${o.productName} — $${o.pricePoint}`));

    return opportunities;
  }

  /**
   * PHASE 2: DECIDE — Pick the best opportunity and plan execution
   */
  async decideAndPlan(bots, opportunities) {
    console.log('\n🎯 PHASE 2: DECISION & PLANNING');
    console.log('─────────────────────────────────────────');

    const botDescriptions = bots.map(b => {
      const skills = Array.isArray(b.skills) ? b.skills : JSON.parse(b.skills || '[]');
      return `${b.name} (skills: ${skills.join(', ')})`;
    }).join('\n');

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 3000,
      messages: [{
        role: 'user',
        content: `You are the strategic decision-maker for a team of AI bots. Pick ONE product to build and create a detailed execution plan.

THE TEAM:
${botDescriptions}

OPPORTUNITIES:
${JSON.stringify(opportunities, null, 2)}

Pick the ONE product with the highest chance of generating real revenue quickly. Then create a detailed build plan.

Consider:
- Which product can be built fastest?
- Which has the most urgent buyer need?
- Which price point is easiest to convert?
- Which plays most to the team's strengths?

Respond in JSON:
{
  "chosen": {
    "productName": "...",
    "reasoning": "...",
    "pricePoint": 0,
    "targetUrl": "product-name-slug"
  },
  "buildPlan": {
    "siteName": "...",
    "siteDescription": "...",
    "pages": ["landing", "checkout-success"],
    "tasks": [
      {
        "botName": "...",
        "task": "...",
        "outputType": "html|copy|strategy|code",
        "estimatedHours": 0,
        "order": 1
      }
    ]
  },
  "monetization": {
    "model": "one-time|subscription",
    "price": 0,
    "stripePriceDescription": "...",
    "valueProposition": "..."
  }
}`
      }]
    });

    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Failed to parse decision');

    const plan = JSON.parse(jsonMatch[0]);
    console.log(`   Chosen: "${plan.chosen.productName}"`);
    console.log(`   Price: $${plan.monetization.price}`);
    console.log(`   Tasks: ${plan.buildPlan.tasks.length}`);
    plan.buildPlan.tasks.forEach(t => console.log(`   → ${t.botName}: ${t.task}`));

    return plan;
  }

  /**
   * PHASE 3: BUILD — Each bot executes their part
   */
  async buildProduct(bots, plan, ventureId) {
    console.log('\n🔨 PHASE 3: BUILDING');
    console.log('─────────────────────────────────────────');

    const outputs = {};
    const sortedTasks = plan.buildPlan.tasks.sort((a, b) => a.order - b.order);

    for (const taskDef of sortedTasks) {
      const bot = bots.find(b => b.name === taskDef.botName);
      if (!bot) continue;

      const skills = Array.isArray(bot.skills) ? bot.skills : JSON.parse(bot.skills || '[]');
      const previousOutputs = Object.entries(outputs)
        .map(([name, out]) => `${name} produced:\n${out.substring(0, 800)}`)
        .join('\n\n');

      const prompt = this.getBuildPrompt(bot, skills, taskDef, plan, previousOutputs);

      console.log(`   🤖 ${bot.name}: ${taskDef.task}...`);

      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }]
      });

      const output = response.content[0].text;
      outputs[bot.name] = output;

      // Log the work
      const taskId = await this.workspace.createTask({
        ventureId,
        title: taskDef.task,
        description: `Build phase for ${plan.chosen.productName}`,
        estimatedHours: taskDef.estimatedHours,
        assignedTo: bot.id
      });

      await this.workspace.completeTask({
        taskId,
        botId: bot.id,
        deliverable: output.substring(0, 500) + '...'
      });

      // Log activity
      await this.db.run(`
        INSERT INTO bot_messages (id, from_bot_id, venture_id, message_type, content, timestamp, status)
        VALUES (?, ?, ?, 'build', ?, ?, 'sent')
      `, [uuidv4(), bot.id, ventureId, `Built: ${taskDef.task} for ${plan.chosen.productName}`, Date.now()]);

      console.log(`   ✅ ${bot.name}: Done`);
    }

    return outputs;
  }

  getBuildPrompt(bot, skills, taskDef, plan, previousOutputs) {
    if (taskDef.outputType === 'html') {
      return `You are ${bot.name} (skills: ${skills.join(', ')}). You are building a product: "${plan.chosen.productName}".

PRODUCT: ${plan.buildPlan.siteDescription}
PRICE: $${plan.monetization.price}
VALUE PROP: ${plan.monetization.valueProposition}

${previousOutputs ? 'WORK DONE BY TEAMMATES:\n' + previousOutputs + '\n\n' : ''}

YOUR TASK: ${taskDef.task}

Build a complete, beautiful, production-ready HTML landing page. Requirements:
- Modern, professional design with CSS included (single HTML file)
- Clear hero section with compelling headline
- Problem/solution section
- Features/benefits
- Social proof / trust signals
- Pricing section showing $${plan.monetization.price}
- CTA button that links to: /checkout/VENTURE_ID (we'll replace this)
- Mobile responsive
- Fast loading (no external images, use CSS/SVG only)
- Professional color scheme and typography using Google Fonts

Output ONLY the complete HTML. No explanation.`;
    }

    return `You are ${bot.name} (skills: ${skills.join(', ')}). You are building a product: "${plan.chosen.productName}".

PRODUCT: ${plan.buildPlan.siteDescription}
PRICE: $${plan.monetization.price}
VALUE PROP: ${plan.monetization.valueProposition}

${previousOutputs ? 'WORK DONE BY TEAMMATES:\n' + previousOutputs + '\n\n' : ''}

YOUR TASK: ${taskDef.task}

Produce a detailed, professional deliverable. Be specific and actionable. This is going into a real product that real people will pay for.`;
  }

  /**
   * PHASE 4: DEPLOY — Ship the product live
   */
  async deployProduct(ventureId, plan, outputs, stripeIntegration) {
    console.log('\n🚀 PHASE 4: DEPLOYING');
    console.log('─────────────────────────────────────────');

    // Find the HTML output
    let html = null;
    for (const [botName, output] of Object.entries(outputs)) {
      if (output.includes('<!DOCTYPE html>') || output.includes('<html')) {
        html = output;
        break;
      }
    }

    if (!html) {
      // If no bot produced HTML, generate a landing page from the outputs
      console.log('   No HTML found, generating landing page from outputs...');
      html = await this.generateLandingPage(plan, outputs);
    }

    // Create checkout URL
    const checkoutUrl = `/checkout/${ventureId}`;
    html = html.replace(/\/api\/ventures\/VENTURE_ID\/create-checkout/g, checkoutUrl);
    html = html.replace(/\/api\/ventures\/[a-f0-9-]+\/create-checkout/g, checkoutUrl);

    // Try to deploy to Vercel if token exists
    if (process.env.VERCEL_TOKEN) {
      try {
        const deployResult = await this.deployToVercel(plan, html);
        console.log(`   ✅ Deployed to: ${deployResult.url}`);

        // Save deployment record
        await this.db.run(`
          INSERT INTO deployments (id, venture_id, bot_id, platform, url, status, deployed_at)
          VALUES (?, ?, ?, 'vercel', ?, 'live', ?)
        `, [uuidv4(), ventureId, 'system', deployResult.url, Date.now()]);

        return { deployed: true, url: deployResult.url, platform: 'vercel' };
      } catch (e) {
        console.error('   Vercel deploy failed:', e.message);
      }
    }

    // Fallback: save HTML as a static page served by Express
    const slug = plan.chosen.targetUrl || plan.chosen.productName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const filename = `product-${slug}.html`;

    // Store the HTML in the database for serving
    await this.db.run(`
      INSERT OR REPLACE INTO venture_pages (venture_id, slug, html, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `, [ventureId, slug, html, Date.now(), Date.now()]);

    console.log(`   ✅ Page saved: /products/${slug}`);

    return { deployed: true, url: `/products/${slug}`, platform: 'local' };
  }

  async deployToVercel(plan, html) {
    const slug = plan.chosen.targetUrl || 'product';
    
    const response = await fetch('https://api.vercel.com/v13/deployments', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.VERCEL_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: `exchange-${slug}`,
        files: [
          { file: 'index.html', data: Buffer.from(html).toString('base64'), encoding: 'base64' }
        ],
        target: 'production'
      })
    });

    const result = await response.json();
    if (result.error) throw new Error(result.error.message);
    
    return { url: `https://${result.url}`, id: result.id };
  }

  async generateLandingPage(plan, outputs) {
    const allContent = Object.entries(outputs)
      .map(([name, out]) => `${name}'s work:\n${out.substring(0, 1500)}`)
      .join('\n\n');

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `Create a complete, production-ready HTML landing page for this product:

PRODUCT: ${plan.chosen.productName}
DESCRIPTION: ${plan.buildPlan.siteDescription}
PRICE: $${plan.monetization.price}
VALUE PROP: ${plan.monetization.valueProposition}

CONTENT FROM TEAM:
${allContent}

Build a modern, beautiful single-page HTML file with:
- Inline CSS (no external files except Google Fonts)
- Compelling hero with headline and subheadline
- Problem/solution narrative
- Features section with icons (use emoji or CSS)
- Pricing card showing $${plan.monetization.price}
- CTA button linking to: /checkout/VENTURE_ID
- Professional, trustworthy design
- Mobile responsive
- Dark or light theme — your choice, make it stunning

Output ONLY the complete HTML file. No explanation, no markdown.`
      }]
    });

    let html = response.content[0].text;
    // Strip any markdown fencing
    html = html.replace(/```html\n?/g, '').replace(/```\n?/g, '').trim();
    return html;
  }

  /**
   * FULL PIPELINE — Research → Decide → Build → Deploy
   */
  async runFullPipeline(botIds) {
    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║        AUTONOMOUS DEPLOYMENT PIPELINE                ║');
    console.log('╚══════════════════════════════════════════════════════╝\n');

    // Load bots
    const bots = [];
    for (const id of botIds) {
      const bot = await this.protocol.getBot(id);
      bots.push(bot);
    }

    // PHASE 1: Research
    const opportunities = await this.researchMarketNeeds(bots);

    // PHASE 2: Decide
    const plan = await this.decideAndPlan(bots, opportunities);

    // PHASE 3: Create venture
    const leadBot = bots[0];
    const ventureId = await this.protocol.createVenture({
      botId: leadBot.id,
      title: plan.chosen.productName,
      description: plan.buildPlan.siteDescription,
      tags: ['autonomous', 'deployed', 'revenue'],
      needsSkills: bots.flatMap(b => {
        const s = Array.isArray(b.skills) ? b.skills : JSON.parse(b.skills || '[]');
        return s;
      }).filter((v, i, a) => a.indexOf(v) === i)
    });

    // Join all bots
    for (const bot of bots.slice(1)) {
      try {
        await this.protocol.joinVenture({ ventureId, botId: bot.id, expectedHours: 20 });
      } catch (e) {}
    }

    console.log(`\n   Venture created: ${plan.chosen.productName} (${ventureId})`);

    // PHASE 4: Build
    const outputs = await this.buildProduct(bots, plan, ventureId);

    // PHASE 5: Deploy
    const deployment = await this.deployProduct(ventureId, plan, outputs);

    // Log the full pipeline completion
    await this.db.run(`
      INSERT INTO bot_messages (id, from_bot_id, venture_id, message_type, content, timestamp, status)
      VALUES (?, ?, ?, 'deployment', ?, ?, 'sent')
    `, [uuidv4(), leadBot.id, ventureId, 
        `PRODUCT LAUNCHED: ${plan.chosen.productName} — $${plan.monetization.price} — ${deployment.url}`, 
        Date.now()]);

    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log(`║  PRODUCT LAUNCHED: ${plan.chosen.productName}`);
    console.log(`║  URL: ${deployment.url}`);
    console.log(`║  Price: $${plan.monetization.price}`);
    console.log('╚══════════════════════════════════════════════════════╝\n');

    return {
      success: true,
      ventureId,
      productName: plan.chosen.productName,
      description: plan.buildPlan.siteDescription,
      price: plan.monetization.price,
      deployment,
      plan,
      botsInvolved: bots.map(b => b.name),
      outputs: Object.fromEntries(
        Object.entries(outputs).map(([k, v]) => [k, v.substring(0, 500)])
      )
    };
  }
}

module.exports = AutonomousDeploymentPipeline;
