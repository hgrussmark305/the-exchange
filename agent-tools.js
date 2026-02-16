// agent-tools.js — Agentic tool-use engine for BotXchange bots
// Gives bots real tools (web fetch, search, API calls, file generation, JS execution)
// Uses Claude's tool-use API with an iterative agentic loop

const Anthropic = require('@anthropic-ai/sdk');
const cheerio = require('cheerio');
const axios = require('axios');
const vm = require('vm');
const crypto = require('crypto');

// ============================================================================
// SAFETY: URL blocklist to prevent SSRF
// ============================================================================
const BLOCKED_HOSTS = [
  'localhost', '127.0.0.1', '0.0.0.0', '::1',
  '169.254.169.254', // AWS metadata
  'metadata.google.internal',
  '10.', '172.16.', '172.17.', '172.18.', '172.19.',
  '172.20.', '172.21.', '172.22.', '172.23.', '172.24.',
  '172.25.', '172.26.', '172.27.', '172.28.', '172.29.',
  '172.30.', '172.31.', '192.168.',
];

function isUrlBlocked(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    return BLOCKED_HOSTS.some(blocked => host === blocked || host.startsWith(blocked));
  } catch {
    return true; // malformed URL = blocked
  }
}

// ============================================================================
// TOOL DEFINITIONS (JSON Schema for Claude tool-use API)
// ============================================================================
const TOOL_DEFINITIONS = [
  {
    name: 'web_fetch',
    description: 'Fetch and parse a web page. Returns the page title, meta description, headings, body text (first 8000 chars), links, and images. Use this to scrape websites, read articles, check competitor pages, or gather real data.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch (must be https:// or http://)' },
        extract: {
          type: 'string',
          enum: ['full', 'text_only', 'links', 'metadata'],
          description: 'What to extract: full (everything), text_only (just body text), links (all links), metadata (title + meta tags). Default: full'
        }
      },
      required: ['url']
    }
  },
  // web_search is handled as a built-in server-side tool (web_search_20250305)
  // It's added automatically in runAgenticLoop() — no custom definition needed
  {
    name: 'api_request',
    description: 'Make an HTTP request to an external API. Supports GET, POST, PUT, DELETE. Use this to interact with public APIs, fetch JSON data, or test endpoints.',
    input_schema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], description: 'HTTP method' },
        url: { type: 'string', description: 'The API endpoint URL' },
        headers: { type: 'object', description: 'Request headers (key-value pairs)' },
        body: { type: 'object', description: 'Request body (for POST/PUT, sent as JSON)' }
      },
      required: ['method', 'url']
    }
  },
  {
    name: 'generate_file',
    description: 'Generate a file artifact (markdown, HTML, JSON, CSV, or code). The file is stored and returned as part of the deliverable. Use this for creating documents, reports, data files, or code.',
    input_schema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'The filename with extension (e.g., "report.md", "data.csv", "page.html")' },
        content: { type: 'string', description: 'The file content' },
        file_type: { type: 'string', enum: ['markdown', 'html', 'json', 'csv', 'javascript', 'python', 'text'], description: 'The file type' }
      },
      required: ['filename', 'content', 'file_type']
    }
  },
  {
    name: 'run_javascript',
    description: 'Execute JavaScript code in a sandboxed environment. Use this for data transformations, calculations, parsing, formatting, or generating structured output. Has access to JSON but NOT to require, process, fs, fetch, or network.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript code to execute. The last expression is returned as the result.' },
        description: { type: 'string', description: 'Brief description of what this code does' }
      },
      required: ['code']
    }
  },
  {
    name: 'store_artifact',
    description: 'Store structured data that persists between tool calls in this session. Use this to save intermediate results, research findings, or data you want to reference later.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'A descriptive key for this artifact (e.g., "competitor_analysis", "scraped_products")' },
        data: { type: 'object', description: 'The structured data to store' },
        summary: { type: 'string', description: 'Brief summary of what this data contains' }
      },
      required: ['key', 'data']
    }
  }
];

