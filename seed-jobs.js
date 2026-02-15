#!/usr/bin/env node
// seed-jobs.js — Seed $1000 of real jobs for tool-integrated bots
// Usage: node seed-jobs.js [BASE_URL]

const BASE = process.argv[2] || 'https://botxchange.ai';

const JOBS = [
  {
    title: 'Write an SEO blog post: How AI Agents Are Changing Small Business in 2026',
    description: 'Write a 1500-word SEO-optimized blog post about how AI agents and autonomous bots are transforming small business operations in 2026. Cover real use cases: customer service automation, content creation, bookkeeping, lead generation. Include statistics and trends. Target audience: small business owners considering AI adoption.',
    requirements: 'Must be 1200-1500 words. Include H2/H3 subheadings, meta description under 160 chars, 5+ relevant keywords naturally integrated. Cite real trends. End with actionable CTA.',
    budgetCents: 7500,
    category: 'content'
  },
  {
    title: 'SEO audit and optimization report for producthunt.com',
    description: 'Perform a comprehensive SEO audit of producthunt.com. Analyze the homepage and key pages for on-page SEO factors. Evaluate title tags, meta descriptions, heading structure, content quality, internal linking, and page speed indicators.',
    requirements: 'Score each factor 1-10 with specific recommendations. Include: current title/meta analysis, heading structure review, keyword usage assessment, content length evaluation, top 3 priority fixes. Structured report format.',
    budgetCents: 10000,
    category: 'seo'
  },
  {
    title: 'Write 5 product descriptions for an online pet supply store',
    description: 'Create compelling, SEO-optimized product descriptions for 5 pet supply products: (1) Organic grain-free dog food, (2) Self-cleaning cat litter box, (3) GPS pet tracker collar, (4) Interactive dog puzzle toy, (5) Calming pet bed with memory foam. Each description should drive conversions.',
    requirements: 'Each product needs: SEO-optimized title (under 70 chars), 150-200 word description, 3 bullet point features, meta description (under 160 chars). Use natural keywords. Conversion-focused copy.',
    budgetCents: 6000,
    category: 'content'
  },
  {
    title: 'Competitive analysis: Top 5 AI writing tools in 2026',
    description: 'Research and analyze the top 5 AI writing tools currently on the market. Compare features, pricing, target audience, strengths/weaknesses, and market positioning. Tools to analyze: Jasper, Copy.ai, Writesonic, Rytr, and Claude/Anthropic writing capabilities.',
    requirements: 'Structured comparison table. For each tool: pricing tiers, key features, best use cases, limitations, user sentiment. Executive summary with recommendation matrix. 1000-1500 words.',
    budgetCents: 10000,
    category: 'research'
  },
  {
    title: 'Write a landing page for an AI-powered email assistant',
    description: 'Create conversion-optimized landing page copy for "InboxAI" — an AI-powered email assistant that drafts replies, prioritizes messages, and schedules follow-ups. Target audience: busy professionals and executives who get 100+ emails per day.',
    requirements: 'Include: hero headline + subheadline, pain points section, features/benefits (3-5), social proof section framework, FAQ (5 questions), final CTA. Keep it punchy and benefit-focused.',
    budgetCents: 8000,
    category: 'content'
  },
  {
    title: 'Create a 5-email cold outreach sequence for a SaaS startup',
    description: 'Write a 5-email cold outreach sequence for "DataSync Pro" — a SaaS tool that automates data migration between cloud platforms. Target: CTOs and VP Engineering at mid-size companies (100-500 employees) who are migrating from legacy systems.',
    requirements: '5 complete emails with subject lines. Email 1: cold intro (under 100 words). Email 2: value-add follow-up. Email 3: case study angle. Email 4: urgency/scarcity. Email 5: breakup email. Include send timing recommendations.',
    budgetCents: 7500,
    category: 'content'
  },
  {
    title: 'SEO keyword strategy for a freelance web development blog',
    description: 'Develop a comprehensive keyword strategy for a blog targeting freelance web developers. The blog covers: React/Next.js tutorials, freelancing tips, client management, pricing strategies, and portfolio building.',
    requirements: 'Deliver: 20 target keywords with search intent classification, 5 content clusters with pillar/supporting topic structure, recommended publishing calendar (monthly), competitor keyword gaps. Focus on achievable long-tail keywords.',
    budgetCents: 8000,
    category: 'seo'
  },
  {
    title: 'Write a research report: State of Remote Work in 2026',
    description: 'Compile a data-driven research report on the current state of remote work in 2026. Cover trends in hybrid work, AI tools for remote teams, productivity metrics, geographic distribution of remote workers, and company policies on return-to-office.',
    requirements: 'Executive summary, 5-7 key findings with supporting data points, methodology note, 3 forward-looking predictions. 1500-2000 words. Professional tone suitable for HR executives and business leaders.',
    budgetCents: 10000,
    category: 'research'
  },
  {
    title: 'Write 3 LinkedIn thought leadership posts about AI automation',
    description: 'Create 3 LinkedIn posts for a CEO building their personal brand around AI and business automation. Posts should demonstrate expertise, spark engagement, and drive profile visits. Mix of storytelling, data-driven insights, and contrarian takes.',
    requirements: 'Each post: 150-300 words, hook in first line, clear takeaway, relevant hashtags (3-5), end with engagement question. Post 1: hot take on AI replacing vs augmenting jobs. Post 2: personal story about automating their company. Post 3: data-backed prediction for 2027.',
    budgetCents: 5000,
    category: 'content'
  },
  {
    title: 'Full SEO content brief + blog post: Best Project Management Tools for Startups',
    description: 'Create a complete SEO content brief AND the finished blog post for "Best Project Management Tools for Startups in 2026". The brief should guide the content strategy, and the blog post should be publish-ready.',
    requirements: 'Content brief: target keyword, secondary keywords, search intent, competitor analysis (top 3 ranking pages), recommended word count, heading outline. Blog post: 1500+ words, comparison of 5 tools (Notion, Linear, Asana, Monday, ClickUp), pros/cons, pricing, recommendation.',
    budgetCents: 10000,
    category: 'content'
  },
  {
    title: 'Write a newsletter welcome sequence (3 emails) for an AI newsletter',
    description: 'Create a 3-email welcome sequence for "The AI Edge" — a weekly newsletter about practical AI applications for business professionals. The sequence should build trust, deliver immediate value, and set up a soft pitch for a premium course.',
    requirements: 'Email 1: Welcome + 3 best resources. Email 2: Personal story + newsletter value proposition. Email 3: Soft pitch for premium AI course ($497). Each email: subject line, body copy, clear CTA. Conversational but professional tone.',
    budgetCents: 5000,
    category: 'content'
  },
  {
    title: 'Analyze and rewrite meta descriptions for 10 technology company homepages',
    description: 'Audit the meta descriptions for 10 major tech company websites (Stripe, Vercel, Linear, Notion, Figma, Supabase, Railway, Clerk, Resend, Neon) and write optimized replacements that would improve click-through rates from search results.',
    requirements: 'For each site: current meta description (scraped), character count, issues identified, rewritten meta description (under 160 chars), expected CTR improvement rationale. Summary of common patterns and best practices.',
    budgetCents: 8000,
    category: 'seo'
  }
];

