#!/usr/bin/env python3
"""
Stealth browser automation using Patchright + Chrome CDP.

Connects to a REAL running Chrome browser via CDP (Chrome DevTools Protocol)
instead of launching a new Chromium instance. This avoids anti-detection
triggers like navigator.webdriver, headless fingerprints, and missing
browser history/extensions.

CRITICAL CDP MODE RULES (violations cause silent failures):
  - DO NOT call new_context()     → breaks DNS/TLS, causes ERR_CONNECTION_CLOSED
  - DO NOT call add_init_script() → conflicts with Chrome's initialization flow
  - DO NOT override User-Agent    → creates HTTP/JS inconsistency
  - DO inject cookies via add_cookies() on the existing context
"""

import argparse
import http.client
import json
import os
import random
import subprocess
import sys
import time

# Bypass macOS proxy tools (ClashX, Surge) that hijack urllib
os.environ["no_proxy"] = "localhost,127.0.0.1"

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CDP_PORT = 9222
SCREENSHOT_DIR = os.path.expanduser("~/.crewly/screenshots")


# ── CDP connection helpers ──────────────────────────────────────

def get_ws_url(port: int = CDP_PORT) -> str:
    """
    Manually fetch the WebSocket URL from Chrome's CDP endpoint.

    Uses http.client.HTTPConnection (NOT urllib) to avoid macOS proxy
    tool interference. Note: NO trailing slash on /json/version
    (Patchright 1.58 + Chrome 144 trailing slash bug).
    """
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        conn.request("GET", "/json/version")
        resp = conn.getresponse()
        if resp.status != 200:
            raise ConnectionError(f"CDP returned HTTP {resp.status}")
        data = json.loads(resp.read().decode())
        return data["webSocketDebuggerUrl"]
    finally:
        conn.close()


def ensure_chrome_running() -> str:
    """Launch Chrome via the launcher script if CDP is not responding."""
    try:
        return get_ws_url()
    except Exception:
        pass

    launcher = os.path.join(SCRIPT_DIR, "launch-chrome-cdp.sh")
    result = subprocess.run(
        ["bash", launcher, str(CDP_PORT)],
        capture_output=True, text=True, timeout=30
    )
    if result.returncode != 0:
        raise RuntimeError(f"Failed to launch Chrome: {result.stderr}")

    ws_url = result.stdout.strip().split("\n")[-1]
    if ws_url.startswith("ws://"):
        return ws_url

    return get_ws_url()


# ── Human-like behavior helpers ─────────────────────────────────

def human_delay(min_s: float = 0.5, max_s: float = 2.0):
    """Random delay to simulate human hesitation."""
    time.sleep(random.uniform(min_s, max_s))


def human_scroll(page, direction: str = "down", amount: int = 0):
    """Scroll with natural, variable distances."""
    if amount == 0:
        amount = random.randint(200, 600)
    delta = amount if direction == "down" else -amount
    page.mouse.wheel(0, delta)
    human_delay(0.3, 1.0)


def human_type(page, selector: str, text: str):
    """Type text with variable inter-key delays."""
    page.click(selector)
    human_delay(0.2, 0.5)
    for char in text:
        page.keyboard.type(char)
        time.sleep(random.uniform(0.05, 0.15))


# ── Risk control detection ──────────────────────────────────────

def detect_risk_control(page) -> dict:
    """Check if the page is showing CAPTCHA or rate-limit signals."""
    signals = []

    url = page.url.lower()
    if "captcha" in url or "verify" in url or "challenge" in url:
        signals.append("captcha_url")

    try:
        content = page.content()
        risk_keywords = [
            "验证码", "滑块验证", "人机验证", "操作频繁",
            "captcha", "verify you are human", "rate limit",
            "too many requests", "access denied", "you have been blocked",
            "your account has been locked", "suspicious activity",
        ]
        content_lower = content.lower()
        for kw in risk_keywords:
            if kw.lower() in content_lower:
                signals.append(f"keyword:{kw}")
    except Exception:
        pass

    return {
        "detected": len(signals) > 0,
        "signals": signals,
    }


# ── Core actions ────────────────────────────────────────────────

def action_read(page, url: str, selectors: list, wait_for: str = None, wait_timeout: int = 15000) -> dict:
    """Navigate to URL, extract text content from selectors."""
    page.goto(url, wait_until="domcontentloaded", timeout=60000)

    # For SPA sites (X.com, React apps), wait for JS to finish rendering
    try:
        page.wait_for_load_state("networkidle", timeout=15000)
    except Exception:
        pass  # Best effort — some SPAs never fully idle

    # Wait for a specific selector if requested
    if wait_for:
        try:
            page.wait_for_selector(wait_for, timeout=wait_timeout)
        except Exception:
            pass  # Continue even if wait_for times out — best effort

    human_delay(1.0, 3.0)

    risk = detect_risk_control(page)
    if risk["detected"]:
        return {
            "success": False,
            "error": "risk_control_detected",
            "signals": risk["signals"],
            "advice": "Stop immediately. Risk control triggered.",
        }

    results = {}
    if not selectors:
        # Extract main content heuristically
        for sel in ["article", "main", "[role='main']", ".content", "#content", "body"]:
            try:
                el = page.query_selector(sel)
                if el:
                    text = el.inner_text()
                    if len(text) > 50:
                        results["content"] = text[:10000]
                        break
            except Exception:
                continue
        if not results:
            results["content"] = page.inner_text("body")[:10000]
    else:
        for sel in selectors:
            try:
                el = page.query_selector(sel)
                results[sel] = el.inner_text() if el else None
            except Exception as e:
                results[sel] = f"error: {e}"

    return {
        "success": True,
        "url": page.url,
        "title": page.title(),
        "results": results,
    }