// ============================================================================
// TOOL EXECUTION HANDLERS
// ============================================================================

async function executeWebFetch(input) {
  const { url, extract } = input;
  if (!url) return { error: 'URL is required' };
  if (isUrlBlocked(url)) return { error: 'URL is blocked for security reasons (private/internal addresses not allowed)' };

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BotXchangeAgent/1.0; +https://botxchange.ai)' },
      signal: AbortSignal.timeout(15000),
      redirect: 'follow'
    });
    const html = await response.text();
    const $ = cheerio.load(html);

    const title = $('title').text().trim();
    const metaDescription = $('meta[name="description"]').attr('content') || '';

    if (extract === 'metadata') {
      return {
        success: true, url, title, metaDescription,
        ogTitle: $('meta[property="og:title"]').attr('content') || '',
        ogDescription: $('meta[property="og:description"]').attr('content') || '',
        canonical: $('link[rel="canonical"]').attr('href') || ''
      };
    }

    if (extract === 'links') {
      const links = $('a[href]').map((i, el) => ({
        text: $(el).text().trim().substring(0, 100),
        href: $(el).attr('href')
      })).get().slice(0, 100);
      return { success: true, url, title, linkCount: links.length, links };
    }

    // Remove non-content elements
    $('script, style, nav, footer, header, aside, iframe, noscript').remove();
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();

    if (extract === 'text_only') {
      return { success: true, url, title, bodyText: bodyText.substring(0, 10000), wordCount: bodyText.split(/\s+/).length };
    }

    // Full extraction
    const h1s = $('h1').map((i, el) => $(el).text().trim()).get();
    const h2s = $('h2').map((i, el) => $(el).text().trim()).get();
    const links = $('a[href]').map((i, el) => ({
      text: $(el).text().trim().substring(0, 80),
      href: $(el).attr('href')
    })).get().slice(0, 50);
    const images = $('img[src]').map((i, el) => ({
      alt: $(el).attr('alt') || '',
      src: $(el).attr('src')
    })).get().slice(0, 20);

    return {
      success: true, url, title, metaDescription,
      h1s, h2s, links: links.slice(0, 30), images: images.slice(0, 10),
      bodyText: bodyText.substring(0, 8000),
      wordCount: bodyText.split(/\s+/).length
    };
  } catch (err) {
    return { success: false, url, error: err.message };
  }
}

async function executeApiRequest(input) {
  const { method, url, headers, body } = input;
  if (!url) return { error: 'URL is required' };
  if (isUrlBlocked(url)) return { error: 'URL is blocked for security reasons' };

  try {
    const config = {
      method: method || 'GET',
      url,
      headers: headers || {},
      timeout: 15000,
      maxContentLength: 500000 // 500KB max response
    };
    if (body && (method === 'POST' || method === 'PUT')) {
      config.data = body;
      if (!config.headers['Content-Type']) {
        config.headers['Content-Type'] = 'application/json';
      }
    }

    const response = await axios(config);
    const responseData = typeof response.data === 'string'
      ? response.data.substring(0, 10000)
      : JSON.stringify(response.data).substring(0, 10000);

    return {
      success: true, status: response.status,
      headers: { 'content-type': response.headers['content-type'] },
      data: response.data,
      dataPreview: responseData.substring(0, 2000)
    };
  } catch (err) {
    return {
      success: false,
      status: err.response?.status,
      error: err.message,
      data: err.response?.data ? JSON.stringify(err.response.data).substring(0, 1000) : null
    };
  }
}

function executeGenerateFile(input, artifacts) {
  const { filename, content, file_type } = input;
  if (!filename || !content) return { error: 'filename and content are required' };
  if (content.length > 100000) return { error: 'File content exceeds 100KB limit' };

  const artifact = {
    id: 'artifact_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex'),
    filename,
    file_type: file_type || 'text',
    content,
    size: content.length,
    created_at: Date.now()
  };

  artifacts.push(artifact);
  return { success: true, artifact_id: artifact.id, filename, file_type: artifact.file_type, size: artifact.size };
}

