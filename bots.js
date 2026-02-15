// bots.js — Tool-integrated bot classes for The Exchange
// Each bot has REAL tool access, not just a different system prompt.

const cheerio = require('cheerio');

// ============================================================
// BOT 1: ResearchBot — Web scraping & data extraction
// ============================================================
class ResearchBot {
  constructor(anthropicClient) {
    this.client = anthropicClient;
    this.name = 'ResearchBot';
    this.id = 'research-bot';
  }

  async scrapeUrl(url) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ExchangeBot/1.0; +https://the-exchange-production-14b3.up.railway.app)' },
        signal: AbortSignal.timeout(15000)
      });
      const html = await response.text();
      const $ = cheerio.load(html);

      const title = $('title').text().trim();
      const metaDescription = $('meta[name="description"]').attr('content') || '';
      const h1s = $('h1').map((i, el) => $(el).text().trim()).get();
      const h2s = $('h2').map((i, el) => $(el).text().trim()).get();
      const links = $('a[href]').map((i, el) => ({ text: $(el).text().trim(), href: $(el).attr('href') })).get().slice(0, 50);
      const images = $('img[src]').map((i, el) => ({ alt: $(el).attr('alt') || '', src: $(el).attr('src') })).get().slice(0, 20);

      $('script, style, nav, footer, header, aside, iframe, noscript').remove();
      const bodyText = $('body').text().replace(/\s+/g, ' ').trim();

      return {
        success: true,
        url,
        title,
        metaDescription,
        h1s,
        h2s,
        links,
        images,
        bodyText: bodyText.substring(0, 8000),
        wordCount: bodyText.split(/\s+/).length
      };
    } catch (err) {
      return { success: false, url, error: err.message };
    }
  }

  async scrapeShopifyProducts(storeUrl) {
    try {
      const cleanUrl = storeUrl.replace(/\/$/, '');
      const response = await fetch(`${cleanUrl}/products.json?limit=250`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ExchangeBot/1.0)' },
        signal: AbortSignal.timeout(15000)
      });
      const data = await response.json();
      return {
        success: true,
        storeUrl: cleanUrl,
        productCount: data.products.length,
        products: data.products.map(p => ({
          title: p.title,
          description: p.body_html ? p.body_html.replace(/<[^>]*>/g, '').substring(0, 500) : '',
          vendor: p.vendor,
          type: p.product_type,
          tags: p.tags,
          price: p.variants[0]?.price,
          compareAtPrice: p.variants[0]?.compare_at_price,
          variants: p.variants.length,
          images: p.images.map(i => i.src).slice(0, 3),
          handle: p.handle,
          url: `${cleanUrl}/products/${p.handle}`
        }))
      };
    } catch (err) {
      return { success: false, storeUrl, error: err.message };
    }
  }

  async researchTopic(urls, topic) {
    const scraped = [];
    for (const url of urls.slice(0, 5)) {
      const result = await this.scrapeUrl(url);
      if (result.success) scraped.push(result);
      await new Promise(r => setTimeout(r, 1000));
    }

    const response = await this.client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: `Research topic: "${topic}"

I scraped ${scraped.length} web pages. Synthesize the key findings into a structured research brief.

SCRAPED DATA:
${scraped.map((s, i) => `--- SOURCE ${i+1}: ${s.url} ---
Title: ${s.title}
Content excerpt: ${s.bodyText.substring(0, 2000)}`).join('\n\n')}

Produce a JSON research brief:
{
  "topic": "${topic}",
  "key_findings": ["finding 1", "finding 2"],
  "statistics": ["stat 1", "stat 2"],
  "trends": ["trend 1", "trend 2"],
  "sources_used": ${scraped.length},
  "summary": "2-3 paragraph synthesis"
}`
      }]
    });
    return response.content[0].text;
  }

  async analyzePage(url, analysisType) {
    const scraped = await this.scrapeUrl(url);
    if (!scraped.success) return JSON.stringify({ error: `Failed to scrape: ${scraped.error}` });

    const response = await this.client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: `Analyze this webpage. Analysis type: ${analysisType}

URL: ${scraped.url}
Title: ${scraped.title} (${scraped.title.length} chars)
Meta Description: ${scraped.metaDescription} (${scraped.metaDescription.length} chars)
H1 Tags: ${JSON.stringify(scraped.h1s)}
H2 Tags: ${JSON.stringify(scraped.h2s)}
Images: ${scraped.images.length} found
Links: ${scraped.links.length} found
Word Count: ~${scraped.wordCount}

Page Content (excerpt):
${scraped.bodyText.substring(0, 4000)}

Provide a structured JSON analysis.`
      }]
    });
    return response.content[0].text;
  }
}

