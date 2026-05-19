'use strict';

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const https = require('https');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── In-memory stores (fallback until Supabase tables are set up) ──────────
const _memory    = new Map(); // persistent key/value memory
const _knowledge = [];        // uploaded knowledge items
const _convHist  = new Map(); // sessionId → messages[]

// ─── Tool definitions ─────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'get_market_data',
    description: 'Fetch OHLC candle data for any trading pair and timeframe. Use this to analyze price action, calculate any custom indicator, or study historical patterns.',
    input_schema: {
      type: 'object',
      properties: {
        pair:     { type: 'string', description: 'Trading pair e.g. XRPUSD, BTCUSD, ETHUSD' },
        interval: { type: 'number', description: 'Candle interval in minutes: 1,5,15,30,60,240,1440,10080' },
        limit:    { type: 'number', description: 'Number of candles to fetch, max 1000' },
      },
      required: ['pair', 'interval'],
    },
  },
  {
    name: 'get_ticker',
    description: 'Get the current live price, 24h change, and volume for a trading pair.',
    input_schema: {
      type: 'object',
      properties: {
        pair: { type: 'string', description: 'Trading pair e.g. XRPUSD' },
      },
      required: ['pair'],
    },
  },
  {
    name: 'get_order_book',
    description: 'Get the live order book (bids and asks) to understand buying and selling pressure.',
    input_schema: {
      type: 'object',
      properties: {
        pair:  { type: 'string', description: 'Trading pair e.g. XRPUSD' },
        depth: { type: 'number', description: 'Number of levels each side, default 20' },
      },
      required: ['pair'],
    },
  },
  {
    name: 'get_trade_history',
    description: 'Retrieve past trades with their reasoning and outcomes. Use this to learn from what worked and what did not.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many recent trades to retrieve, default 20' },
      },
    },
  },
  {
    name: 'calculate',
    description: 'Run a custom calculation on market data. Write JavaScript that receives a `candles` array (each with t,o,h,l,c,v fields) and returns a result. Use this to build any indicator or analysis you need.',
    input_schema: {
      type: 'object',
      properties: {
        pair:     { type: 'string', description: 'Trading pair to fetch data for' },
        interval: { type: 'number', description: 'Candle interval in minutes' },
        limit:    { type: 'number', description: 'Number of candles' },
        code:     { type: 'string', description: 'JavaScript function body. Has access to `candles` array. Must return a value.' },
      },
      required: ['pair', 'interval', 'code'],
    },
  },
  {
    name: 'remember',
    description: 'Store something important to persistent memory. Use this to save insights, patterns, rules, or anything you want to recall in future sessions.',
    input_schema: {
      type: 'object',
      properties: {
        key:      { type: 'string', description: 'A short label for this memory' },
        value:    { type: 'string', description: 'The content to remember' },
        category: { type: 'string', description: 'Category: strategy, pattern, rule, observation, user_preference' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'recall',
    description: 'Search your persistent memory and knowledge base for relevant information.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for' },
      },
      required: ['query'],
    },
  },
  {
    name: 'place_trade',
    description: 'Execute a trade. Only call this when you have strong conviction and have clearly reasoned through the setup. Always specify your reasoning.',
    input_schema: {
      type: 'object',
      properties: {
        pair:      { type: 'string', description: 'Trading pair' },
        side:      { type: 'string', enum: ['buy', 'sell'], description: 'Direction' },
        size_usd:  { type: 'number', description: 'Position size in USD' },
        order_type:{ type: 'string', enum: ['market', 'limit'], description: 'Order type' },
        limit_price:{ type: 'number', description: 'Limit price if order_type is limit' },
        stop_loss:  { type: 'number', description: 'Stop loss price' },
        take_profit:{ type: 'number', description: 'Take profit price' },
        reasoning:  { type: 'string', description: 'Why you are placing this trade — be specific' },
      },
      required: ['pair', 'side', 'size_usd', 'order_type', 'reasoning'],
    },
  },
  {
    name: 'get_knowledge',
    description: 'Retrieve all uploaded knowledge — chart images that have been analyzed, trading strategies, zone maps, and rules the user has taught you.',
    input_schema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Optional keyword to filter knowledge items' },
      },
    },
  },
];

