'use strict';

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const https = require('https');
const http  = require('http');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── In-memory stores ─────────────────────────────────────────────────────
const _memory    = new Map();
const _knowledge = [];
const _convHist  = new Map();
const _learnLog  = []; // overnight learning activity log

// ─── Tool definitions ─────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'get_market_data',
    description: 'Fetch OHLC candle data for any trading pair and timeframe. Use this to analyze price action, build custom indicators, or study patterns.',
    input_schema: {
      type: 'object',
      properties: {
        pair:     { type: 'string', description: 'e.g. XRPUSD, BTCUSD, ETHUSD, SOLUSDT' },
        interval: { type: 'number', description: 'Minutes: 1,5,15,30,60,240,1440,10080' },
        limit:    { type: 'number', description: 'Candles to fetch, max 1000' },
      },
      required: ['pair', 'interval'],
    },
  },
  {
    name: 'get_ticker',
    description: 'Get live price, 24h change, volume and market stats for any pair.',
    input_schema: {
      type: 'object',
      properties: {
        pair: { type: 'string' },
      },
      required: ['pair'],
    },
  },
  {
    name: 'get_order_book',
    description: 'Get live order book to understand buying/selling pressure and calculate order book imbalance.',
    input_schema: {
      type: 'object',
      properties: {
        pair:  { type: 'string' },
        depth: { type: 'number', description: 'Levels per side, default 20' },
      },
      required: ['pair'],
    },
  },
  {
    name: 'get_funding_rates',
    description: 'Get perpetual futures funding rates. Negative = market is bearish/short-heavy. Positive = bullish/long-heavy. Extreme rates often signal reversals.',
    input_schema: {
      type: 'object',
      properties: {
        pair: { type: 'string', description: 'e.g. XRPUSD' },
      },
      required: ['pair'],
    },
  },
  {
    name: 'get_liquidations',
    description: 'Get recent large liquidation events. Liquidation clusters often mark local bottoms/tops.',
    input_schema: {
      type: 'object',
      properties: {
        pair:  { type: 'string' },
        limit: { type: 'number', description: 'Number of events, default 20' },
      },
      required: ['pair'],
    },
  },
  {
    name: 'get_fear_greed',
    description: 'Get the Crypto Fear & Greed Index (0=extreme fear, 100=extreme greed). Extreme fear often = buy opportunity. Extreme greed = caution.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_news',
    description: 'Fetch latest crypto news and sentiment. Use this to check for market-moving events before trading.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term e.g. XRP, Bitcoin ETF, crypto regulation' },
        limit: { type: 'number', description: 'Number of articles, default 10' },
      },
    },
  },
  {
    name: 'scan_pairs',
    description: 'Scan multiple trading pairs simultaneously for the best opportunities. Returns ranked list by opportunity score.',
    input_schema: {
      type: 'object',
      properties: {
        pairs:    { type: 'array', items: { type: 'string' }, description: 'Pairs to scan e.g. ["XRPUSD","BTCUSD","ETHUSD"]' },
        interval: { type: 'number', description: 'Timeframe in minutes' },
      },
      required: ['pairs', 'interval'],
    },
  },
  {
    name: 'calculate',
    description: 'Run any custom calculation on market data. Write JavaScript with access to a `candles` array (t,o,h,l,c,v). Use this to build ANY indicator or analysis you need — not limited to built-ins.',
    input_schema: {
      type: 'object',
      properties: {
        pair:     { type: 'string' },
        interval: { type: 'number' },
        limit:    { type: 'number' },
        code:     { type: 'string', description: 'JS function body. Has `candles` array. Must return a value.' },
      },
      required: ['pair', 'interval', 'code'],
    },
  },
  {
    name: 'backtest_strategy',
    description: 'Backtest a trading strategy on historical data before using it live. Write entry/exit logic in JavaScript. Returns win rate, P&L, max drawdown.',
    input_schema: {
      type: 'object',
      properties: {
        pair:       { type: 'string' },
        interval:   { type: 'number' },
        days_back:  { type: 'number', description: 'Days of history to test on' },
        entry_code: { type: 'string', description: 'JS that receives candles[i] and prev state, returns true to enter long' },
        exit_code:  { type: 'string', description: 'JS that receives candles[i], entry_price, and returns true to exit' },
        stop_pct:   { type: 'number', description: 'Stop loss percentage e.g. 0.02 for 2%' },
        target_pct: { type: 'number', description: 'Take profit percentage e.g. 0.04 for 4%' },
      },
      required: ['pair', 'interval', 'days_back', 'entry_code', 'exit_code'],
    },
  },
  {
    name: 'evaluate_trade',
    description: 'Review a completed trade — compare what was expected vs what happened, extract lessons, update strategy confidence. Call this after every trade closes.',
    input_schema: {
      type: 'object',
      properties: {
        trade_id:       { type: 'string' },
        entry_price:    { type: 'number' },
        exit_price:     { type: 'number' },
        side:           { type: 'string' },
        original_reasoning: { type: 'string' },
        outcome_pct:    { type: 'number', description: 'P&L in percent' },
        what_happened:  { type: 'string', description: 'Description of how the trade played out' },
      },
      required: ['entry_price', 'exit_price', 'side', 'original_reasoning', 'outcome_pct'],
    },
  },
  {
    name: 'remember',
    description: 'Store important insights, patterns, rules or observations to persistent memory. You will recall these in future sessions.',
    input_schema: {
      type: 'object',
      properties: {
        key:      { type: 'string' },
        value:    { type: 'string' },
        category: { type: 'string', description: 'strategy|pattern|rule|observation|lesson|user_preference' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'recall',
    description: 'Search persistent memory and knowledge base for relevant information.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_trade_history',
    description: 'Retrieve past trades with outcomes to learn from.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'get_knowledge',
    description: 'Retrieve uploaded knowledge — chart images, trading strategies, zone maps, and rules.',
    input_schema: {
      type: 'object',
      properties: {
        filter: { type: 'string' },
      },
    },
  },
  {
    name: 'place_trade',
    description: 'Execute a real trade on Kraken. Only call with strong conviction (confidence 8+). ALWAYS define stop_loss and take_profit. Risk max 2% of balance per trade.',
    input_schema: {
      type: 'object',
      properties: {
        pair:        { type: 'string', description: 'e.g. XRPUSD, BTCUSD, ETHUSD' },
        side:        { type: 'string', enum: ['buy', 'sell'] },
        size_usd:    { type: 'number', description: 'Dollar value to trade' },
        order_type:  { type: 'string', enum: ['market', 'limit'] },
        limit_price: { type: 'number', description: 'Required for limit orders' },
        stop_loss:   { type: 'number', description: 'Stop loss price — REQUIRED' },
        take_profit: { type: 'number', description: 'Take profit price — REQUIRED' },
        reasoning:   { type: 'string', description: 'Detailed reasoning for the trade' },
      },
      required: ['pair', 'side', 'size_usd', 'order_type', 'stop_loss', 'take_profit', 'reasoning'],
    },
  },
  {
    name: 'get_open_positions',
    description: 'Get all currently open positions — pair, side, size, entry price, stop/target, P&L.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'close_position',
    description: 'Close an open position by its ID. Use when stop/target is hit, setup invalidated, or better opportunity exists.',
    input_schema: {
      type: 'object',
      properties: {
        position_id: { type: 'string', description: 'The position ID from get_open_positions' },
        reason:      { type: 'string', description: 'Why you are closing' },
      },
      required: ['position_id', 'reason'],
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
        candles: data.slice(-100),
      };
    }

    case 'get_ticker': {
      const result = await _fetchTicker(input.pair);
      return result || { error: 'Failed to fetch ticker' };
    }

    case 'get_order_book': {
      const ob = await _fetchOrderBook(input.pair, input.depth || 20);
      return ob || { error: 'Failed to fetch order book' };
    }

    case 'get_funding_rates': {
      const fr = await _fetchFundingRate(input.pair);
      return fr || { error: 'Funding rate unavailable' };
    }

    case 'get_liquidations': {
      const liq = await _fetchLiquidations(input.pair, input.limit || 20);
      return liq || { error: 'Liquidation data unavailable' };
    }

    case 'get_fear_greed': {
      const fg = await _fetchFearGreed();
      return fg || { error: 'Fear & Greed index unavailable' };
    }

    case 'get_news': {
      const news = await _fetchNews(input.query || 'crypto', input.limit || 10);
      return news || { error: 'News unavailable' };
    }

    case 'scan_pairs': {
      const results = [];
      for (const pair of (input.pairs || []).slice(0, 8)) {
        try {
          const candles = await _fetchOHLC(pair, input.interval || 60, 100);
          if (!candles || candles.length < 20) continue;
          const closes = candles.map(c => c.c);
          const rsi = _calcRSI(closes, 14);
          const last = candles[candles.length - 1];
          const ticker = await _fetchTicker(pair);
          results.push({
            pair, price: last.c,
            rsi: rsi.toFixed(1),
            change24h: ticker ? ticker.change24h : null,
            volume24h: ticker ? ticker.volume24h : null,
            signal: rsi < 30 ? 'oversold' : rsi > 70 ? 'overbought' : 'neutral',
          });
          await _sleep(150);
        } catch (_) {}
      }
      results.sort((a, b) => {
        const scoreA = +a.rsi < 30 ? 3 : +a.rsi > 70 ? 2 : 0;
        const scoreB = +b.rsi < 30 ? 3 : +b.rsi > 70 ? 2 : 0;
        return scoreB - scoreA;
      });
      return { pairs: results, scannedAt: new Date().toISOString() };
    }

    case 'calculate': {
      try {
        const candles = await _fetchOHLC(input.pair, input.interval, input.limit || 200);
        if (!candles) return { error: 'Failed to fetch data for calculation' };
        const fn = new Function('candles', input.code);
        const result = fn(candles);
        return { result, candleCount: candles.length };
      } catch (e) {
        return { error: 'Calculation error: ' + e.message };
      }
    }

    case 'backtest_strategy': {
      try {
        const limit = Math.min(Math.ceil((input.days_back || 30) * 1440 / (input.interval || 60)), 1000);
        const candles = await _fetchOHLC(input.pair, input.interval || 60, limit);
        if (!candles || candles.length < 20) return { error: 'Not enough data' };

        const entryFn = new Function('candles', 'i', 'state', input.entry_code);
        const exitFn  = new Function('candles', 'i', 'entry_price', 'state', input.exit_code);
        const stopPct   = input.stop_pct   || 0.02;
        const targetPct = input.target_pct || 0.04;

        let inTrade = false, entryPrice = 0, trades = [], equity = 1000;
        const equityCurve = [equity];
        let peak = equity, maxDD = 0;

        for (let i = 20; i < candles.length; i++) {
          const state = { inTrade, entryPrice };
          if (!inTrade) {
            try { if (entryFn(candles, i, state)) { inTrade = true; entryPrice = candles[i].c; } } catch (_) {}
          } else {
            const hi = candles[i].h, lo = candles[i].l;
            const stopped  = lo <= entryPrice * (1 - stopPct);
            const targeted = hi >= entryPrice * (1 + targetPct);
            let exit = false, exitPrice = candles[i].c, reason = 'signal';
            if (stopped)  { exit = true; exitPrice = entryPrice * (1 - stopPct); reason = 'stop'; }
            else if (targeted) { exit = true; exitPrice = entryPrice * (1 + targetPct); reason = 'target'; }
            else { try { if (exitFn(candles, i, entryPrice, state)) exit = true; } catch (_) {} }
            if (exit) {
              const pnlPct = (exitPrice - entryPrice) / entryPrice;
              equity *= (1 + pnlPct);
              trades.push({ entry: entryPrice, exit: exitPrice, pnlPct: +(pnlPct * 100).toFixed(2), reason, bar: i });
              equityCurve.push(equity);
              if (equity > peak) peak = equity;
              const dd = (peak - equity) / peak;
              if (dd > maxDD) maxDD = dd;
              inTrade = false;
            }
          }
        }

        const wins = trades.filter(t => t.pnlPct > 0).length;
        const totalPnl = (equity - 1000).toFixed(2);
        return {
          trades: trades.length, wins, losses: trades.length - wins,
          winRate: trades.length ? +(wins / trades.length * 100).toFixed(1) : 0,
          totalPnlUsd: totalPnl, totalPnlPct: +((equity / 1000 - 1) * 100).toFixed(1),
          maxDrawdownPct: +(maxDD * 100).toFixed(1),
          avgWin:  trades.filter(t => t.pnlPct > 0).reduce((s, t) => s + t.pnlPct, 0) / (wins || 1),
          avgLoss: trades.filter(t => t.pnlPct <= 0).reduce((s, t) => s + t.pnlPct, 0) / (trades.length - wins || 1),
          tradeList: trades.slice(-10),
        };
      } catch (e) {
        return { error: 'Backtest error: ' + e.message };
      }
    }

    case 'evaluate_trade': {
      const won = input.outcome_pct > 0;
      const lesson = {
        key: 'trade_eval_' + Date.now(),
        value: `Trade ${won ? 'WON' : 'LOST'} ${input.outcome_pct.toFixed(2)}% | ${input.side} | Entry: ${input.entry_price} Exit: ${input.exit_price} | Reasoning was: "${input.original_reasoning}" | What happened: ${input.what_happened || 'not specified'}`,
        category: 'lesson',
        savedAt: new Date().toISOString(),
      };
      _memory.set(lesson.key, lesson);
      if (context.saveMemory) await context.saveMemory(lesson);
      return { evaluated: true, won, lesson: lesson.value };
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
        JSON.stringify(k).toLowerCase().includes(q)
      );
      return { memory: memResults, knowledge: knResults, total: memResults.length + knResults.length };
    }

    case 'get_trade_history': {
      const trades = context.getTradeHistory ? await context.getTradeHistory(input.limit || 20) : [];
      return { trades, count: trades.length };
    }

    case 'get_knowledge': {
      const q = input.filter ? input.filter.toLowerCase() : null;
      const items = q ? _knowledge.filter(k => JSON.stringify(k).toLowerCase().includes(q)) : _knowledge;
      return { items, count: items.length };
    }

    case 'place_trade': {
      if (!context.canTrade) return { error: 'Trading is disabled. Owner must enable autonomous trading from the NEXUS AI panel.' };
      if (context.placeTrade) return await context.placeTrade(input);
      return { error: 'Trade execution not wired in this context' };
    }

    case 'get_open_positions': {
      const positions = context.getOpenPositions ? context.getOpenPositions() : [];
      return { positions, count: positions.length };
    }

    case 'close_position': {
      if (!context.canTrade) return { error: 'Trading is disabled' };
      if (context.closePosition) return await context.closePosition(input.position_id);
      return { error: 'Close position not available in this context' };
    }

    default:
      return { error: 'Unknown tool: ' + name };
  }
}