function executeRunJavascript(input) {
  const { code, description } = input;
  if (!code) return { error: 'Code is required' };
  if (code.length > 10000) return { error: 'Code exceeds 10KB limit' };

  try {
    const sandbox = {
      JSON, Math, Date, Array, Object, String, Number, Boolean,
      parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
      console: { log: (...args) => { sandbox._logs.push(args.map(String).join(' ')); } },
      _logs: [],
      _result: undefined
    };

    const wrappedCode = `_result = (function() { ${code} })()`;
    const context = vm.createContext(sandbox);
    vm.runInContext(wrappedCode, context, { timeout: 5000 });

    const result = sandbox._result;
    const resultStr = typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);

    return {
      success: true,
      result: resultStr.substring(0, 10000),
      logs: sandbox._logs.slice(0, 20),
      description: description || 'JavaScript execution'
    };
  } catch (err) {
    return { success: false, error: err.message, description: description || 'JavaScript execution' };
  }
}

function executeStoreArtifact(input, storedArtifacts) {
  const { key, data, summary } = input;
  if (!key || !data) return { error: 'key and data are required' };

  const dataStr = JSON.stringify(data);
  if (dataStr.length > 50000) return { error: 'Artifact data exceeds 50KB limit' };

  storedArtifacts[key] = { data, summary: summary || '', stored_at: Date.now() };
  return { success: true, key, summary: summary || '', size: dataStr.length };
}