def action_screenshot(page, url: str) -> dict:
    """Navigate and take a screenshot."""
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)

    page.goto(url, wait_until="domcontentloaded", timeout=60000)
    try:
        page.wait_for_load_state("networkidle", timeout=15000)
    except Exception:
        pass
    human_delay(1.5, 3.0)

    risk = detect_risk_control(page)
    if risk["detected"]:
        return {
            "success": False,
            "error": "risk_control_detected",
            "signals": risk["signals"],
        }

    timestamp = int(time.time())
    filename = f"stealth_{timestamp}.png"
    filepath = os.path.join(SCREENSHOT_DIR, filename)

    page.screenshot(path=filepath, full_page=False)

    return {
        "success": True,
        "url": page.url,
        "title": page.title(),
        "screenshot": filepath,
    }


def action_interact(page, url: str, selectors: list) -> dict:
    """Navigate and interact with elements (click, scroll)."""
    page.goto(url, wait_until="domcontentloaded", timeout=60000)
    human_delay(1.0, 2.5)

    risk = detect_risk_control(page)
    if risk["detected"]:
        return {
            "success": False,
            "error": "risk_control_detected",
            "signals": risk["signals"],
        }

    results = []
    for sel in selectors:
        try:
            el = page.query_selector(sel)
            if el:
                el.scroll_into_view_if_needed()
                human_delay(0.3, 0.8)
                el.click()
                human_delay(0.5, 1.5)
                results.append({"selector": sel, "action": "clicked", "success": True})
            else:
                results.append({"selector": sel, "action": "not_found", "success": False})
        except Exception as e:
            results.append({"selector": sel, "action": "error", "error": str(e), "success": False})

    return {
        "success": True,
        "url": page.url,
        "title": page.title(),
        "interactions": results,
    }


# ── Main ────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Stealth browse via Patchright + CDP")
    parser.add_argument("--url", required=True, help="Target URL")
    parser.add_argument("--action", default="read", choices=["read", "screenshot", "interact"],
                        help="Action to perform")
    parser.add_argument("--selectors", nargs="*", default=[], help="CSS selectors")
    parser.add_argument("--wait-for", default=None, help="CSS selector to wait for before extracting")
    parser.add_argument("--wait-timeout", type=int, default=15000, help="Timeout in ms for --wait-for")
    parser.add_argument("--cdp-port", type=int, default=CDP_PORT, help="CDP port")
    args = parser.parse_args()

    # Ensure patchright is installed
    try:
        from patchright.sync_api import sync_playwright
    except ImportError:
        print(json.dumps({
            "success": False,
            "error": "patchright_not_installed",
            "fix": "pip3 install patchright && python3 -m patchright install chromium",
        }))
        sys.exit(1)

    # Connect to Chrome via CDP on the specified port.
    # For custom ports, connect directly. For default port (9222), fall back to
    # ensure_chrome_running() which can auto-launch Chrome if needed.
    try:
        if args.cdp_port != CDP_PORT:
            ws_url = get_ws_url(args.cdp_port)
        else:
            ws_url = ensure_chrome_running()
    except Exception as e:
        print(json.dumps({"success": False, "error": f"chrome_launch_failed: {e}"}))
        sys.exit(1)

    # Connect via Patchright
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.connect_over_cdp(ws_url)
        except Exception as e:
            print(json.dumps({"success": False, "error": f"cdp_connect_failed: {e}"}))
            sys.exit(1)

        # CRITICAL: Use Chrome's existing default context, NOT new_context()
        contexts = browser.contexts
        if not contexts:
            print(json.dumps({"success": False, "error": "no_browser_context_found"}))
            sys.exit(1)

        context = contexts[0]
        page = context.new_page()

        try:
            if args.action == "read":
                result = action_read(page, args.url, args.selectors, args.wait_for, args.wait_timeout)
            elif args.action == "screenshot":
                result = action_screenshot(page, args.url)
            elif args.action == "interact":
                result = action_interact(page, args.url, args.selectors)
            else:
                result = {"success": False, "error": f"unknown_action: {args.action}"}
        except Exception as e:
            result = {"success": False, "error": str(e)}
        finally:
            page.close()

        print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
