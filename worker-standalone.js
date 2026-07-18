/**
 * Wall Street Analyst - single-file Cloudflare Worker.
 *
 * The whole site and its backend live in this one file. Paste it into the
 * Cloudflare Workers editor, add ANTHROPIC_API_KEY as a Secret, and deploy.
 *
 * This file is deliberately PURE ASCII: every non-English character is written
 * as a \uXXXX escape, so copying and pasting it through any editor can never
 * corrupt the Chinese text (which was the cause of the earlier mojibake).
 *
 * Secrets (Cloudflare -> Settings -> Variables and Secrets):
 *   ANTHROPIC_API_KEY   required
 *   ACCESS_PASSWORD     optional but recommended
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

CHARTS. The interface renders charts from fenced \`\`\`chart blocks containing JSON.
Include one or two whenever they genuinely aid understanding - especially a football
field for a valuation range, a bar chart for peer multiples, and a scenario chart for
bull/base/bear. Emit the raw JSON only, with no comments. Supported shapes:

\`\`\`chart
{"type":"football","title":"Valuation range","unit":"$",
 "series":[{"label":"DCF","low":120,"high":180},{"label":"Comps","low":140,"high":205}],
 "marker":{"label":"Current","value":155},"note":"optional caption"}
\`\`\`

\`\`\`chart
{"type":"bar","title":"EV/EBITDA (NTM)","unit":"x",
 "data":[{"label":"NVDA","value":28,"highlight":true},{"label":"AMD","value":24}]}
\`\`\`

\`\`\`chart
{"type":"scenario","title":"Per-share value","unit":"$",
 "bear":58,"base":125,"bull":179,"current":201,"currentLabel":"Market"}
\`\`\`

Always keep the equivalent numbers in a markdown table as well, so the analysis still
reads correctly if a chart cannot be drawn. Keep formatting clean and readable.`;

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

const LANGUAGES = {
  en: "Reply in English.",
  zh: "Reply in Traditional Chinese, Hong Kong style. Keep standard finance terms " +
      "(EBITDA, WACC, DCF, EV/EBITDA, IRR) in English.",
  both: "Reply BILINGUALLY. For every heading, paragraph and bullet, give the English " +
        "first, then the Traditional Chinese (Hong Kong style) immediately beneath it. " +
        "In tables, write each header as 'English / \u4e2d\u6587' in the same cell rather " +
        "than duplicating the table. Keep standard finance terms in English.",
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
  const langRule = LANGUAGES[data.lang] || LANGUAGES.en;
  system += "\n\nLANGUAGE. " + langRule;

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
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wall Street Analyst</title>
<style>
  :root{
    --bg:#0d1117; --panel:#141b24; --panel-2:#1b2430; --line:#263341;
    --text:#e6edf3; --muted:#8b98a5; --accent:#d4a24a; --accent-2:#3fb950;
    --danger:#f85149; --user:#1f6feb; --bear:#f85149; --base:#8b98a5; --bull:#3fb950;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
    --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue","PingFang HK","Microsoft JhengHei",sans-serif;
  }
  *{box-sizing:border-box}
  html,body{height:100%}
  body{margin:0;background:var(--bg);color:var(--text);font-family:var(--sans);
       display:flex;flex-direction:column;font-size:15px;line-height:1.6}

  header{background:var(--panel);border-bottom:1px solid var(--line);
         padding:14px 20px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .brand{display:flex;align-items:center;gap:10px;font-weight:650}
  .brand .dot{width:9px;height:9px;border-radius:50%;background:var(--accent-2);
              box-shadow:0 0 8px var(--accent-2)}
  .brand small{display:block;font-weight:400;color:var(--muted);font-size:11.5px;
               letter-spacing:.4px;text-transform:uppercase}
  .spacer{flex:1}
  .status{font-family:var(--mono);font-size:12px;color:var(--muted)}

  .langsw{display:flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
  .langsw button{background:var(--panel-2);border:0;color:var(--muted);
                 padding:6px 11px;font-size:12.5px;cursor:pointer;font-family:inherit}
  .langsw button+button{border-left:1px solid var(--line)}
  .langsw button.on{background:var(--accent);color:#1a1206;font-weight:650}

  .chips{display:flex;gap:7px;padding:12px 20px;overflow-x:auto;
         background:var(--panel);border-bottom:1px solid var(--line)}
  .chip{flex:0 0 auto;background:var(--panel-2);border:1px solid var(--line);
        color:var(--muted);padding:6px 13px;border-radius:20px;font-size:12.5px;
        cursor:pointer;white-space:nowrap;transition:.15s}
  .chip:hover{border-color:var(--accent);color:var(--text)}
  .chip.on{background:var(--accent);border-color:var(--accent);color:#1a1206;font-weight:600}

  main{flex:1;overflow-y:auto;padding:24px 20px}
  .wrap{max-width:900px;margin:0 auto}

  .welcome{text-align:center;padding:44px 16px;color:var(--muted)}
  .welcome h1{color:var(--text);font-size:26px;margin:0 0 10px}
  .examples{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));
            gap:10px;margin-top:26px;text-align:left}
  .ex{background:var(--panel);border:1px solid var(--line);border-radius:9px;
      padding:13px 15px;cursor:pointer;transition:.15s;font-size:13.5px;color:var(--text)}
  .ex:hover{border-color:var(--accent);transform:translateY(-1px)}
  .ex b{display:block;color:var(--accent);font-size:11.5px;text-transform:uppercase;
        letter-spacing:.5px;margin-bottom:3px;font-weight:600}

  .msg{margin-bottom:22px;display:flex;gap:12px}
  .avatar{flex:0 0 30px;height:30px;border-radius:6px;display:grid;place-items:center;
          font-size:12px;font-weight:700;font-family:var(--mono)}
  .msg.user .avatar{background:var(--user);color:#fff}
  .msg.bot .avatar{background:var(--accent);color:#1a1206}
  .body{flex:1;min-width:0}
  .msg.user .body{background:var(--panel-2);border:1px solid var(--line);
                  border-radius:9px;padding:11px 15px}

  .body h1,.body h2,.body h3{margin:20px 0 9px;line-height:1.3}
  .body h1{font-size:20px;border-bottom:1px solid var(--line);padding-bottom:7px}
  .body h2{font-size:17px;color:var(--accent)}
  .body h3{font-size:15px}
  .body p{margin:9px 0}
  .body ul,.body ol{margin:9px 0;padding-left:22px}
  .body li{margin:4px 0}
  .body strong{color:#fff;font-weight:650}
  .body code{background:var(--panel-2);border:1px solid var(--line);border-radius:4px;
             padding:1px 5px;font-family:var(--mono);font-size:13px;color:var(--accent)}
  .body pre{background:var(--panel-2);border:1px solid var(--line);border-radius:8px;
            padding:12px 14px;overflow-x:auto;margin:12px 0}
  .body pre code{background:none;border:0;padding:0;color:var(--text)}
  .body hr{border:0;border-top:1px solid var(--line);margin:18px 0}
  .body a{color:var(--user)}
  .body blockquote{border-left:3px solid var(--accent);margin:12px 0;padding:2px 14px;
                   color:var(--muted);background:var(--panel);border-radius:0 6px 6px 0}
  .tablewrap{overflow-x:auto;margin:13px 0;border:1px solid var(--line);border-radius:8px}
  .body table{border-collapse:collapse;width:100%;font-size:13.5px}
  .body th,.body td{padding:8px 12px;text-align:left;border-bottom:1px solid var(--line);
                    white-space:nowrap}
  .body th{background:var(--panel-2);font-weight:600;color:var(--accent);
           font-size:12px;text-transform:uppercase;letter-spacing:.4px}
  .body tr:last-child td{border-bottom:0}
  .body td{font-family:var(--mono);font-size:13px}
  .body td:first-child{font-family:var(--sans)}

  .chartbox{background:var(--panel);border:1px solid var(--line);border-radius:9px;
            padding:14px 16px;margin:14px 0}
  .chartbox .ctitle{font-size:13px;font-weight:650;color:var(--accent);
                    margin-bottom:10px;letter-spacing:.3px}
  .chartbox svg{width:100%;height:auto;display:block;overflow:visible}
  .chartbox .cnote{font-size:11px;color:var(--muted);margin-top:9px;line-height:1.5}

  .typing{display:flex;gap:5px;padding:6px 0}
  .typing i{width:7px;height:7px;border-radius:50%;background:var(--accent);
            animation:blink 1.4s infinite both}
  .typing i:nth-child(2){animation-delay:.2s}
  .typing i:nth-child(3){animation-delay:.4s}
  @keyframes blink{0%,80%,100%{opacity:.25}40%{opacity:1}}

  .err{background:rgba(248,81,73,.1);border:1px solid var(--danger);color:#ffa198;
       padding:11px 15px;border-radius:8px;font-size:13.5px}

  footer{background:var(--panel);border-top:1px solid var(--line);padding:14px 20px}
  .composer{max-width:900px;margin:0 auto;display:flex;gap:10px;align-items:flex-end}
  textarea{flex:1;background:var(--panel-2);border:1px solid var(--line);color:var(--text);
           border-radius:9px;padding:11px 14px;font-family:var(--sans);font-size:14.5px;
           resize:none;min-height:46px;max-height:180px;line-height:1.5}
  textarea:focus{outline:0;border-color:var(--accent)}
  button.send{background:var(--accent);color:#1a1206;border:0;border-radius:9px;
              padding:0 22px;height:46px;font-weight:650;cursor:pointer;font-size:14.5px}
  button.send:disabled{opacity:.45;cursor:not-allowed}
  .disclaim{max-width:900px;margin:9px auto 0;font-size:11px;color:var(--muted);
            text-align:center;line-height:1.5}

  .gate{position:fixed;inset:0;background:var(--bg);display:none;place-items:center;
        z-index:50;padding:20px}
  .gate.show{display:grid}
  .gatebox{background:var(--panel);border:1px solid var(--line);border-radius:12px;
           padding:30px;max-width:340px;width:100%;text-align:center}
  .gatebox input{width:100%;margin:16px 0 12px;background:var(--panel-2);
                 border:1px solid var(--line);color:var(--text);padding:11px 14px;
                 border-radius:8px;font-size:14.5px}
  .gatebox input:focus{outline:0;border-color:var(--accent)}
  .gatebox button{width:100%;background:var(--accent);color:#1a1206;border:0;
                  padding:11px;border-radius:8px;font-weight:650;cursor:pointer;font-size:14.5px}
  @media(max-width:640px){
    main{padding:16px 13px} header{padding:12px 14px}
    .body td,.body th{white-space:normal}
  }
</style>
</head>
<body>

<div class="gate" id="gate">
  <div class="gatebox">
    <div class="brand" style="justify-content:center">
      <span class="dot"></span><span>Wall Street Analyst</span>
    </div>
    <input type="password" id="pw" placeholder="Access password" autocomplete="current-password">
    <button id="unlockBtn">Enter</button>
    <div id="gateErr" style="color:var(--danger);font-size:12.5px;margin-top:10px"></div>
  </div>
</div>

<header>
  <div class="brand">
    <span class="dot"></span>
    <div>Wall Street Analyst<small id="tagline">Institutional-grade equity research</small></div>
  </div>
  <div class="spacer"></div>
  <div class="langsw" id="langsw"></div>
  <div class="status" id="status">READY</div>
</header>

<div class="chips" id="chips"></div>

<main>
  <div class="wrap" id="feed">
    <div class="welcome" id="welcome">
      <h1 id="wTitle"></h1>
      <p id="wBody"></p>
      <div class="examples" id="examples"></div>
    </div>
  </div>
</main>

<footer>
  <div class="composer">
    <textarea id="input" rows="1"></textarea>
    <button class="send" id="send">Analyse</button>
  </div>
  <div class="disclaim" id="disclaim"></div>
</footer>

<script>
"use strict";

/* ===================== i18n ===================== */
const I18N = {
  en: {
    tagline:"Institutional-grade equity research",
    wTitle:"Institutional-grade financial analysis",
    wBody:"Pick a framework above, then name a company or ticker. Every analysis shows its math, states its assumptions, and gives a bull / base / bear range.",
    placeholder:"Ask about any stock, deal, or financial model...",
    send:"Analyse", ready:"READY", analysing:"ANALYSING...",
    disclaim:"Educational analysis only \u2014 not investment advice. Figures may be outdated; verify against SEC filings before acting. Consult a licensed advisor.",
    chips:{auto:"Auto",screen:"Quick Screen",dcf:"DCF",comps:"Comps","3stmt":"3-Statement",
           lbo:"LBO",ma:"M&A",sotp:"SOTP",credit:"Credit",unit:"Unit Economics",
           risk:"Sensitivity",memo:"IC Memo"},
    examples:[
      ["Full analysis","Analyse NVDA \u2014 is it worth buying?","Analyse NVDA. Is it worth buying at the current price?"],
      ["DCF model","Build a DCF for Apple","Build a DCF valuation for Apple with a sensitivity table and a football field chart."],
      ["Comps","Compare AMD to its peers","Compare AMD against its semiconductor peers on NTM multiples, with a bar chart."],
      ["Scenarios","Bull / base / bear for Tesla","Give bull, base and bear cases for Tesla with a scenario chart."]
    ]
  },
  zh: {
    tagline:"\u6a5f\u69cb\u7d1a\u80a1\u7968\u7814\u7a76",
    wTitle:"\u6a5f\u69cb\u7d1a\u91d1\u878d\u5206\u6790",
    wBody:"\u65bc\u4e0a\u65b9\u63c0\u4e00\u500b\u5206\u6790\u6846\u67b6\uff0c\u7136\u5f8c\u8f38\u5165\u516c\u53f8\u540d\u6216\u80a1\u7968\u4ee3\u865f\u3002\u6bcf\u4efd\u5206\u6790\u90fd\u6703\u5217\u51fa\u8a08\u7b97\u904e\u7a0b\u3001\u8aaa\u660e\u5047\u8a2d\uff0c\u4e26\u7d66\u51fa\u6a02\u89c0 / \u57fa\u672c / \u60b2\u89c0\u4e09\u500b\u60c5\u5883\u3002",
    placeholder:"\u554f\u4efb\u4f55\u80a1\u7968\u3001\u4ea4\u6613\u6216\u8ca1\u52d9\u6a21\u578b...",
    send:"\u5206\u6790", ready:"\u5c31\u7dd2", analysing:"\u5206\u6790\u4e2d...",
    disclaim:"\u50c5\u4f5c\u6559\u80b2\u7528\u9014 \u2014 \u4e26\u975e\u6295\u8cc7\u5efa\u8b70\u3002\u6578\u64da\u53ef\u80fd\u904e\u6642\uff0c\u884c\u52d5\u524d\u8acb\u6838\u5c0d\u5b98\u65b9\u7533\u5831\u6587\u4ef6\uff0c\u4e26\u8aee\u8a62\u6301\u724c\u9867\u554f\u3002",
    chips:{auto:"\u81ea\u52d5",screen:"\u5feb\u901f\u7be9\u9078",dcf:"DCF \u4f30\u503c",comps:"\u540c\u696d\u6bd4\u8f03",
           "3stmt":"\u4e09\u5927\u5831\u8868",lbo:"\u69d3\u687f\u6536\u8cfc",ma:"\u4e26\u8cfc",sotp:"\u5206\u90e8\u4f30\u503c",
           credit:"\u4fe1\u8cb8\u5206\u6790",unit:"\u55ae\u4f4d\u7d93\u6fdf",risk:"\u654f\u611f\u5ea6",memo:"\u6295\u59d4\u6703\u5099\u5fd8\u9304"},
    examples:[
      ["\u5b8c\u6574\u5206\u6790","\u5206\u6790 NVDA \u2014 \u503c\u4e0d\u503c\u5f97\u8cb7\uff1f","\u5206\u6790 NVDA\uff0c\u73fe\u50f9\u503c\u4e0d\u503c\u5f97\u6295\u8cc7\uff1f"],
      ["DCF \u6a21\u578b","\u70ba\u860b\u679c\u5efa\u7acb DCF","\u70ba\u860b\u679c\u5efa\u7acb DCF \u4f30\u503c\uff0c\u9644\u654f\u611f\u5ea6\u8868\u53ca football field \u5716\u8868\u3002"],
      ["\u540c\u696d\u6bd4\u8f03","AMD \u8207\u540c\u696d\u6bd4\u8f03","\u5c07 AMD \u8207\u534a\u5c0e\u9ad4\u540c\u696d\u4ee5 NTM \u500d\u6578\u6bd4\u8f03\uff0c\u9644\u9577\u689d\u5716\u3002"],
      ["\u60c5\u5883\u5206\u6790","Tesla \u6a02\u89c0/\u57fa\u672c/\u60b2\u89c0","\u7d66\u51fa Tesla \u7684\u6a02\u89c0\u3001\u57fa\u672c\u3001\u60b2\u89c0\u60c5\u5883\uff0c\u9644\u60c5\u5883\u5716\u8868\u3002"]
    ]
  }
};
I18N.both = JSON.parse(JSON.stringify(I18N.zh));
I18N.both.tagline = "Institutional-grade equity research / " + I18N.zh.tagline;

