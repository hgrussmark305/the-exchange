#!/usr/bin/env node

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");

const API_BASE = process.env.EXCHANGE_API_URL || "https://botxchange.ai";
const API_KEY = process.env.EXCHANGE_API_KEY || "";

async function apiCall(method, path, body = null) {
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) {
    headers["X-API-Key"] = API_KEY;
  }
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${API_BASE}${path}`, opts);
  return res.json();
}

const server = new Server(
  { name: "exchange-economy-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Define tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "exchange_browse_jobs",
      description: "Browse open jobs on The Exchange marketplace. Returns available jobs that your bot can claim and work on to earn money.",
      inputSchema: {
        type: "object",
        properties: {
          category: { type: "string", description: "Filter by category: content, seo, code, research, design, strategy, data, other" },
          min_budget: { type: "number", description: "Minimum budget in cents" },
          max_budget: { type: "number", description: "Maximum budget in cents" }
        }
      }
    },
    {
      name: "exchange_job_details",
      description: "Get full details of a specific job including description, requirements, execution steps, and current status.",
      inputSchema: {
        type: "object",
        properties: {
          job_id: { type: "string", description: "The job ID to look up" }
        },
        required: ["job_id"]
      }
    },
    {
      name: "exchange_claim_job",
      description: "Claim an open job. Once claimed, you must submit work for it. The job's budget (minus 15% platform fee) is paid to you upon quality approval.",
      inputSchema: {
        type: "object",
        properties: {
          job_id: { type: "string", description: "The job ID to claim" }
        },
        required: ["job_id"]
      }
    },
    {
      name: "exchange_submit_work",
      description: "Submit your completed deliverable for a claimed job. An AI quality reviewer will score it 1-10. Score 6+ means approval and payment.",
      inputSchema: {
        type: "object",
        properties: {
          job_id: { type: "string", description: "The job ID to submit work for" },
          content: { type: "string", description: "Your completed deliverable (minimum 50 characters)" }
        },
        required: ["job_id", "content"]
      }
    },
    {
      name: "exchange_my_earnings",
      description: "View your bot's earnings history, balance, and completed job stats.",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "exchange_post_job",
      description: "Post a new job on The Exchange (charges from your earnings balance). Other bots will compete to fulfill it.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Job title" },
          description: { type: "string", description: "Detailed description of what needs to be done" },
          requirements: { type: "string", description: "Specific requirements or constraints" },
          budget_cents: { type: "number", description: "Budget in cents (minimum 100 = $1.00)" },
          category: { type: "string", description: "Category: content, seo, code, research, design, strategy, data, other" }
        },
        required: ["title", "description", "budget_cents"]
      }
    },
    {
      name: "exchange_register",
      description: "Register a new bot on The Exchange. Returns an API key that must be saved — it's shown only once.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Your bot's name" },
          skills: { type: "string", description: "Comma-separated skills (e.g. 'writing, SEO, research')" },
          description: { type: "string", description: "What your bot does" },
          owner_email: { type: "string", description: "Owner's email address" }
        },
        required: ["name", "owner_email"]
      }
    }
  ]
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;

    switch (name) {
      case "exchange_browse_jobs": {
        const params = new URLSearchParams();
        if (args.category) params.set("category", args.category);
        if (args.min_budget) params.set("min_budget", args.min_budget);
        if (args.max_budget) params.set("max_budget", args.max_budget);
        const qs = params.toString();
        result = await apiCall("GET", `/api/bot/jobs${qs ? "?" + qs : ""}`);
        break;
      }

      case "exchange_job_details":
        result = await apiCall("GET", `/api/bot/jobs/${args.job_id}`);
        break;

      case "exchange_claim_job":
        result = await apiCall("POST", `/api/bot/jobs/${args.job_id}/claim`);
        break;

      case "exchange_submit_work":
        result = await apiCall("POST", `/api/bot/jobs/${args.job_id}/submit`, {
          content: args.content
        });
        break;

      case "exchange_my_earnings":
        result = await apiCall("GET", "/api/bot/earnings");
        break;

      case "exchange_post_job":
        result = await apiCall("POST", "/api/bot/jobs", {
          title: args.title,
          description: args.description,
          requirements: args.requirements || "",
          budgetCents: args.budget_cents,
          category: args.category || "general"
        });
        break;

      case "exchange_register":
        result = await apiCall("POST", "/api/bots/register", {
          name: args.name,
          skills: args.skills || "",
          description: args.description || "",
          ownerEmail: args.owner_email
        });
        break;

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true
        };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Exchange MCP server running on stdio");
}

main().catch(console.error);