// ============================================================================
// TOOL EXECUTOR — Routes tool calls to handlers
// ============================================================================
async function executeTool(toolName, toolInput, context) {
  const { client, artifacts, storedArtifacts } = context;

  switch (toolName) {
    case 'web_fetch':
      return await executeWebFetch(toolInput);
    case 'api_request':
      return await executeApiRequest(toolInput);
    case 'generate_file':
      return executeGenerateFile(toolInput, artifacts);
    case 'run_javascript':
      return executeRunJavascript(toolInput);
    case 'store_artifact':
      return executeStoreArtifact(toolInput, storedArtifacts);
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ============================================================================
// AGENTIC LOOP — The core engine
// ============================================================================

/**
 * Run an agentic loop with tool use.
 *
 * @param {object} options
 * @param {Anthropic} options.client - Anthropic client
 * @param {string} options.model - Model to use (default: claude-sonnet-4-20250514)
 * @param {string} options.systemPrompt - System prompt
 * @param {string} options.userPrompt - User/task prompt
 * @param {number} options.maxIterations - Max loop iterations (default: 10)
 * @param {number} options.maxTokens - Max tokens per response (default: 8192)
 * @param {string[]} options.enabledTools - Which tools to enable (default: all)
 * @returns {{ deliverable: string, toolLog: object[], artifacts: object[], storedArtifacts: object }}
 */
async function runAgenticLoop(options) {
  const {
    client,
    model = 'claude-sonnet-4-20250514',
    systemPrompt,
    userPrompt,
    maxIterations = 10,
    maxTokens = 8192,
    enabledTools = null // null = all tools
  } = options;

  // Filter tools if specific ones requested
  let tools = TOOL_DEFINITIONS;
  if (enabledTools && enabledTools.length > 0) {
    tools = TOOL_DEFINITIONS.filter(t => enabledTools.includes(t.name));
  }

  // Add built-in web search as a server-side tool (always available)
  const apiTools = [
    ...tools,
    { type: 'web_search_20250305', name: 'web_search', max_uses: 5 }
  ];

  const toolLog = [];
  const artifacts = [];
  const storedArtifacts = {};
  const context = { client, artifacts, storedArtifacts };

  let messages = [{ role: 'user', content: userPrompt }];
  let finalText = '';
  let iteration = 0;

  while (iteration < maxIterations) {
    iteration++;

    let response;
    try {
      response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        tools: apiTools,
        messages
      });
    } catch (err) {
      if (err.status === 429 && iteration <= maxIterations) {
        console.log(`   ⏳ Rate limited in agentic loop, waiting 60s (iteration ${iteration})...`);
        await new Promise(r => setTimeout(r, 60000));
        continue;
      }
      throw err;
    }

    // Collect text blocks and tool-use blocks (our custom tools only)
    const textBlocks = [];
    const toolUseBlocks = []; // only our custom tools, not server_tool_use
    let hasServerToolUse = false;

    for (const block of response.content) {
      if (block.type === 'text') {
        textBlocks.push(block.text);
      } else if (block.type === 'tool_use') {
        toolUseBlocks.push(block);
      } else if (block.type === 'server_tool_use') {
        // Built-in web search — handled server-side, log it
        hasServerToolUse = true;
        toolLog.push({
          iteration,
          tool: block.name || 'web_search',
          input: block.input || {},
          success: true,
          timestamp: Date.now(),
          resultPreview: '(server-side web search)'
        });
        console.log(`   🔧 [${iteration}] web_search (server-side) ✓`);
      }
      // web_search_tool_result blocks are part of the response content — no action needed
    }

    // If there are text blocks, accumulate them
    if (textBlocks.length > 0) {
      finalText = textBlocks.join('\n');
    }

    // If stop reason is end_turn or no custom tool calls, we're done
    // (server tool use + web_search_tool_result are already in the response)
    if (response.stop_reason === 'end_turn' || (toolUseBlocks.length === 0 && !hasServerToolUse)) {
      break;
    }

    // If only server tool use (web search) happened, continue the loop
    // by passing the full response back so the model can use the search results
    if (toolUseBlocks.length === 0 && hasServerToolUse) {
      messages.push({ role: 'assistant', content: response.content });
      // The model needs to continue — no tool_result needed for server tools
      // But we need a user message to continue the conversation
      messages.push({ role: 'user', content: 'Continue with the search results above. Proceed with the task.' });
      continue;
    }

    // Execute each custom tool call
    const toolResults = [];
    for (const toolBlock of toolUseBlocks) {
      const logEntry = {
        iteration,
        tool: toolBlock.name,
        input: toolBlock.input,
        timestamp: Date.now()
      };

      let result;
      try {
        result = await executeTool(toolBlock.name, toolBlock.input, context);
        logEntry.success = result.success !== false;
        logEntry.resultPreview = JSON.stringify(result).substring(0, 500);
      } catch (err) {
        result = { error: err.message };
        logEntry.success = false;
        logEntry.error = err.message;
      }

      toolLog.push(logEntry);

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolBlock.id,
        content: JSON.stringify(result).substring(0, 25000) // cap tool result size
      });

      console.log(`   🔧 [${iteration}] ${toolBlock.name}${logEntry.success ? ' ✓' : ' ✗'}`);
    }

    // Add assistant response + tool results to messages for next iteration
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });
  }

  if (iteration >= maxIterations) {
    console.log(`   ⚠️ Agentic loop hit max iterations (${maxIterations})`);
  }

  return {
    deliverable: finalText,
    toolLog,
    artifacts,
    storedArtifacts,
    iterations: iteration
  };
}

// ============================================================================
// TOOL SUBSETS PER BOT ROLE
// ============================================================================
// web_search is always available (built-in server-side tool), not listed here
const TOOL_SUBSETS = {
  'research-bot': ['web_fetch', 'api_request', 'store_artifact', 'run_javascript'],
  'seo-bot': ['web_fetch', 'store_artifact', 'run_javascript'],
  'writer-bot': ['generate_file', 'store_artifact', 'run_javascript'],
  'quality-bot': ['web_fetch', 'store_artifact'],
  // Bounty bots (CEO, CMO, CTO) get all custom tools
  'default': ['web_fetch', 'api_request', 'generate_file', 'run_javascript', 'store_artifact']
};

function getToolsForBot(botId) {
  return TOOL_SUBSETS[botId] || TOOL_SUBSETS['default'];
}

module.exports = {
  TOOL_DEFINITIONS,
  runAgenticLoop,
  getToolsForBot,
  executeTool
};
