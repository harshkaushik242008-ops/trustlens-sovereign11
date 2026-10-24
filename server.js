'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Groq = require('groq-sdk');

const PORT = process.env.PORT || 5000;
const PRIMARY_MODEL = (process.env.GROQ_MODEL || 'openai/gpt-oss-120b').trim();
const FALLBACK_MODELS = (process.env.GROQ_FALLBACK_MODELS || 'qwen/qwen3.6-27b')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
const MODEL_CHAIN = [PRIMARY_MODEL, ...FALLBACK_MODELS.filter((m) => m !== PRIMARY_MODEL)];

if (!process.env.GROQ_API_KEY) {
  console.error('[TrustLens] Missing GROQ_API_KEY in .env');
  process.exit(1);
}

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const app = express();

// Chrome Private Network Access: allow https pages to reach localhost.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  next();
});

app.use(
  cors({
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
  })
);
app.use(express.json({ limit: '1mb' }));

/* ---------------------------- helpers ---------------------------- */

const clip = (v, n = 500) => String(v == null ? '' : v).slice(0, n);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number(n) || 0));
const toStringArray = (a, max = 8) =>
  Array.isArray(a) ? a.map((x) => clip(x, 300)).filter(Boolean).slice(0, max) : [];

function verdictFromScore(score) {
  if (score >= 70) return 'DANGEROUS';
  if (score >= 40) return 'SUSPICIOUS';
  return 'SAFE';
}