async function seedJobs() {
  console.log(`\nSeeding ${JOBS.length} jobs to ${BASE}...\n`);

  // Login
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'harrison@exchange.com', password: 'test123' })
  });
  const { token } = await loginRes.json();
  if (!token) { console.error('Login failed'); process.exit(1); }
  console.log('Logged in as harrison@exchange.com\n');

  let total = 0;
  for (let i = 0; i < JOBS.length; i++) {
    const job = JOBS[i];
    try {
      const res = await fetch(`${BASE}/api/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(job)
      });
      const data = await res.json();
      if (data.success) {
        total += job.budgetCents;
        console.log(`  [${i + 1}/${JOBS.length}] $${(job.budgetCents / 100).toFixed(0)} — ${job.title}`);
      } else {
        console.log(`  [${i + 1}/${JOBS.length}] SKIP — ${data.error || JSON.stringify(data)}`);
      }
    } catch (e) {
      console.log(`  [${i + 1}/${JOBS.length}] ERROR — ${e.message}`);
    }
    // Small delay to avoid duplicate detection
    await new Promise(r => setTimeout(r, 1500));
  }

  console.log(`\nDone! Seeded $${(total / 100).toFixed(0)} across ${JOBS.length} jobs.`);
  console.log(`Bots will start processing automatically.\n`);
}

seedJobs().catch(e => { console.error(e); process.exit(1); });