// ─── Tool execution ───────────────────────────────────────────────────────
async function executeTool(name, input, context = {}) {
  switch (name) {

    case 'get_market_data': {
      const data = await _fetchOHLC(input.pair, input.interval, input.limit || 200);
      if (!data) return { error: 'Failed to fetch market data' };
      const last = data[data.length - 1];
      return {
        pair: input.pair, interval: input.interval, count: data.length,
        latest: { time: new Date(last.t * 1000).toISOString(), open: last.o, high: last.h, low: last.l, close: last.c, volume: last.v },
        candles: data.slice(-100), // return last 100 for context
      };
    }

    case 'get_ticker': {
      const price = await _fetchPrice(input.pair);
      return price ? { pair: input.pair, price } : { error: 'Failed to fetch price' };
    }

    case 'get_order_book': {
      const ob = await _fetchOrderBook(input.pair, input.depth || 20);
      return ob || { error: 'Failed to fetch order book' };
    }

    case 'get_trade_history': {
      const trades = context.getTradeHistory ? await context.getTradeHistory(input.limit || 20) : [];
      return { trades, count: trades.length };
    }

    case 'calculate': {
      try {
        const candles = await _fetchOHLC(input.pair, input.interval, input.limit || 200);
        if (!candles) return { error: 'Failed to fetch data for calculation' };
        // Safe execution: wrap in function, pass candles
        const fn = new Function('candles', input.code);
        const result = fn(candles);
        return { result, candleCount: candles.length };
      } catch (e) {
        return { error: 'Calculation error: ' + e.message };
      }
    }

    case 'remember': {
      const item = { key: input.key, value: input.value, category: input.category || 'general', savedAt: new Date().toISOString() };
      _memory.set(input.key, item);
      if (context.saveMemory) await context.saveMemory(item);
      return { saved: true, key: input.key };
    }

    case 'recall': {
      const q = input.query.toLowerCase();
      const memResults = [..._memory.values()].filter(m =>
        m.key.toLowerCase().includes(q) || m.value.toLowerCase().includes(q)
      );
      const knResults = _knowledge.filter(k =>
        (k.summary || '').toLowerCase().includes(q) ||
        (k.rules || []).some(r => r.toLowerCase().includes(q))
      );
      return { memory: memResults, knowledge: knResults, total: memResults.length + knResults.length };
    }

    case 'place_trade': {
      if (context.placeTrade) {
        const result = await context.placeTrade(input);
        return result;
      }
      return { error: 'Trade execution not available in this context' };
    }

    case 'get_knowledge': {
      const q = input.filter ? input.filter.toLowerCase() : null;
      const items = q
        ? _knowledge.filter(k => JSON.stringify(k).toLowerCase().includes(q))
        : _knowledge;
      return { items, count: items.length };
    }

    default:
      return { error: 'Unknown tool: ' + name };
  }
}