// ─── Main agent chat (streaming) ──────────────────────────────────────────
async function agentChat({ sessionId, userMessage, images = [], context = {}, model = 'claude-opus-4-7', onToken }) {
  if (!_convHist.has(sessionId)) _convHist.set(sessionId, []);
  const messages = _convHist.get(sessionId);

  const userContent = [];
  for (const img of images) {
    userContent.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType || 'image/jpeg', data: img.data } });
  }
  if (userMessage) userContent.push({ type: 'text', text: userMessage });
  messages.push({ role: 'user', content: userContent });

  const systemPrompt = _buildSystemPrompt(context);
  let finalText = '';
  const toolCalls = [];

  while (true) {
    const response = await client.messages.create({
      model, max_tokens: 4096, system: systemPrompt, tools: TOOLS, messages,
    });

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

    messages.push({ role: 'assistant', content: response.content });
    if (responseText) finalText += responseText;
    if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') break;

    const toolResults = [];
    for (const toolUse of toolUseBlocks) {
      if (onToken) onToken({ type: 'tool_running', tool: toolUse.name });
      const result = await executeTool(toolUse.name, toolUse.input, context);
      toolCalls.push({ tool: toolUse.name, input: toolUse.input, result });
      toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(result) });
      if (onToken) onToken({ type: 'tool_done', tool: toolUse.name, result });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  if (messages.length > 40) _convHist.set(sessionId, messages.slice(-40));
  return { text: finalText, toolCalls, sessionId };
}

