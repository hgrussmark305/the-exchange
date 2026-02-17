# BOTXCHANGE.AI — PLATFORM PIVOT

Read CLAUDE.md first for project context. The repo is at /workspaces/the-exchange. Deployed on Railway at https://botxchange.ai (auto-deploys on git push to main).

## WHAT CHANGED

We are pivoting from "The Exchange" (an AI work marketplace where bots complete freelance jobs) to **BotXchange** (an execution platform where founders get a governed AI team that runs outbound revenue workflows). This is NOT a rebuild — it's a restructuring. Much of the existing infrastructure carries over.

**Old model:** Humans post jobs → bots collaborate to fulfill them → payment flows
**New model:** Founders onboard → platform assigns a fixed AI execution team → team runs outbound revenue workflows → founder approves key decisions → platform takes % of attributable revenue

## THE VISION

BotXchange is an execution platform for early founders with traction, where a governed AI execution team runs outbound revenue workflows, founders approve key decisions, and payment only occurs when value is proven.

The target customer is a solo or small-team founder (1-5 people) who has a live product, a defined offer, some leads or early revenue, and is overwhelmed by execution. They want leverage without hiring. They do NOT want to design workflows, wire tools, or manage agents.

## WHAT TO KEEP VS REPLACE

### KEEP (rename/restructure):
- Express server architecture (server.js)
- SQLite database (database.js) — new tables, keep old ones dormant
- Anthropic Claude API integration — already working
- Stripe payment processing — restructure for credits/revenue share model
- Railway deployment pipeline — already working
- Basic auth system — extend for founder accounts

### REPLACE:
- Old bot personas (CEO/CMO/CTO) → New fixed agent team (see below)
- Old job posting flow → New founder onboarding flow
- Old dashboard → New Execution Control Panel
- Old homepage → New BotXchange landing page
- Old bounty/job marketplace → New venture-based execution system
- collaboration-engine.js, collaborative-ventures.js, run-debate.js → Remove or archive

### NEW:
- Founder onboarding system
- Venture management (each founder = one venture)
- Agent execution team with fixed roles
- Structured memory architecture (4 layers per venture)
- Proof-of-work system for every agent action
- Activity feed with evidence drawer
- Kill switch (pause all execution)
- Credit system (founders load credits, pay their own agent costs)
- Revenue attribution tracking

---

## PHASE 1: Database Schema for New Model

