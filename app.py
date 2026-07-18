#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Wall Street Analyst - web application backend.

The Anthropic API key lives ONLY here on the server. The browser never sees it.
Secrets come from real environment variables (Render), falling back to a local
.env file for development. This file is safe to commit.

Required:
    ANTHROPIC_API_KEY=<from console.anthropic.com>
Optional:
    ACCESS_PASSWORD=<gate the site so strangers cannot burn your credits>
"""

import os
import sys

from flask import Flask, request, jsonify, send_from_directory
from anthropic import Anthropic

HERE = os.path.dirname(os.path.abspath(__file__))


def load_env(path):
    """Tiny .env parser so local dev needs no extra dependency."""
    values = {}
    if not os.path.exists(path):
        return values
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            values[key.strip()] = val.strip().strip('"').strip("'")
    return values


_env_file = load_env(os.path.join(HERE, ".env"))


def get_secret(name, default=""):
    return os.environ.get(name) or _env_file.get(name, default)


API_KEY = get_secret("ANTHROPIC_API_KEY")
ACCESS_PASSWORD = get_secret("ACCESS_PASSWORD")  # empty = open access

if not API_KEY:
    print("ERROR: ANTHROPIC_API_KEY is not set.")
    print("Set it in Render's Environment tab, or in a local .env file.")
    sys.exit(1)

client = Anthropic(api_key=API_KEY)
app = Flask(__name__, static_folder="static", static_url_path="")

MODEL = "claude-opus-4-8"
MAX_TOKENS = 4000

BASE_SYSTEM = """You are a senior Wall Street analyst producing institutional-grade \
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
Otherwise reply in the user's language. Keep formatting clean and readable."""

FRAMEWORKS = {
    "auto": "",
    "dcf": """Produce a DCF valuation: 5-year FCF build (revenue -> EBITDA -> EBIT -> \
NOPAT -> FCF), WACC via CAPM with each input stated, terminal value using BOTH \
perpetuity growth and exit multiple, a two-way WACC x terminal-growth sensitivity \
table, and a bull/base/bear per-share range.""",
    "comps": """Produce a comparable company analysis: 8-15 peers with inclusion \
rationale, NTM EV/Revenue, EV/EBITDA, P/E and EV/FCF for each, 25th/median/75th \
percentiles, implied valuation applied to the target, and a premium/discount \
justification versus peers.""",
    "3stmt": """Produce a three-statement model: 5-year income statement, balance \
sheet and cash flow statement, the linking logic between them, a working-capital \
model (DSO/DIO/DPO), a debt schedule, key assumptions, and error checks (A = L + E).""",
    "lbo": """Produce an LBO model: sources and uses, debt structure by tranche with \
rates and amortisation, cash flow sweep, exit scenarios at years 3/4/5 across a \
multiple range, equity IRR and MOIC for each, and a debt paydown schedule.""",
    "ma": """Produce an M&A accretion/dilution analysis: deal structure and premium, \
pro forma income statement, standalone vs pro forma EPS, itemised synergies with \
phasing, funding sources with interest cost, pro forma credit metrics, breakeven \
synergies, and a sensitivity table.""",
    "sotp": """Produce a sum-of-the-parts valuation: break the company into segments, \
give each segment's financials, choose and justify a valuation method per segment, \
value each, handle unallocated corporate costs, bridge enterprise value to equity \
value, and give value per share versus the current price.""",
    "credit": """Produce a credit and debt capacity analysis: historical and \
projected EBITDA with adjustments, leverage and coverage ratios versus rating-agency \
thresholds, debt structure by tranche, covenant package, maximum debt capacity, a \
pricing grid by leverage level, and the refinancing maturity profile.""",
    "unit": """Produce an operating model and unit economics: bottom-up revenue build \
with the explicit driver model, CAC / LTV / LTV-to-CAC / payback, cohort retention, \
the five most sensitive drivers with +/-10% impact, burn rate and runway, and \
breakeven analysis.""",
    "risk": """Produce a sensitivity and scenario analysis: one-way sensitivity on \
each key variable at +/-20%, a two-way matrix on the two most impactful variables, \
explicit bull/base/bear assumption sets, breakeven analysis, downside protection and \
margin of safety, and the top 5 risks ranked by impact.""",
    "memo": """Produce an investment committee memo: three-paragraph executive \
summary, company analysis, industry and TAM, a 3-5 point investment thesis where each \
point is a testable hypothesis, valuation summary across methods (football field), \
returns analysis, top 5 risks with mitigants, and a clear invest/pass recommendation \
with a maximum acceptable price.""",
    "screen": """Produce a quick screen in under one page: one-line business \
description, current price and key multiples, three things to like, three concerns, \
the single most important question for deeper work, and which framework to apply \
next.""",
}


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/api/config")
def config():
    """Tells the frontend whether a password gate is active."""
    return jsonify({"requires_password": bool(ACCESS_PASSWORD)})


@app.route("/api/chat", methods=["POST"])
def chat():
    data = request.get_json(silent=True) or {}

    if ACCESS_PASSWORD and data.get("password") != ACCESS_PASSWORD:
        return jsonify({"error": "Incorrect access password."}), 401

    messages = data.get("messages") or []
    if not messages:
        return jsonify({"error": "No message provided."}), 400

    # Keep the last 20 turns so long sessions stay within budget.
    messages = [
        {"role": m.get("role"), "content": m.get("content", "")}
        for m in messages[-20:]
        if m.get("role") in ("user", "assistant") and m.get("content")
    ]
    if not messages:
        return jsonify({"error": "No valid message content."}), 400

    system = BASE_SYSTEM
    extra = FRAMEWORKS.get(data.get("framework", "auto"), "")
    if extra:
        system += "\n\nThe user selected a specific framework. " + extra

    try:
        resp = client.messages.create(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            system=system,
            messages=messages,
        )
        return jsonify({"reply": resp.content[0].text})
    except Exception as exc:
        detail = str(exc)
        if "credit balance" in detail.lower():
            friendly = ("Your Anthropic account is out of credits. "
                        "Top up at console.anthropic.com under Plans & Billing.")
        elif "authentication" in detail.lower():
            friendly = "The API key is invalid. Check ANTHROPIC_API_KEY."
        elif "rate_limit" in detail.lower():
            friendly = "Rate limited by the API. Wait a moment and try again."
        else:
            friendly = "API error: " + detail[:300]
        return jsonify({"error": friendly}), 502


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