// ─── Main agent chat function ─────────────────────────────────────────────
async function agentChat({ sessionId, userMessage, images = [], context = {}, model = 'claude-opus-4-7', onToken }) {
  // Build or retrieve conversation history
  if (!_convHist.has(sessionId)) _convHist.set(sessionId, []);
  const messages = _convHist.get(sessionId);

  // Build user message content
  const userContent = [];
  for (const img of images) {
    userContent.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType || 'image/jpeg', data: img.data },
    });
  }
  if (userMessage) userContent.push({ type: 'text', text: userMessage });
  messages.push({ role: 'user', content: userContent });

  // System prompt — the agent's identity and instructions
  const systemPrompt = _buildSystemPrompt(context);

  let finalText = '';
  const toolCalls = [];

  // Agentic loop — Claude can call multiple tools before responding
  while (true) {
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      tools: TOOLS,
      messages,
    });

    // Collect text and tool use blocks
    let responseText = '';
    const toolUseBlocks = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        responseText += block.text;
        if (onToken) onToken({ type: 'text', text: block.text });
      }
      if (block.type === 'tool_use') {
        toolUseBlocks.push(block);
        if (onToken) onToken({ type: 'tool_call', tool: block.name, input: block.input });
      }
    }

    // Add assistant message to history
    messages.push({ role: 'assistant', content: response.content });

    if (responseText) finalText += responseText;

    // If no tool calls or stop reason is end_turn, we're done
    if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') break;

    // Execute all tool calls and build tool_result message
    const toolResults = [];
    for (const toolUse of toolUseBlocks) {
      if (onToken) onToken({ type: 'tool_running', tool: toolUse.name });
      const result = await executeTool(toolUse.name, toolUse.input, context);
      toolCalls.push({ tool: toolUse.name, input: toolUse.input, result });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(result),
      });
      if (onToken) onToken({ type: 'tool_done', tool: toolUse.name, result });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  // Trim history to last 40 messages to avoid context overflow
  if (messages.length > 40) _convHist.set(sessionId, messages.slice(-40));

  return { text: finalText, toolCalls, sessionId };
}

// ─── Analyze image(s) and extract trading knowledge ───────────────────────
async function analyzeImages({ images, userContext = '', model = 'claude-opus-4-7' }) {
  const content = [];
  for (const img of images) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType || 'image/jpeg', data: img.data },
    });
  }
  content.push({
    type: 'text',
    text: `You are a professional trading analyst with deep knowledge of technical analysis, institutional order flow, market structure, and trading psychology.

Analyze the provided image(s) and extract ALL useful trading information. Return a JSON object with this exact structure:
{
  "summary": "Plain English description of what this image shows",
  "type": "chart|strategy|zones|educational|other",
  "price_levels": [{ "price": number, "label": "support/resistance/entry/target/stop/zone", "strength": "strong/medium/weak", "notes": "..." }],
  "trading_rules": ["rule 1", "rule 2", ...],
  "entry_conditions": ["condition 1", ...],
  "exit_conditions": ["condition 1", ...],
  "risk_rules": ["rule 1", ...],
  "key_concepts": ["concept 1", ...],
  "explanation": "Detailed explanation of everything in the image and how to use this information for trading",
  "tradeable": true/false,
  "confidence": 1-10
}

${userContext ? 'Additional context from user: ' + userContext : ''}

Respond ONLY with valid JSON.`,
  });

  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    messages: [{ role: 'user', content }],
  });

  const raw = response.content[0]?.text || '{}';
  try {
    const parsed = JSON.parse(raw.replace(/```json\n?|\n?```/g, '').trim());
    // Store in knowledge base
    const item = { ...parsed, uploadedAt: new Date().toISOString(), id: Date.now() };
    _knowledge.push(item);
    return item;
  } catch {
    return { summary: raw, error: 'Could not parse structured response', raw };
  }
}

