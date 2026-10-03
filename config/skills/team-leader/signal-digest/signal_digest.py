#!/usr/bin/env python3
"""signal-digest: a site's daily signals, turned into ranked draft actions (#987).

Standard library only. Google access, the site config, Search Console windows and
analysis come from the seo-ops skill (seo_ops.py), so both skills share one config
file and one service account.

Subcommand
  collect   GA4 traffic + key events, Search Console opportunities, the site inbox
            (passed in by execute.sh), broken sitemap pages and an optional JS-error
            source; drops what the site's history or experiment log already covers;
            prints JSON with the signals and up to 10 rule-ranked draft actions.

The team lead reads the output, keeps or rewrites 3-5 actions and proposes them
(execute.sh propose). Every source reports what it examined; a source that fails
says why and the others still run. Exit codes: 0 ok, 1 nothing could be examined,
2 setup problem.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import importlib.util
import json
import os
import re
import subprocess
import sys
import urllib.parse

EXIT_OK, EXIT_EMPTY, EXIT_SETUP = 0, 1, 2

MAX_CANDIDATES = 10
SITEMAP_CHECK_DEFAULT = 60
SITEMAP_CHECK_WORKERS = 8
ERRORS_COMMAND_TIMEOUT_S = 60
DEFAULT_DAYS = 7
LIST_ROWS = 5

# Typical organic CTR by position (rounded industry curves), used only to size
# the expected effect of a title rewrite or of reaching the top 3.
BENCHMARK_CTR = {1: 0.28, 2: 0.16, 3: 0.11, 4: 0.08, 5: 0.06}
NEAR_MISS_TARGET_POSITION = 3
# A rising query is proposed as a new topic only beyond this position (or when new).
RISING_MAX_RANKED_POSITION = 10

DEFAULTS = {
    "days": DEFAULT_DAYS,
    "thresholds": {
        "ga4DropPct": 20,
        "ga4MinPrevSessions": 50,
        "ga4MinPrevKeyEvents": 5,
    },
    "errors": {"checkSitemap": True, "maxUrls": SITEMAP_CHECK_DEFAULT},
}


class DigestError(Exception):
    """A setup problem the operator can act on."""


# --------------------------------------------------------------------------- seo-ops

def seo_ops_candidates(script_dir=None, home=None):
    """Where seo_ops.py may live: env override, the bundled skill, the marketplace install."""
    script_dir = script_dir or os.path.dirname(os.path.abspath(__file__))
    home = home or os.path.expanduser("~")
    out = []
    if os.environ.get("SIGNAL_DIGEST_SEO_OPS"):
        out.append(os.environ["SIGNAL_DIGEST_SEO_OPS"])
    out.append(os.path.join(script_dir, "..", "..", "agent", "marketplace", "seo-ops", "seo_ops.py"))
    out.append(os.path.join(home, ".crewly", "marketplace", "skills", "seo-ops", "seo_ops.py"))
    return out


def load_seo_ops(paths=None):
    """Import seo_ops.py from the first path that exists."""
    for path in paths or seo_ops_candidates():
        if os.path.isfile(path):
            spec = importlib.util.spec_from_file_location("seo_ops", path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return module
    raise DigestError("seo-ops (seo_ops.py) not found. Install the seo-ops skill, or set "
                      "SIGNAL_DIGEST_SEO_OPS to its seo_ops.py.")


# --------------------------------------------------------------------------- helpers

def normalize_key(key):
    """Same identity rule as the backend: case and spacing do not matter."""
    return re.sub(r"\s+", " ", str(key)).strip().lower()


def change_pct(now, prev):
    if not prev:
        return None
    return round(100.0 * (now - prev) / prev, 1)


def per_week(value, days):
    return value * 7.0 / days if days else value


def short_path(url, site_url=""):
    if site_url and url.startswith(site_url.rstrip("/")):
        rest = url[len(site_url.rstrip("/")):]
        return rest or "/"
    p = urllib.parse.urlsplit(url)
    return p.path or url


def digest_settings(cfg):
    sd = cfg.get("signalDigest") or {}
    merged = json.loads(json.dumps(DEFAULTS))
    for k, v in sd.items():
        if isinstance(v, dict) and isinstance(merged.get(k), dict):
            merged[k].update(v)
        else:
            merged[k] = v
    if not merged.get("site"):
        host = urllib.parse.urlsplit(cfg.get("siteUrl", "")).netloc
        if not host:
            raise DigestError("Config needs signalDigest.site (or siteUrl) to name the site.")
        merged["site"] = host
    return merged


# --------------------------------------------------------------------------- GA4

def ga4_windows(days, today):
    end = today - dt.timedelta(days=1)
    start = end - dt.timedelta(days=days - 1)
    p_end = start - dt.timedelta(days=1)
    return start, end, p_end - dt.timedelta(days=days - 1), p_end


def _ga4_report(so, net, cfg, dims, metrics, ranges):
    body = {"dateRanges": ranges, "dimensions": [{"name": d} for d in dims], "metrics": [{"name": m} for m in metrics]}
    data = net.post_json(so.GA4_API.format(prop=cfg["ga4PropertyId"]), body, so.GA4_SCOPE,
                         "GA4 property %s" % cfg["ga4PropertyId"], net.service_account_email())
    out = []
    for r in data.get("rows", []) or []:
        values = [v.get("value", "") for v in r.get("dimensionValues", [])]
        # With two date ranges GA4 appends the range name as an extra dimension.
        rng = values[len(dims)] if len(values) > len(dims) else "now"
        nums = [float(v.get("value", 0) or 0) for v in r.get("metricValues", [])]
        out.append((values[:len(dims)], rng, nums))
    return out


def ga4_summary(so, net, cfg, days, today, conversion_events=None):
    """Sessions (all / organic) and key events, this window vs the previous one."""
    start, end, p_start, p_end = ga4_windows(days, today)
    ranges = [{"startDate": str(start), "endDate": str(end), "name": "now"},
              {"startDate": str(p_start), "endDate": str(p_end), "name": "prev"}]
    totals = {"now": {"sessions": 0.0, "organic": 0.0, "keyEvents": 0.0}, "prev": {"sessions": 0.0, "organic": 0.0, "keyEvents": 0.0}}
    for (channel,), rng, (sessions, key_events) in _ga4_report(so, net, cfg, ["sessionDefaultChannelGroup"], ["sessions", "keyEvents"], ranges):
        t = totals.setdefault(rng, {"sessions": 0.0, "organic": 0.0, "keyEvents": 0.0})
        t["sessions"] += sessions
        t["keyEvents"] += key_events
        if channel == "Organic Search":
            t["organic"] += sessions
    events = {}
    for (name,), rng, (count,) in _ga4_report(so, net, cfg, ["eventName"], ["keyEvents"], ranges):
        if conversion_events and name not in conversion_events:
            continue
        events.setdefault(name, {"now": 0, "prev": 0})[rng] = int(count)
    by_event = sorted(({"event": k, **v} for k, v in events.items() if v["now"] or v["prev"]), key=lambda e: -e["now"])
    if conversion_events:
        key_now = sum(e["now"] for e in by_event)
        key_prev = sum(e["prev"] for e in by_event)
    else:
        key_now, key_prev = int(totals["now"]["keyEvents"]), int(totals["prev"]["keyEvents"])

    def metric(now, prev):
        return {"now": int(now), "prev": int(prev), "changePct": change_pct(now, prev)}
    return {
        "window": {"start": str(start), "end": str(end), "prevStart": str(p_start), "prevEnd": str(p_end)},
        "sessions": metric(totals["now"]["sessions"], totals["prev"]["sessions"]),
        "organicSessions": metric(totals["now"]["organic"], totals["prev"]["organic"]),
        "keyEvents": metric(key_now, key_prev),
        "byEvent": by_event[:LIST_ROWS * 2],
    }


# --------------------------------------------------------------------------- Search Console

def top_pages(qp_rows):
    """Best page (most impressions) per query."""
    best = {}
    for r in qp_rows:
        q, page = r["keys"][0], r["keys"][1]
        if q not in best or r["impressions"] > best[q][1]:
            best[q] = (page, r["impressions"])
    return {q: p for q, (p, _) in best.items()}


def gsc_opportunities(so, net, cfg, days, today):
    start, end, p_start, p_end = so.windows(days, today)
    q_now = so.gsc_rows(net, cfg, start, end, ["query"])
    q_prev = so.gsc_rows(net, cfg, p_start, p_end, ["query"])
    qp = so.gsc_rows(net, cfg, start, end, ["query", "page"])
    res = so.analyse_queries(q_now, q_prev, qp, cfg)
    pages = top_pages(qp)

    def q(r):
        query = r["keys"][0]
        out = {"query": query, "impressions": int(r["impressions"]), "clicks": int(r["clicks"]),
               "ctr": round(r["ctr"], 4), "position": round(r["position"], 1)}
        if query in pages:
            out["page"] = pages[query]
        return out
    return {
        "window": {"start": str(start), "end": str(end), "days": days},
        "examined": {"queries": res["queries_examined"], "queryPageRows": res["query_page_rows_examined"]},
        "clicks": int(sum(r["clicks"] for r in q_now)),
        "impressions": int(sum(r["impressions"] for r in q_now)),
        "lowCtrTop3": [q(r) for r in res["low_ctr_top3"][:LIST_ROWS]],
        "nearMiss": [q(r) for r in res["near_miss_4_20"][:LIST_ROWS]],
        "rising": [dict(q(r), previous=int(r["previous"]), isNew=bool(r["is_new"])) for r in res["rising"][:LIST_ROWS]],
        "cannibalization": [{"query": f["query"], "impressions": int(f["total_impressions"]),
                             "pages": [{"page": p["page"], "impressions": int(p["impressions"]), "position": p["position"]} for p in f["pages"][:3]]}
                            for f in res["cannibalization"][:LIST_ROWS]],
    }


# --------------------------------------------------------------------------- errors

def check_urls(net, urls, workers=SITEMAP_CHECK_WORKERS):
    """Status of each URL (0 = unreachable)."""
    def one(u):
        try:
            return u, net.get(u, timeout=20)[0]
        except Exception:  # noqa: BLE001 - a URL that cannot be fetched is a finding, not a crash
            return u, 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        return dict(pool.map(one, urls))


def parse_error_list(raw):
    """External JS-error source: a list, or {"errors": [...]}; each {message, count?, url?}."""
    data = json.loads(raw)
    items = data.get("errors", []) if isinstance(data, dict) else data
    if not isinstance(items, list):
        raise ValueError("expected a JSON list of errors")
    out = []
    for e in items:
        if isinstance(e, dict) and e.get("message"):
            out.append({"message": str(e["message"])[:200], "count": int(e.get("count") or 1),
                        **({"url": str(e["url"])} if e.get("url") else {})})
    return sorted(out, key=lambda e: -e["count"])


def site_errors(so, net, cfg, settings):
    out = {"brokenPages": [], "checked": 0, "jsErrors": [], "notes": []}
    es = settings.get("errors") or {}
    if es.get("checkSitemap") and cfg.get("sitemapUrl"):
        urls = sorted(so.load_sitemap(net, cfg["sitemapUrl"]).keys())[: int(es.get("maxUrls") or SITEMAP_CHECK_DEFAULT)]
        statuses = check_urls(net, urls)
        out["checked"] = len(urls)
        out["brokenPages"] = [{"url": u, "status": s} for u, s in sorted(statuses.items()) if s != 200]
    elif es.get("checkSitemap"):
        out["notes"].append("no sitemapUrl in config: sitemap pages not checked")
    if es.get("url"):
        status, body = net.get(es["url"])
        if status != 200:
            out["notes"].append("errors.url answered HTTP %d" % status)
        else:
            out["jsErrors"] = parse_error_list(body)
    elif es.get("command"):
        proc = subprocess.run(es["command"], shell=True, capture_output=True, text=True, timeout=ERRORS_COMMAND_TIMEOUT_S)
        if proc.returncode != 0:
            out["notes"].append("errors.command exited %d: %s" % (proc.returncode, proc.stderr.strip()[:160]))
        else:
            out["jsErrors"] = parse_error_list(proc.stdout)
    else:
        out["notes"].append("no JS-error source configured (signalDigest.errors.url or .command)")
    out["jsErrors"] = out["jsErrors"][:LIST_ROWS]
    return out


# --------------------------------------------------------------------------- inbox / history / log

def read_json_file(path):
    if not path:
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def inbox_summary(raw):
    """gmail-search output (passed in by execute.sh) → count + messages."""
    if raw is None:
        return None
    if raw.get("success") is False:
        raise DigestError("inbox search failed: %s %s" % (raw.get("reason", ""), raw.get("message", "")))
    messages = [{k: m.get(k) for k in ("from", "subject", "date", "snippet") if m.get(k)} for m in raw.get("messages", [])]
    return {"query": raw.get("query"), "count": len(messages), "messages": messages}


def history_entries(raw):
    if not raw:
        return []
    data = raw.get("data", raw)
    return data.get("entries", []) if isinstance(data, dict) else []


def read_log(path):
    if not path:
        return ""
    try:
        with open(os.path.expanduser(path), encoding="utf-8") as f:
            return f.read().lower()
    except FileNotFoundError:
        return ""


# --------------------------------------------------------------------------- candidates

def _cand(key, source, signal, proposal, effect, effort, score, subject, metric=None):
    c = {"key": key, "source": source, "signal": signal, "proposal": proposal,
         "expectedEffect": effect, "effort": effort, "score": round(score, 1), "subject": subject}
    if metric:
        c["metric"] = metric
    return c


def build_candidates(signals, settings, site_url=""):
    """Rule-based draft actions from the signals, best first (the lead decides)."""
    out = []
    t = settings["thresholds"]
    ga4 = signals.get("ga4")
    if isinstance(ga4, dict) and "sessions" in ga4:
        ke, ss = ga4["keyEvents"], ga4["sessions"]
        if ke["prev"] >= t["ga4MinPrevKeyEvents"] and ke["changePct"] is not None and ke["changePct"] <= -t["ga4DropPct"]:
            out.append(_cand("ga4:key-events-drop", "ga4",
                             "Key events (form submissions) %d → %d (%s%%) vs the previous %d days" % (ke["prev"], ke["now"], ke["changePct"], settings["days"]),
                             "Find where the inquiry-form drop happens (form errors, landing pages that lost traffic) and fix the biggest cause",
                             "Back to ~%d key events per %d days" % (ke["prev"], settings["days"]), "M — half a day", 1000 + abs(ke["changePct"]),
                             "key-events-drop", "GA4 key events"))
        if ss["prev"] >= t["ga4MinPrevSessions"] and ss["changePct"] is not None and ss["changePct"] <= -t["ga4DropPct"]:
            out.append(_cand("ga4:sessions-drop", "ga4",
                             "Sessions %d → %d (%s%%) vs the previous %d days" % (ss["prev"], ss["now"], ss["changePct"], settings["days"]),
                             "Find which channel and landing pages lost the sessions and fix the top one",
                             "Recover ~%d sessions per %d days" % (ss["prev"] - ss["now"], settings["days"]), "M — half a day", 500 + abs(ss["changePct"]),
                             "sessions-drop", "GA4 sessions"))
    gsc = signals.get("gsc")
    if isinstance(gsc, dict) and "lowCtrTop3" in gsc:
        days = gsc["window"]["days"]
        for r in gsc["lowCtrTop3"]:
            bench = BENCHMARK_CTR.get(max(1, min(5, int(round(r["position"])))), 0.06)
            extra = per_week(max(0.0, (bench - r["ctr"]) * r["impressions"]), days)
            page = short_path(r.get("page", ""), site_url) if r.get("page") else "the ranking page"
            out.append(_cand("gsc:low-ctr:%s" % r["query"], "gsc",
                             "'%s' ranks #%d with %.1f%% CTR on %d impressions (%d days)" % (r["query"], round(r["position"]), 100 * r["ctr"], r["impressions"], days),
                             "Rewrite the title and description of %s to answer '%s'" % (page, r["query"]),
                             "CTR %.1f%% → ~%d%%: about +%d clicks a week" % (100 * r["ctr"], round(100 * bench), round(extra)),
                             "S — 1 h", extra, r["query"], "GSC clicks for '%s'" % r["query"]))
        for r in gsc["nearMiss"]:
            target = BENCHMARK_CTR[NEAR_MISS_TARGET_POSITION]
            extra = per_week(max(0.0, (target - r["ctr"]) * r["impressions"]), days)
            page = short_path(r.get("page", ""), site_url) if r.get("page") else "the best page"
            out.append(_cand("gsc:near-miss:%s" % r["query"], "gsc",
                             "'%s' averages position %s on %d impressions (%d days)" % (r["query"], r["position"], r["impressions"], days),
                             "Expand %s with a section that answers '%s' and add 2–3 internal links to it" % (page, r["query"]),
                             "Into the top 3: about +%d clicks a week" % round(extra),
                             "M — half a day", extra * 0.6, r["query"], "GSC position and clicks for '%s'" % r["query"]))
        covered = {r["query"] for r in gsc["lowCtrTop3"] + gsc["nearMiss"]} | {f["query"] for f in gsc["cannibalization"]}
        for r in gsc["rising"]:
            # Rising demand is a topic only when no page ranks for it yet: new,
            # or beyond page 1, and not already an action above.
            if r["query"] in covered or not (r["isNew"] or r["position"] > RISING_MAX_RANKED_POSITION):
                continue
            out.append(_cand("gsc:rising:%s" % r["query"], "gsc",
                             "'%s' impressions %d → %d%s (%d days)" % (r["query"], r["previous"], r["impressions"], " (new)" if r["isNew"] else "", days),
                             "Check whether a page answers '%s'; if none does, write one" % r["query"],
                             "Catch new demand: ~%d impressions a week" % round(per_week(r["impressions"], days)),
                             "M — half a day", per_week(r["impressions"], days) * 0.05, r["query"], "GSC impressions and clicks for '%s'" % r["query"]))
        for f in gsc["cannibalization"]:
            pages = [short_path(p["page"], site_url) for p in f["pages"]]
            out.append(_cand("gsc:cannibal:%s" % f["query"], "gsc",
                             "'%s' is split across %d pages (%s), %d impressions" % (f["query"], len(pages), ", ".join(pages), f["impressions"]),
                             "Make %s the one page for '%s': differentiate the others or point them at it" % (pages[0], f["query"]),
                             "One stronger ranking for '%s'" % f["query"],
                             "M — half a day", per_week(f["impressions"], days) * 0.05, f["query"], "GSC position for '%s'" % f["query"]))
    errors = signals.get("errors")
    if isinstance(errors, dict):
        for p in errors.get("brokenPages", []):
            path = short_path(p["url"], site_url)
            out.append(_cand("errors:broken:%s" % path, "errors",
                             "%s is in the sitemap but answers %s" % (path, "no response" if p["status"] == 0 else "HTTP %d" % p["status"]),
                             "Fix or redirect %s, and drop it from the sitemap if it is gone" % path,
                             "No dead page for visitors and crawlers", "S — 1 h", 300, path))
        for e in errors.get("jsErrors", []):
            msg = e["message"][:80]
            out.append(_cand("errors:js:%s" % msg, "errors",
                             "JS error '%s' ×%d%s" % (msg, e["count"], " on %s" % short_path(e["url"], site_url) if e.get("url") else ""),
                             "Fix the JS error '%s'" % msg,
                             "Fewer broken sessions (×%d in the window)" % e["count"], "S — 1 h", 200 + e["count"], msg))
    return sorted(out, key=lambda c: -c["score"])


def filter_tried(candidates, history, log_text):
    """Drop candidates whose key was Done/Skipped, or whose subject the experiment log mentions."""
    blocked = {normalize_key(h["key"]): h for h in history if h.get("status") in ("do", "skip")}
    kept, tried = [], []
    for c in candidates:
        h = blocked.get(normalize_key(c["key"]))
        if h:
            tried.append({"key": c["key"], "why": "owner chose %s on %s (%s)" % ("Do" if h["status"] == "do" else "Skip", str(h.get("at", ""))[:10], h.get("digestId", ""))})
        elif log_text and len(c["subject"]) >= 4 and c["subject"].lower() in log_text:
            tried.append({"key": c["key"], "why": "mentioned in the experiment log"})
        else:
            kept.append(c)
    return kept, tried


# --------------------------------------------------------------------------- collect

def collect(so, cfg, net, today, history=None, inbox=None, days=None):
    settings = digest_settings(cfg)
    days = int(days or settings["days"])
    settings["days"] = days
    signals, sources = {}, {}

    def run(name, configured, fn):
        if not configured:
            sources[name] = "not configured"
            return
        try:
            signals[name] = fn()
            sources[name] = "ok"
        except (so.SeoOpsError, DigestError, ValueError, OSError, subprocess.SubprocessError) as e:
            sources[name] = "error: %s" % str(e).splitlines()[0][:200]

    run("ga4", bool(cfg.get("ga4PropertyId")), lambda: ga4_summary(so, net, cfg, days, today, (settings.get("ga4") or {}).get("conversionEvents")))
    run("gsc", bool(cfg.get("gscProperty")), lambda: gsc_opportunities(so, net, cfg, days, today))
    run("inbox", inbox is not None, lambda: inbox_summary(inbox))
    es = settings.get("errors") or {}
    # Only a source that can examine something counts as configured.
    run("errors", bool((es.get("checkSitemap") and cfg.get("sitemapUrl")) or es.get("url") or es.get("command")),
        lambda: site_errors(so, net, cfg, settings))
    entries = history_entries(history)
    candidates, tried = filter_tried(build_candidates(signals, settings, cfg.get("siteUrl", "")), entries, read_log(settings.get("experimentLog")))
    for c in candidates:
        c.pop("subject", None)
    pending = [{"key": h["key"], "digestId": h.get("digestId")} for h in entries if h.get("status") == "open"]
    return {
        "site": settings["site"],
        "project": settings.get("project"),
        "date": str(today),
        "days": days,
        "sources": sources,
        **signals,
        "alreadyTried": tried,
        "pendingOnOwner": pending,
        "candidates": candidates[:MAX_CANDIDATES],
        "next": "Pick 3-5 actions (the candidates, rewritten, or your own from the signals, e.g. repeated inbox questions), "
                "best first, each with key/source/signal/proposal/expectedEffect/effort(/metric), and run: "
                "execute.sh propose --config <config> --actions <file.json>",
    }


def main(argv=None, net=None, today=None, so=None):
    parser = argparse.ArgumentParser(prog="signal_digest.py", description="Daily signal digest for one site.")
    sub = parser.add_subparsers(dest="command", required=True)
    c = sub.add_parser("collect", help="gather the signals and draft actions (JSON)")
    c.add_argument("--config", required=True)
    c.add_argument("--days", type=int)
    c.add_argument("--history", help="file with GET /api/signal-digests/history output")
    c.add_argument("--inbox", help="file with gmail-search output")
    args = parser.parse_args(argv)
    try:
        so = so or load_seo_ops()
        cfg = so.load_config(args.config)
        net = net or so.Net(cfg)
        result = collect(so, cfg, net, today or dt.date.today(), read_json_file(args.history), read_json_file(args.inbox), args.days)
    except DigestError as e:
        print("signal-digest: %s" % e, file=sys.stderr)
        return EXIT_SETUP
    except Exception as e:  # noqa: BLE001 - seo_ops errors carry their own message
        if so is not None and isinstance(e, getattr(so, "SeoOpsError", ())):
            print("signal-digest: %s" % e, file=sys.stderr)
            return EXIT_SETUP
        raise
    print(json.dumps(result, ensure_ascii=False, indent=1))
    if not any(v == "ok" for v in result["sources"].values()):
        print("signal-digest: no source could be examined (%s). Nothing to propose from."
              % ", ".join("%s: %s" % kv for kv in result["sources"].items()), file=sys.stderr)
        return EXIT_EMPTY
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
