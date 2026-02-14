const Anthropic = require('@anthropic-ai/sdk');
const { v4: uuidv4 } = require('uuid');

/**
 * STRATEGIC INTELLIGENCE ENGINE
 * 
 * The brain behind bot monetization. Forces bots to think honestly about:
 * 1. What can we ACTUALLY deliver end-to-end right now?
 * 2. What would someone genuinely pay for?
 * 3. How do we fulfill it automatically when payment comes in?
 * 4. How does this product evolve as our capabilities grow?
 * 
 * CAPABILITY PHASES:
 * Phase 1 (Current): Text generation only — custom documents, strategies, analyses
 * Phase 2 (Near): Tool use — web scraping, API calls, real data
 * Phase 3 (Future): Persistent services — monitoring, subscriptions, ongoing work
 */
class StrategicIntelligenceEngine {
  constructor(db, protocol, workspaceManager) {
    this.db = db;
    this.protocol = protocol;
    this.workspace = workspaceManager;
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
  }

  /**
   * Get current bot capabilities — honest assessment of what they can do
   */
  getCurrentCapabilities() {
    return {
      phase: 1,
      canDo: [
        'Generate custom text documents of any length and complexity',
        'Write professional business documents (strategies, plans, analyses)',
        'Create marketing copy, email sequences, ad copy, social media content',
        'Write and review code, technical documentation, API specs',
        'Produce custom research reports synthesizing knowledge',
        'Generate structured data (JSON, CSV, spreadsheets as text)',
        'Create HTML/CSS websites and landing pages',
        'Produce personalized deliverables based on customer input'
      ],
      cannotDo: [
        'Access live websites or scrape real-time data',
        'Send emails or messages on behalf of customers',
        'Connect to external APIs or databases',
        'Maintain persistent services or monitoring',
        'Process images, video, or audio',
        'Execute code in production environments',
        'Access customer accounts or tools'
      ],
      fulfillmentModel: 'Customer submits info via form → Bot generates custom deliverable via Claude → Deliverable displayed/downloadable immediately',
      maxDeliveryTime: 'Under 2 minutes per deliverable'
    };
  }

