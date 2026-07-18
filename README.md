# Wall Street Analyst

An institutional-grade financial analysis assistant. Ask it about any stock, deal or
financial model and it replies with the frameworks used by investment banks: DCF,
comparable companies, LBO, M&A accretion/dilution, sum-of-the-parts, credit capacity,
unit economics, sensitivity analysis and investment committee memos.

Every answer shows its math, labels its assumptions, and gives a bull / base / bear
range rather than a single number.

## Contents

| File | What it is |
|---|---|
| `worker.js` | Cloudflare Workers backend (recommended - free, never sleeps) |
| `app.py` | Flask backend, same API (for Render or local development) |
| `static/index.html` | The web interface, shared by both backends |
| `finance_bot.py` | Optional Telegram bot version |
| `wrangler.toml` | Cloudflare deployment config |
| `render.yaml` | Render deployment config |

## Security model

The Anthropic API key is **only ever stored server-side** - as a Cloudflare Secret, a
Render environment variable, or a local `.env` file that is git-ignored. The browser
never receives it. Never put the key in `static/index.html` or any other file that is
sent to the browser: anyone could read it from "View Source" and spend your credits.

Set `ACCESS_PASSWORD` as well. Without it, anyone who discovers the URL can use the
site and the usage is billed to your Anthropic account.

## Deploy to Cloudflare Workers (free, recommended)

Free tier covers 100,000 requests/day and the Worker never sleeps.

1. Sign up at [dash.cloudflare.com](https://dash.cloudflare.com).
2. **Workers & Pages** → **Create** → **Workers** → **Import a repository**.
3. Authorise GitHub and pick this repository. Leave the build command empty;
   `wrangler.toml` already describes the deployment. Click **Deploy**.
4. Open the new Worker → **Settings** → **Variables and Secrets** → **Add**, type
   **Secret**:

   | Name | Value | Required |
   |---|---|---|
   | `ANTHROPIC_API_KEY` | Your key from [console.anthropic.com](https://console.anthropic.com) | Yes |
   | `ACCESS_PASSWORD` | Any password you choose | Strongly recommended |

5. Click **Deploy** again so the secrets take effect.

Your site is then live at `wall-street-analyst.<your-account>.workers.dev`.

## Deploy to Render (alternative)

Render's free web tier works too, but the service sleeps after 15 minutes idle and
takes 30-60 seconds to wake. **New +** → **Blueprint** → select this repo; Render
reads `render.yaml`. Add the same environment variables in the dashboard.

Note: the Telegram worker in `render.yaml` requires a paid Background Worker plan
(~$7/month), because long-polling needs an always-running process. Delete that block
if you only want the website.

## Run locally

```bash
pip3 install -r requirements.txt

cat > .env << 'EOF'
ANTHROPIC_API_KEY=your-key-here
ACCESS_PASSWORD=optional-password
EOF

python3 app.py
```

Then open the printed URL. On macOS, port 5000 is often occupied by the AirPlay
receiver in Control Centre; set `PORT=5050` before running if that happens.

## Cost

Two separate meters:

- **Hosting** - Cloudflare Workers free tier is $0 for this workload.
- **Anthropic API** - billed per question from your credit balance at
  [console.anthropic.com](https://console.anthropic.com) under Plans & Billing.
  A Claude Code or Claude.ai subscription does **not** include API credits.

## Disclaimer

Educational analysis only. Not investment advice. Model output can be outdated or
wrong - verify every figure against primary sources (SEC filings, investor relations)
and consult a licensed financial advisor before making any investment decision.