Keep ALL existing tables (don't drop anything). Add new tables for the pivot. The old systems stay dormant.

```sql
-- Founders: platform users who run ventures
CREATE TABLE IF NOT EXISTS founders (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  
  -- Onboarding
  business_description TEXT,
  offer TEXT,
  icp TEXT,                          -- ideal customer profile (JSON)
  brand_constraints TEXT,            -- JSON: {tone, forbidden_claims, proof_requirements}
  
  -- Email integration
  email_provider TEXT,               -- 'instantly', 'smartlead', 'smtp'
  email_provider_config TEXT,        -- encrypted JSON with API keys/SMTP config
  sending_domain TEXT,
  domain_warmup_confirmed INTEGER DEFAULT 0,
  
  -- Settings
  autonomy_mode TEXT DEFAULT 'bootstrap',  -- 'bootstrap' or 'accelerate'
  monthly_spend_ceiling_cents INTEGER DEFAULT 20000,  -- $200 default
  
  -- Credits
  credit_balance_cents INTEGER DEFAULT 0,
  total_credits_purchased_cents INTEGER DEFAULT 0,
  
  -- Timestamps
  created_at INTEGER,
  onboarding_completed_at INTEGER,
  last_active_at INTEGER
);

-- Ventures: each founder has one active venture
CREATE TABLE IF NOT EXISTS ventures (
  id TEXT PRIMARY KEY,
  founder_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'onboarding',  -- onboarding, active, paused, completed
  venture_type TEXT DEFAULT 'outbound_revenue',  -- only option in MVP
  
  -- Execution state
  kill_switch_active INTEGER DEFAULT 0,
  daily_emails_sent INTEGER DEFAULT 0,
  daily_email_limit INTEGER DEFAULT 25,  -- bootstrap default
  
  -- Revenue tracking
  total_revenue_cents INTEGER DEFAULT 0,
  platform_take_rate REAL DEFAULT 0.05,  -- 5%
  total_platform_revenue_cents INTEGER DEFAULT 0,
  
  -- Stats
  total_prospects_found INTEGER DEFAULT 0,
  total_emails_sent INTEGER DEFAULT 0,
  total_replies INTEGER DEFAULT 0,
  total_meetings_booked INTEGER DEFAULT 0,
  total_deals_closed INTEGER DEFAULT 0,
  
  created_at INTEGER,
  updated_at INTEGER,
  FOREIGN KEY (founder_id) REFERENCES founders(id)
);

-- Agents: the fixed execution team per venture
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  venture_id TEXT NOT NULL,
  role TEXT NOT NULL,                 -- 'research', 'messaging', 'quality', 'outreach', 'ops'
  display_name TEXT NOT NULL,         -- 'Head of Research', 'CRO', 'CMO', 'CQO', 'Chief of Staff'
  status TEXT DEFAULT 'idle',         -- idle, working, blocked, needs_approval
  current_task TEXT,
  
  -- Stats
  actions_completed INTEGER DEFAULT 0,
  spend_cents INTEGER DEFAULT 0,     -- API costs this agent has consumed
  pending_approvals INTEGER DEFAULT 0,
  
  created_at INTEGER,
  FOREIGN KEY (venture_id) REFERENCES ventures(id)
);

-- Tasks: every unit of work an agent performs
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  venture_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  
  -- Task definition
  title TEXT NOT NULL,
  description TEXT,
  task_type TEXT NOT NULL,            -- 'research', 'draft_email', 'review', 'send_email', 'report', 'follow_up'
  
  -- Lifecycle: created → in_progress → review → approved → executed → logged
  status TEXT DEFAULT 'created',
  
  -- Approval
  requires_approval INTEGER DEFAULT 1,  -- 1 in bootstrap mode
  approved_by TEXT,                     -- 'founder' or 'quality_agent'
  approved_at INTEGER,
  
  -- Proof of work (CRITICAL — no task can reach 'executed' without these)
  intent TEXT,                        -- what the agent planned to do
  artifact TEXT,                      -- the actual output (email draft, prospect list, etc.)
  receipt TEXT,                       -- external verification (API response ID, delivery confirmation)
  cost_cents INTEGER DEFAULT 0,       -- tokens/API costs for this task
  
  -- Linking
  input_from_task TEXT,               -- ID of task whose output feeds this one
  prospect_id TEXT,                   -- if related to a specific prospect
  
  created_at INTEGER,
  started_at INTEGER,
  completed_at INTEGER,
  FOREIGN KEY (venture_id) REFERENCES ventures(id),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

-- Prospects: relationship memory per contact
CREATE TABLE IF NOT EXISTS prospects (
  id TEXT PRIMARY KEY,
  venture_id TEXT NOT NULL,
  
  -- Contact info
  email TEXT,
  name TEXT,
  title TEXT,
  company TEXT,
  company_url TEXT,
  linkedin_url TEXT,
  
  -- Research
  source_url TEXT,                    -- where we found them
  icp_match_reason TEXT,              -- why they match the ICP
  icp_confidence_score REAL,          -- 0.0 - 1.0
  research_notes TEXT,                -- JSON: company info, recent news, pain points
  
  -- Outreach state
  outreach_status TEXT DEFAULT 'new', -- new, contacted, replied, meeting_booked, closed_won, closed_lost, unresponsive, opted_out
  
  -- Interaction history (JSON array)
  interactions TEXT DEFAULT '[]',     -- [{date, type, content, response}]
  
  -- Follow-up
  next_follow_up_date INTEGER,
  follow_up_count INTEGER DEFAULT 0,
  
  -- Sentiment
  last_response_sentiment TEXT,       -- positive, neutral, negative, not_now
  
  created_at INTEGER,
  updated_at INTEGER,
  FOREIGN KEY (venture_id) REFERENCES ventures(id)
);

-- Memory: structured memory architecture (4 layers)
CREATE TABLE IF NOT EXISTS venture_memory (
  id TEXT PRIMARY KEY,
  venture_id TEXT NOT NULL,
  layer TEXT NOT NULL,                -- 'vision', 'execution', 'relationship', 'performance'
  key TEXT NOT NULL,                  -- memory key (e.g., 'icp_definition', 'brand_voice', 'best_subject_line')
  value TEXT NOT NULL,                -- the memory content
  
  -- Access control
  readable_by TEXT DEFAULT 'all',     -- 'all' or JSON array of agent roles
  writable_by TEXT DEFAULT 'system',  -- 'founder', 'system', or specific agent role
  
  -- Metadata
  source TEXT,                        -- who/what created this memory
  created_at INTEGER,
  updated_at INTEGER,
  FOREIGN KEY (venture_id) REFERENCES ventures(id)
);

-- Activity log: every action for the activity feed
CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY,
  venture_id TEXT NOT NULL,
  agent_id TEXT,                      -- null for system events
  
  -- Event
  event_type TEXT NOT NULL,           -- 'prospect_found', 'email_drafted', 'email_approved', 'email_sent', 'reply_received', 'meeting_booked', 'deal_closed', 'quality_flag', 'kill_switch', 'credit_reload', etc.
  message TEXT NOT NULL,              -- human-readable description
  details TEXT,                       -- JSON with additional context
  
  -- Linking
  task_id TEXT,
  prospect_id TEXT,
  
  created_at INTEGER,
  FOREIGN KEY (venture_id) REFERENCES ventures(id)
);

-- Revenue events: for attribution tracking
CREATE TABLE IF NOT EXISTS revenue_events (
  id TEXT PRIMARY KEY,
  venture_id TEXT NOT NULL,
  prospect_id TEXT,
  
  -- Revenue
  amount_cents INTEGER NOT NULL,
  attribution_type TEXT NOT NULL,     -- 'stripe_connected', 'founder_confirmed'
  
  -- Attribution chain
  originating_email_task_id TEXT,     -- which outreach task started this
  attribution_chain TEXT,             -- JSON: [{task_id, type, date}] showing email→reply→meeting→close
  
  -- Platform take
  platform_take_cents INTEGER,
  
  -- Status
  status TEXT DEFAULT 'pending',      -- pending, confirmed, disputed
  confirmed_at INTEGER,
  
  created_at INTEGER,
  FOREIGN KEY (venture_id) REFERENCES ventures(id)
);

-- Credit transactions
CREATE TABLE IF NOT EXISTS credit_transactions (
  id TEXT PRIMARY KEY,
  founder_id TEXT NOT NULL,
  
  amount_cents INTEGER NOT NULL,      -- positive = deposit, negative = spend
  balance_after_cents INTEGER NOT NULL,
  
  description TEXT,                   -- 'Credit purchase', 'API cost: Research Agent', etc.
  transaction_type TEXT NOT NULL,     -- 'purchase', 'api_cost', 'tool_cost', 'refund'
  
  -- Linking
  task_id TEXT,                       -- which task consumed this credit
  stripe_payment_intent TEXT,         -- for purchases
  
  created_at INTEGER,
  FOREIGN KEY (founder_id) REFERENCES founders(id)
);
```

### Database migration approach:
- Use `CREATE TABLE IF NOT EXISTS` for all new tables
- Do NOT drop existing tables (jobs, bounties, bots, etc.)
- Mark old bots inactive: `UPDATE bots SET active = 0;`
- Old systems remain functional but dormant

---

## PHASE 2: Agent Execution Team

Create a new file: `agents.js` that exports the agent execution classes. These replace the old bot classes in `bots.js`.

### Fixed Agent Team (5 agents per venture, no customization)

| Role | Display Name | Model | Responsibility | Permissions |
|------|-------------|-------|---------------|-------------|
| research | Head of Research | Haiku | Prospect identification, company research, contact enrichment | Read web, enrichment APIs |
| messaging | CMO | Haiku (Sonnet for premium) | Personalized outreach copy, email variants | Write drafts only |
| quality | CQO | Sonnet | Claim verification, tone check, compliance, brand consistency | Block/flag actions, override other agents |
| outreach | CRO | Haiku | Email sequencing, sending via connected provider, follow-ups | Send emails (tool-gated, requires approval in bootstrap) |
| ops | Chief of Staff | Haiku | Coordination, reporting, performance dashboards, alerts | Read all, write logs |

### Agent Architecture

```javascript
// agents.js

const Anthropic = require('@anthropic-ai/sdk');
const cheerio = require('cheerio');

class BaseAgent {
  constructor(venture, role, model = 'claude-haiku-4-5-20251001') {
    this.venture = venture;
    this.role = role;
    this.model = model;
    this.client = new Anthropic(); // uses ANTHROPIC_API_KEY env var
  }

  // Every agent action goes through this — enforces proof-of-work
  async executeTask(task) {
    // 1. Update task status to 'in_progress'
    // 2. Load relevant memory layers for this agent's role
    // 3. Execute the specific task logic (overridden by subclass)
    // 4. Validate proof-of-work: intent + artifact + receipt required
    // 5. Log cost (tokens used)
    // 6. Update task status to 'review' (or 'executed' if no approval needed)
    // 7. Log to activity feed
    // 8. Return result
  }

  async loadMemory(layers) {
    // Query venture_memory for specified layers
    // Return formatted context string for the agent's prompt
  }

  async logActivity(eventType, message, details) {
    // Insert into activity_log
  }

  async deductCredits(costCents, taskId) {
    // Deduct from founder's credit balance
    // Insert credit_transaction
    // If balance would go negative, pause and alert founder
  }
}

class ResearchAgent extends BaseAgent {
  constructor(venture) {
    super(venture, 'research', 'claude-haiku-4-5-20251001');
  }

  // Find prospects matching the founder's ICP
  async findProspects(icp, count = 20) {
    // 1. Load vision memory (ICP definition, brand constraints)
    // 2. Load execution memory (already-found prospects to avoid duplicates)
    // 3. Use web scraping (fetch + cheerio) to find companies matching ICP
    // 4. For each prospect: extract name, title, company, email (if findable), company URL
    // 5. Score each prospect on ICP match (0.0 - 1.0)
    // 6. Store in prospects table with source_url and icp_match_reason
    // 7. PROOF: source URL required for every prospect, no prospect without a source
    // 8. Return structured prospect list
  }

  // Deep research on a specific prospect/company
  async researchCompany(companyUrl) {
    // Scrape company website, extract key info
    // Return structured data: what they do, team size, recent news, pain points
  }
}

class MessagingAgent extends BaseAgent {
  constructor(venture) {
    super(venture, 'messaging', 'claude-haiku-4-5-20251001');
  }

  // Draft personalized outreach email for a prospect
  async draftEmail(prospect, sequence_position = 1) {
    // 1. Load vision memory (offer, brand voice, forbidden claims)
    // 2. Load relationship memory for this prospect
    // 3. Load performance memory (best-performing subject lines, templates)
    // 4. Generate personalized email referencing prospect's company/role
    // 5. Auto-check against forbidden claims list
    // 6. PROOF: draft stored as artifact, references to prospect data logged
    // 7. Return email draft (subject, body) — does NOT send
  }

  // Generate email variants for A/B testing
  async generateVariants(prospect, count = 3) {
    // Create multiple approaches: direct, value-first, question-based
  }
}

class QualityAgent extends BaseAgent {
  constructor(venture) {
    super(venture, 'quality', 'claude-sonnet-4-5-20250514');  // Sonnet for better judgment
  }

  // Review an email draft before sending
  async reviewEmail(draft, prospect, brandConstraints) {
    // 1. Check for forbidden claims
    // 2. Verify tone matches brand constraints
    // 3. Check for unverified claims/statistics
    // 4. Verify personalization is accurate to prospect data
    // 5. Score: pass / flag (with reason) / block (with reason)
    // 6. CQO decisions OVERRIDE other agents
    // 7. PROOF: review logged with specific issues found
  }

  // Review a prospect list for quality
  async reviewProspects(prospects, icp) {
    // Verify ICP match, flag duplicates, check data quality
  }
}

class OutreachAgent extends BaseAgent {
  constructor(venture) {
    super(venture, 'outreach', 'claude-haiku-4-5-20251001');
  }

  // Queue emails for sending (requires approval in bootstrap mode)
  async queueEmails(approvedDrafts) {
    // 1. Check kill switch — if active, refuse
    // 2. Check daily send limit — if hit, refuse and alert
    // 3. Check budget ceiling — if hit, refuse and alert
    // 4. For each draft: create task with status 'needs_approval' (bootstrap) or 'approved' (accelerate)
    // 5. PROOF: queue confirmation with count and recipient list
  }

  // Actually send emails via connected provider
  async sendEmail(task, emailConfig) {
    // 1. Verify task is approved
    // 2. Send via founder's email provider (Instantly API, Smartlead API, or SMTP)
    // 3. PROOF: provider message ID + timestamp + recipient = receipt
    // 4. Update prospect outreach_status
    // 5. Log interaction in prospect's interaction history
    // 6. Deduct credits for sending cost
  }

  // Schedule follow-ups
  async scheduleFollowUps(prospects) {
    // Based on performance memory: optimal follow-up timing
    // Create follow-up tasks with future execution dates
  }
}

class OpsAgent extends BaseAgent {
  constructor(venture) {
    super(venture, 'ops', 'claude-haiku-4-5-20251001');
  }

  // Generate daily report
  async generateReport(venture) {
    // Pull stats: emails sent, replies, meetings, spend
    // Compare to performance memory benchmarks
    // Flag anomalies
  }

  // Coordinate the execution pipeline
  async runDailyExecution(venture) {
    // This is the main orchestration loop:
    // 1. Check kill switch
    // 2. Check credit balance
    // 3. ResearchAgent.findProspects() if pipeline needs more
    // 4. MessagingAgent.draftEmail() for new prospects
    // 5. QualityAgent.reviewEmail() on all drafts
    // 6. Queue approved emails via OutreachAgent
    // 7. OutreachAgent.scheduleFollowUps() for contacted prospects
    // 8. Generate daily report
    // 9. Update performance memory with today's metrics
  }
}
```

### Key implementation rules:
- Every agent method must populate: intent, artifact, receipt on the task
- No task reaches 'executed' status without all three proof fields
- Quality Agent uses Sonnet; all others use Haiku
- All agents read from venture_memory before acting
- Credit deduction happens on every API call
- Kill switch check happens before every outbound action
- Daily email limit enforced by OutreachAgent before any send

---

## PHASE 3: Founder Onboarding

### 3A: Signup Page (/signup)
Clean, minimal signup form:
- Email
- Password
- Business name

On submit: create founder record, redirect to /onboarding

### 3B: Onboarding Flow (/onboarding)
Multi-step form that must be completed in ≤ 7 minutes. Each step saves progress so founders can resume.

**Step 1: Your Business**
- "Describe your business in 2-3 sentences" (textarea)
- "What's your offer? What do you sell?" (textarea)

**Step 2: Your Ideal Customer**
- Industry (dropdown: SaaS, E-commerce, Agency, Professional Services, Healthcare, Finance, Education, Other)
- Company size (dropdown: 1-10, 11-50, 51-200, 201-1000, 1000+)
- Title/Role of decision maker (text input)
- "What pain point does your product solve for them?" (textarea)

**Step 3: Your Brand Voice**
- Tone (radio: Professional, Casual, Bold, Friendly)
- "Any claims or phrases we should NEVER use?" (textarea, optional)
- "Any specific proof points we should include?" (textarea, optional)

**Step 4: Connect Email**
- Provider selection (tabs: Instantly, Smartlead, Custom SMTP)
- API key / SMTP credentials input
- "Is your sending domain warmed up?" (checkbox with explanation tooltip)
- If not warmed up: show warning, set daily limit to 10 instead of 25

**Step 5: Set Budget**
- Monthly spend ceiling slider ($50 - $1000)
- "Load initial credits" button → Stripe Checkout for first credit purchase (minimum $25)
- Explanation: "Credits cover AI processing and tool costs. You only pay for what your team uses."

**Step 6: Launch**
- Review summary of all inputs
- "Launch Your Team" button
- On click: create venture, create 5 agents, populate vision memory from onboarding data, redirect to /dashboard

### 3C: On Venture Creation
When the "Launch Your Team" button is pressed:

```javascript
async function createVenture(founderId, onboardingData) {
  // 1. Create venture record
  const ventureId = generateId();
  
  // 2. Create 5 agents for this venture
  const agents = [
    { role: 'research', display_name: 'Head of Research' },
    { role: 'messaging', display_name: 'CMO' },
    { role: 'quality', display_name: 'CQO' },
    { role: 'outreach', display_name: 'CRO' },
    { role: 'ops', display_name: 'Chief of Staff' }
  ];
  
  // 3. Populate vision memory from onboarding data
  const visionMemory = [
    { key: 'business_description', value: onboardingData.businessDescription },
    { key: 'offer', value: onboardingData.offer },
    { key: 'icp', value: JSON.stringify(onboardingData.icp) },
    { key: 'brand_tone', value: onboardingData.tone },
    { key: 'forbidden_claims', value: onboardingData.forbiddenClaims || '' },
    { key: 'proof_points', value: onboardingData.proofPoints || '' }
  ];
  
  // 4. Initialize performance memory with defaults
  const performanceMemory = [
    { key: 'avg_reply_rate', value: '0' },
    { key: 'best_subject_line', value: '' },
    { key: 'optimal_send_time', value: '9:00 AM' },
    { key: 'emails_per_day_target', value: '25' }
  ];
  
  // 5. Log activity: "Venture launched — your team is ready"
}
```

---

## PHASE 4: Execution Control Panel (Dashboard)

This replaces the old dashboard entirely. New route: `/dashboard`

### 4A: Layout

Three-panel layout:

**Left Panel: Agent Team View**
For each of the 5 agents, show a card:
- Agent avatar/icon + display name (e.g., "CRO")
- Current status badge: idle (gray), working (blue), blocked (red), needs approval (amber)
- Current task text (if working)
- Spend this month: $X.XX
- Actions completed: N
- Pending approvals: N (clickable → shows approval queue)

**Center Panel: Activity Feed**
Reverse-chronological feed of all agent actions:
- Each entry: timestamp + agent name + human-readable message
- Every entry is clickable → opens evidence drawer
- Color-coded by event type
- Auto-refreshes every 30 seconds (or websocket if feasible)

Examples:
- "Head of Research identified 42 prospects matching your ICP (view sources)"
- "CMO drafted 3 email variants for SaaS segment"
- "CQO flagged email #47 — unverified claim about '10x ROI'"
- "CRO queued 25 emails — awaiting your approval"
- "Chief of Staff: Daily report — 23 emails sent, 3 replies, $4.50 spent"

**Right Panel: Evidence Drawer (expandable)**
When an activity entry is clicked, show:
- Intent: what the agent planned to do
- Artifact: the actual output (email draft, prospect list, report) — rendered nicely
- Receipt: API confirmation, delivery ID, timestamp
- Cost: tokens consumed, dollar amount

### 4B: Top Bar
- Venture name + status badge
- Credit balance: "$XX.XX remaining" with "Add Credits" button
- Monthly spend: "$XX / $XXX ceiling"
- **Kill Switch button: "⏸ Pause Everything"** — always visible, red, prominent

### 4C: Approval Queue
When there are pending approvals (bootstrap mode):
- Modal or slide-over showing each item awaiting approval
- For email approvals: show the email draft, recipient, subject line
- "Approve" / "Reject" / "Edit & Approve" buttons per item
- "Approve All" button for batch approval

### 4D: Stats Bar (below top bar or as sub-nav)
Quick stats: Prospects Found | Emails Sent | Replies | Meetings Booked | Revenue

### 4E: Kill Switch Implementation
When kill switch is activated:
```javascript
async function activateKillSwitch(ventureId) {
  // 1. Set ventures.kill_switch_active = 1
  // 2. Cancel all tasks with status 'in_progress' or 'approved'
  // 3. Set all agents to status 'idle'
  // 4. Log activity: "⏸ Kill switch activated — all activity paused"
  // 5. Return confirmation to UI
  // To resume: founder clicks "Resume" → kill_switch_active = 0
}
```

---

## PHASE 5: Landing Page & Branding

### 5A: Rebrand homepage (/)
Replace the old "The Exchange" homepage with BotXchange branding.

**Hero Section:**
- Headline: "Your AI Execution Team"
- Subheadline: "Tell us your business. We'll build your team. They start working today."
- CTA: "Get Started Free" → /signup
- Secondary CTA: "See How It Works" → scrolls down

**How It Works (3 steps):**
1. "Describe your business" — "Tell us what you sell and who you sell to. Takes 5 minutes."
2. "Meet your team" — "We create a 5-person AI execution team: Research, Messaging, Quality, Outreach, and Operations."
3. "Watch them work" — "Your team researches prospects, writes personalized outreach, and sends emails — you approve the important decisions."

**Trust Signals:**
- "You control the budget" — hard spending ceilings, pay only for what's used
- "Every action has proof" — evidence drawer, full audit trail
- "One-click pause" — kill switch stops everything instantly
- "Pay only for results" — 5% of revenue you actually earn

**For Founders Section:**
- "You're already overwhelmed. Let your AI team handle outbound while you build your product."
- "No workflows to design. No tools to wire. No agents to manage."

### 5B: Design System
Keep the existing dark theme but update branding:
- Replace all "The Exchange" text with "BotXchange"
- Update logo/branding
- Keep: Dark theme, Sora/JetBrains Mono fonts, green/blue/amber accents
- Keep: Mobile responsive design

### 5C: Navigation
Update nav bar:
- Logo "BotXchange" (links to /)
- How It Works (anchor link on homepage)
- Dashboard (/dashboard) — for logged-in founders
- Login (/login)
- "Get Started" button (/signup)

Remove old nav items: Browse Jobs, Post a Job, Leaderboard, Connect Your Bot, Ventures

---

## PHASE 6: Memory Architecture

### 6A: Memory Layers

Each venture has 4 memory layers stored in `venture_memory` table:

**Vision Memory** (writable_by: 'founder')
- Business description, ICP, offer, brand voice, constraints
- Populated from onboarding, editable by founder
- Read by ALL agents before every action
- Rarely changes

**Execution Memory** (writable_by: 'system')
- What's been done, what's pending, what failed
- Append-only log of completed actions
- Agents read to avoid duplication and maintain continuity
- Auto-summarized weekly to prevent bloat

**Relationship Memory** (writable_by: 'system')
- Stored in prospects table (interactions, sentiment, follow-up dates)
- Each prospect record IS relationship memory
- CRM-like: "They said check back in Q3" persists and triggers action
- Agents read before any interaction with a prospect

**Performance Memory** (writable_by: 'system')
- Reply rates by segment, best subject lines, optimal send times
- Updated after each outreach cycle
- Agents read to self-optimize over time
- Key for the compounding moat

### 6B: Memory Access per Agent

| Agent | Reads | Writes |
|-------|-------|--------|
| Research | Vision (ICP), Execution (avoid duplicates) | Execution (prospects found), Relationship (new prospects) |
| Messaging | Vision (brand/offer), Relationship (prospect data), Performance (best templates) | Execution (drafts created) |
| Quality | Vision (forbidden claims), Execution (draft to review), Relationship (prospect data) | Execution (review results) |
| Outreach | Execution (approved emails), Relationship (interaction history) | Execution (emails sent), Relationship (updated status) |
| Ops | All layers | Performance (updated metrics), Execution (reports) |

### 6C: Founder Memory Controls
- Founder can view all memory layers from dashboard
- Founder can edit vision memory (change ICP, update offer, etc.)
- Founder can reset relationship memory (for ICP pivots)
- Founder can view but not edit execution and performance memory

---

## PHASE 7: Revenue & Credits System

### 7A: Credit System
Founders pre-load credits to cover agent costs (API tokens, tool usage).

**Credit purchase flow:**
1. Founder clicks "Add Credits" on dashboard
2. Select amount: $25, $50, $100, $250, or custom
3. Stripe Checkout session
4. On webhook success: add credits to founder's balance
5. Log credit_transaction

**Credit deduction:**
- Every AI API call: estimate token cost, deduct from balance
- Every tool call (email sending, enrichment): deduct actual cost
- If balance reaches $0: pause all agent activity, alert founder
- Show running balance on dashboard at all times

### 7B: Revenue Attribution (MVP)
For MVP, two attribution paths:

**Path 1: Founder confirmation**
- Founder manually marks a deal as closed-won from the dashboard
- Selects which prospect and enters revenue amount
- Platform calculates 5% take
- Revenue event logged

**Path 2: Stripe connection (future, not MVP)**
- Founder connects Stripe account
- Platform monitors for payments from prospects in the system
- Auto-attributes revenue to outreach chain

### 7C: Revenue Dashboard
On the dashboard, show:
- Total revenue attributed
- Platform take (5%)
- Revenue by prospect (which outreach led to which deals)
- Attribution chain visualization: email → reply → meeting → close

---

## PHASE 8: Execution Modes

### 8A: Bootstrap Mode (default)
- Human approval required before ANY email is sent
- Max 25 emails/day (10 if domain not warmed)
- Quality Agent reviews ALL drafts
- Full evidence required for every action
- Daily spend alerts
- Auto-pause at budget ceiling

### 8B: Accelerate Mode (unlocked after 14 days + founder opt-in)
- Only flagged items require approval
- Max 100 emails/day (subject to domain safety)
- Quality Agent reviews samples (20%)
- Evidence logged but non-blocking
- Weekly spend summaries
- Auto-pause at budget ceiling

Founder can switch modes from dashboard settings.

---

## TECHNICAL NOTES

- **Agent architecture**: All 5 agent classes in `agents.js`. Each extends BaseAgent which handles memory loading, proof-of-work validation, credit deduction, and activity logging.
- **Dependencies**: `npm install cheerio` for Research Agent web scraping. Everything else uses built-in fetch and existing Anthropic SDK.
- **Old systems**: Keep all old tables, routes, and files. Mark old bots inactive. Old dashboard accessible at /dashboard-old if needed. New system runs in parallel.
- **Stripe keys**: Already in Railway env vars — reuse for credit purchases.
- **Anthropic API key**: Already in Railway env var — reuse.
- **Rate limits**: Quality Agent uses Sonnet (8k tokens/min limit). All other agents use Haiku. Process tasks sequentially with 2-second delays.
- **Kill switch**: Check `ventures.kill_switch_active` before EVERY outbound action (email sends, follow-ups). This is non-negotiable.
- **Proof-of-work**: No task reaches 'executed' without intent + artifact + receipt. This is enforced in BaseAgent.executeTask().
- **Email sending**: The platform does NOT send emails directly. It calls the founder's connected email provider API (Instantly, Smartlead, SMTP). The founder owns the sending infrastructure and compliance.
- **Daily email limit**: Enforced in OutreachAgent. Reset counter at midnight UTC. Check before every send.
- **Credit balance**: Check before every API call. If insufficient, pause and alert.
- **Database**: SQLite on persistent Railway volume. CREATE TABLE IF NOT EXISTS for all new tables. Don't touch existing tables.

## GIT WORKFLOW
```bash
git add -A
git commit -m "descriptive message"
git push origin main
# Railway auto-deploys — check https://botxchange.ai
```

## AUTH
- Founder auth: email + password (bcrypt hash)
- Admin: harrison@botxchange.ai / (keep existing password)
- API keys for email providers stored encrypted in founder record

## PRIORITY ORDER
Build in this order:
1. **Phase 1** (schema) — foundation for everything
2. **Phase 3** (onboarding) — founders need to be able to sign up
3. **Phase 2** (agents) — the execution team needs to exist
4. **Phase 4** (dashboard) — founders need to see their team
5. **Phase 5** (landing page) — need to attract founders
6. **Phase 6** (memory) — agents need context to work well
7. **Phase 7** (credits/revenue) — payment flows
8. **Phase 8** (execution modes) — bootstrap is default, accelerate comes later

## START NOW
Begin with Phase 1 — create all new database tables. Then build the founder signup and onboarding flow. Then create the agent classes. The goal is: a founder can sign up, complete onboarding, see their 5-agent team on a dashboard, and trigger a prospect research cycle — all within the first sprint.

Read the existing server.js first to understand the current structure. Add new routes alongside existing ones. Don't break anything that currently works.
