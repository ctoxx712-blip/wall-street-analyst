/**
 * Wall Street Analyst - single-file Cloudflare Worker.
 *
 * EVERYTHING is in this one file: the website and the API backend.
 * Paste it into the Cloudflare Workers editor, add your ANTHROPIC_API_KEY
 * as a Secret, and deploy. No GitHub, no build step, no config files.
 *
 * Secrets (Cloudflare -> your Worker -> Settings -> Variables and Secrets):
 *   ANTHROPIC_API_KEY   required
 *   ACCESS_PASSWORD     optional but recommended; blank = anyone with the URL
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
    --danger:#f85149; --user:#1f6feb;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
    --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;
  }
  *{box-sizing:border-box}
  html,body{height:100%}
  body{margin:0;background:var(--bg);color:var(--text);font-family:var(--sans);
       display:flex;flex-direction:column;font-size:15px;line-height:1.6}

  header{background:var(--panel);border-bottom:1px solid var(--line);
         padding:14px 20px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
  .brand{display:flex;align-items:center;gap:10px;font-weight:650;letter-spacing:.2px}
  .brand .dot{width:9px;height:9px;border-radius:50%;background:var(--accent-2);
              box-shadow:0 0 8px var(--accent-2)}
  .brand small{display:block;font-weight:400;color:var(--muted);font-size:11.5px;
               letter-spacing:.4px;text-transform:uppercase}
  .spacer{flex:1}
  .status{font-family:var(--mono);font-size:12px;color:var(--muted)}

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

  .gate{position:fixed;inset:0;background:var(--bg);display:grid;place-items:center;
        z-index:50;padding:20px}
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

<div class="gate" id="gate" style="display:none">
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
    <div>Wall Street Analyst<small>Institutional-grade equity research</small></div>
  </div>
  <div class="spacer"></div>
  <div class="status" id="status">READY</div>
</header>

<div class="chips" id="chips"></div>

<main>
  <div class="wrap" id="feed">
    <div class="welcome" id="welcome">
      <h1>Institutional-grade financial analysis</h1>
      <p>Pick a framework above, then name a company or ticker.<br>
         Every analysis shows its math, states its assumptions, and gives a bull / base / bear range.</p>
      <div class="examples" id="examples"></div>
    </div>
  </div>
</main>

<footer>
  <div class="composer">
    <textarea id="input" rows="1" placeholder="Ask about any stock, deal, or financial model…"></textarea>
    <button class="send" id="send">Analyse</button>
  </div>
  <div class="disclaim">
    Educational analysis only — not investment advice. Figures may be outdated;
    verify against SEC filings before acting. Consult a licensed advisor.
  </div>
</footer>

<script>
"use strict";

const FRAMEWORKS = [
  ["auto","Auto"],["screen","Quick Screen"],["dcf","DCF"],["comps","Comps"],
  ["3stmt","3-Statement"],["lbo","LBO"],["ma","M&A"],["sotp","SOTP"],
  ["credit","Credit"],["unit","Unit Economics"],["risk","Sensitivity"],["memo","IC Memo"]
];
const EXAMPLES = [
  ["Full analysis","Analyse NVDA — is it worth buying?","Analyse NVDA. Is it worth buying at the current price?"],
  ["DCF model","Build a DCF for Apple","Build a DCF valuation for Apple with a sensitivity table."],
  ["Comps","Compare AMD to its peers","Compare AMD against its semiconductor peers on NTM multiples."],
  ["中文分析","分析騰訊 0700.HK","分析騰訊 (0700.HK) 嘅估值同主要風險。"]
];

let framework = "auto", history = [], busy = false, password = "";
const $ = id => document.getElementById(id);

/* ---------------------------------------------------------------
   SECURITY MODEL for rendering model output.
   Untrusted text (API replies, user input) is ALWAYS run through
   esc() first, which neutralises < > & " and '. Only after that do
   we add markup tags that this file itself generates. Because quotes
   are escaped, text can never break out of an HTML attribute, and
   link hrefs are additionally restricted to http/https.
   --------------------------------------------------------------- */
