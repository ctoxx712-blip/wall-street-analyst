/**
 * Wall Street Analyst - Cloudflare Worker backend.
 *
 * Runs on Cloudflare's free tier (100k requests/day, never sleeps).
 * The Anthropic API key lives ONLY in Worker secrets - the browser never sees it.
 * Static files (static/index.html) are served through the ASSETS binding, so the
 * same frontend works against either this Worker or the Flask app in app.py.
 *
 * Secrets to set (Cloudflare dashboard -> Settings -> Variables and Secrets):
 *   ANTHROPIC_API_KEY   required
 *   ACCESS_PASSWORD     optional; blank = anyone with the URL can use it
 */

const MODEL = "claude-opus-4-8";
const MAX_TOKENS = 4000;
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const BASE_SYSTEM = `You are a senior Wall Street analyst producing institutional-grade \
financial analysis, using the frameworks employed at Goldman Sachs, Morgan Stanley, \
KKR and Blackstone.

Core standards for every response:
- SHOW YOUR MATH. Never state a multiple, ratio or valuation without its inputs.
- LABEL EVERY ASSUMPTION (growth rate, margin, WACC, terminal growth, exit multiple).
- PRESENT RANGES: bull / base / bear. Never a single-point estimate.
- USE MARKDOWN TABLES for multiples, comps, sensitivity grids and scenarios.
- COMPARE TO PEERS. Absolute numbers mean little without context.
- FLAG THE 3 ASSUMPTIONS that swing the valuation most.
- PICK THE RIGHT METRIC FOR THE SECTOR: banks use P/TBV and ROTCE (not EV/EBITDA); \
REITs use P/FFO and NAV (not P/E); biotech uses risk-adjusted NPV; SaaS uses \
EV/ARR, NRR and Rule of 40; E&P uses EV/EBITDAX and reserve life.
- STATE DATA VINTAGE. If you are unsure whether a figure is current, say so and tell \
the user to verify against the latest SEC filing or investor-relations page.

Always close with a short, plain disclaimer: this is educational analysis, not \
investment advice, and the user should verify figures and consult a licensed advisor.

If the user writes in Chinese, reply in Traditional Chinese (Hong Kong style). \
Otherwise reply in the user's language. Keep formatting clean and readable.`;