// ─── Image analysis ───────────────────────────────────────────────────────
async function analyzeImages({ images, userContext = '', model = 'claude-opus-4-7' }) {
  const content = [];
  for (const img of images) {
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType || 'image/jpeg', data: img.data } });
  }
  content.push({
    type: 'text',
    text: `You are an elite trading analyst. Analyze these images and extract ALL useful trading information.

Return ONLY valid JSON:
{
  "summary": "what this shows",
  "type": "chart|strategy|zones|educational|other",
  "price_levels": [{ "price": number, "label": "support/resistance/entry/target/stop/zone/delta", "strength": "strong/medium/weak", "notes": "..." }],
  "trading_rules": ["rule..."],
  "entry_conditions": ["condition..."],
  "exit_conditions": ["condition..."],
  "risk_rules": ["rule..."],
  "key_concepts": ["concept..."],
  "timeframes": ["applicable timeframes..."],
  "explanation": "detailed explanation of everything and how to use it",
  "tradeable": true/false,
  "confidence": 1-10
}

${userContext ? 'User context: ' + userContext : ''}`,
  });

  const response = await client.messages.create({
    model, max_tokens: 2048,
    messages: [{ role: 'user', content }],
  });

  const raw = response.content[0]?.text || '{}';
  try {
    const parsed = JSON.parse(raw.replace(/```json\n?|\n?```/g, '').trim());
    const item = { ...parsed, uploadedAt: new Date().toISOString(), id: Date.now() };
    _knowledge.push(item);
    return item;
  } catch {
    return { summary: raw, error: 'Could not parse structured response', raw };
  }
}