// ============================================================
// BOT 2: SEOBot — Keyword research, SERP analysis, content optimization
// ============================================================
class SEOBot {
  constructor(anthropicClient, researchBot) {
    this.client = anthropicClient;
    this.research = researchBot;
    this.name = 'SEOBot';
    this.id = 'seo-bot';
  }

  async analyzeKeyword(keyword) {
    const response = await this.client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: `You are an SEO analyst. For the keyword "${keyword}", provide a comprehensive analysis.

Respond ONLY with valid JSON:
{
  "keyword": "${keyword}",
  "search_intent": "informational|transactional|navigational|commercial",
  "competition_level": "low|medium|high",
  "difficulty_score": 1-100,
  "suggested_title": "under 60 chars",
  "suggested_meta_description": "under 160 chars",
  "heading_structure": {
    "h1": "main heading",
    "h2s": ["subheading 1", "subheading 2", "subheading 3", "subheading 4"],
    "h3s": ["detail 1", "detail 2"]
  },
  "related_keywords": ["keyword 1", "keyword 2", "keyword 3", "keyword 4", "keyword 5", "keyword 6", "keyword 7", "keyword 8", "keyword 9", "keyword 10"],
  "content_recommendations": {
    "word_count": 1500,
    "content_type": "guide|listicle|comparison|tutorial|review",
    "topics_to_cover": ["topic 1", "topic 2", "topic 3", "topic 4", "topic 5"],
    "cta_suggestions": ["cta 1", "cta 2"]
  }
}`
      }]
    });
    return response.content[0].text;
  }

  async auditPage(url) {
    const scraped = await this.research.scrapeUrl(url);
    if (!scraped.success) return JSON.stringify({ error: `Failed to scrape: ${scraped.error}` });

    const response = await this.client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: `Perform an SEO audit on this REAL page data (scraped just now):

URL: ${scraped.url}
Title: "${scraped.title}" (${scraped.title.length} chars)
Meta Description: "${scraped.metaDescription}" (${scraped.metaDescription.length} chars)
H1 Tags: ${JSON.stringify(scraped.h1s)}
H2 Tags: ${JSON.stringify(scraped.h2s)}
Images: ${scraped.images.length} total (${scraped.images.filter(i => !i.alt).length} missing alt text)
Internal Links: ${scraped.links.filter(l => l.href && l.href.startsWith('/')).length}
External Links: ${scraped.links.filter(l => l.href && l.href.startsWith('http')).length}
Word Count: ~${scraped.wordCount}

Content excerpt:
${scraped.bodyText.substring(0, 3000)}

Score each factor 1-10 and provide SPECIFIC fixes based on the actual data above.

Respond ONLY with valid JSON:
{
  "url": "${scraped.url}",
  "scores": {
    "title_tag": {"score": 0, "issue": "specific issue or good", "fix": "specific fix"},
    "meta_description": {"score": 0, "issue": "", "fix": ""},
    "heading_structure": {"score": 0, "issue": "", "fix": ""},
    "content_length": {"score": 0, "issue": "", "fix": ""},
    "image_optimization": {"score": 0, "issue": "", "fix": ""},
    "internal_linking": {"score": 0, "issue": "", "fix": ""},
    "overall": 0
  },
  "top_3_priorities": ["priority 1", "priority 2", "priority 3"],
  "optimized_title": "improved title under 60 chars",
  "optimized_meta": "improved meta description under 160 chars"
}`
      }]
    });
    return response.content[0].text;
  }

  async productSEOStrategy(products) {
    const response = await this.client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: `You are an e-commerce SEO specialist. Analyze these REAL products (scraped from a live store) and create an SEO strategy.

PRODUCTS:
${products.slice(0, 20).map((p, i) => `${i+1}. "${p.title}" — $${p.price} — Type: ${p.type || 'N/A'} — Tags: ${p.tags || 'none'}
   Current description (excerpt): ${(p.description || 'NONE').substring(0, 150)}`).join('\n')}

Respond ONLY with valid JSON:
{
  "store_analysis": {
    "product_count": ${products.length},
    "categories_found": ["cat1", "cat2"],
    "pricing_range": "$X - $Y",
    "seo_gaps": ["gap 1", "gap 2", "gap 3"]
  },
  "keyword_strategy": {
    "primary_keywords": ["kw1", "kw2", "kw3"],
    "long_tail_keywords": ["ltkw1", "ltkw2", "ltkw3", "ltkw4", "ltkw5"],
    "category_keywords": {"category": ["keywords"]}
  },
  "per_product_guidance": [
    {
      "product": "product title",
      "target_keyword": "primary keyword",
      "title_template": "SEO title under 70 chars",
      "description_approach": "brief guidance for writer bot"
    }
  ]
}`
      }]
    });
    return response.content[0].text;
  }
}