const FRAMEWORKS = {
  auto: "",
  dcf: `Produce a DCF valuation: 5-year FCF build (revenue -> EBITDA -> EBIT -> \
NOPAT -> FCF), WACC via CAPM with each input stated, terminal value using BOTH \
perpetuity growth and exit multiple, a two-way WACC x terminal-growth sensitivity \
table, and a bull/base/bear per-share range.`,
  comps: `Produce a comparable company analysis: 8-15 peers with inclusion \
rationale, NTM EV/Revenue, EV/EBITDA, P/E and EV/FCF for each, 25th/median/75th \
percentiles, implied valuation applied to the target, and a premium/discount \
justification versus peers.`,
  "3stmt": `Produce a three-statement model: 5-year income statement, balance \
sheet and cash flow statement, the linking logic between them, a working-capital \
model (DSO/DIO/DPO), a debt schedule, key assumptions, and error checks (A = L + E).`,
  lbo: `Produce an LBO model: sources and uses, debt structure by tranche with \
rates and amortisation, cash flow sweep, exit scenarios at years 3/4/5 across a \
multiple range, equity IRR and MOIC for each, and a debt paydown schedule.`,
  ma: `Produce an M&A accretion/dilution analysis: deal structure and premium, \
pro forma income statement, standalone vs pro forma EPS, itemised synergies with \
phasing, funding sources with interest cost, pro forma credit metrics, breakeven \
synergies, and a sensitivity table.`,
  sotp: `Produce a sum-of-the-parts valuation: break the company into segments, \
give each segment's financials, choose and justify a valuation method per segment, \
value each, handle unallocated corporate costs, bridge enterprise value to equity \
value, and give value per share versus the current price.`,
  credit: `Produce a credit and debt capacity analysis: historical and projected \
EBITDA with adjustments, leverage and coverage ratios versus rating-agency \
thresholds, debt structure by tranche, covenant package, maximum debt capacity, a \
pricing grid by leverage level, and the refinancing maturity profile.`,
  unit: `Produce an operating model and unit economics: bottom-up revenue build \
with the explicit driver model, CAC / LTV / LTV-to-CAC / payback, cohort retention, \
the five most sensitive drivers with +/-10% impact, burn rate and runway, and \
breakeven analysis.`,
  risk: `Produce a sensitivity and scenario analysis: one-way sensitivity on each \
key variable at +/-20%, a two-way matrix on the two most impactful variables, \
explicit bull/base/bear assumption sets, breakeven analysis, downside protection and \
margin of safety, and the top 5 risks ranked by impact.`,
  memo: `Produce an investment committee memo: three-paragraph executive summary, \
company analysis, industry and TAM, a 3-5 point investment thesis where each point \
is a testable hypothesis, valuation summary across methods (football field), returns \
analysis, top 5 risks with mitigants, and a clear invest/pass recommendation with a \
maximum acceptable price.`,
  screen: `Produce a quick screen in under one page: one-line business description, \
current price and key multiples, three things to like, three concerns, the single \
most important question for deeper work, and which framework to apply next.`,
};

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Turn an Anthropic error into something a non-engineer can act on. */
function friendlyError(status, body) {
  const detail = (body && body.error && body.error.message) || "";
  const lower = detail.toLowerCase();
  if (lower.includes("credit balance")) {
    return "Your Anthropic account is out of credits. Top up at console.anthropic.com under Plans & Billing.";
  }
  if (status === 401 || lower.includes("authentication")) {
    return "The API key is invalid. Check the ANTHROPIC_API_KEY secret in Cloudflare.";
  }
  if (status === 429 || lower.includes("rate_limit")) {
    return "Rate limited by the API. Wait a moment and try again.";
  }
  if (lower.includes("overloaded")) {
    return "The model is temporarily overloaded. Please try again shortly.";
  }
  return "API error (" + status + "): " + (detail || "unknown").slice(0, 300);
}

async function handleChat(request, env) {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: "Server is missing ANTHROPIC_API_KEY. Set it in Cloudflare secrets." }, 500);
  }

  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }

  if (env.ACCESS_PASSWORD && data.password !== env.ACCESS_PASSWORD) {
    return json({ error: "Incorrect access password." }, 401);
  }

  // Keep the last 20 turns so long sessions stay within budget.
  const messages = (Array.isArray(data.messages) ? data.messages : [])
    .slice(-20)
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content)
    .map((m) => ({ role: m.role, content: String(m.content) }));

  if (messages.length === 0) {
    return json({ error: "No message provided." }, 400);
  }

  let system = BASE_SYSTEM;
  const extra = FRAMEWORKS[data.framework] || "";
  if (extra) system += "\n\nThe user selected a specific framework. " + extra;

  let upstream;
  try {
    upstream = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system, messages }),
    });
  } catch (e) {
    return json({ error: "Could not reach the Anthropic API: " + e.message }, 502);
  }

  let body;
  try {
    body = await upstream.json();
  } catch {
    return json({ error: "Unexpected response from the Anthropic API." }, 502);
  }

  if (!upstream.ok) {
    return json({ error: friendlyError(upstream.status, body) }, 502);
  }

  const reply = (body.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  if (!reply) {
    return json({ error: "The model returned an empty response. Try rephrasing." }, 502);
  }

  return json({ reply });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/config") {
      return json({ requires_password: Boolean(env.ACCESS_PASSWORD) });
    }

    if (url.pathname === "/api/chat") {
      if (request.method !== "POST") {
        return json({ error: "Method not allowed." }, 405);
      }
      return handleChat(request, env);
    }

    // Everything else is a static file (static/index.html and friends).
    return env.ASSETS.fetch(request);
  },
};
