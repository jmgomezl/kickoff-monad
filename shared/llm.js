/**
 * Provider-agnostic LLM completion for the kickoff agent + backend.
 *
 * Prefers Anthropic (Claude) when ANTHROPIC_API_KEY is set; otherwise falls back
 * to OpenAI when OPENAI_API_KEY is set. SDKs are lazy-required so a service only
 * needs the package for the provider it actually uses.
 */
let _provider = null;
let _client = null;
let _model = null;

function init() {
  if (_provider) return;
  const { ANTHROPIC_API_KEY, OPENAI_API_KEY, CLAUDE_MODEL, OPENAI_MODEL } = process.env;
  if (ANTHROPIC_API_KEY) {
    const Anthropic = require("@anthropic-ai/sdk");
    _client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    _provider = "anthropic";
    _model = CLAUDE_MODEL || "claude-sonnet-4-6";
  } else if (OPENAI_API_KEY) {
    const OpenAI = require("openai");
    _client = new OpenAI({ apiKey: OPENAI_API_KEY });
    _provider = "openai";
    _model = OPENAI_MODEL || "gpt-4o";
  } else {
    _provider = "none";
  }
}

/** Run a single-prompt completion; returns the raw text. */
async function complete(prompt, { maxTokens = 600 } = {}) {
  init();
  if (_provider === "anthropic") {
    const r = await _client.messages.create({
      model: _model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    });
    return r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  }
  if (_provider === "openai") {
    const r = await _client.chat.completions.create({
      model: _model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    });
    return r.choices?.[0]?.message?.content || "";
  }
  throw new Error("No LLM provider configured (set ANTHROPIC_API_KEY or OPENAI_API_KEY).");
}

function provider() {
  init();
  return _provider;
}
function model() {
  init();
  return _model;
}

/** Extract the first JSON object from a model's text response. */
function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch (_) {}
  }
  return null;
}

module.exports = { complete, provider, model, extractJson };