// ============================================================
// BOT 3: WriterBot — Content generation grounded in real data
// ============================================================
class WriterBot {
  constructor(anthropicClient) {
    this.client = anthropicClient;
    this.name = 'WriterBot';
    this.id = 'writer-bot';
  }

  async writeProductDescriptions(products, seoData) {
    const response = await this.client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: `Write SEO-optimized product descriptions for these REAL products (scraped from a live store).

PRODUCTS:
${products.slice(0, 10).map((p, i) => `${i+1}. "${p.title}" — Price: $${p.price} — Type: ${p.type || 'N/A'}
   Current description: ${(p.description || 'NONE').substring(0, 200)}
   URL: ${p.url || 'N/A'}`).join('\n')}

SEO STRATEGY (from SEOBot analysis):
${typeof seoData === 'string' ? seoData : JSON.stringify(seoData)}

For EACH product write:
1. SEO-optimized title (under 70 chars, include target keyword)
2. Product description (150-200 words, naturally incorporate keywords)
3. 3-4 bullet point features/benefits
4. Meta description (under 160 chars)

CRITICAL RULES:
- Use the ACTUAL product details above. Do NOT invent features not implied by the data.
- Each description must be unique — no template copy-paste.
- Write for humans first, search engines second.
- Include the target keywords naturally, not stuffed.

Format as a clear deliverable the customer can copy and use immediately.`
      }]
    });
    return response.content[0].text;
  }

  async writeBlogPost(topic, researchData, seoData) {
    const researchStr = typeof researchData === 'string' ? researchData.substring(0, 3000) : JSON.stringify(researchData).substring(0, 3000);
    const seoStr = typeof seoData === 'string' ? seoData.substring(0, 1500) : JSON.stringify(seoData).substring(0, 1500);
    const response = await this.client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: `Write an SEO-optimized blog post.

TOPIC: ${topic}

RESEARCH (from ResearchBot):
${researchStr}

SEO KEYWORDS (from SEOBot):
${seoStr}

Write a 1000-1200 word blog post that:
1. Uses the researched facts — do NOT make up statistics
2. Naturally incorporates target keywords
3. Has a compelling title under 60 chars
4. Includes H2 and H3 subheadings
5. Opens with a hook, not "In today's world..."
6. Ends with a clear CTA
7. Includes a meta description under 160 chars

CRITICAL: Completeness over length. Finish every section. End with a proper conclusion. Never stop mid-sentence.`
      }]
    });

    // If truncated, retry with shorter prompt
    if (response.stop_reason === 'max_tokens') {
      console.log('   WriterBot output truncated — retrying with shorter target...');
      const retry = await this.client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8192,
        messages: [{
          role: 'user',
          content: `Write a COMPLETE 800-word SEO blog post on: ${topic}\n\nKey points from research: ${researchStr.substring(0, 1500)}\n\nBe concise. Cover ALL sections. End with a conclusion. NEVER stop mid-sentence.`
        }]
      });
      return retry.content[0].text;
    }
    return response.content[0].text;
  }

  async writeLandingPage(topic, competitorAnalysis, seoData) {
    const response = await this.client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: `Write conversion-focused landing page copy.

PRODUCT/SERVICE: ${topic}

COMPETITOR ANALYSIS (from ResearchBot):
${typeof competitorAnalysis === 'string' ? competitorAnalysis : JSON.stringify(competitorAnalysis)}

SEO DATA (from SEOBot):
${typeof seoData === 'string' ? seoData : JSON.stringify(seoData)}

Write complete landing page sections:
1. Hero: headline (under 10 words), subheadline (under 25 words), CTA button text
2. Problem/Pain section: 3 pain points the audience faces
3. Solution section: how this product solves each pain point
4. Features section: 4-6 features with titles and descriptions
5. Social proof section: placeholder for testimonials + suggested messaging
6. FAQ section: 5 common questions and answers
7. Final CTA section: urgency-driven closing with CTA

Use insights from competitor analysis to differentiate. Target the SEO keywords naturally.`
      }]
    });
    return response.content[0].text;
  }

  async writeContent(brief) {
    const briefStr = typeof brief === 'string' ? brief.substring(0, 5000) : JSON.stringify(brief).substring(0, 5000);
    const response = await this.client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: `You are WriterBot on The Exchange, a professional content writer.

BRIEF:
${briefStr}

CRITICAL RULES:
1. COMPLETENESS IS #1 PRIORITY. Cover every section and requirement. Never cut off mid-sentence.
2. Keep content under 1200 words. Be concise but thorough — brevity beats length.
3. If the task covers multiple items (e.g. "10 companies"), cover ALL of them with shorter entries rather than going deep on a few.
4. End with a proper conclusion. If running long, wrap up quickly rather than stopping mid-thought.
5. Be professional, engaging, and specific. Use any research data or SEO guidelines provided.
6. Do not hallucinate facts — if you don't have specific data, make reasonable general statements.`
      }]
    });

    // If truncated, retry with condensed prompt
    if (response.stop_reason === 'max_tokens') {
      console.log('   WriterBot output truncated — retrying condensed...');
      const retry = await this.client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8192,
        messages: [{
          role: 'user',
          content: `Write a COMPLETE, CONCISE deliverable (under 800 words) for this task:\n\n${briefStr.substring(0, 3000)}\n\nCover ALL requirements briefly. End with a proper conclusion. NEVER stop mid-sentence.`
        }]
      });
      return retry.content[0].text;
    }
    return response.content[0].text;
  }
}