const LANG_INSTRUCTION = {
  en:"Reply in English.",
  zh:"Reply in Traditional Chinese, Hong Kong style. Keep standard finance terms (EBITDA, WACC, DCF, EV/EBITDA) in English.",
  both:"Reply BILINGUALLY. For every heading, paragraph and bullet, give the English first, then the Traditional Chinese (Hong Kong style) immediately beneath it. In tables, write headers as 'English / \u4e2d\u6587' in the same cell rather than duplicating the table. Keep standard finance terms in English."
};

/* ===================== config ===================== */
const CHIP_ORDER = ["auto","screen","dcf","comps","3stmt","lbo","ma","sotp","credit","unit","risk","memo"];
let lang = "en", framework = "auto", history = [], busy = false, password = "";
const $ = id => document.getElementById(id);

/* ===================== markdown renderer =====================
   Builds real DOM nodes. All model text enters via textContent and
   link hrefs are scheme-checked, so markup can only originate from
   the createElement calls below - there is no injection surface.
   ============================================================= */
function safeUrl(u){ return /^https?:\\/\\//i.test(u) ? u : "#"; }

const INLINE_RE = /(\`[^\`]+\`)|(\\*\\*[^*]+\\*\\*)|(\\*[^*\\n]+\\*)|(\\[[^\\]]+\\]\\([^)\\s]+\\))/g;
const LINK_RE = /^\\[([^\\]]+)\\]\\(([^)\\s]+)\\)$/;

function appendInline(parent, text){
  let last = 0;
  for(const m of String(text).matchAll(INLINE_RE)){
    if(m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    const tok = m[0];
    let el;
    if(tok.charAt(0) === "\`"){
      el = document.createElement("code"); el.textContent = tok.slice(1,-1);
    } else if(tok.slice(0,2) === "**"){
      el = document.createElement("strong"); el.textContent = tok.slice(2,-2);
    } else if(tok.charAt(0) === "["){
      const p = tok.match(LINK_RE);
      el = document.createElement("a");
      el.textContent = p[1];
      el.setAttribute("href", safeUrl(p[2]));
      el.setAttribute("target","_blank");
      el.setAttribute("rel","noopener noreferrer");
    } else {
      el = document.createElement("em"); el.textContent = tok.slice(1,-1);
    }
    parent.appendChild(el);
    last = m.index + tok.length;
  }
  if(last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

function splitRow(r){ return r.trim().replace(/^\\||\\|$/g,"").split("|").map(c=>c.trim()); }

/* ---------- SVG charts ---------- */
const NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs){
  const e = document.createElementNS(NS, tag);
  for(const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}
function svgText(x, y, str, attrs){
  const t = svgEl("text", Object.assign({x:x, y:y}, attrs || {}));
  t.textContent = str;
  return t;
}
function fmt(n, unit){
  const s = (Math.abs(n) >= 1000) ? Math.round(n).toLocaleString() :
            (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(1));
  if(unit === "x") return s + "x";
  if(unit === "%") return s + "%";
  if(unit === "$") return "$" + s;
  return unit ? s + " " + unit : s;
}

/** Horizontal range bars with an optional marker - the banker's "football field". */
function chartFootball(spec){
  const rows = spec.series || [];
  if(!rows.length) return null;
  const W = 700, rowH = 38, padL = 130, padR = 60, top = 14;
  const H = top + rows.length * rowH + 30;
  let lo = Infinity, hi = -Infinity;
  rows.forEach(r => { lo = Math.min(lo, r.low); hi = Math.max(hi, r.high); });
  if(spec.marker && typeof spec.marker.value === "number"){
    lo = Math.min(lo, spec.marker.value); hi = Math.max(hi, spec.marker.value);
  }
  const span = (hi - lo) || 1;
  lo -= span * 0.12; hi += span * 0.12;
  const X = v => padL + ((v - lo) / (hi - lo)) * (W - padL - padR);

  const svg = svgEl("svg", {viewBox:"0 0 " + W + " " + H, role:"img"});
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    svg.appendChild(svgText(padL - 10, y + 19, r.label,
      {fill:"#8b98a5","font-size":"12","text-anchor":"end","font-family":"sans-serif"}));
    const x1 = X(r.low), x2 = X(r.high);
    svg.appendChild(svgEl("rect", {x:x1, y:y + 6, width:Math.max(2, x2 - x1), height:20,
      rx:4, fill:"#d4a24a", opacity:"0.75"}));
    svg.appendChild(svgText(x1 - 5, y + 20, fmt(r.low, spec.unit),
      {fill:"#8b98a5","font-size":"10.5","text-anchor":"end","font-family":"monospace"}));
    svg.appendChild(svgText(x2 + 5, y + 20, fmt(r.high, spec.unit),
      {fill:"#8b98a5","font-size":"10.5","font-family":"monospace"}));
  });
  if(spec.marker && typeof spec.marker.value === "number"){
    const mx = X(spec.marker.value);
    svg.appendChild(svgEl("line", {x1:mx, y1:top - 4, x2:mx, y2:top + rows.length * rowH + 2,
      stroke:"#f85149","stroke-width":"2","stroke-dasharray":"4 3"}));
    svg.appendChild(svgText(mx, top + rows.length * rowH + 18,
      (spec.marker.label || "Current") + " " + fmt(spec.marker.value, spec.unit),
      {fill:"#f85149","font-size":"11","text-anchor":"middle","font-family":"sans-serif"}));
  }
  return svg;
}

/** Vertical bars for peer multiples and similar comparisons. */
function chartBar(spec){
  const d = spec.data || [];
  if(!d.length) return null;
  const W = 700, H = 260, padL = 46, padB = 46, top = 16;
  const max = Math.max.apply(null, d.map(x => x.value)) * 1.15 || 1;
  const bw = (W - padL - 16) / d.length;
  const svg = svgEl("svg", {viewBox:"0 0 " + W + " " + H, role:"img"});
  for(let g = 0; g <= 4; g++){
    const y = top + (H - top - padB) * (g / 4);
    const val = max * (1 - g / 4);
    svg.appendChild(svgEl("line", {x1:padL, y1:y, x2:W - 8, y2:y,
      stroke:"#263341","stroke-width":"1"}));
    svg.appendChild(svgText(padL - 7, y + 4, fmt(val, spec.unit),
      {fill:"#8b98a5","font-size":"10","text-anchor":"end","font-family":"monospace"}));
  }
  d.forEach((it, i) => {
    const h = ((it.value / max) * (H - top - padB));
    const x = padL + i * bw + bw * 0.18;
    const w = bw * 0.64;
    const y = H - padB - h;
    svg.appendChild(svgEl("rect", {x:x, y:y, width:w, height:Math.max(1, h), rx:3,
      fill: it.highlight ? "#3fb950" : "#d4a24a", opacity: it.highlight ? "0.95" : "0.75"}));
    svg.appendChild(svgText(x + w / 2, y - 6, fmt(it.value, spec.unit),
      {fill:"#e6edf3","font-size":"11","text-anchor":"middle","font-family":"monospace"}));
    svg.appendChild(svgText(x + w / 2, H - padB + 16, it.label,
      {fill:"#8b98a5","font-size":"11","text-anchor":"middle","font-family":"sans-serif"}));
  });
  return svg;
}

/** Bear / base / bull columns against the current price. */
function chartScenario(spec){
  const order = [["bear","#f85149"],["base","#8b98a5"],["bull","#3fb950"]];
  const items = order.filter(o => typeof spec[o[0]] === "number")
                     .map(o => ({label:o[0], value:spec[o[0]], color:o[1]}));
  if(!items.length) return null;
  const W = 700, H = 250, padL = 46, padB = 46, top = 16;
  let max = Math.max.apply(null, items.map(i => i.value));
  if(typeof spec.current === "number") max = Math.max(max, spec.current);
  max *= 1.18;
  const bw = (W - padL - 16) / items.length;
  const svg = svgEl("svg", {viewBox:"0 0 " + W + " " + H, role:"img"});
  const Y = v => H - padB - (v / max) * (H - top - padB);
  items.forEach((it, i) => {
    const x = padL + i * bw + bw * 0.24, w = bw * 0.52, y = Y(it.value);
    svg.appendChild(svgEl("rect", {x:x, y:y, width:w, height:Math.max(1, H - padB - y),
      rx:3, fill:it.color, opacity:"0.8"}));
    svg.appendChild(svgText(x + w / 2, y - 6, fmt(it.value, spec.unit),
      {fill:"#e6edf3","font-size":"12","text-anchor":"middle","font-family":"monospace"}));
    svg.appendChild(svgText(x + w / 2, H - padB + 17,
      (spec.labels && spec.labels[it.label]) || it.label.toUpperCase(),
      {fill:"#8b98a5","font-size":"11","text-anchor":"middle","font-family":"sans-serif"}));
  });
  if(typeof spec.current === "number"){
    const y = Y(spec.current);
    svg.appendChild(svgEl("line", {x1:padL, y1:y, x2:W - 8, y2:y,
      stroke:"#1f6feb","stroke-width":"2","stroke-dasharray":"5 3"}));
    svg.appendChild(svgText(W - 10, y - 6,
      (spec.currentLabel || "Current") + " " + fmt(spec.current, spec.unit),
      {fill:"#1f6feb","font-size":"11","text-anchor":"end","font-family":"sans-serif"}));
  }
  return svg;
}

function renderChart(spec){
  let svg = null;
  try{
    if(spec.type === "football") svg = chartFootball(spec);
    else if(spec.type === "bar") svg = chartBar(spec);
    else if(spec.type === "scenario") svg = chartScenario(spec);
  }catch(e){ svg = null; }
  if(!svg) return null;
  const box = document.createElement("div");
  box.className = "chartbox";
  if(spec.title){
    const t = document.createElement("div");
    t.className = "ctitle"; t.textContent = spec.title;
    box.appendChild(t);
  }
  box.appendChild(svg);
  if(spec.note){
    const n = document.createElement("div");
    n.className = "cnote"; n.textContent = spec.note;
    box.appendChild(n);
  }
  return box;
}

function renderMarkdown(src){
  const frag = document.createDocumentFragment();
  const lines = String(src).replace(/\\r/g,"").split("\\n");
  const isRow = s => /^\\s*\\|.*\\|\\s*$/.test(s);
  let i = 0;

  while(i < lines.length){
    const L = lines[i];
    if(!L.trim()){ i++; continue; }

    // fenced block: \`\`\`chart renders a graphic, anything else is code
    const fence = L.match(/^\\s*\`\`\`\\s*(\\w*)\\s*$/);
    if(fence){
      const kind = (fence[1] || "").toLowerCase();
      const buf = [];
      i++;
      while(i < lines.length && !/^\\s*\`\`\`\\s*$/.test(lines[i])){ buf.push(lines[i]); i++; }
      i++; // closing fence
      const raw = buf.join("\\n");
      if(kind === "chart"){
        let spec = null;
        try{ spec = JSON.parse(raw); }catch(e){ spec = null; }
        const c = spec ? renderChart(spec) : null;
        if(c){ frag.appendChild(c); continue; }
      }
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = raw;
      pre.appendChild(code);
      frag.appendChild(pre);
      continue;
    }

    if(isRow(L) && isRow(lines[i+1] || "") && /^[\\s|:\\-]+$/.test(lines[i+1])){
      const wrap = document.createElement("div");
      wrap.className = "tablewrap";
      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const hrow = document.createElement("tr");
      splitRow(L).forEach(c => { const th = document.createElement("th"); appendInline(th,c); hrow.appendChild(th); });
      thead.appendChild(hrow); table.appendChild(thead);
      const tbody = document.createElement("tbody");
      i += 2;
      while(i < lines.length && isRow(lines[i])){
        const tr = document.createElement("tr");
        splitRow(lines[i]).forEach(c => { const td = document.createElement("td"); appendInline(td,c); tr.appendChild(td); });
        tbody.appendChild(tr); i++;
      }
      table.appendChild(tbody); wrap.appendChild(table); frag.appendChild(wrap);
      continue;
    }

    const head = L.match(/^(#{1,3})\\s+(.*)/);
    if(head){
      const h = document.createElement("h" + head[1].length);
      appendInline(h, head[2]); frag.appendChild(h); i++; continue;
    }
    if(/^\\s*([-*_])\\s*\\1\\s*\\1[\\s\\-*_]*$/.test(L)){
      frag.appendChild(document.createElement("hr")); i++; continue;
    }
    if(/^\\s*>/.test(L)){
      const buf = [];
      while(i < lines.length && /^\\s*>/.test(lines[i])){ buf.push(lines[i].replace(/^\\s*>\\s?/,"")); i++; }
      const bq = document.createElement("blockquote");
      bq.appendChild(renderMarkdown(buf.join("\\n")));
      frag.appendChild(bq); continue;
    }
    if(/^\\s*([-*+]|\\d+\\.)\\s+/.test(L)){
      const ordered = /^\\s*\\d+\\./.test(L);
      const list = document.createElement(ordered ? "ol" : "ul");
      while(i < lines.length && /^\\s*([-*+]|\\d+\\.)\\s+/.test(lines[i])){
        const li = document.createElement("li");
        appendInline(li, lines[i].replace(/^\\s*([-*+]|\\d+\\.)\\s+/,""));
        list.appendChild(li); i++;
      }
      frag.appendChild(list); continue;
    }
    const buf = [];
    while(i < lines.length && lines[i].trim() && !isRow(lines[i]) &&
          !/^\\s*(\`\`\`|#{1,3}\\s|>|[-*+]\\s|\\d+\\.\\s)/.test(lines[i])){ buf.push(lines[i]); i++; }
    if(buf.length){
      const p = document.createElement("p");
      appendInline(p, buf.join(" ")); frag.appendChild(p);
    }
  }
  return frag;
}

/* ===================== UI ===================== */
function buildLangSwitch(){
  const sw = $("langsw");
  while(sw.firstChild) sw.removeChild(sw.firstChild);
  [["en","EN"],["zh","\u4e2d"],["both","\u4e2d/EN"]].forEach(([code,label]) => {
    const b = document.createElement("button");
    b.textContent = label;
    if(code === lang) b.className = "on";
    b.onclick = () => { lang = code; try{ localStorage.setItem("wsa_lang", code); }catch(e){} applyLang(); };
    sw.appendChild(b);
  });
}

function buildChips(){
  const box = $("chips");
  while(box.firstChild) box.removeChild(box.firstChild);
  const t = I18N[lang];
  CHIP_ORDER.forEach(id => {
    const c = document.createElement("div");
    c.className = "chip" + (id === framework ? " on" : "");
    c.textContent = t.chips[id];
    c.onclick = () => {
      framework = id;
      document.querySelectorAll(".chip").forEach(x => x.classList.remove("on"));
      c.classList.add("on");
    };
    box.appendChild(c);
  });
}

function buildExamples(){
  const box = $("examples");
  if(!box) return;
  while(box.firstChild) box.removeChild(box.firstChild);
  I18N[lang].examples.forEach(([tag,label,prompt]) => {
    const d = document.createElement("div");
    d.className = "ex";
    const b = document.createElement("b");
    b.textContent = tag;
    d.appendChild(b);
    d.appendChild(document.createTextNode(label));
    d.onclick = () => { $("input").value = prompt; $("input").focus(); };
    box.appendChild(d);
  });
}

function applyLang(){
  const t = I18N[lang];
  $("tagline").textContent = t.tagline;
  $("input").placeholder = t.placeholder;
  $("send").textContent = t.send;
  $("status").textContent = busy ? t.analysing : t.ready;
  $("disclaim").textContent = t.disclaim;
  if($("wTitle")) $("wTitle").textContent = t.wTitle;
  if($("wBody")) $("wBody").textContent = t.wBody;
  document.documentElement.lang = (lang === "en") ? "en" : "zh-HK";
  buildLangSwitch(); buildChips(); buildExamples();
}

function bubble(role, node){
  const w = $("welcome"); if(w) w.remove();
  const d = document.createElement("div");
  d.className = "msg " + role;
  const av = document.createElement("div");
  av.className = "avatar";
  av.textContent = role === "user" ? "YOU" : "WS";
  const body = document.createElement("div");
  body.className = "body";
  if(node) body.appendChild(node);
  d.appendChild(av); d.appendChild(body);
  $("feed").appendChild(d);
  d.scrollIntoView({behavior:"smooth", block:"end"});
  return body;
}
function textNode(t){
  const p = document.createElement("p");
  p.textContent = t; p.style.whiteSpace = "pre-wrap"; return p;
}
function typingNode(){
  const t = document.createElement("div"); t.className = "typing";
  t.appendChild(document.createElement("i"));
  t.appendChild(document.createElement("i"));
  t.appendChild(document.createElement("i"));
  return t;
}
function errorNode(m){
  const e = document.createElement("div"); e.className = "err"; e.textContent = m; return e;
}
function clearNode(n){ while(n.firstChild) n.removeChild(n.firstChild); }

async function send(){
  const box = $("input"), text = box.value.trim();
  if(!text || busy) return;
  busy = true; $("send").disabled = true; $("status").textContent = I18N[lang].analysing;
  bubble("user", textNode(text));
  box.value = ""; box.style.height = "auto";
  history.push({role:"user", content:text});

  const pending = bubble("bot", typingNode());
  try{
    const r = await fetch("/api/chat", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({messages:history, framework:framework, lang:lang, password:password})
    });
    const data = await r.json();
    clearNode(pending);
    if(!r.ok || data.error){
      pending.appendChild(errorNode(data.error || "Request failed."));
    } else {
      pending.appendChild(renderMarkdown(data.reply));
      history.push({role:"assistant", content:data.reply});
    }
  }catch(e){
    clearNode(pending);
    pending.appendChild(errorNode("Network error: " + e.message));
  }
  busy = false; $("send").disabled = false; $("status").textContent = I18N[lang].ready;
  pending.scrollIntoView({behavior:"smooth", block:"end"});
}

$("send").onclick = send;
$("input").addEventListener("keydown", e => {
  if(e.key === "Enter" && !e.shiftKey){ e.preventDefault(); send(); }
});
$("input").addEventListener("input", function(){
  this.style.height = "auto";
  this.style.height = Math.min(this.scrollHeight, 180) + "px";
});

function unlock(){
  password = $("pw").value;
  if(!password){ $("gateErr").textContent = "Enter the password."; return; }
  $("gate").classList.remove("show");
  $("input").focus();
}
$("unlockBtn").onclick = unlock;
$("pw").addEventListener("keydown", e => { if(e.key === "Enter") unlock(); });

try{ lang = localStorage.getItem("wsa_lang") || "en"; }catch(e){ lang = "en"; }
if(!I18N[lang]) lang = "en";
applyLang();

fetch("/api/config").then(r => r.json()).then(c => {
  if(c.requires_password){ $("gate").classList.add("show"); $("pw").focus(); }
  else $("input").focus();
}).catch(() => {});
</script>
</body>
</html>
`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/config") {
      return json({ requires_password: Boolean(env.ACCESS_PASSWORD) });
    }
    if (url.pathname === "/api/chat") {
      if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
      return handleChat(request, env);
    }
    return new Response(PAGE, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
