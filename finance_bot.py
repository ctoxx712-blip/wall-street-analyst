#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Finance Telegram Bot - clean edition.

Secrets are read from real environment variables first (e.g. Render's
"Environment" settings), then fall back to a local .env file for dev.
NEVER hardcode secrets here - this file is safe to commit to git.

Required variables (set in Render dashboard, or in a local .env):
    BOT_TOKEN=<from BotFather>
    CHAT_ID=<your telegram chat id>
    ANTHROPIC_API_KEY=<from console.anthropic.com>
"""

import os
import sys
import time
import requests

# Force UTF-8 so Chinese / emoji never crash the terminal
os.environ.setdefault("PYTHONUTF8", "1")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def load_env(path):
    """Tiny .env parser - no extra pip install needed."""
    values = {}
    if not os.path.exists(path):
        return values
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            # strip quotes and whitespace; guard against smart-quote paste
            values[key.strip()] = val.strip().strip('"').strip("'")
    return values


HERE = os.path.dirname(os.path.abspath(__file__))
env_file = load_env(os.path.join(HERE, ".env"))


def get_secret(name):
    """Prefer real env vars (Render), fall back to local .env file."""
    return os.environ.get(name) or env_file.get(name, "")


BOT_TOKEN = get_secret("BOT_TOKEN")
CHAT_ID = get_secret("CHAT_ID")
API_KEY = get_secret("ANTHROPIC_API_KEY")

missing = [k for k, v in {"BOT_TOKEN": BOT_TOKEN, "CHAT_ID": CHAT_ID,
                          "ANTHROPIC_API_KEY": API_KEY}.items() if not v]
if missing:
    print("ERROR: missing config -> " + ", ".join(missing))
    print("Set them as environment variables (Render) or in a local .env file.")
    sys.exit(1)

# Verify every secret is pure ASCII (catches smart-quote / hidden-char paste)
for name, val in (("BOT_TOKEN", BOT_TOKEN), ("ANTHROPIC_API_KEY", API_KEY)):
    try:
        val.encode("ascii")
    except UnicodeEncodeError:
        print("ERROR: " + name + " contains a non-ASCII character.")
        print("You likely copied a 'smart quote' or hidden space. Retype it in .env.")
        sys.exit(1)

CHAT_ID = int(CHAT_ID)
API_URL = "https://api.telegram.org/bot" + BOT_TOKEN

from anthropic import Anthropic
client = Anthropic(api_key=API_KEY)

SYSTEM = (
    "You are a professional Wall Street analyst. Give institutional-grade "
    "financial analysis: show assumptions, give bull/base/bear ranges for "
    "valuations, flag key risks, and end with a short 'not financial advice' "
    "disclaimer. Be concise and readable."
)


def send(text):
    for i in range(0, len(text), 4000):
        try:
            requests.post(API_URL + "/sendMessage",
                          json={"chat_id": CHAT_ID, "text": text[i:i + 4000]},
                          timeout=15)
        except Exception as e:
            print("send error: " + str(e))
        time.sleep(0.3)


def main():
    print("Bot running. Send a message in Telegram. Ctrl+C to stop.")
    send("Finance bot online. Ask me about any stock.")
    offset = 0
    while True:
        try:
            r = requests.get(API_URL + "/getUpdates",
                             params={"offset": offset, "timeout": 20}, timeout=25)
            data = r.json()
            if not data.get("ok"):
                # 409 = another copy is running
                if data.get("error_code") == 409:
                    print("Another bot copy is running. Stop it, then rerun.")
                time.sleep(2)
                continue
            for upd in data.get("result", []):
                offset = max(offset, upd["update_id"] + 1)
                msg = upd.get("message")
                if not msg or msg["chat"]["id"] != CHAT_ID:
                    continue
                text = msg.get("text", "").strip()
                if not text:
                    continue
                if text.lower() in ("/stop", "stop"):
                    send("Bot stopped.")
                    print("stopped by user")
                    return
                print("Q: " + text[:80])
                try:
                    resp = client.messages.create(
                        model="claude-opus-4-8", max_tokens=1500,
                        system=SYSTEM,
                        messages=[{"role": "user", "content": text}])
                    send(resp.content[0].text)
                    print("answered")
                except Exception as e:
                    send("Claude error: " + str(e)[:300])
                    print("claude error: " + str(e))
            time.sleep(1)
        except KeyboardInterrupt:
            print("\nstopped")
            return
        except Exception as e:
            print("loop error: " + str(e))
            time.sleep(3)


if __name__ == "__main__":
    main()