// ============================================================
// BOT 4: QualityBot — Review, fact-check, score deliverables
// ============================================================
class QualityBot {
  constructor(anthropicClient, researchBot) {
    this.client = anthropicClient;
    this.research = researchBot;
    this.name = 'QualityBot';
    this.id = 'quality-bot';
  }

  async reviewDeliverable(job, deliverable, stepOutputs) {
    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `You are QualityBot, the quality reviewer for The Exchange AI marketplace.

JOB REQUIREMENTS:
Title: ${job.title}
Description: ${job.description}
Requirements: ${job.requirements || 'None specified'}
Category: ${job.category || 'general'}
Budget: $${(job.budget_cents / 100).toFixed(2)}

DELIVERABLE TO REVIEW:
${typeof deliverable === 'string' ? deliverable.substring(0, 5000) : JSON.stringify(deliverable).substring(0, 5000)}

${stepOutputs ? `PIPELINE DATA (what each bot produced):
${stepOutputs}` : 'Single-step job — no pipeline data.'}

Score this deliverable on 5 dimensions (each 0-10):

1. COMPLETENESS: Does it cover ALL requirements in the job description?
2. ACCURACY: Are facts/claims verifiable? Any obvious hallucinations or made-up data?
3. QUALITY: Is the writing professional, well-structured, and polished?
4. SEO (if applicable): Proper keywords, meta tags, heading structure? Score N/A as 7 if not relevant.
5. VALUE: Would the customer be satisfied at this price point? Is it worth $${(job.budget_cents / 100).toFixed(2)}?

Respond ONLY with valid JSON:
{
  "scores": {
    "completeness": 0,
    "accuracy": 0,
    "quality": 0,
    "seo": 0,
    "value": 0
  },
  "overall": 0,
  "passes": true,
  "feedback": "2-3 sentences of specific feedback",
  "issues": ["specific issue 1", "specific issue 2"],
  "strengths": ["specific strength 1", "specific strength 2"]
}

Overall score = average of 5 dimensions. Score 6+ passes. Be FAIR — judge relative to budget. A $10 job has different standards than a $100 job.`
      }]
    });
    return response.content[0].text;
  }

  async factCheck(deliverable) {
    const urlRegex = /https?:\/\/[^\s)>"]+/g;
    const urls = deliverable.match(urlRegex) || [];

    const verificationResults = [];
    for (const url of urls.slice(0, 3)) {
      const scraped = await this.research.scrapeUrl(url);
      if (scraped.success) {
        verificationResults.push({
          url,
          accessible: true,
          title: scraped.title,
          excerpt: scraped.bodyText.substring(0, 500)
        });
      } else {
        verificationResults.push({ url, accessible: false, error: scraped.error });
      }
    }

    return {
      urls_found: urls.length,
      urls_checked: verificationResults.length,
      results: verificationResults
    };
  }
}

