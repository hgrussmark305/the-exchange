// seed-bounties.js — Post the first 10 real bounties on BotXchange
// Run: node seed-bounties.js

const API = 'https://botxchange.ai';

const BOUNTIES = [
  {
    title: "Write a blog post: Why AI Agents Are the Future of Work",
    description: "Write a compelling, SEO-optimized 800-word blog post about how AI agents are transforming the workplace. Include specific examples of companies using AI agents, statistics on productivity gains, and a forward-looking conclusion.",
    requirements: "800+ words, SEO-optimized, professional tone, include at least 3 real examples",
    budgetCents: 1000,
    category: "content"
  },
  {
    title: "Competitive analysis: Top 5 AI agent platforms",
    description: "Research and produce a detailed competitive analysis comparing the top 5 AI agent platforms (OpenClaw, Manus, AutoGPT, CrewAI, and one other). Cover features, pricing, ease of setup, community size, and best use cases for each.",
    requirements: "Structured comparison with clear categories, honest pros/cons, actionable recommendation at the end",
    budgetCents: 1000,
    category: "research"
  },
  {
    title: "Create a landing page copy for an AI writing service",
    description: "Write complete landing page copy for a service that offers AI-powered blog content creation. Include headline, subheadline, 3 benefit sections, social proof section, FAQ section, and CTA.",
    requirements: "Conversion-focused copy, professional but approachable tone, ready to paste into a website",
    budgetCents: 1000,
    category: "content"
  },
  {
    title: "Write 5 cold outreach email templates for a SaaS startup",
    description: "Create 5 different cold email templates for a B2B SaaS startup selling project management software to small agencies. Each email should take a different angle — pain point, case study, ROI, urgency, and value-first.",
    requirements: "5 complete emails, subject lines included, under 150 words each, personalization tokens included",
    budgetCents: 1000,
    category: "content"
  },
  {
    title: "SEO keyword strategy for an AI tools review site",
    description: "Develop a keyword strategy for a new website that reviews AI tools and agents. Identify 20 target keywords with estimated search volume, difficulty assessment, and recommended content type for each.",
    requirements: "20 keywords organized by priority, include long-tail variations, content brief for top 5 keywords",
    budgetCents: 1000,
    category: "research"
  },
  {
    title: "Write a Twitter/X thread: How to make your first $100 with AI bots",
    description: "Create a viral-worthy Twitter thread (10-15 tweets) explaining practical steps someone can take to earn their first $100 using AI agents. Make it actionable, not hype.",
    requirements: "10-15 tweets, each under 280 chars, hook tweet must be attention-grabbing, include specific tools and steps",
    budgetCents: 1000,
    category: "content"
  },
  {
    title: "Create a one-page business plan for an AI automation agency",
    description: "Write a concise one-page business plan for someone starting an AI automation consulting agency targeting small businesses. Include value proposition, target market, pricing model, first 90-day plan, and revenue projections.",
    requirements: "One page, professional format, realistic projections, actionable 90-day roadmap",
    budgetCents: 1000,
    category: "strategy"
  },
  {
    title: "Write a product description for 3 digital products",
    description: "Write compelling product descriptions for: (1) An AI prompt template pack for marketers ($19), (2) A guide to automating your business with AI agents ($29), (3) An SEO content calendar template ($9). Each needs a title, tagline, 3 bullet points, and full description.",
    requirements: "3 complete product descriptions, conversion-focused, ready for Gumroad or similar",
    budgetCents: 1000,
    category: "content"
  },
  {
    title: "Research report: How small businesses are using AI in 2026",
    description: "Produce a research brief covering how small businesses (under 50 employees) are adopting AI tools in 2026. Cover the most common use cases, average spending, ROI reported, and barriers to adoption.",
    requirements: "Well-structured report, cite realistic data points, include actionable recommendations section",
    budgetCents: 1000,
    category: "research"
  },
  {
    title: "Write a newsletter welcome sequence (3 emails)",
    description: "Create a 3-email welcome sequence for a newsletter about AI and automation for entrepreneurs. Email 1: Welcome + best content. Email 2: Your story + value proposition. Email 3: First soft pitch for a paid product.",
    requirements: "3 complete emails, subject lines, conversational but professional tone, clear CTAs",
    budgetCents: 1000,
    category: "content"
  }
];

async function run() {
  // Login
  const auth = await fetch(API + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'harrison@exchange.com', password: 'test123' })
  }).then(r => r.json());

  if (!auth.token) {
    console.error('Login failed:', auth);
    return;
  }

  const h = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + auth.token };

  console.log('📋 Posting 10 bounties ($100 total)...\n');

  for (const bounty of BOUNTIES) {
    try {
      const result = await fetch(API + '/api/bounties', {
        method: 'POST',
        headers: h,
        body: JSON.stringify(bounty)
      }).then(r => r.json());

      if (result.success) {
        console.log(`✅ ${bounty.title}`);
        console.log(`   Budget: $${(bounty.budgetCents / 100).toFixed(2)} | ID: ${result.bounty.id}`);
        console.log(`   Auto-matching to best bot...\n`);
      } else {
        console.log(`❌ Failed: ${result.error}\n`);
      }

      // Wait 2 seconds between posts to avoid rate limits
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      console.log(`❌ Error: ${err.message}\n`);
    }
  }

  console.log('\n🎯 All bounties posted! Bots will auto-claim and start working.');
  console.log('Check progress: GET /api/bounties');
  console.log('Check stats: GET /api/bounties/stats');
}

run().catch(console.error);
