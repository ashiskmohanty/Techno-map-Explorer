"""
Optional LLM bridge for the Object Finder assistant.

Used to understand *generic* / free-form questions and route them to an action
(clear the chat, help, or search) plus concise search keywords. It is entirely
optional: when no API key is configured the assistant falls back to its local
intent rules and keyword ranking, so nothing breaks offline.

Configuration (environment variables)
-------------------------------------
Azure OpenAI:
    AZURE_OPENAI_ENDPOINT     e.g. https://my-res.openai.azure.com
    AZURE_OPENAI_API_KEY
    AZURE_OPENAI_DEPLOYMENT   the chat deployment name
    AZURE_OPENAI_API_VERSION  default 2024-06-01

OpenAI (or compatible):
    OPENAI_API_KEY
    OPENAI_MODEL              default gpt-4o-mini
    OPENAI_BASE_URL           default https://api.openai.com/v1

The model only classifies intent and extracts keywords - the actual object
matching is always done locally against the real repository, so it cannot
invent object names.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Dict, Optional

_TIMEOUT = 20

SYSTEM_PROMPT = (
    "You are the intent router for an SAP 'Object Finder' assistant that helps "
    "users locate custom ABAP function modules and BW-IP objects (BEx queries, "
    "planning sequences, planning functions, filters).\n"
    "Classify the user's message into exactly one action:\n"
    "  - \"clear\": the user wants to clear/reset/wipe the chat or the previous response.\n"
    "  - \"help\": the user asks what you can do or how to use you.\n"
    "  - \"smalltalk\": greetings or thanks with no object request.\n"
    "  - \"search\": the user is looking for an ABAP/BW object.\n"
    "For \"search\", put concise search keywords (key nouns/verbs, expand obvious "
    "SAP synonyms, drop filler words) into \"query\".\n"
    "For \"help\"/\"smalltalk\" put a short friendly reply into \"message\".\n"
    "Respond with ONLY minified JSON: "
    "{\"action\":\"clear|help|smalltalk|search\",\"query\":\"\",\"message\":\"\"}."
)


def _provider() -> Optional[Dict[str, str]]:
    if (os.environ.get("AZURE_OPENAI_API_KEY")
            and os.environ.get("AZURE_OPENAI_ENDPOINT")
            and os.environ.get("AZURE_OPENAI_DEPLOYMENT")):
        endpoint = os.environ["AZURE_OPENAI_ENDPOINT"].rstrip("/")
        dep = os.environ["AZURE_OPENAI_DEPLOYMENT"]
        ver = os.environ.get("AZURE_OPENAI_API_VERSION", "2024-06-01")
        return {
            "kind": "azure",
            "url": f"{endpoint}/openai/deployments/{dep}/chat/completions?api-version={ver}",
            "key": os.environ["AZURE_OPENAI_API_KEY"],
            "model": dep,
            "auth_header": "api-key",
        }
    if os.environ.get("OPENAI_API_KEY"):
        base = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
        return {
            "kind": "openai",
            "url": f"{base}/chat/completions",
            "key": os.environ["OPENAI_API_KEY"],
            "model": os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
            "auth_header": "bearer",
        }
    return None


def available() -> bool:
    return _provider() is not None


def status() -> Dict[str, Any]:
    p = _provider()
    return {"available": bool(p), "provider": p["kind"] if p else None,
            "model": p["model"] if p else None}


def interpret(message: str) -> Optional[Dict[str, Any]]:
    """Return {action, query, message} for a user message, or None if no LLM /
    on any error (caller then uses local rules)."""
    p = _provider()
    if not p or not (message or "").strip():
        return None

    body = {
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": message.strip()[:1000]},
        ],
        "temperature": 0,
        "max_tokens": 200,
        "response_format": {"type": "json_object"},
    }
    if p["kind"] == "openai":
        body["model"] = p["model"]

    headers = {"Content-Type": "application/json"}
    if p["auth_header"] == "api-key":
        headers["api-key"] = p["key"]
    else:
        headers["Authorization"] = f"Bearer {p['key']}"

    req = urllib.request.Request(
        p["url"], data=json.dumps(body).encode("utf-8"),
        headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        content = data["choices"][0]["message"]["content"]
        parsed = json.loads(content)
        action = (parsed.get("action") or "search").lower()
        if action not in ("clear", "help", "smalltalk", "search"):
            action = "search"
        return {
            "action": action,
            "query": (parsed.get("query") or "").strip(),
            "message": (parsed.get("message") or "").strip(),
            "source": p["kind"],
        }
    except (urllib.error.URLError, KeyError, ValueError, TimeoutError, Exception):
        return None