// ============================================================
// JOB ORCHESTRATOR — Routes jobs through the bot pipeline
// ============================================================
class JobOrchestrator {
  constructor(anthropicClient) {
    this.research = new ResearchBot(anthropicClient);
    this.seo = new SEOBot(anthropicClient, this.research);
    this.writer = new WriterBot(anthropicClient);
    this.quality = new QualityBot(anthropicClient, this.research);
  }

  async analyzeAndPlan(job) {
    const response = await this.research.client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `You are the job orchestrator for The Exchange AI marketplace.

JOB:
Title: ${job.title}
Description: ${job.description}
Requirements: ${job.requirements || 'none specified'}
Category: ${job.category}
Budget: $${(job.budget_cents / 100).toFixed(2)}

AVAILABLE BOTS (each has real tool access):
- ResearchBot: web scraping, Shopify product extraction, competitive analysis, multi-URL research
- SEOBot: keyword analysis, page audits (uses ResearchBot's scraper), product SEO strategy
- WriterBot: blog posts, product descriptions, landing pages, email sequences (takes structured data input)
- QualityBot: review & scoring on 5 dimensions, fact-checking via URL verification (uses Sonnet model)

Create an execution plan. Respond ONLY with valid JSON:
{
  "complexity": "simple or multi_step",
  "steps": [
    {
      "step_number": 1,
      "bot": "research-bot or seo-bot or writer-bot",
      "method": "the specific bot method to call",
      "description": "what this step does",
      "input_source": "job_description or previous_step or url_from_description",
      "earnings_share": 0.0
    }
  ],
  "quality_review": true,
  "lead_bot": "bot-id",
  "estimated_quality": "high or medium or low",
  "reasoning": "1 sentence on why this plan"
}

RULES:
- ALWAYS end with QualityBot review (don't include in steps, it's automatic)
- For content jobs with a URL: start with ResearchBot scraping, then SEOBot analysis, then WriterBot
- For content jobs without a URL: start with SEOBot keyword analysis, then WriterBot
- For research/analysis jobs: ResearchBot does the heavy lifting, WriterBot formats
- For simple $5-10 jobs: 1-2 steps max. For $15+ jobs: 2-4 steps.
- Earnings share must total 1.0 across all steps (excluding QualityBot, which is platform cost)`
      }]
    });

    const text = response.content[0].text;
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Failed to parse orchestrator plan');
    return JSON.parse(match[0]);
  }

  async executeJob(job, plan) {
    const stepOutputs = [];
    let previousOutput = null;

    for (const step of plan.steps) {
      let result;
      try {
        result = await this.executeStep(step, job, previousOutput, stepOutputs);
      } catch (err) {
        console.error(`   Step ${step.step_number} failed: ${err.message}`);
        result = `Step failed: ${err.message}`;
      }

      stepOutputs.push({
        step: step.step_number,
        bot: step.bot,
        method: step.method,
        output: result
      });

      previousOutput = result;
      await new Promise(r => setTimeout(r, 2000));
    }

    // ── PEER REVIEW: SEOBot reviews content before QualityBot ──
    let peerFeedback = null;
    if (typeof previousOutput === 'string' && previousOutput.length > 200) {
      try {
        console.log(`   Peer review: SEOBot reviewing content...`);
        const peerReview = await this.seo.client.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1500,
          messages: [{
            role: 'user',
            content: `You are SEOBot, performing a peer review of content before final quality check.

JOB: ${job.title}
REQUIREMENTS: ${job.requirements || 'None specified'}

CONTENT TO REVIEW:
${previousOutput.substring(0, 4000)}

Review for these issues:
1. Missing sections or requirements not addressed
2. Weak SEO (missing keywords, bad heading structure, no meta description)
3. Content that could be stronger (vague claims, missing specifics)
4. Formatting issues

Respond with JSON:
{
  "issues": ["specific issue 1", "specific issue 2"],
  "suggestions": ["specific improvement 1", "specific improvement 2"],
  "needsRevision": true/false,
  "summary": "1-2 sentence peer review"
}`
          }]
        });
        const peerText = peerReview.content[0].text;
        const peerMatch = peerText.match(/\{[\s\S]*\}/);
        if (peerMatch) {
          peerFeedback = JSON.parse(peerMatch[0]);
          console.log(`   Peer review: ${peerFeedback.summary || 'Done'}`);
        }
      } catch (e) {
        console.error(`   Peer review failed: ${e.message}`);
      }
    }

    // ── REVISION LOOP: If peer review flagged issues, revise before quality check ──
    if (peerFeedback && peerFeedback.needsRevision && peerFeedback.issues && peerFeedback.issues.length > 0) {
      try {
        console.log(`   Revision: WriterBot revising based on peer feedback...`);
        const revisionResult = await this.writer.client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 8192,
          messages: [{
            role: 'user',
            content: `You are WriterBot. Your content was peer-reviewed and needs improvement.

ORIGINAL JOB: ${job.title}
REQUIREMENTS: ${job.requirements || 'None specified'}

YOUR CURRENT CONTENT:
${previousOutput.substring(0, 5000)}

PEER REVIEW FEEDBACK:
Issues found: ${peerFeedback.issues.join('; ')}
Suggestions: ${(peerFeedback.suggestions || []).join('; ')}

REVISE the content to fix ALL the issues above. Keep everything that was good, fix what was flagged. Output the COMPLETE revised content (not just the changes).`
          }]
        });
        previousOutput = revisionResult.content[0].text;
        stepOutputs.push({
          step: stepOutputs.length + 1,
          bot: 'writer-bot',
          method: 'revision_after_peer_review',
          output: previousOutput
        });
        console.log(`   Revision complete (${previousOutput.length} chars)`);
        await new Promise(r => setTimeout(r, 2000));
      } catch (e) {
        console.error(`   Revision failed: ${e.message}`);
      }
    }

    // ── QUALITY REVIEW (always runs) ──
    const stepSummary = stepOutputs.map(s =>
      `Step ${s.step} (${s.bot}): ${typeof s.output === 'string' ? s.output.substring(0, 500) : JSON.stringify(s.output).substring(0, 500)}`
    ).join('\n\n');

    const qualityResult = await this.quality.reviewDeliverable(
      job,
      previousOutput,
      stepSummary
    );

    let parsedQuality;
    try {
      const qMatch = qualityResult.match(/\{[\s\S]*\}/);
      parsedQuality = JSON.parse(qMatch[0]);
    } catch (e) {
      parsedQuality = { overall: 7, passes: true, feedback: 'Auto-approved', scores: {} };
    }

    // ── SECOND REVISION: If quality score < 7, revise once more with quality feedback ──
    if (parsedQuality.overall && parsedQuality.overall < 7 && !parsedQuality.passes) {
      try {
        console.log(`   Quality revision: Score ${parsedQuality.overall}/10 — WriterBot revising with quality feedback...`);
        const qRevision = await this.writer.client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 8192,
          messages: [{
            role: 'user',
            content: `You are WriterBot. Your deliverable was reviewed and scored ${parsedQuality.overall}/10. You need 7+ to pass.

ORIGINAL JOB: ${job.title}
REQUIREMENTS: ${job.requirements || 'None specified'}

YOUR CURRENT CONTENT:
${previousOutput.substring(0, 5000)}

QUALITY REVIEWER FEEDBACK:
Score: ${parsedQuality.overall}/10
Feedback: ${parsedQuality.feedback}
Issues: ${(parsedQuality.issues || []).join('; ')}
${parsedQuality.scores ? 'Dimension scores: completeness=' + parsedQuality.scores.completeness + ' accuracy=' + parsedQuality.scores.accuracy + ' quality=' + parsedQuality.scores.quality + ' seo=' + parsedQuality.scores.seo + ' value=' + parsedQuality.scores.value : ''}

REVISE to address every issue. Focus on:
- Completeness: cover ALL requirements
- Missing sections: add anything that was left out
- Specificity: replace vague claims with concrete details
- Structure: proper headings, formatting, meta descriptions

Output the COMPLETE revised content.`
          }]
        });
        previousOutput = qRevision.content[0].text;
        stepOutputs.push({
          step: stepOutputs.length + 1,
          bot: 'writer-bot',
          method: 'revision_after_quality_review',
          output: previousOutput
        });
        console.log(`   Quality revision complete — re-scoring...`);
        await new Promise(r => setTimeout(r, 2000));

        // Re-score the revised content
        const reScoreResult = await this.quality.reviewDeliverable(
          job,
          previousOutput,
          stepSummary + `\n\nRevision step (writer-bot): ${previousOutput.substring(0, 500)}`
        );
        try {
          const reMatch = reScoreResult.match(/\{[\s\S]*\}/);
          const reScore = JSON.parse(reMatch[0]);
          console.log(`   Re-scored: ${reScore.overall}/10 (was ${parsedQuality.overall}/10)`);
          parsedQuality = reScore;
        } catch (e) {
          // Keep original score if re-parse fails
        }
      } catch (e) {
        console.error(`   Quality revision failed: ${e.message}`);
      }
    }

    return {
      deliverable: previousOutput,
      steps: stepOutputs,
      quality: parsedQuality,
      plan: plan
    };
  }

  async executeStep(step, job, previousOutput, stepOutputs) {
    const description = job.description || '';
    const urlMatch = description.match(/https?:\/\/[^\s)>"]+/);
    const url = urlMatch ? urlMatch[0] : null;

    switch (step.bot) {
      case 'research-bot':
        if ((url && url.includes('shopify')) || description.toLowerCase().includes('shopify')) {
          return await this.research.scrapeShopifyProducts(url || description);
        } else if (url) {
          return await this.research.analyzePage(url, job.category || 'general');
        } else {
          // General research — use the topic from the job title
          return await this.research.analyzePage(
            `https://www.google.com/search?q=${encodeURIComponent(job.title)}`,
            job.category || 'general'
          );
        }

      case 'seo-bot':
        if (previousOutput && typeof previousOutput === 'object' && previousOutput.products) {
          return await this.seo.productSEOStrategy(previousOutput.products);
        } else if (url) {
          return await this.seo.auditPage(url);
        } else {
          const keyword = job.title.replace(/write|create|make|for|my|a|the|an/gi, '').trim();
          return await this.seo.analyzeKeyword(keyword);
        }

      case 'writer-bot':
        if (previousOutput && typeof previousOutput === 'string' && previousOutput.includes('per_product_guidance')) {
          const productStep = stepOutputs?.find(s => s.bot === 'research-bot');
          const products = productStep?.output?.products || [];
          return await this.writer.writeProductDescriptions(products, previousOutput);
        } else if (job.category === 'content_writing' || job.category === 'seo_marketing') {
          return await this.writer.writeBlogPost(job.title, previousOutput, previousOutput);
        } else {
          return await this.writer.writeContent({
            job_title: job.title,
            job_description: job.description,
            requirements: job.requirements,
            research_data: previousOutput,
            category: job.category
          });
        }

      default:
        return await this.writer.writeContent({
          job_title: job.title,
          job_description: job.description,
          previous_step_output: previousOutput
        });
    }
  }

  getBot(botId) {
    const map = {
      'research-bot': this.research,
      'seo-bot': this.seo,
      'writer-bot': this.writer,
      'quality-bot': this.quality
    };
    return map[botId] || this.writer;
  }
}

module.exports = { ResearchBot, SEOBot, WriterBot, QualityBot, JobOrchestrator };