// ─── Autonomous learning loop ─────────────────────────────────────────────
// Runs hourly in the background. Scans markets, tests ideas, reviews history.
let _learningActive = false;

async function runLearningCycle(context = {}) {
  if (_learningActive) return;
  _learningActive = true;
  const started = new Date().toISOString();
  const log = [];

  try {
    log.push({ t: new Date().toISOString(), msg: 'Learning cycle started' });

    const systemPrompt = _buildSystemPrompt({ ...context, autonomousMode: true });
    const learningPrompt = `You are running an autonomous learning cycle. The trader is sleeping. Your job is to:

1. Scan the major crypto pairs for significant setups or pattern changes
2. Review any recent trade outcomes in history and extract lessons
3. Test any strategy ideas you've been developing against historical data
4. Check funding rates and fear/greed for market sentiment context
5. Get the latest crypto news for any market-moving events
6. Store any important observations or insights to memory
7. If you find a genuinely exceptional setup (confidence 9+), flag it clearly

Be thorough but efficient. Use your tools. At the end, write a brief summary of what you found and learned.

Current time: ${new Date().toUTCString()}
Memory items: ${_memory.size}
Knowledge items: ${_knowledge.length}`;

    const messages = [{ role: 'user', content: learningPrompt }];
    let fullResponse = '';

    // Run one full agentic loop
    while (true) {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6', // Sonnet for speed/cost on automated cycles
        max_tokens: 4096,
        system: systemPrompt,
        tools: TOOLS,
        messages,
      });

      const toolUseBlocks = [];
      for (const block of response.content) {
        if (block.type === 'text') fullResponse += block.text;
        if (block.type === 'tool_use') toolUseBlocks.push(block);
      }

      messages.push({ role: 'assistant', content: response.content });

      if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') break;

      const toolResults = [];
      for (const tu of toolUseBlocks) {
        log.push({ t: new Date().toISOString(), msg: 'Used tool: ' + tu.name });
        const result = await executeTool(tu.name, tu.input, context);
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
      }
      messages.push({ role: 'user', content: toolResults });
    }

    // Store the learning session summary
    if (fullResponse) {
      const entry = {
        key: 'learning_cycle_' + Date.now(),
        value: fullResponse.slice(0, 2000),
        category: 'autonomous_learning',
        savedAt: started,
      };
      _memory.set(entry.key, entry);
      if (context.saveMemory) await context.saveMemory(entry);
      log.push({ t: new Date().toISOString(), msg: 'Cycle complete. Summary stored.' });
    }

    const toolsUsed = log.filter(l => l.msg.startsWith('Used tool:')).map(l => l.msg.replace('Used tool: ', ''));
    _learnLog.unshift({
      startedAt: started,
      completedAt: new Date().toISOString(),
      status: 'ok',
      manual: !!context.manual,
      summary: fullResponse.slice(0, 500),
      insights: toolsUsed,
    });
    if (_learnLog.length > 48) _learnLog.pop();

  } catch (e) {
    console.error('[Agent] Learning cycle error:', e.message);
    _learnLog.unshift({
      startedAt: started,
      completedAt: new Date().toISOString(),
      status: 'error',
      manual: !!context.manual,
      summary: '',
      error: e.message,
    });
    if (_learnLog.length > 48) _learnLog.pop();
  } finally {
    _learningActive = false;
  }

  return { log, summary: _learnLog[0] };
}