// Remove <think>...</think> blocks some reasoning models leak into content.
const stripThinking = (s) => String(s || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

function isModelUnavailable(err) {
  const code = err && (err.code || (err.error && err.error.code) || (err.error && err.error.error && err.error.error.code));
  const msg = String((err && err.message) || '').toLowerCase();
  return (
    code === 'model_not_found' ||
    code === 'model_decommissioned' ||
    err.status === 404 ||
    msg.includes('model_not_found') ||
    msg.includes('decommissioned') ||
    msg.includes('does not exist')
  );
}

/**
 * Calls Groq with automatic fallback if a model is retired / unavailable.
 * Uses the first working model for all subsequent requests.
 */
let activeModelIndex = 0;
async function createCompletion({ messages, temperature, maxTokens, json = false }) {
  let lastErr;
  for (let i = activeModelIndex; i < MODEL_CHAIN.length; i++) {
    const model = MODEL_CHAIN[i];
    const params = {
      model,
      messages,
      temperature,
      max_completion_tokens: maxTokens, // reasoning tokens count here, so keep it generous
    };
    if (json) params.response_format = { type: 'json_object' };
    if (model.startsWith('openai/gpt-oss')) params.reasoning_effort = 'low'; // fast + cheap

    try {
      const completion = await groq.chat.completions.create(params);
      if (i !== activeModelIndex) {
        console.warn(`[TrustLens] Switched to fallback model: ${model}`);
        activeModelIndex = i;
      }
      completion._modelUsed = model;
      return completion;
    } catch (err) {
      lastErr = err;
      if (isModelUnavailable(err) && i < MODEL_CHAIN.length - 1) {
        console.warn(`[TrustLens] Model "${model}" unavailable, trying next fallback...`);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

const ANALYZE_SYSTEM_PROMPT = `You are TrustLens Sovereign, an elite cybersecurity and e-commerce fraud analyst.
You receive telemetry collected from a web page the user is viewing. Assess the likelihood of fraud, phishing,
counterfeit listings, fake reviews, deceptive pricing, dark patterns, or malicious behavior.

Guidelines:
- Official marketplace domains (amazon.*, flipkart.com) over HTTPS are generally legitimate; focus on the listing,
  seller, pricing, reviews and urgency tactics rather than the domain itself.
- Lookalike domains, missing HTTPS, password forms posting off-domain, excessive iframes, unrealistic discounts,
  extreme urgency, unknown sellers and off-platform payment requests raise risk.
- Do not invent facts. If data is missing, say so and lower confidence.

Respond with ONLY a valid JSON object in this exact shape:
{
  "riskScore": <integer 0-100, higher = more dangerous>,
  "verdict": "SAFE" | "SUSPICIOUS" | "DANGEROUS",
  "confidence": <integer 0-100>,
  "summary": "<one or two sentence plain-language conclusion>",
  "threats": ["<specific finding>", "..."],
  "recommendations": ["<actionable advice>", "..."]
}`;

const CHAT_SYSTEM_PROMPT = `You are TrustLens Sovereign, a concise and friendly cybersecurity assistant embedded in a browser extension.
Help the user judge whether a website, seller, product or message is safe. Give practical, specific advice.
Use the supplied page context when relevant. Keep answers under 150 words unless asked for detail.
Never claim certainty you do not have. Reply in the same language the user writes in.`;

function buildTelemetrySummary(t = {}) {
  return JSON.stringify(
    {
      url: clip(t.url, 500),
      hostname: clip(t.hostname, 200),
      title: clip(t.title, 300),
      isHttps: !!t.isHttps,
      isTrustedMarketplace: !!t.isTrustedMarketplace,
      price: clip(t.price, 60),
      originalPrice: clip(t.originalPrice, 60),
      discount: clip(t.discount, 60),
      rating: clip(t.rating, 60),
      reviewCount: clip(t.reviewCount, 60),
      seller: clip(t.seller, 200),
      urgencyPhrases: toStringArray(t.urgencyPhrases, 10),
      passwordFields: Number(t.passwordFields) || 0,
      offDomainForms: Number(t.offDomainForms) || 0,
      iframeCount: Number(t.iframeCount) || 0,
      totalLinks: Number(t.totalLinks) || 0,
      externalLinks: Number(t.externalLinks) || 0,
      externalDomains: toStringArray(t.externalDomains, 15),
      textSample: clip(t.textSample, 3000),
    },
    null,
    2
  );
}

/* ----------------------------- routes ----------------------------- */

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'TrustLens Sovereign',
    activeModel: MODEL_CHAIN[activeModelIndex],
    modelChain: MODEL_CHAIN,
  });
});

app.post('/api/analyze', async (req, res, next) => {
  try {
    const telemetry = req.body && (req.body.telemetry || req.body);
    if (!telemetry || typeof telemetry !== 'object' || !telemetry.url) {
      return res.status(400).json({ error: 'Telemetry payload with a "url" field is required.' });
    }

    const completion = await createCompletion({
      temperature: 0.2,
      maxTokens: 2500,
      json: true,
      messages: [
        { role: 'system', content: ANALYZE_SYSTEM_PROMPT },
        { role: 'user', content: `Analyze this page telemetry:\n${buildTelemetrySummary(telemetry)}` },
      ],
    });

    const raw = stripThinking(completion.choices?.[0]?.message?.content) || '{}';
    let parsed = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      try {
        parsed = match ? JSON.parse(match[0]) : {};
      } catch {
        parsed = {};
      }
    }

    const riskScore = Math.round(clamp(parsed.riskScore, 0, 100));
    const verdict = ['SAFE', 'SUSPICIOUS', 'DANGEROUS'].includes(parsed.verdict)
      ? parsed.verdict
      : verdictFromScore(riskScore);

    res.json({
      riskScore,
      verdict,
      confidence: Math.round(clamp(parsed.confidence, 0, 100)),
      summary: clip(parsed.summary || 'Analysis complete.', 600),
      threats: toStringArray(parsed.threats),
      recommendations: toStringArray(parsed.recommendations),
      model: completion._modelUsed,
      analyzedAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

app.post('/api/chat', async (req, res, next) => {
  try {
    const { message, history, context } = req.body || {};
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'A non-empty "message" string is required.' });
    }

    const safeHistory = Array.isArray(history)
      ? history
          .filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
          .slice(-10)
          .map((m) => ({ role: m.role, content: clip(m.content, 1500) }))
      : [];

    const messages = [{ role: 'system', content: CHAT_SYSTEM_PROMPT }];
    if (context && typeof context === 'object') {
      messages.push({
        role: 'system',
        content: `Current page context:\n${buildTelemetrySummary(context)}`,
      });
    }
    messages.push(...safeHistory, { role: 'user', content: clip(message, 2000) });

    const completion = await createCompletion({
      temperature: 0.5,
      maxTokens: 1500,
      messages,
    });

    res.json({
      reply: stripThinking(completion.choices?.[0]?.message?.content) || 'I could not generate a response.',
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------ error handling ------------------------ */

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[TrustLens] Error:', err.message || err);
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  res.status(status).json({
    error: status === 429 ? 'Rate limit reached. Please retry shortly.' : 'Internal server error',
    detail: process.env.NODE_ENV === 'production' ? undefined : err.message,
  });
});

app.listen(PORT, () => {
  console.log(`[TrustLens Sovereign] Running on http://localhost:${PORT}`);
  console.log(`[TrustLens Sovereign] Model chain: ${MODEL_CHAIN.join(' -> ')}`);
});