// ─── Quick trading scan (Sonnet — runs on cycle) ──────────────────────────
async function quickScan({ pair, currentData, context = {} }) {
  const knowledge = _knowledge.slice(-10);
  const memories  = [..._memory.values()].slice(-20);

  const prompt = `You are a trading bot scanning for opportunities. Be concise and decisive.

Current data for ${pair}:
${JSON.stringify(currentData, null, 2)}

Recent knowledge base (${knowledge.length} items):
${knowledge.map(k => k.summary).join('\n')}

Key memories:
${memories.map(m => `${m.key}: ${m.value}`).join('\n')}

Should I trade right now? Respond with JSON:
{
  "action": "buy"|"sell"|"wait",
  "confidence": 1-10,
  "reasoning": "one sentence why",
  "entry": number|null,
  "stop": number|null,
  "target": number|null
}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });

  try {
    return JSON.parse(response.content[0].text.replace(/```json\n?|\n?```/g, '').trim());
  } catch {
    return { action: 'wait', confidence: 0, reasoning: 'Parse error', raw: response.content[0].text };
  }
}

// ─── System prompt builder ────────────────────────────────────────────────
function _buildSystemPrompt(context) {
  const memCount  = _memory.size;
  const knowCount = _knowledge.length;
  return `You are NEXUS AI — an elite autonomous trading agent and market analyst. You are the brain of a live crypto trading system.

Your capabilities:
- Analyze any market data across any timeframe using your tools
- Build custom indicators and calculations on the fly using JavaScript
- Read and learn from uploaded chart images and trading strategies
- Execute real trades when you have strong conviction
- Remember insights across sessions — you have persistent memory
- Explain your reasoning clearly so the trader always knows what you're thinking

Your personality:
- Direct and confident, but honest about uncertainty
- You think like a professional trader: risk-first, never emotional
- You explain complex concepts in plain English
- You ask clarifying questions when you need more information
- You never force trades — if conditions aren't right, you say so and explain why

Current session context:
- Active pair: ${context.pair || 'XRPUSD'}
- Memory items stored: ${memCount}
- Knowledge base items: ${knowCount}
- Trade execution: ${context.canTrade ? 'ENABLED' : 'ANALYSIS ONLY'}

When analyzing charts or making decisions:
1. Always check your knowledge base first — the trader may have uploaded relevant zones or strategies
2. Consider multiple timeframes before entering
3. Always define stop loss and take profit before placing any trade
4. Explain your reasoning step by step
5. If you're uncertain, say so — a "wait" is always a valid call

You have access to tools — use them. Don't guess at prices or data, fetch it.`;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────
function _fetchOHLC(pair, interval, limit = 200) {
  return new Promise((resolve) => {
    const url = `http://localhost:${process.env.PORT || 3000}/ohlc?pair=${pair}&interval=${interval}&limit=${Math.min(limit, 1000)}`;
    const req = require('http').get(url, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { const d = JSON.parse(raw); resolve(d.ok ? d.candles : null); } catch { resolve(null); }
      });
    });
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function _fetchPrice(pair) {
  return new Promise((resolve) => {
    const sym = pair.replace('XBT','BTC').replace('USD','USDT').replace(/^X/,'').replace(/^Z/,'');
    const url = `https://api.binance.com/api/v3/ticker/price?symbol=${sym}`;
    const req = https.get(url, { headers: { 'User-Agent': 'NEXUS/4.0' } }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve(+JSON.parse(raw).price || null); } catch { resolve(null); }
      });
    });
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function _fetchOrderBook(pair, depth = 20) {
  return new Promise((resolve) => {
    const sym = pair.replace('XBT','BTC').replace('USD','USDT').replace(/^X/,'').replace(/^Z/,'');
    const url = `https://api.binance.com/api/v3/depth?symbol=${sym}&limit=${depth}`;
    const req = https.get(url, { headers: { 'User-Agent': 'NEXUS/4.0' } }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const d = JSON.parse(raw);
          const bids = d.bids.map(b => ({ price: +b[0], size: +b[1] }));
          const asks = d.asks.map(a => ({ price: +a[0], size: +a[1] }));
          const bidVol = bids.reduce((s, b) => s + b.size, 0);
          const askVol = asks.reduce((s, a) => s + a.size, 0);
          resolve({ bids, asks, bidVolume: bidVol, askVolume: askVol, obi: (bidVol - askVol) / (bidVol + askVol) });
        } catch { resolve(null); }
      });
    });
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// ─── Memory access (for external use) ────────────────────────────────────
function getMemory()    { return [..._memory.values()]; }
function getKnowledge() { return [..._knowledge]; }
function loadMemory(items) { items.forEach(i => _memory.set(i.key, i)); }
function loadKnowledge(items) { items.forEach(i => _knowledge.push(i)); }

module.exports = { agentChat, analyzeImages, quickScan, getMemory, getKnowledge, loadMemory, loadKnowledge, TOOLS };