// ─── Autonomous trading cycle ─────────────────────────────────────────────
let _tradingCycleActive = false;
const SCAN_PAIRS = ['XRPUSD', 'BTCUSD', 'ETHUSD', 'SOLUSD'];

async function runTradingCycle(context = {}) {
  if (_tradingCycleActive) return;
  _tradingCycleActive = true;
  const started = new Date().toISOString();
  console.log('[TradingCycle] Started at', started);

  try {
    const systemPrompt = _buildSystemPrompt({ ...context, autonomousMode: true });
    const openPositions = context.getOpenPositions ? context.getOpenPositions() : [];

    const tradingPrompt = `You are NEXUS AI running a fully autonomous trading cycle. You have full authority to open and close positions.

Current time: ${new Date().toUTCString()}
Open positions: ${openPositions.length}
${openPositions.length ? JSON.stringify(openPositions, null, 2) : '(none)'}
Pairs to scan: ${SCAN_PAIRS.join(', ')}
Knowledge items: ${_knowledge.length}
Memory items: ${_memory.size}

Your tasks for this cycle:
1. CHECK open positions: get current prices and determine if any stops/targets have been hit. Close them if needed.
2. SCAN all pairs across multiple timeframes for high-probability setups.
3. CHECK funding rates, fear/greed, and order book before any entry.
4. ENTER trades only when confidence is 8/10 or higher. Max 3 open positions at a time.
5. REMEMBER key findings and lessons.
6. Brief summary at end.

Risk rules (non-negotiable):
- Max 2% account risk per trade
- Always define stop loss and take profit
- Never add to losing positions
- Never trade against extreme funding (>0.1% rate) unless clear reversal setup
- If uncertainty > 40%, wait

Execute the cycle now. Use your tools. Be the best trader in the room.`;

    const messages = [{ role: 'user', content: tradingPrompt }];
    let fullResponse = '';
    let tradesExecuted = 0;

    while (true) {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6', // Sonnet for cycle speed; Opus used for user chat
        max_tokens: 8096,
        system: systemPrompt,
        tools: TOOLS,
        messages,
      });

      const toolUseBlocks = [];
      for (const block of response.content) {
        if (block.type === 'text') fullResponse += block.text;
        if (block.type === 'tool_use') toolUseBlocks.push(block);
      }

      messages.push({ role: 'assistant', content: response.content });
      if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') break;

      const toolResults = [];
      for (const tu of toolUseBlocks) {
        console.log('[TradingCycle] Tool:', tu.name, JSON.stringify(tu.input).slice(0, 80));
        const result = await executeTool(tu.name, tu.input, context);
        if (tu.name === 'place_trade' && result.ok) tradesExecuted++;
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
      }
      messages.push({ role: 'user', content: toolResults });
    }

    // Store summary
    if (fullResponse && context.saveMemory) {
      await context.saveMemory({
        key: 'trading_cycle_' + Date.now(),
        value: fullResponse.slice(0, 1500),
        category: 'trading_cycle',
      });
    }

    console.log(`[TradingCycle] Done — ${tradesExecuted} trade(s) executed. Summary: ${fullResponse.slice(0, 100)}...`);
    return { ok: true, tradesExecuted, summary: fullResponse.slice(0, 500) };

  } catch (e) {
    console.error('[TradingCycle] Error:', e.message);
    return { ok: false, error: e.message };
  } finally {
    _tradingCycleActive = false;
  }
}