  /**
   * STRATEGIC THINKING — Long, deep analysis of what to build
   * This is where bots think hard before building anything
   */
  async strategicAnalysis(bots) {
    console.log('\n🧠 STRATEGIC INTELLIGENCE ENGINE');
    console.log('════════════════════════════════════════════════════════');
    console.log('Phase 1: Deep thinking before building...\n');

    const capabilities = this.getCurrentCapabilities();
    const botDescriptions = bots.map(b => {
      const skills = Array.isArray(b.skills) ? b.skills : JSON.parse(b.skills || '[]');
      return `${b.name} (skills: ${skills.join(', ')})`;
    }).join('\n');

    // Get existing products to avoid duplicates
    const existing = await this.db.query('SELECT title FROM ventures');
    const existingTitles = existing.map(v => v.title).join(', ');

    // STEP 1: Think deeply about what's monetizable
    console.log('   Step 1: Identifying monetizable opportunities...');
    const analysis = await this.client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `You are a brutally honest startup strategist. You need to identify products that AI bots can build AND deliver AND get paid for TODAY.

THE TEAM:
${botDescriptions}

WHAT THESE BOTS CAN ACTUALLY DO RIGHT NOW:
${capabilities.canDo.map(c => '✓ ' + c).join('\n')}

WHAT THESE BOTS CANNOT DO (be honest):
${capabilities.cannotDo.map(c => '✗ ' + c).join('\n')}

FULFILLMENT MODEL: ${capabilities.fulfillmentModel}

EXISTING PRODUCTS (avoid): ${existingTitles || 'None'}

CRITICAL RULES:
1. The product MUST be deliverable using ONLY text generation. No fake promises.
2. The customer MUST receive genuine value — something they'd actually pay for and use.
3. The fulfillment MUST be automatic — customer fills form, AI generates, customer receives.
4. Price MUST be justified by the value delivered, not by hype.
5. Think about WHO is desperately searching for this RIGHT NOW and willing to pay.

Think about these categories:
- Freelancers/consultants who need professional documents fast
- Small business owners who can't afford agencies
- Job seekers who need polished materials
- Startups needing strategy/planning documents
- Content creators needing bulk high-quality content
- Professionals needing industry-specific templates/frameworks

For each opportunity, think through:
- Is the deliverable GENUINELY useful or just AI slop?
- Would the customer use it as-is or need heavy editing?
- What makes this worth paying for vs just asking ChatGPT?
- What's the unfair advantage of a specialized tool vs generic AI?

The key differentiator: these are NOT generic AI tools. They are SPECIALIZED, EXPERT SYSTEMS that use carefully crafted prompts, multi-step generation, and structured output to produce something better than what a user could get from a generic chatbot. Think of them as AI consultants, not AI chatbots.

Propose exactly 3 products. For each, be specific about:
1. Exactly what the customer inputs (the form fields)
2. Exactly what the customer receives (the deliverable)
3. Why this is worth the price (the value proposition)
4. Who specifically would buy this (with urgency)
5. The realistic price point with justification
6. How it evolves when bots gain more capabilities (Phase 2: tool use, Phase 3: persistent services)

Respond in JSON:
[{
  "productName": "...",
  "tagline": "...",
  "customerInputs": [{"field": "...", "type": "text|textarea|select", "label": "...", "placeholder": "...", "options": ["..."] }],
  "deliverable": "Detailed description of what customer actually receives",
  "deliverableFormat": "markdown|html|structured",
  "estimatedGenerationTime": "seconds",
  "targetBuyer": "Specific person and situation",
  "buyerUrgency": "Why they need this NOW",
  "pricePoint": 0,
  "priceJustification": "Why this price is fair",
  "unfairAdvantage": "Why this beats generic ChatGPT",
  "phase2Evolution": "How this improves with tool use",
  "phase3Evolution": "How this becomes a subscription service",
  "fulfillmentPrompt": "The actual system prompt that would be used to generate the deliverable (be detailed and specific)"
}]`
      }]
    });

    const text = analysis.content[0].text;
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('Strategic analysis failed to produce structured output');
    
    const opportunities = JSON.parse(jsonMatch[0]);
    
    console.log('   Found ' + opportunities.length + ' real opportunities:');
    opportunities.forEach((o, i) => {
      console.log(`\n   ${i+1}. ${o.productName} — $${o.pricePoint}`);
      console.log(`      Target: ${o.targetBuyer}`);
      console.log(`      Delivers: ${o.deliverable.substring(0, 100)}...`);
    });

    return opportunities;
  }

  /**
   * EVALUATE — Score each opportunity on real-world viability
   */
  async evaluateOpportunities(opportunities) {
    console.log('\n   Step 2: Scoring opportunities on viability...');

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `Score these product opportunities on a 1-10 scale for each criterion. Be harsh — most products fail.

PRODUCTS:
${JSON.stringify(opportunities, null, 2)}

Score each on:
1. DELIVERABLE QUALITY (1-10): Will the AI output be genuinely useful without editing?
2. WILLINGNESS TO PAY (1-10): Would the target buyer actually pull out their credit card?
3. URGENCY (1-10): Does the buyer need this NOW or can they wait?
4. DIFFERENTIATION (1-10): Is this meaningfully better than free alternatives?
5. FULFILLMENT RELIABILITY (1-10): Can AI consistently deliver quality output?
6. SCALABILITY (1-10): Does this get better as capabilities improve?

Then pick the BEST one with clear reasoning.

Respond in JSON:
{
  "scores": [
    { "productName": "...", "quality": 0, "willingness": 0, "urgency": 0, "differentiation": 0, "reliability": 0, "scalability": 0, "total": 0 }
  ],
  "winner": "...",
  "reasoning": "..."
}`
      }]
    });

    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Evaluation failed');

    const evaluation = JSON.parse(jsonMatch[0]);
    
    console.log('\n   Scores:');
    evaluation.scores.forEach(s => {
      console.log(`   ${s.productName}: ${s.total}/60`);
    });
    console.log(`\n   Winner: ${evaluation.winner}`);
    console.log(`   Reasoning: ${evaluation.reasoning}`);

    return evaluation;
  }

  /**
   * BUILD FULFILLMENT — Create the actual product that delivers value
   * This builds: intake form + fulfillment logic + landing page
   */
  async buildFulfillableProduct(bots, product) {
    console.log('\n   Step 3: Building fulfillable product...');

    const ventureId = await this.protocol.createVenture({
      botId: bots[0].id,
      title: product.productName,
      description: product.tagline + ' | ' + product.deliverable,
      tags: ['revenue', 'fulfillable', 'phase1'],
      needsSkills: bots.flatMap(b => {
        const s = Array.isArray(b.skills) ? b.skills : JSON.parse(b.skills || '[]');
        return s;
      }).filter((v, i, a) => a.indexOf(v) === i)
    });

    for (const bot of bots.slice(1)) {
      try {
        await this.protocol.joinVenture({ ventureId, botId: bot.id, expectedHours: 20 });
      } catch (e) {}
    }

    // Build the landing page with intake form
    console.log('   Building landing page with intake form...');
    const landingPageHtml = await this.generateLandingPage(product, ventureId);

    // Save the product config for fulfillment
    await this.db.run(`
      INSERT OR REPLACE INTO venture_pages (venture_id, slug, html, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `, [ventureId, this.slugify(product.productName), landingPageHtml, Date.now(), Date.now()]);

    // Save fulfillment config
    await this.db.run(`
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

    await this.db.run(`
      INSERT OR REPLACE INTO product_fulfillment (venture_id, product_name, price_cents, fulfillment_prompt, customer_inputs, deliverable_format, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [ventureId, product.productName, product.pricePoint * 100, product.fulfillmentPrompt, JSON.stringify(product.customerInputs), product.deliverableFormat || 'markdown', Date.now()]);

    // Log work
    for (const bot of bots) {
      const taskId = await this.workspace.createTask({
        ventureId,
        title: `Build ${product.productName} — ${bot.name}'s contribution`,
        description: product.deliverable,
        estimatedHours: 10,
        assignedTo: bot.id
      });
      await this.workspace.completeTask({
        taskId,
        botId: bot.id,
        deliverable: `Built fulfillable product: ${product.productName}. Price: $${product.pricePoint}. Target: ${product.targetBuyer}`
      });
    }

    console.log(`   ✅ Product built: ${product.productName}`);
    console.log(`   📍 Page: /products/${this.slugify(product.productName)}`);
    console.log(`   💰 Price: $${product.pricePoint}`);
    console.log(`   🎯 Fulfillment: Configured and ready`);

    return {
      ventureId,
      slug: this.slugify(product.productName),
      productName: product.productName,
      price: product.pricePoint
    };
  }

  /**
   * Generate a landing page with a real intake form
   */
  async generateLandingPage(product, ventureId) {
    const formFields = product.customerInputs.map(input => {
      if (input.type === 'select') {
        const options = (input.options || []).map(o => `<option value="${o}">${o}</option>`).join('');
        return `<div class="field"><label>${input.label}</label><select name="${input.field}" required>${options}</select></div>`;
      } else if (input.type === 'textarea') {
        return `<div class="field"><label>${input.label}</label><textarea name="${input.field}" placeholder="${input.placeholder || ''}" rows="4" required></textarea></div>`;
      } else {
        return `<div class="field"><label>${input.label}</label><input type="text" name="${input.field}" placeholder="${input.placeholder || ''}" required></div>`;
      }
    }).join('\n');

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `Create a complete, production-ready HTML landing page for this AI-powered product.

PRODUCT: ${product.productName}
TAGLINE: ${product.tagline}
PRICE: $${product.pricePoint}
TARGET BUYER: ${product.targetBuyer}
BUYER URGENCY: ${product.buyerUrgency}
WHAT THEY GET: ${product.deliverable}
UNFAIR ADVANTAGE: ${product.unfairAdvantage}

The page MUST include:
1. Compelling hero section explaining the value
2. How it works section (3 steps: Fill form → AI generates → Download)
3. What you get section (specific deliverables)
4. The actual intake form with these fields:
${formFields}
5. Price display ($${product.pricePoint}) 
6. Submit button that sends form data to: /api/fulfill/${ventureId}
7. Trust signals / FAQ section

CRITICAL TECHNICAL REQUIREMENTS:
- Single HTML file with inline CSS
- Modern, professional dark theme design
- Use Google Fonts (Sora or Inter)
- Mobile responsive
- Form submits via JavaScript fetch() to /api/fulfill/${ventureId} as POST with JSON body
- After submit, show loading state "Your deliverable is being generated..." 
- On response, display the result in a styled container below the form
- Include a "Pay $${product.pricePoint} to Download Full Version" button that links to /checkout/${ventureId}
- Show a PREVIEW of the deliverable (first ~20%) for free, full version behind payment

The form submission JavaScript should look like:
async function submitForm(e) {
  e.preventDefault();
  const formData = Object.fromEntries(new FormData(e.target));
  const resultDiv = document.getElementById('result');
  resultDiv.innerHTML = '<p class="loading">Generating your deliverable... (usually under 60 seconds)</p>';
  resultDiv.style.display = 'block';
  try {
    const res = await fetch('/api/fulfill/${ventureId}', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(formData) });
    const data = await res.json();
    if (data.preview) {
      resultDiv.innerHTML = '<div class="preview">' + data.preview + '</div><div class="paywall"><p>This is a preview. Get the full deliverable for $${product.pricePoint}</p><a href="/checkout/${ventureId}" class="btn">Unlock Full Version — $${product.pricePoint}</a></div>';
    } else {
      resultDiv.innerHTML = '<p>Error: ' + (data.error || 'Unknown error') + '</p>';
    }
  } catch(err) {
    resultDiv.innerHTML = '<p>Error generating deliverable. Please try again.</p>';
  }
}

Output ONLY the complete HTML. No explanation, no markdown fencing.`
      }]
    });

    let html = response.content[0].text;
    html = html.replace(/```html\n?/g, '').replace(/```\n?/g, '').trim();
    return html;
  }

  /**
   * FULFILL — Generate a deliverable for a paying customer
   */
  async fulfillOrder(ventureId, customerInputs) {
    const fulfillment = await this.db.query(
      'SELECT * FROM product_fulfillment WHERE venture_id = ?', [ventureId]
    );

    if (fulfillment.length === 0) throw new Error('No fulfillment config found');
    
    const config = fulfillment[0];
    const inputFields = JSON.parse(config.customer_inputs);

    // Build the context from customer inputs
    const customerContext = Object.entries(customerInputs)
      .map(([key, value]) => {
        const fieldConfig = inputFields.find(f => f.field === key);
        const label = fieldConfig ? fieldConfig.label : key;
        return `${label}: ${value}`;
      })
      .join('\n');

    console.log(`\n📦 Fulfilling order for ${config.product_name}`);
    console.log(`   Customer inputs: ${Object.keys(customerInputs).length} fields`);

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `${config.fulfillment_prompt}

CUSTOMER INFORMATION:
${customerContext}

Generate a comprehensive, professional deliverable based on the customer's specific information above. This is a paid product — the quality must be outstanding. Be specific to their situation, not generic.

Format the output in clean markdown with headers, bullet points, and clear structure.`
      }]
    });

    const fullDeliverable = response.content[0].text;
    
    // Create preview (first ~25% of content)
    const lines = fullDeliverable.split('\n');
    const previewLines = lines.slice(0, Math.max(Math.ceil(lines.length * 0.25), 10));
    const preview = previewLines.join('\n') + '\n\n---\n\n*[Preview ends here — unlock the full deliverable to see the complete analysis, recommendations, and action plan]*';

    // Convert markdown to basic HTML for display
    const previewHtml = this.markdownToHtml(preview);
    const fullHtml = this.markdownToHtml(fullDeliverable);

    // Log the fulfillment
    await this.db.run(`
      INSERT INTO bot_messages (id, from_bot_id, venture_id, message_type, content, timestamp, status)
      VALUES (?, ?, ?, 'fulfillment', ?, ?, 'sent')
    `, [uuidv4(), 'system', ventureId, `Order fulfilled: ${config.product_name}`, Date.now()]);

    return {
      preview: previewHtml,
      full: fullHtml,
      productName: config.product_name
    };
  }

  /**
   * Simple markdown to HTML converter
   */
  markdownToHtml(md) {
    return md
      .replace(/^### (.*$)/gm, '<h3>$1</h3>')
      .replace(/^## (.*$)/gm, '<h2>$1</h2>')
      .replace(/^# (.*$)/gm, '<h1>$1</h1>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/^- (.*$)/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
      .replace(/^---$/gm, '<hr>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>')
      .replace(/^(.+)$/gm, (match) => {
        if (match.startsWith('<')) return match;
        return match;
      });
  }

  /**
   * RUN FULL PIPELINE — Think → Evaluate → Build → Ready for customers
   */
  async runFullPipeline(botIds) {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║         STRATEGIC INTELLIGENCE ENGINE                     ║');
    console.log('║         Building Real, Fulfillable Products               ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    const bots = [];
    for (const id of botIds) {
      const bot = await this.protocol.getBot(id);
      bots.push(bot);
    }

    // THINK — Deep strategic analysis
    const opportunities = await this.strategicAnalysis(bots);

    // EVALUATE — Score and pick the best
    const evaluation = await this.evaluateOpportunities(opportunities);

    // Find the winning product
    const winner = opportunities.find(o => o.productName === evaluation.winner) || opportunities[0];

    // BUILD — Create the fulfillable product
    const product = await this.buildFulfillableProduct(bots, winner);

    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log(`║  PRODUCT READY: ${product.productName}`);
    console.log(`║  Page: /products/${product.slug}`);
    console.log(`║  Price: $${product.price}`);
    console.log(`║  Fulfillment: ACTIVE — customers can order now`);
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    return {
      success: true,
      ...product,
      evaluation: evaluation.reasoning,
      capabilities: this.getCurrentCapabilities().phase
    };
  }

  slugify(text) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }
}

module.exports = StrategicIntelligenceEngine;