const ESC_MAP = {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"};
function esc(s){ return String(s).replace(/[&<>"']/g, c => ESC_MAP[c]); }

function safeUrl(u){
  // u is already escaped, so quotes are inert; still restrict the scheme.
  return /^https?:\\/\\//i.test(u) ? u : "#";
}

function inline(s){
  return esc(s)
    .replace(/\`([^\`]+)\`/g, "<code>$1</code>")
    .replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\\*([^*]+)\\*/g, "$1<em>$2</em>")
    .replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g,
      (m, label, url) => '<a href="' + safeUrl(url) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>');
}

function md(src){
  const lines = String(src).replace(/\\r/g,"").split("\\n");
  let out = "", i = 0;
  const isRow = s => /^\\s*\\|.*\\|\\s*$/.test(s);
  while(i < lines.length){
    const L = lines[i];
    if(!L.trim()){ i++; continue; }

    // table: header row + separator row + body rows
    if(isRow(L) && isRow(lines[i+1] || "") && /^[\\s|:\\-]+$/.test(lines[i+1])){
      const cells = r => r.trim().replace(/^\\||\\|$/g,"").split("|").map(c => inline(c.trim()));
      let html = "<div class='tablewrap'><table><thead><tr>" +
                 cells(L).map(c => "<th>" + c + "</th>").join("") + "</tr></thead><tbody>";
      i += 2;
      while(i < lines.length && isRow(lines[i])){
        html += "<tr>" + cells(lines[i]).map(c => "<td>" + c + "</td>").join("") + "</tr>";
        i++;
      }
      out += html + "</tbody></table></div>";
      continue;
    }
    let m;
    if((m = L.match(/^(#{1,3})\\s+(.*)/))){
      const n = m[1].length;
      out += "<h" + n + ">" + inline(m[2]) + "</h" + n + ">"; i++; continue;
    }
    if(/^\\s*([-*_])\\s*\\1\\s*\\1[\\s\\-*_]*$/.test(L)){ out += "<hr>"; i++; continue; }
    if(/^\\s*>/.test(L)){
      const buf = [];
      while(i < lines.length && /^\\s*>/.test(lines[i])){ buf.push(lines[i].replace(/^\\s*>\\s?/,"")); i++; }
      out += "<blockquote>" + md(buf.join("\\n")) + "</blockquote>"; continue;
    }
    if(/^\\s*([-*+]|\\d+\\.)\\s+/.test(L)){
      const ordered = /^\\s*\\d+\\./.test(L);
      const buf = [];
      while(i < lines.length && /^\\s*([-*+]|\\d+\\.)\\s+/.test(lines[i])){
        buf.push(inline(lines[i].replace(/^\\s*([-*+]|\\d+\\.)\\s+/,""))); i++;
      }
      out += (ordered ? "<ol>" : "<ul>") + buf.map(x => "<li>" + x + "</li>").join("") +
             (ordered ? "</ol>" : "</ul>");
      continue;
    }
    const buf = [];
    while(i < lines.length && lines[i].trim() && !isRow(lines[i]) &&
          !/^\\s*(#{1,3}\\s|>|[-*+]\\s|\\d+\\.\\s)/.test(lines[i])){ buf.push(lines[i]); i++; }
    if(buf.length) out += "<p>" + inline(buf.join(" ")) + "</p>";
  }
  return out;
}

/* ---- UI construction (no innerHTML with untrusted values) ---- */
FRAMEWORKS.forEach(([id, label], idx) => {
  const c = document.createElement("div");
  c.className = "chip" + (idx === 0 ? " on" : "");
  c.textContent = label;
  c.onclick = () => {
    framework = id;
    document.querySelectorAll(".chip").forEach(x => x.classList.remove("on"));
    c.classList.add("on");
  };
  $("chips").appendChild(c);
});

EXAMPLES.forEach(([tag, label, prompt]) => {
  const d = document.createElement("div");
  d.className = "ex";
  const b = document.createElement("b");
  b.textContent = tag;
  d.appendChild(b);
  d.appendChild(document.createTextNode(label));
  d.onclick = () => { $("input").value = prompt; $("input").focus(); };
  $("examples").appendChild(d);
});

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

function textNode(text){
  const p = document.createElement("p");
  p.textContent = text;          // plain text, no markup path at all
  p.style.whiteSpace = "pre-wrap";
  return p;
}
function typingNode(){
  const t = document.createElement("div");
  t.className = "typing";
  t.appendChild(document.createElement("i"));
  t.appendChild(document.createElement("i"));
  t.appendChild(document.createElement("i"));
  return t;
}
function errorNode(msg){
  const e = document.createElement("div");
  e.className = "err";
  e.textContent = msg;           // plain text
  return e;
}

async function send(){
  const box = $("input"), text = box.value.trim();
  if(!text || busy) return;
  busy = true; $("send").disabled = true; $("status").textContent = "ANALYSING…";

  bubble("user", textNode(text));
  box.value = ""; box.style.height = "auto";
  history.push({role:"user", content:text});

  const pending = bubble("bot", typingNode());
  try{
    const r = await fetch("/api/chat", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({messages:history, framework, password})
    });
    const data = await r.json();
    pending.textContent = "";
    if(!r.ok || data.error){
      pending.appendChild(errorNode(data.error || "Request failed."));
    } else {
      // data.reply passes through md() -> inline() -> esc(): fully escaped
      // before any tag this file generates is added.
      pending.innerHTML = md(data.reply);
      history.push({role:"assistant", content:data.reply});
    }
  }catch(e){
    pending.textContent = "";
    pending.appendChild(errorNode("Network error: " + e.message));
  }
  busy = false; $("send").disabled = false; $("status").textContent = "READY";
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
  $("gate").style.display = "none";
  $("input").focus();
}
$("unlockBtn").onclick = unlock;
$("pw").addEventListener("keydown", e => { if(e.key === "Enter") unlock(); });

fetch("/api/config").then(r => r.json()).then(c => {
  if(c.requires_password){ $("gate").style.display = "grid"; $("pw").focus(); }
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
      if (request.method !== "POST") {
        return json({ error: "Method not allowed." }, 405);
      }
      return handleChat(request, env);
    }

    // Every other path returns the single-page app.
    return new Response(PAGE, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