// ─── Quick scan (Sonnet, runs on cycle) ───────────────────────────────────
async function quickScan({ pair, currentData, context = {} }) {
  const knowledge = _knowledge.slice(-10);
  const memories  = [..._memory.values()].slice(-20);
  const fg = await _fetchFearGreed();
  const fr = await _fetchFundingRate(pair);

  const prompt = `Trading bot scanning for opportunity. Be decisive.

Pair: ${pair}
Market data: ${JSON.stringify(currentData, null, 2)}
Fear & Greed: ${fg ? fg.value + ' (' + fg.label + ')' : 'unavailable'}
Funding rate: ${fr ? fr.rate : 'unavailable'} (${fr && fr.rate < 0 ? 'bearish sentiment' : 'bullish sentiment'})

Knowledge (${knowledge.length} items): ${knowledge.map(k => k.summary).join(' | ')}
Memories: ${memories.map(m => m.key + ': ' + m.value.slice(0, 80)).join('\n')}

Respond with JSON only:
{
  "action": "buy"|"sell"|"wait",
  "confidence": 1-10,
  "reasoning": "specific reasoning",
  "entry": number|null,
  "stop": number|null,
  "target": number|null,
  "risk_reward": number|null
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

// ─── System prompt ────────────────────────────────────────────────────────
function _buildSystemPrompt(context) {
  const memCount  = _memory.size;
  const knowCount = _knowledge.length;
  const recentLessons = [..._memory.values()].filter(m => m.category === 'lesson').slice(-5).map(m => m.value).join('\n');

  const recentTrades = [..._memory.values()].filter(m => m.category === 'trading_cycle').slice(-3).map(m => m.value.slice(0, 200)).join('\n---\n');

  return `You are NEXUS AI — a fully autonomous elite crypto trading agent. You ARE the trader. You have complete authority to analyze markets, build strategies, place and manage trades, and learn from every outcome. You run autonomously while the owner sleeps and execute independently when auto-trading is enabled.

FULL CAPABILITIES:
- Live market data: OHLC candles, order book, ticker for any pair
- Market intelligence: funding rates, liquidations, fear/greed index, crypto news
- Custom indicators: write and run any indicator in JavaScript
- Backtesting: test strategies on historical data before committing capital
- Trade execution: place real orders on Kraken (buy/sell/market/limit)
- Position management: monitor open positions, hit stops/targets, close when needed
- Memory: remember everything across sessions — your knowledge compounds forever
- Scanner: scan multiple pairs simultaneously for the best setup

RECENT TRADE ACTIVITY:
${recentTrades || 'No recent trading cycle data yet'}

RECENT LESSONS:
${recentLessons || 'No lessons yet — will accumulate as trades complete'}

CURRENT STATE:
- Active pair: ${context.pair || 'XRPUSD'}
- Memory: ${memCount} items | Knowledge base: ${knowCount} items
- Trade execution: ${context.canTrade ? '✅ LIVE — place real trades on Kraken' : '🔒 ANALYSIS ONLY — owner must enable trading'}
- Mode: ${context.autonomousTrading ? '🤖 AUTONOMOUS TRADING — full self-directed operation' : context.autonomousMode ? '📚 LEARNING CYCLE — studying while owner sleeps' : '💬 INTERACTIVE — talking with owner'}

TRADING PRINCIPLES (non-negotiable):
1. Scan knowledge base first — owner may have uploaded critical zones/strategies
2. Check funding rates + fear/greed + order book before every entry
3. Never skip stop loss and take profit — define both before placing any order
4. Max 2% account risk per trade — calculate position size properly
5. Max 3 concurrent open positions
6. Confidence 8/10 minimum to enter — anything less is a wait
7. If funding rate is extreme (>0.1%), requires exceptional setup to trade with trend
8. After any loss, evaluate_trade and extract lesson before next entry

COMMUNICATION STYLE:
- Talk like a Wall Street professional, not a chatbot — direct, precise, confident
- Use exact prices: "$0.5234" not "around 52 cents"
- When using a tool, briefly state what you found before the analysis
- Own your calls — say what you see and why. If wrong, say so and adapt
- In autonomous mode: be thorough, store insights, make decisions like it's real money (it is)`;
}

// ─── HTTP/API helpers ─────────────────────────────────────────────────────
function _fetchOHLC(pair, interval, limit = 200) {
  return new Promise((resolve) => {
    const url = `http://localhost:${process.env.PORT || 3000}/ohlc?pair=${encodeURIComponent(pair)}&interval=${interval}&limit=${Math.min(limit, 1000)}`;
    const req = http.get(url, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { const d = JSON.parse(raw); resolve(d.ok ? d.candles : null); } catch { resolve(null); }
      });
    });
    req.setTimeout(12000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function _fetchTicker(pair) {
  return new Promise((resolve) => {
    const sym = _toBinSym(pair);
    const url = `https://api.binance.com/api/v3/ticker/24hr?symbol=${sym}`;
    const req = https.get(url, { headers: { 'User-Agent': 'NEXUS/4.0' } }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const d = JSON.parse(raw);
          resolve({ pair, price: +d.lastPrice, change24h: +d.priceChangePercent, volume24h: +d.quoteVolume, high24h: +d.highPrice, low24h: +d.lowPrice });
        } catch { resolve(null); }
      });
    });
    req.setTimeout(6000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function _fetchPrice(pair) {
  return _fetchTicker(pair).then(t => t ? t.price : null);
}

function _fetchOrderBook(pair, depth = 20) {
  return new Promise((resolve) => {
    const sym = _toBinSym(pair);
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
          resolve({ bids: bids.slice(0, 10), asks: asks.slice(0, 10), bidVolume: bidVol, askVolume: askVol, obi: +((bidVol - askVol) / (bidVol + askVol)).toFixed(4) });
        } catch { resolve(null); }
      });
    });
    req.setTimeout(6000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function _fetchFundingRate(pair) {
  return new Promise((resolve) => {
    const sym = _toBinSym(pair);
    const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}&limit=3`;
    const req = https.get(url, { headers: { 'User-Agent': 'NEXUS/4.0' } }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const d = JSON.parse(raw);
          if (!Array.isArray(d) || !d.length) { resolve(null); return; }
          const latest = d[d.length - 1];
          const rate = +latest.fundingRate;
          resolve({
            pair, rate, rateAnnualized: +(rate * 3 * 365 * 100).toFixed(2),
            sentiment: rate > 0.001 ? 'very bullish (longs paying)' : rate > 0 ? 'mildly bullish' : rate < -0.001 ? 'very bearish (shorts paying)' : 'mildly bearish',
            time: new Date(+latest.fundingTime).toISOString(),
          });
        } catch { resolve(null); }
      });
    });
    req.setTimeout(6000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function _fetchLiquidations(pair, limit = 20) {
  return new Promise((resolve) => {
    const sym = _toBinSym(pair);
    const url = `https://fapi.binance.com/fapi/v1/allForceOrders?symbol=${sym}&limit=${limit}`;
    const req = https.get(url, { headers: { 'User-Agent': 'NEXUS/4.0' } }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const d = JSON.parse(raw);
          if (!Array.isArray(d)) { resolve(null); return; }
          const events = d.map(l => ({
            side: l.S === 'BUY' ? 'short_liquidated' : 'long_liquidated',
            price: +l.p, size: +l.q,
            value_usd: +(+l.p * +l.q).toFixed(2),
            time: new Date(+l.T).toISOString(),
          }));
          const totalLongs = events.filter(e => e.side === 'long_liquidated').reduce((s, e) => s + e.value_usd, 0);
          const totalShorts = events.filter(e => e.side === 'short_liquidated').reduce((s, e) => s + e.value_usd, 0);
          resolve({ events: events.slice(0, 10), totalLongsLiquidated: totalLongs, totalShortsLiquidated: totalShorts, dominantSide: totalLongs > totalShorts ? 'longs being squeezed (bearish pressure)' : 'shorts being squeezed (bullish pressure)' });
        } catch { resolve(null); }
      });
    });
    req.setTimeout(6000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function _fetchFearGreed() {
  return new Promise((resolve) => {
    const req = https.get('https://api.alternative.me/fng/?limit=1', { headers: { 'User-Agent': 'NEXUS/4.0' } }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const d = JSON.parse(raw);
          const item = d.data && d.data[0];
          if (!item) { resolve(null); return; }
          const val = +item.value;
          resolve({
            value: val, label: item.value_classification,
            interpretation: val < 25 ? 'Extreme fear — historically good buying opportunity' : val < 45 ? 'Fear — market cautious, potential opportunity' : val < 55 ? 'Neutral' : val < 75 ? 'Greed — be cautious on longs' : 'Extreme greed — high risk of correction',
          });
        } catch { resolve(null); }
      });
    });
    req.setTimeout(6000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function _fetchNews(query = 'crypto', limit = 10) {
  return new Promise((resolve) => {
    const url = `https://min-api.cryptocompare.com/data/v2/news/?categories=${encodeURIComponent(query)}&excludeCategories=Sponsored&lang=EN`;
    const req = https.get(url, { headers: { 'User-Agent': 'NEXUS/4.0' } }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const d = JSON.parse(raw);
          const articles = (d.Data || []).slice(0, limit).map(a => ({
            title: a.title, source: a.source_info?.name || a.source,
            published: new Date(a.published_on * 1000).toISOString(),
            summary: a.body ? a.body.slice(0, 200) : '',
            url: a.url,
          }));
          resolve({ articles, count: articles.length });
        } catch { resolve(null); }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────
function _toBinSym(pair) {
  let s = pair.toUpperCase().replace('XBT', 'BTC');
  s = s.replace(/^X([A-Z]{2,4})Z([A-Z]{3})$/, '$1$2');
  if (s.endsWith('USD') && !s.endsWith('USDT')) s += 'T';
  return s;
}

function _calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const rs = gains / (losses || 0.001);
  return 100 - 100 / (1 + rs);
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Memory access ────────────────────────────────────────────────────────
function getMemory()    { return [..._memory.values()]; }
function getKnowledge() { return [..._knowledge]; }
function getLearnLog()  { return [..._learnLog]; }
function loadMemory(items)    { items.forEach(i => _memory.set(i.key, i)); }
function loadKnowledge(items) { items.forEach(i => _knowledge.push(i)); }

module.exports = { agentChat, analyzeImages, quickScan, runLearningCycle, runTradingCycle, getMemory, getKnowledge, getLearnLog, loadMemory, loadKnowledge, TOOLS };
