#!/usr/bin/env python3
"""seo-ops: Search Console-driven SEO operations for any site.

Standard library only (plus the `openssl` binary for signing the service-account
JWT), so it runs on a fresh machine with python3 >= 3.8 and nothing to install.

Subcommands
  gsc-report        Search Console patterns: low-CTR top-3, near-miss 4-20,
                    fastest-rising queries, keyword cannibalization (in code).
  page-report       Per-URL report card.
  prepublish-check  SEO/AEO checks on a URL or a local HTML draft.
  pattern-queue     plan | next | status: gated programmatic-page queue.
  live-diff         Gate: compare a proposed page with the live page.

Every check reports what it examined (counts) and refuses to pass on an empty
input set. Exit codes: 0 ok, 1 gate failed / needs human approval, 2 setup or
credentials problem, 3 permission problem.
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import gzip
import hashlib
import html as htmllib
import io
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from html.parser import HTMLParser

EXIT_OK, EXIT_GATE, EXIT_SETUP, EXIT_PERMISSION = 0, 1, 2, 3
GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly"
GA4_SCOPE = "https://www.googleapis.com/auth/analytics.readonly"
TOKEN_URL = "https://oauth2.googleapis.com/token"
GSC_API = "https://www.googleapis.com/webmasters/v3/sites/{site}/searchAnalytics/query"
GA4_API = "https://analyticsdata.googleapis.com/v1beta/properties/{prop}:runReport"
UA = "Mozilla/5.0 (compatible; crewly-seo-ops/1.0; +https://crewlyai.com)"
GSC_LAG_DAYS = 3  # the last 2-3 days of Search Console data are incomplete
GSC_PAGE_ROWS = 5000

DEFAULTS = {
    "exclusions": {"queries": [], "pages": []},
    "thresholds": {
        "lowCtrMaxPosition": 3, "lowCtrBelow": 0.35, "lowCtrMinImpressions": 100,
        "nearMissMinPosition": 4, "nearMissMaxPosition": 20, "nearMissMinImpressions": 40,
        "risingTop": 12, "cannibalMinPageImpressions": 10, "cannibalMinTotalImpressions": 30,
        "reportRows": 12,
        "pageNoImpressionsAfterDays": 7, "pageBadPosition": 20,
        "pageTopPosition": 5, "pageLowCtr": 0.05, "pageLowCtrMinImpressions": 50,
    },
    "prepublish": {
        "headTerms": [], "authorityLinkPattern": r"\.(gov|edu)(/|$|\?)",
        "titleMaxWidth": 60, "minBodyUnitsFail": 300, "minBodyUnitsWarn": 800,
        "yearIntentPattern": r"\b(best|top|latest|newest|updated|compar\w*|vs\.?|versus|alternatives?|review\w*)\b",
        "leadMarkers": ["in short", "short answer", "tl;dr", "the answer is", "key takeaway",
                        "bottom line", "in summary", "先给结论", "结论是", "简单说", "答案是"],
        "danglingPhrases": ["see above", "as mentioned above", "click here", "see below",
                            "见上文", "见下文", "如上所述", "点击这里"],
    },
    "liveDiff": {"maxTextShrinkPct": 30},
}


class SeoOpsError(Exception):
    """A problem the operator can act on. Printed without a stack trace."""

    def __init__(self, message, code=EXIT_SETUP):
        super().__init__(message)
        self.code = code


# --------------------------------------------------------------------------- config

def deep_merge(base, over):
    out = json.loads(json.dumps(base))
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def load_config(path):
    if not path:
        raise SeoOpsError("No config given. Pass --config <file.json> (see seo-ops.config.example.json).")
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
    except FileNotFoundError:
        raise SeoOpsError("Config file not found: %s" % path)
    except json.JSONDecodeError as e:
        raise SeoOpsError("Config file %s is not valid JSON: %s" % (path, e))
    if not isinstance(raw, dict):
        raise SeoOpsError("Config file %s must contain a JSON object." % path)
    return deep_merge(DEFAULTS, raw)


def require_keys(cfg, keys, why):
    missing = [k for k in keys if not cfg.get(k)]
    if missing:
        raise SeoOpsError("Config is missing %s (needed for %s)." % (", ".join(missing), why))


def compile_patterns(patterns, label):
    out = []
    for p in patterns or []:
        try:
            out.append(re.compile(p, re.I))
        except re.error as e:
            raise SeoOpsError("Invalid regex in config %s: %r (%s)" % (label, p, e))
    return out


def excluded(text, regexes):
    return any(r.search(text) for r in regexes)


# --------------------------------------------------------------------------- network

def _b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def load_service_account(cfg):
    """Resolve credentialsPath (an ENV VAR NAME) to the key JSON, with actionable errors."""
    env_name = cfg.get("credentialsPath")
    if not env_name:
        raise SeoOpsError("Config credentialsPath is missing. It must be the NAME of an environment "
                          "variable that holds the path to a Google service-account JSON file.")
    if os.sep in env_name or env_name.endswith(".json"):
        raise SeoOpsError("credentialsPath must be an environment variable NAME, not a file path "
                          "(keys never go in config). Example: \"credentialsPath\": \"SEO_OPS_GOOGLE_CREDENTIALS\".")
    path = os.environ.get(env_name)
    if not path:
        raise SeoOpsError("Environment variable %s is not set.\n  Fix: export %s=/path/to/service-account.json\n"
                          "  The service account needs webmasters.readonly (and analytics.readonly for GA4)."
                          % (env_name, env_name))
    try:
        with open(os.path.expanduser(path), encoding="utf-8") as f:
            key = json.load(f)
    except FileNotFoundError:
        raise SeoOpsError("$%s points to %s, which does not exist." % (env_name, path))
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise SeoOpsError("$%s points to %s, which is not a valid service-account JSON file." % (env_name, path))
    if not isinstance(key, dict) or not key.get("client_email") or not key.get("private_key"):
        raise SeoOpsError("%s is not a service-account key (client_email / private_key missing)." % path)
    return key


def sign_jwt(key, scope, now=None):
    """RS256 JWT assertion signed with the openssl binary (no python crypto dependency)."""
    if not shutil.which("openssl"):
        raise SeoOpsError("The `openssl` binary is required to sign the service-account token "
                          "(macOS ships it; Debian/Ubuntu: apt install openssl).")
    now = int(now or dt.datetime.now(dt.timezone.utc).timestamp())
    header = _b64url(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    claims = _b64url(json.dumps({"iss": key["client_email"], "scope": scope, "aud": TOKEN_URL,
                                 "iat": now, "exp": now + 3600}).encode())
    signing_input = ("%s.%s" % (header, claims)).encode()
    fd, keyfile = tempfile.mkstemp(prefix="seo-ops-", suffix=".pem")  # mkstemp -> mode 0600
    try:
        with os.fdopen(fd, "w") as f:
            f.write(key["private_key"])
        proc = subprocess.run(["openssl", "dgst", "-sha256", "-sign", keyfile],
                              input=signing_input, capture_output=True)
    finally:
        os.unlink(keyfile)
    if proc.returncode != 0:
        raise SeoOpsError("Could not sign with the private key in the service-account file "
                          "(is it a valid RSA key?): %s" % proc.stderr.decode("utf-8", "replace")[:120])
    return "%s.%s" % (signing_input.decode(), _b64url(proc.stdout))


class Net:
    """All network access lives here so tests can substitute a fake."""

    def __init__(self, cfg=None):
        self.cfg = cfg or {}
        self._tokens = {}

    def get(self, url, timeout=30):
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "gzip"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.GzipFile(fileobj=io.BytesIO(raw)).read()
                return r.status, raw.decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            return e.code, ""
        except (urllib.error.URLError, OSError) as e:
            raise SeoOpsError("Could not fetch %s: %s" % (url, getattr(e, "reason", e)), EXIT_GATE)

    def token(self, scope):
        if scope in self._tokens:
            return self._tokens[scope]
        key = load_service_account(self.cfg)
        body = urllib.parse.urlencode({
            "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
            "assertion": sign_jwt(key, scope)}).encode()
        req = urllib.request.Request(TOKEN_URL, data=body,
                                     headers={"Content-Type": "application/x-www-form-urlencoded"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                tok = json.loads(r.read())["access_token"]
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:200]
            raise SeoOpsError("Google rejected the service-account credentials (HTTP %d): %s\n"
                              "  Check the key has not been deleted/rotated and the system clock is right."
                              % (e.code, detail))
        except (urllib.error.URLError, OSError) as e:
            raise SeoOpsError("Could not reach Google's token endpoint: %s" % getattr(e, "reason", e))
        self._tokens[scope] = tok
        return tok

    def post_json(self, url, body, scope, what, email_hint=None):
        req = urllib.request.Request(
            url, data=json.dumps(body).encode(),
            headers={"Authorization": "Bearer %s" % self.token(scope), "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:200]
            if e.code in (401, 403):
                who = email_hint or "the service account"
                raise SeoOpsError("%s is not authorized for %s (HTTP %d).\n  Fix: add %s as a (restricted/read-only) "
                                  "user on that property, and make sure the API is enabled for its Google Cloud project."
                                  % (who, what, e.code, who), EXIT_PERMISSION)
            if e.code == 404:
                raise SeoOpsError("%s not found (HTTP 404). Check the property name in config." % what)
            raise SeoOpsError("%s failed: HTTP %d %s" % (what, e.code, detail), EXIT_GATE)
        except (urllib.error.URLError, OSError) as e:
            raise SeoOpsError("Could not reach Google APIs: %s" % getattr(e, "reason", e))

    def service_account_email(self):
        try:
            return load_service_account(self.cfg)["client_email"]
        except SeoOpsError:
            return None


# --------------------------------------------------------------------------- Search Console

def gsc_rows(net, cfg, start, end, dims):
    """All rows for a window, paginated. Returns [{keys, clicks, impressions, ctr, position}]."""
    require_keys(cfg, ["gscProperty"], "Search Console")
    url = GSC_API.format(site=urllib.parse.quote(cfg["gscProperty"], safe=""))
    out, offset = [], 0
    while True:
        data = net.post_json(url, {"startDate": str(start), "endDate": str(end), "dimensions": dims,
                                   "rowLimit": GSC_PAGE_ROWS, "startRow": offset},
                             GSC_SCOPE, "Search Console property %s" % cfg["gscProperty"],
                             net.service_account_email())
        rows = data.get("rows", [])
        for r in rows:
            imp = r.get("impressions", 0)
            clk = r.get("clicks", 0)
            out.append({"keys": r["keys"], "clicks": clk, "impressions": imp,
                        "ctr": r.get("ctr", (clk / imp) if imp else 0), "position": r.get("position", 0)})
        if len(rows) < GSC_PAGE_ROWS:
            return out
        offset += GSC_PAGE_ROWS


def windows(days, today=None):
    today = today or dt.date.today()
    end = today - dt.timedelta(days=GSC_LAG_DAYS)
    start = end - dt.timedelta(days=days - 1)
    p_end = start - dt.timedelta(days=1)
    return start, end, p_end - dt.timedelta(days=days - 1), p_end


def norm_url(u):
    u = u.split("#")[0]
    p = urllib.parse.urlsplit(u)
    path = p.path.rstrip("/") or "/"
    return urllib.parse.urlunsplit((p.scheme.lower(), p.netloc.lower(), path, p.query, ""))


def find_cannibalization(query_page_rows, min_page_imp, min_total_imp):
    """A query served by 2+ distinct pages. Returns (findings, queries_examined)."""
    by_query = defaultdict(lambda: defaultdict(lambda: {"impressions": 0, "clicks": 0, "pos_w": 0.0}))
    for r in query_page_rows:
        q, page = r["keys"][0], norm_url(r["keys"][1])
        d = by_query[q][page]
        d["impressions"] += r["impressions"]
        d["clicks"] += r["clicks"]
        d["pos_w"] += r["position"] * r["impressions"]
    findings = []
    for q, pages in by_query.items():
        real = {p: d for p, d in pages.items() if d["impressions"] >= min_page_imp}
        total = sum(d["impressions"] for d in real.values())
        if len(real) >= 2 and total >= min_total_imp:
            plist = sorted(({"page": p, "impressions": d["impressions"], "clicks": d["clicks"],
                             "position": round(d["pos_w"] / d["impressions"], 1) if d["impressions"] else 0}
                            for p, d in real.items()), key=lambda x: -x["impressions"])
            findings.append({"query": q, "total_impressions": total, "pages": plist})
    findings.sort(key=lambda f: -f["total_impressions"])
    return findings, len(by_query)


def analyse_queries(q_now, q_prev, qp_rows, cfg):
    t = cfg["thresholds"]
    qx = compile_patterns(cfg["exclusions"]["queries"], "exclusions.queries")
    px = compile_patterns(cfg["exclusions"]["pages"], "exclusions.pages")
    q_now = [r for r in q_now if not excluded(r["keys"][0], qx)]
    prev = {r["keys"][0]: r for r in q_prev}
    qp = [r for r in qp_rows if not excluded(r["keys"][0], qx) and not excluded(r["keys"][1], px)]
    low = [r for r in q_now if r["position"] <= t["lowCtrMaxPosition"]
           and r["impressions"] >= t["lowCtrMinImpressions"] and r["ctr"] < t["lowCtrBelow"]]
    near = [r for r in q_now if t["nearMissMinPosition"] <= r["position"] <= t["nearMissMaxPosition"]
            and r["impressions"] >= t["nearMissMinImpressions"]]

    def growth(r):
        return r["impressions"] - prev.get(r["keys"][0], {"impressions": 0})["impressions"]
    rising = [r for r in sorted(q_now, key=growth, reverse=True) if growth(r) > 0][:t["risingTop"]]
    cannibal, examined = find_cannibalization(qp, t["cannibalMinPageImpressions"], t["cannibalMinTotalImpressions"])
    return {
        "queries_examined": len(q_now), "query_page_rows_examined": len(qp),
        "cannibal_queries_examined": examined,
        "low_ctr_top3": sorted(low, key=lambda r: -r["impressions"]),
        "near_miss_4_20": sorted(near, key=lambda r: -r["impressions"]),
        "rising": [dict(r, previous=prev.get(r["keys"][0], {"impressions": 0})["impressions"],
                        is_new=r["keys"][0] not in prev) for r in rising],
        "cannibalization": cannibal,
    }


def cmd_gsc_report(args, cfg, net, today=None):
    days = args.days
    start, end, p_start, p_end = windows(days, today)
    q_now = gsc_rows(net, cfg, start, end, ["query"])
    q_prev = gsc_rows(net, cfg, p_start, p_end, ["query"])
    qp = gsc_rows(net, cfg, start, end, ["query", "page"])
    if not q_now:
        print("gsc-report: 0 queries returned for %s..%s on %s. Refusing to report a clean result on empty data "
              "(new property, wrong gscProperty, or no traffic yet)." % (start, end, cfg["gscProperty"]))
        return EXIT_GATE
    res = analyse_queries(q_now, q_prev, qp, cfg)
    rows = cfg["thresholds"]["reportRows"]
    clicks = sum(r["clicks"] for r in q_now)
    imps = sum(r["impressions"] for r in q_now)
    out = ["seo-ops gsc-report  %s  %s -> %s (vs previous %d days)" % (cfg["gscProperty"], start, end, days),
           "examined: %d queries, %d query x page rows" % (res["queries_examined"], res["query_page_rows_examined"]),
           "totals (query-level, anonymised long tail excluded): clicks %s  impressions %s  CTR %s"
           % (f"{clicks:,.0f}", f"{imps:,.0f}", pct(clicks, imps))]

    def section(title, action, items, fmt):
        out.append("")
        out.append("== %s: %d found ==" % (title, len(items)))
        out.append("   action: " + action)
        for it in items[:rows]:
            out.append("   " + fmt(it))
    section("Top-3 position, CTR < %d%%" % round(cfg["thresholds"]["lowCtrBelow"] * 100),
            "rewrite title/description to match the query intent", res["low_ctr_top3"],
            lambda r: "%-38s imp %6d  CTR %6s  pos %.1f" % (r["keys"][0][:38], r["impressions"], pct(r["clicks"], r["impressions"]), r["position"]))
    section("Positions 4-20, %d+ impressions" % cfg["thresholds"]["nearMissMinImpressions"],
            "add content and internal links", res["near_miss_4_20"],
            lambda r: "%-38s imp %6d  pos %4.1f  clicks %d" % (r["keys"][0][:38], r["impressions"], r["position"], r["clicks"]))
    section("Fastest-rising queries", "new demand: check whether a page exists; if not, it is a topic", res["rising"],
            lambda r: "%-38s imp %6d -> %6d %s  pos %.1f" % (r["keys"][0][:38], r["previous"], r["impressions"], "(new)" if r["is_new"] else "", r["position"]))
    section("Keyword cannibalization (query served by 2+ pages)",
            "pick the page that should win; point the others at it or differentiate them", res["cannibalization"],
            lambda f: "%-30s total imp %5d  " % (f["query"][:30], f["total_impressions"]) +
            " | ".join("%s (imp %d, pos %s)" % (p["page"].replace(cfg.get("siteUrl", ""), "") or "/", p["impressions"], p["position"]) for p in f["pages"][:3]))
    out.append("")
    out.append("Cannibalization checked %d distinct queries against %d query x page rows."
               % (res["cannibal_queries_examined"], res["query_page_rows_examined"]))
    if cfg.get("publishMethod"):
        out.append("How changes are published on this site: %s" % cfg["publishMethod"])
    print("\n".join(out))
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(res, f, ensure_ascii=False, indent=2)
    return EXIT_OK


def pct(a, b):
    return "%.1f%%" % (100 * a / b) if b else "-"


# --------------------------------------------------------------------------- sitemap / page-report

def parse_sitemap_xml(xml):
    """Return (urls: {url: lastmod|None}, child_sitemaps: [url])."""
    urls, children = {}, []
    for m in re.finditer(r"(?is)<(url|sitemap)>(.*?)</\1>", xml):
        loc = re.search(r"(?is)<loc>\s*(.*?)\s*</loc>", m.group(2))
        if not loc:
            continue
        loc = htmllib.unescape(loc.group(1))
        if m.group(1).lower() == "sitemap":
            children.append(loc)
        else:
            lm = re.search(r"(?is)<lastmod>\s*(.*?)\s*</lastmod>", m.group(2))
            urls[loc] = lm.group(1)[:10] if lm else None
    return urls, children


def load_sitemap(net, url):
    status, xml = net.get(url)
    if status != 200:
        raise SeoOpsError("Could not read sitemap %s (HTTP %d)." % (url, status), EXIT_GATE)
    urls, children = parse_sitemap_xml(xml)
    for child in children[:50]:
        s2, x2 = net.get(child)
        if s2 == 200:
            urls.update(parse_sitemap_xml(x2)[0])
    return {norm_url(u): lm for u, lm in urls.items()}


def diagnose_page(url, row, age_days, in_sitemap, t):
    """Report-card verdicts for one URL. Returns a list of (code, message)."""
    v = []
    if in_sitemap is False:
        v.append(("not-in-sitemap", "not in the sitemap: check publish status and section"))
    if age_days is not None and age_days < t["pageNoImpressionsAfterDays"]:
        return v + [("too-new", "published %d days ago: numbers only, no diagnosis yet (Search Console lags 2-3 days)" % age_days)]
    imp = row["impressions"] if row else 0
    if imp == 0:
        if age_days is None:
            v.append(("age-unknown", "0 impressions but publish date unknown (no sitemap lastmod): cannot apply the 7-day rule"))
        else:
            v.append(("no-impressions", "0 impressions after %d days: not indexed or not ranking; inspect URL in Search Console" % age_days))
        return v
    if row["position"] > t["pageBadPosition"]:
        v.append(("bad-position", "average position %.1f > %d: topic is searched but this page is not competitive; add first-hand sources and links" % (row["position"], t["pageBadPosition"])))
    if row["position"] <= t["pageTopPosition"] and imp >= t["pageLowCtrMinImpressions"] and row["ctr"] < t["pageLowCtr"]:
        v.append(("low-ctr", "top-%d but CTR %s: rewrite the title around the query that brings impressions" % (t["pageTopPosition"], pct(row["clicks"], imp))))
    return v


def cmd_page_report(args, cfg, net, today=None):
    today = today or dt.date.today()
    t = cfg["thresholds"]
    require_keys(cfg, ["sitemapUrl"], "page-report")
    sitemap = load_sitemap(net, cfg["sitemapUrl"])
    start, end, _, _ = windows(args.days, today)
    px = compile_patterns(cfg["exclusions"]["pages"], "exclusions.pages")
    pages = {norm_url(r["keys"][0]): r for r in gsc_rows(net, cfg, start, end, ["page"])}
    explicit = [norm_url(u) for u in (args.url or [])]
    if args.urls_file:
        with open(args.urls_file, encoding="utf-8") as f:
            explicit += [norm_url(x.strip()) for x in f if x.strip() and not x.startswith("#")]
    urls = explicit or sorted(sitemap)
    if args.include:
        inc = re.compile(args.include)
        urls = [u for u in urls if inc.search(u)]
    urls = [u for u in urls if not excluded(u, px)]
    if not urls:
        print("page-report: 0 URLs to examine (sitemap empty, or --include/exclusions removed everything). Refusing to report clean.")
        return EXIT_GATE
    flagged, lines = 0, []
    for u in urls:
        lm = sitemap.get(u)
        age = (today - dt.date.fromisoformat(lm)).days if lm else None
        verdicts = diagnose_page(u, pages.get(u), age, (u in sitemap) if explicit else None, t)
        real = [x for x in verdicts if x[0] not in ("too-new",)]
        flagged += bool(real)
        row = pages.get(u)
        lines.append("%s  imp %s  clicks %s  pos %s  age %s" % (
            u.replace(cfg.get("siteUrl", "").rstrip("/"), "") or "/",
            row["impressions"] if row else 0, row["clicks"] if row else 0,
            "%.1f" % row["position"] if row else "-", "%dd" % age if age is not None else "?"))
        for code, msg in verdicts:
            lines.append("    [%s] %s" % (code, msg))
    print("seo-ops page-report  %s  %s -> %s" % (cfg.get("gscProperty", ""), start, end))
    print("examined: %d URL(s) (%d in sitemap, %d with Search Console rows); %d flagged" % (
        len(urls), sum(1 for u in urls if u in sitemap), sum(1 for u in urls if u in pages), flagged))
    print("\n".join(lines))
    if cfg.get("ga4PropertyId") and args.ga4:
        print("\nGA4 organic landing sessions (property %s):" % cfg["ga4PropertyId"])
        for path, sess in ga4_landing_sessions(net, cfg, start, end)[:15]:
            print("    %6d  %s" % (sess, path))
    return EXIT_OK


def ga4_landing_sessions(net, cfg, start, end):
    body = {"dateRanges": [{"startDate": str(start), "endDate": str(end)}],
            "dimensions": [{"name": "landingPagePlusQueryString"}], "metrics": [{"name": "sessions"}],
            "dimensionFilter": {"filter": {"fieldName": "sessionDefaultChannelGroup",
                                           "stringFilter": {"value": "Organic Search"}}},
            "orderBys": [{"metric": {"metricName": "sessions"}, "desc": True}], "limit": 50}
    data = net.post_json(GA4_API.format(prop=cfg["ga4PropertyId"]), body, GA4_SCOPE,
                         "GA4 property %s" % cfg["ga4PropertyId"], net.service_account_email())
    return [(r["dimensionValues"][0]["value"], int(r["metricValues"][0]["value"])) for r in data.get("rows", [])]


# --------------------------------------------------------------------------- HTML extraction

class _Extract(HTMLParser):
    """One pass over HTML: title, meta, canonical, headings, tables, links, JSON-LD, visible text."""

    SKIP = {"script", "style", "noscript", "template"}

    def __init__(self, base_url=""):
        super().__init__(convert_charrefs=True)
        self.base = base_url
        self.title = ""
        self.meta = {}
        self.canonical = None
        self.headings = []      # (level, text)
        self.tables = []        # list of first-row text
        self.links = []         # absolute hrefs
        self.jsonld_raw = []
        self.text_parts = []
        self.in_article = 0
        self.article_text = []
        self._stack = []
        self._cur = None
        self._buf = []
        self._skip = 0
        self._table_depth = 0
        self._table_first_row = None
        self._row_open = False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in self.SKIP:
            if tag == "script" and "ld+json" in (a.get("type") or "").lower():
                self._cur = "jsonld"
                self._buf = []
            self._skip += 1
            return
        if tag == "meta" and a.get("name"):
            self.meta[a["name"].lower()] = a.get("content", "")
        elif tag == "link" and "canonical" in (a.get("rel") or "").lower():
            self.canonical = a.get("href")
        elif tag == "title":
            self._cur, self._buf = "title", []
        elif tag == "article":
            self.in_article += 1
        elif re.fullmatch(r"h[1-6]", tag):
            self._cur, self._buf = tag, []
        elif tag == "a" and a.get("href") and not a["href"].startswith(("#", "javascript:", "mailto:", "tel:")):
            self.links.append(urllib.parse.urljoin(self.base, a["href"]))
        elif tag == "table":
            self._table_depth += 1
            if self._table_depth == 1:
                self._table_first_row = None
                self._cur_table_buf = []
        elif tag == "tr" and self._table_depth == 1 and self._table_first_row is None:
            self._row_open = True
            self._first_row_buf = []

    def handle_endtag(self, tag):
        if tag in self.SKIP:
            self._skip = max(0, self._skip - 1)
            if tag == "script" and self._cur == "jsonld":
                self.jsonld_raw.append("".join(self._buf))
                self._cur = None
            return
        if tag == "title" and self._cur == "title":
            self.title = collapse("".join(self._buf))
            self._cur = None
        elif tag == "article":
            self.in_article = max(0, self.in_article - 1)
        elif re.fullmatch(r"h[1-6]", tag) and self._cur == tag:
            self.headings.append((int(tag[1]), collapse("".join(self._buf))))
            self._cur = None
        elif tag == "tr" and self._row_open:
            self._table_first_row = collapse(" ".join(self._first_row_buf))
            self._row_open = False
        elif tag == "table" and self._table_depth:
            if self._table_depth == 1:
                self.tables.append(self._table_first_row if self._table_first_row is not None else "")
            self._table_depth -= 1

    def handle_data(self, data):
        if self._cur == "jsonld":
            self._buf.append(data)
            return
        if self._skip:
            return
        if self._cur:
            self._buf.append(data)
        if self._row_open:
            self._first_row_buf.append(data)
        self.text_parts.append(data)
        if self.in_article:
            self.article_text.append(data)


def collapse(s):
    return re.sub(r"\s+", " ", htmllib.unescape(s)).strip()


def extract(html, base_url=""):
    p = _Extract(base_url)
    p.feed(html)
    p.close()
    return p


def jsonld_nodes(raw_blocks):
    nodes = []

    def walk(n):
        if isinstance(n, list):
            for x in n:
                walk(x)
        elif isinstance(n, dict):
            if "@graph" in n:
                walk(n["@graph"])
            if n.get("@type"):
                nodes.append(n)
    for blob in raw_blocks:
        try:
            walk(json.loads(blob.strip()))
        except (json.JSONDecodeError, ValueError):
            continue
    return nodes


def node_types(n):
    t = n.get("@type")
    return [str(x) for x in (t if isinstance(t, list) else [t])]


def body_units(text):
    """Length that works for CJK and Latin text: CJK characters + Latin words."""
    cjk = len(re.findall(r"[⺀-鿿가-힯]", text))
    words = len(re.findall(r"[A-Za-z0-9][A-Za-z0-9'’\-]*", text))
    return cjk + words


def text_width(s):
    return sum(2 if ord(c) > 0x2E7F else 1 for c in s)


# --------------------------------------------------------------------------- prepublish-check

class Report:
    def __init__(self, label):
        self.label, self.rows = label, []

    def add(self, group, name, level, detail=""):
        self.rows.append((group, name, level, detail))

    @property
    def fails(self):
        return sum(1 for r in self.rows if r[2] == "FAIL")

    @property
    def warns(self):
        return sum(1 for r in self.rows if r[2] == "WARN")

    def render(self, brief=False):
        out, last = [self.label], None
        for g, n, lv, d in self.rows:
            if brief and lv == "PASS":
                continue
            if g != last:
                out.append("  [%s]" % g)
                last = g
            out.append("  %-4s %-24s %s" % (lv, n, d))
        out.append("  -> %d checks: %d FAIL / %d WARN / %d PASS" % (
            len(self.rows), self.fails, self.warns, len(self.rows) - self.fails - self.warns))
        return "\n".join(out)


def prepublish(html, url, cfg, sitemap_locs=None, targets=(), today=None):
    today = today or dt.date.today()
    pp = cfg["prepublish"]
    rep = Report(url or "(local draft)")
    ex = extract(html, url or "")
    body_text = collapse(" ".join(ex.article_text)) if ex.article_text else collapse(" ".join(ex.text_parts))
    if not ex.article_text:
        rep.add("SEO", "body scope", "WARN", "no <article> element: measured the whole page, length is inflated")
    title = ex.title
    if not title:
        rep.add("SEO", "title", "FAIL", "missing")
    else:
        w = text_width(title)
        rep.add("SEO", "title length", "WARN" if w > pp["titleMaxWidth"] else "PASS",
                "%d wide%s" % (w, " (> %d gets truncated in results)" % pp["titleMaxWidth"] if w > pp["titleMaxWidth"] else ""))
        if pp["headTerms"]:
            hit = [h for h in pp["headTerms"] if h.lower() in title.lower()]
            rep.add("SEO", "title has head term", "PASS" if hit else "FAIL",
                    "/".join(hit) if hit else "none of %s in the title" % ", ".join(pp["headTerms"]))
        if targets:
            miss = [x for x in targets if x.lower() not in title.lower()]
            rep.add("SEO", "title has target query", "WARN" if miss else "PASS", ("missing: " + ", ".join(miss)) if miss else ", ".join(targets))
    year = str(today.year)
    h1s = [t for lv, t in ex.headings if lv == 1]
    slug = urllib.parse.urlsplit(url or "").path
    intent = re.compile(pp["yearIntentPattern"], re.I)
    if intent.search(" ".join([title] + h1s + [slug.replace("-", " ").replace("_", " ")])):
        rep.add("SEO", "current year in title", "PASS" if year in title else "WARN",
                "'best/latest/comparison' intent page; title %s %s" % ("has" if year in title else "lacks", year))
    else:
        rep.add("SEO", "current year in title", "PASS", "not a best/latest/comparison intent page (n/a)")
    desc = ex.meta.get("description", "").strip()
    rep.add("SEO", "meta description", "FAIL" if not desc else ("WARN" if len(desc) < 70 else "PASS"),
            "missing" if not desc else "%d chars%s" % (len(desc), " (short)" if len(desc) < 70 else ""))
    if not ex.canonical:
        rep.add("SEO", "canonical", "FAIL", "missing")
    elif url and norm_url(ex.canonical) != norm_url(url):
        rep.add("SEO", "canonical", "WARN", "points elsewhere: %s" % ex.canonical)
    else:
        rep.add("SEO", "canonical", "PASS")
    rep.add("SEO", "h1", "PASS" if len(h1s) == 1 else ("FAIL" if not h1s else "WARN"),
            h1s[0][:50] if len(h1s) == 1 else ("no h1" if not h1s else "%d h1 elements" % len(h1s)))
    h2 = [t for lv, t in ex.headings if lv == 2]
    rep.add("SEO", "h2 sections", "PASS" if len(h2) >= 3 else "WARN", "%d h2" % len(h2))
    units = body_units(body_text)
    lvl = "FAIL" if units < pp["minBodyUnitsFail"] else ("WARN" if units < pp["minBodyUnitsWarn"] else "PASS")
    rep.add("SEO", "body length", lvl, "%d units (CJK chars + Latin words)" % units)
    host = urllib.parse.urlsplit(url).netloc if url else ""
    inner = {norm_url(l) for l in ex.links if not host or urllib.parse.urlsplit(l).netloc == host}
    if url:
        inner.discard(norm_url(url))
    rep.add("SEO", "internal links", "PASS" if len(inner) >= 2 else "FAIL", "%d" % len(inner))
    if sitemap_locs is not None and url:
        rep.add("SEO", "in sitemap", "PASS" if norm_url(url) in sitemap_locs else "FAIL",
                "" if norm_url(url) in sitemap_locs else "not in sitemap (a draft may not be yet: re-run after publish)")
    types = {t for n in jsonld_nodes(ex.jsonld_raw) for t in node_types(n)}
    art = {"Article", "NewsArticle", "BlogPosting", "TechArticle", "HowTo", "FAQPage", "Product"} & types
    rep.add("SEO", "structured data", "PASS" if art else "WARN", ", ".join(sorted(types)) or "none")
    # ---- AEO: a paragraph an answer engine can lift and cite
    lead = body_text[:400].lower()
    marks = [m for m in pp["leadMarkers"] if m.lower() in lead]
    rep.add("AEO", "opens with the answer", "PASS" if marks else "WARN",
            marks[0] if marks else "no direct-answer marker in the first 400 chars (answer engines read this part)")
    rep.add("AEO", "number in the opening", "PASS" if re.search(r"\d", body_text[:600]) else "WARN",
            "" if re.search(r"\d", body_text[:600]) else "no figure in the first 600 chars")
    auth = re.compile(pp["authorityLinkPattern"], re.I)
    good = {l for l in ex.links if auth.search(l)}
    rep.add("AEO", "primary-source link", "PASS" if good else "FAIL",
            "%d link(s)" % len(good) if good else "no link matching %s: claims without a primary source are not cited" % pp["authorityLinkPattern"])
    qh = [h for h in h2 if h.rstrip().endswith(("?", "？"))]
    rep.add("AEO", "question headings", "PASS" if qh else "WARN", "%d" % len(qh))
    rep.add("AEO", "dated", "PASS" if re.search(r"\b20\d\d\b", body_text) else "WARN", "")
    bad = [p for p in pp["danglingPhrases"] if p.lower() in body_text.lower()]
    rep.add("AEO", "self-contained wording", "WARN" if bad else "PASS", ("dangling: " + ", ".join(bad)) if bad else "")
    return rep


def cmd_prepublish(args, cfg, net, today=None):
    if bool(args.url) == bool(args.file):
        raise SeoOpsError("prepublish-check needs exactly one of --url or --file.")
    if args.file:
        with open(args.file, encoding="utf-8") as f:
            html = f.read()
        url = args.canonical_url or ""
    else:
        status, html = net.get(args.url)
        if status != 200:
            print("%s\n  FAIL fetch: HTTP %d" % (args.url, status))
            return EXIT_GATE
        url = args.url
    locs = None
    if cfg.get("sitemapUrl") and url:
        try:
            locs = set(load_sitemap(net, cfg["sitemapUrl"]))
        except SeoOpsError as e:
            print("(sitemap check skipped: %s)" % e, file=sys.stderr)
    rep = prepublish(html, url, cfg, locs, args.target or [], today)
    print(rep.render(args.brief))
    if cfg.get("publishMethod"):
        print("Publish via: %s" % cfg["publishMethod"])
    return EXIT_GATE if rep.fails else EXIT_OK


# --------------------------------------------------------------------------- live-diff

def element_keys(html, base_url):
    """The comparable structure of a page. Returns (dict kind -> set(keys), text_len)."""
    ex = extract(html, base_url)
    heads = {"h%d: %s" % (lv, t.lower()) for lv, t in ex.headings if t}
    tables = {"table: " + (t.lower() or "(no header row)") for t in ex.tables}
    links = {norm_url(l) for l in ex.links if l.startswith(("http://", "https://"))}
    ld = set()
    for n in jsonld_nodes(ex.jsonld_raw):
        for t in node_types(n):
            ld.add("jsonld: %s" % t)
            for prop in n:
                if not prop.startswith("@"):
                    ld.add("jsonld: %s.%s" % (t, prop))
    text_len = len(collapse(" ".join(ex.article_text or ex.text_parts)))
    return {"heading": heads, "table": tables, "link": links, "structured-data": ld}, text_len, len(ex.tables)


def live_diff(live_html, proposed_html, live_url, cfg):
    """Compare live vs proposed. Returns a result dict; result['pass'] is the gate verdict."""
    live, live_len, live_tables = element_keys(live_html, live_url)
    prop, prop_len, prop_tables = element_keys(proposed_html, live_url)
    n_live = sum(len(v) for v in live.values()) + live_tables
    n_prop = sum(len(v) for v in prop.values()) + prop_tables
    res = {"compared": {"live": n_live, "proposed": n_prop}, "removed": {}, "added": {},
           "text_len": {"live": live_len, "proposed": prop_len}, "reasons": []}
    if n_live == 0 or n_prop == 0:
        which = "live page" if n_live == 0 else "proposed page"
        res.update({"pass": False, "reasons": ["0 elements parsed from the %s (headings/tables/links/structured data): "
                                               "nothing to compare, refusing to pass. Check the URL/file is real HTML." % which]})
        return res
    for kind in live:
        rem, add = sorted(live[kind] - prop[kind]), sorted(prop[kind] - live[kind])
        if rem:
            res["removed"][kind] = rem
        if add:
            res["added"][kind] = add
    if live_tables > prop_tables and not res["removed"].get("table"):
        res["removed"]["table"] = ["%d table(s) fewer than live (%d -> %d)" % (live_tables - prop_tables, live_tables, prop_tables)]
    removed_n = sum(len(v) for v in res["removed"].values())
    if removed_n:
        res["reasons"].append("%d element(s) REMOVED" % removed_n)
    shrink = 100 * (live_len - prop_len) / live_len if live_len else 0
    res["text_len"]["delta"] = prop_len - live_len
    res["text_len"]["shrink_pct"] = round(max(shrink, 0), 1)
    if shrink > cfg["liveDiff"]["maxTextShrinkPct"]:
        res["reasons"].append("text shrank %.0f%% (limit %d%%)" % (shrink, cfg["liveDiff"]["maxTextShrinkPct"]))
    res["pass"] = not res["reasons"]
    return res


def cmd_live_diff(args, cfg, net, today=None):
    if not (args.proposed_file or args.proposed_url):
        raise SeoOpsError("live-diff needs --proposed-file <html> (or --proposed-url).")
    status, live_html = net.get(args.url)
    if status != 200:
        print("live-diff: live page %s returned HTTP %d. Cannot compare: NOT passing." % (args.url, status))
        return EXIT_GATE
    if args.proposed_file:
        with open(args.proposed_file, encoding="utf-8") as f:
            proposed = f.read()
    else:
        ps, proposed = net.get(args.proposed_url)
        if ps != 200:
            print("live-diff: proposed URL returned HTTP %d. NOT passing." % ps)
            return EXIT_GATE
    res = live_diff(live_html, proposed, args.url, cfg)
    out = ["seo-ops live-diff  %s" % args.url,
           "compared: %d live element(s) vs %d proposed element(s)" % (res["compared"]["live"], res["compared"]["proposed"])]
    for label in ("removed", "added"):
        for kind, items in res[label].items():
            out.append("%s %s (%d):" % (label.upper(), kind, len(items)))
            out += ["    %s %s" % ("-" if label == "removed" else "+", i) for i in items[:25]]
    if res["text_len"].get("delta") is not None:
        out.append("text length: %d -> %d (%+d chars)" % (res["text_len"]["live"], res["text_len"]["proposed"], res["text_len"]["delta"]))
    if res["pass"]:
        out.append("RESULT: PASS (nothing removed)")
    elif res["compared"]["live"] == 0 or res["compared"]["proposed"] == 0:
        out.append("RESULT: FAIL - %s" % res["reasons"][0])
    else:
        out.append("RESULT: NEEDS HUMAN APPROVAL - %s. Do not publish; show this report to a person." % "; ".join(res["reasons"]))
    print("\n".join(out))
    return EXIT_OK if res["pass"] else EXIT_GATE


# --------------------------------------------------------------------------- pattern-queue

BINDING = re.compile(r"\{\{\s*data\.([A-Za-z0-9_.\-]+)\s*\}\}")
VAR = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")


def var_options(spec):
    """Variable values as [(value, [aliases...])]. Accepts strings or {value, aliases}."""
    out = []
    for item in spec:
        if isinstance(item, dict):
            out.append((str(item["value"]), [str(a) for a in item.get("aliases", [])] + [str(item["value"])]))
        else:
            out.append((str(item), [str(item)]))
    return out


def candidate_key(combo):
    return "|".join("%s=%s" % (k, combo[k]) for k in sorted(combo))


def pq_settings(cfg):
    pq = cfg.get("patternQueue")
    if not pq:
        raise SeoOpsError("Config has no patternQueue section (see the example config).")
    pq = deep_merge({"statePath": ".seo-ops/pattern-queue.json", "localeVariable": "locale",
                     "localesCountTogether": True,
                     "demand": {"days": 28, "minImpressions": 50},
                     "similarity": {"threshold": 0.9, "ignoreKeys": []}, "seeds": [], "variables": {}}, pq)
    if not pq.get("template"):
        raise SeoOpsError("patternQueue.template is missing (path to the page template file).")
    if not pq.get("variables"):
        raise SeoOpsError("patternQueue.variables is empty: nothing to expand.")
    return pq


def load_template(pq, base_dir="."):
    """Read the template and REJECT it unless it has live data bindings ({{data.x}}) and a dataSource."""
    tpl = pq["template"]
    if isinstance(tpl, dict):
        text = tpl.get("inline")
        if text is None:
            with open(os.path.join(base_dir, tpl["file"]), encoding="utf-8") as f:
                text = f.read()
    else:
        try:
            with open(os.path.join(base_dir, tpl), encoding="utf-8") as f:
                text = f.read()
        except FileNotFoundError:
            raise SeoOpsError("Template file not found: %s" % tpl)
    if not BINDING.search(text):
        raise SeoOpsError("REJECTED: the template has no data bindings ({{data.<field>}}). Static pattern pages go "
                          "stale within a month; bind the page to a live dataSource before queueing anything.")
    if not pq.get("dataSource"):
        raise SeoOpsError("REJECTED: template has data bindings but patternQueue.dataSource is not configured "
                          "(a URL or command that returns JSON for one variable set).")
    return text


def expand_candidates(pq):
    """Cross product of all NON-locale variables, in config order. Locale handled separately."""
    loc = pq["localeVariable"]
    names = [n for n in pq["variables"] if n != loc]
    combos = [{}]
    for n in names:
        combos = [dict(c, **{n: v}) for c in combos for v, _ in var_options(pq["variables"][n])]
    return combos


def locales(pq):
    spec = pq["variables"].get(pq["localeVariable"])
    return [v for v, _ in var_options(spec)] if spec else [None]


def demand_for(combo, pq, query_rows):
    """Queries matching every variable value (by value or alias). Returns (matched, impressions)."""
    matchers = []
    for name, value in combo.items():
        aliases = dict(var_options(pq["variables"][name])).get(value, [value])
        matchers.append([a.lower() for a in aliases])
    matched = [r for r in query_rows if all(any(a in r["keys"][0].lower() for a in m) for m in matchers)]
    return matched, sum(r["impressions"] for r in matched)


def flatten(data, prefix="", ignore=()):
    out = {}
    if isinstance(data, dict):
        for k, v in data.items():
            if k in ignore:
                continue
            out.update(flatten(v, "%s.%s" % (prefix, k) if prefix else str(k), ignore))
    elif isinstance(data, list):
        for i, v in enumerate(data):
            out.update(flatten(v, "%s[%d]" % (prefix, i), ignore))
    else:
        out[prefix] = json.dumps(data, sort_keys=True)
    return out


def similarity(a, b):
    """Jaccard similarity of (path, value) pairs. 1.0 = identical bound data."""
    sa, sb = set(a.items()), set(b.items())
    return len(sa & sb) / len(sa | sb) if (sa or sb) else 0.0


def fetch_data(pq, combo, net):
    """Resolve the live data for one variable set from dataSource {url|command}."""
    src = pq["dataSource"]
    vals = {k: v for k, v in combo.items()}

    if src.get("url"):
        url = re.sub(r"\{(\w+)\}", lambda m: urllib.parse.quote(str(vals.get(m.group(1), m.group(0))), safe=""), src["url"])
        status, body = net.get(url)
        if status != 200:
            raise SeoOpsError("dataSource %s returned HTTP %d" % (url, status), EXIT_GATE)
    elif src.get("command"):
        argv = [re.sub(r"\{(\w+)\}", lambda m: str(vals.get(m.group(1), m.group(0))), a) for a in shlex.split(src["command"])]
        try:
            proc = subprocess.run(argv, capture_output=True, text=True, timeout=60)
        except (OSError, subprocess.TimeoutExpired) as e:
            raise SeoOpsError("dataSource command failed to run: %s" % e, EXIT_GATE)
        if proc.returncode != 0:
            raise SeoOpsError("dataSource command exited %d: %s" % (proc.returncode, proc.stderr[:120]), EXIT_GATE)
        body = proc.stdout
    else:
        raise SeoOpsError("patternQueue.dataSource needs a `url` or a `command`.")
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        raise SeoOpsError("dataSource did not return JSON for %s" % candidate_key(combo), EXIT_GATE)
    return data


def resolve_path(data, path):
    cur = data
    for part in path.split("."):
        if isinstance(cur, dict) and part in cur and cur[part] is not None:
            cur = cur[part]
        else:
            return None, False
    return cur, True


def render_page(text, combo, data, locale=None):
    """Fill {{var}} and {{data.path}}. Raises if any binding is unresolved."""
    missing = []

    def bind(m):
        v, ok = resolve_path(data, m.group(1))
        if not ok:
            missing.append(m.group(1))
            return m.group(0)
        return v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
    out = BINDING.sub(bind, text)
    if missing:
        raise SeoOpsError("unresolved data binding(s): %s. Page not rendered." % ", ".join(sorted(set(missing))), EXIT_GATE)
    vals = dict(combo)
    if locale is not None:
        vals["locale"] = locale
    return VAR.sub(lambda m: str(vals.get(m.group(1), m.group(0))), out)


def load_state(pq):
    try:
        with open(pq["statePath"], encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {"released": []}
    except json.JSONDecodeError:
        raise SeoOpsError("Queue state file %s is corrupt JSON; fix or delete it." % pq["statePath"])


def save_state(pq, state):
    d = os.path.dirname(pq["statePath"])
    if d:
        os.makedirs(d, exist_ok=True)
    with open(pq["statePath"], "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)


def plan_candidates(cfg, net, pq, today=None):
    """The 'should this page exist' gate. Returns ranked decisions [{key, combo, decision, reason, ...}]."""
    start, end, _, _ = windows(pq["demand"]["days"], today)
    rows = gsc_rows(net, cfg, start, end, ["query"])
    qx = compile_patterns(cfg["exclusions"]["queries"], "exclusions.queries")
    rows = [r for r in rows if not excluded(r["keys"][0], qx)]
    if not rows:
        raise SeoOpsError("plan: 0 queries returned from Search Console for %s..%s. Refusing to decide on empty demand data." % (start, end), EXIT_GATE)
    seeds = {candidate_key(s) for s in pq["seeds"]}
    state = load_state(pq)
    built = {r["key"]: r.get("data") for r in state["released"]}
    ignore = set(pq["similarity"]["ignoreKeys"])
    thr = pq["similarity"]["threshold"]
    cands = []
    for combo in expand_candidates(pq):
        matched, imp = demand_for(combo, pq, rows)
        cands.append({"key": candidate_key(combo), "combo": combo, "matched_queries": len(matched),
                      "impressions": imp, "seed": candidate_key(combo) in seeds,
                      "top_queries": [r["keys"][0] for r in sorted(matched, key=lambda r: -r["impressions"])[:3]]})
    cands.sort(key=lambda c: (-c["seed"], -c["impressions"], c["key"]))
    parent = None
    if pq.get("parent"):
        p = pq["parent"]
        parent = flatten(p["data"] if "data" in p else fetch_data({"dataSource": p["dataSource"]}, p.get("vars", {}), net), ignore=ignore)
    accepted = []  # (key, flat)
    for k, d in built.items():
        if d:
            accepted.append((k, d))
    for c in cands:
        if c["key"] in built:
            c.update(decision="skip", reason="already released")
            continue
        min_imp = pq["demand"]["minImpressions"]
        if not c["seed"] and c["impressions"] < min_imp:
            c.update(decision="skip", reason=("0 matched queries" if c["matched_queries"] == 0 else "%d matched queries, %d impressions" % (c["matched_queries"], c["impressions"])) +
                     (" (below the %d threshold)" % min_imp if c["matched_queries"] else " in %d days: no demand" % pq["demand"]["days"]))
            continue
        try:
            flat = flatten(fetch_data(pq, c["combo"], net), ignore=ignore)
        except SeoOpsError as e:
            c.update(decision="skip", reason="data binding unavailable: %s" % e)
            continue
        if not flat:
            c.update(decision="skip", reason="dataSource returned no data for this variable set")
            continue
        best = ("", 0.0)
        for name, other in ([("parent page", parent)] if parent else []) + accepted:
            s = similarity(flat, other)
            if s > best[1]:
                best = (name, s)
        c["similarity"] = round(best[1], 3)
        c["nearest"] = best[0]
        if best[1] >= thr:
            c.update(decision="skip", reason="near-duplicate of %s: similarity %.2f >= %.2f" % (best[0], best[1], thr))
            continue
        accepted.append((c["key"], flat))
        c["data"] = flat
        c["decision"] = "build"
        c["reason"] = ("seed" if c["seed"] else "demand %d impressions from %d queries" % (c["impressions"], c["matched_queries"])) + \
                      ("; nearest %s at %.2f" % (best[0], best[1]) if best[0] else "")
    return cands


def units_released_today(state, today):
    return len({r["unit"] for r in state["released"] if r["date"] == str(today)})


def cmd_pattern_queue(args, cfg, net, today=None):
    today = today or dt.date.today()
    pq = pq_settings(cfg)
    template = load_template(pq, os.path.dirname(os.path.abspath(args.config)))
    limit = int(cfg.get("maxPagesPerDay", 1))
    state = load_state(pq)
    if args.action == "status":
        print("pattern-queue status: %d released in total, %d today (limit %d/day)" % (
            len(state["released"]), units_released_today(state, today), limit))
        return EXIT_OK
    if args.action == "next":
        n = units_released_today(state, today)
        if n >= limit:
            print("pattern-queue next: REFUSED. %d page(s) already released today (%s); the limit is %d/day. Try again tomorrow." % (n, today, limit))
            return EXIT_GATE
    decisions = plan_candidates(cfg, net, pq, today)
    build = [d for d in decisions if d["decision"] == "build"]
    if args.action == "plan":
        print("seo-ops pattern-queue plan  (%d candidates: %d build / %d skip)" % (len(decisions), len(build), len(decisions) - len(build)))
        for i, d in enumerate(build, 1):
            print("  BUILD #%d  %-40s %s" % (i, d["key"], d["reason"]))
        for d in decisions:
            if d["decision"] == "skip":
                print("  skip      %-40s %s" % (d["key"], d["reason"]))
        if args.json:
            with open(args.json, "w", encoding="utf-8") as f:
                json.dump([{k: v for k, v in d.items() if k != "data"} for d in decisions], f, ensure_ascii=False, indent=2)
        if cfg.get("publishMethod"):
            print("Publish via: %s" % cfg["publishMethod"])
        return EXIT_OK
    # next
    if not build:
        print("pattern-queue next: nothing to build (%d candidates examined, all skipped). Run `plan` to see why." % len(decisions))
        return EXIT_GATE
    pick = build[0]
    locs = locales(pq)
    together = pq["localesCountTogether"]
    todo = [(l,) for l in locs] if together else [(locs[units_released_today(state, today) % len(locs)],)]
    pages = []
    raw = fetch_data(pq, pick["combo"], net)
    for (loc,) in todo:
        pages.append((loc, render_page(template, pick["combo"], raw, loc)))  # raises on unresolved binding
    unit = pick["key"] if together else "%s|locale=%s" % (pick["key"], todo[0][0])
    state["released"].append({"key": pick["key"], "unit": unit, "date": str(today), "data": pick["data"]})
    save_state(pq, state)
    print("pattern-queue next: released %s (%s)" % (pick["key"], pick["reason"]))
    for loc, content in pages:
        if args.out:
            os.makedirs(args.out, exist_ok=True)
            name = re.sub(r"[^A-Za-z0-9_.-]+", "_", "%s%s" % (pick["key"], "_" + loc if loc else ""))
            with open(os.path.join(args.out, name + ".md"), "w", encoding="utf-8") as f:
                f.write(content)
        else:
            print("--- page%s ---\n%s" % (" [%s]" % loc if loc else "", content))
    if cfg.get("publishMethod"):
        print("Publish via: %s" % cfg["publishMethod"])
    return EXIT_OK


# --------------------------------------------------------------------------- CLI

def build_parser():
    ap = argparse.ArgumentParser(prog="seo-ops", description="Search Console-driven SEO operations.")
    ap.add_argument("--config", help="site config JSON (see seo-ops.config.example.json)")
    sub = ap.add_subparsers(dest="command", required=True)
    g = sub.add_parser("gsc-report")
    g.add_argument("--days", type=int, default=28)
    g.add_argument("--json")
    p = sub.add_parser("page-report")
    p.add_argument("--days", type=int, default=28)
    p.add_argument("--url", action="append")
    p.add_argument("--urls-file")
    p.add_argument("--include", help="regex: only URLs matching")
    p.add_argument("--ga4", action="store_true", help="append GA4 organic landing sessions")
    c = sub.add_parser("prepublish-check")
    c.add_argument("--url")
    c.add_argument("--file")
    c.add_argument("--canonical-url", help="the URL a --file draft will live at")
    c.add_argument("--target", action="append")
    c.add_argument("--brief", action="store_true")
    q = sub.add_parser("pattern-queue")
    q.add_argument("action", choices=["plan", "next", "status"])
    q.add_argument("--json")
    q.add_argument("--out", help="directory to write rendered pages to")
    d = sub.add_parser("live-diff")
    d.add_argument("--url", required=True, help="the live page")
    d.add_argument("--proposed-file")
    d.add_argument("--proposed-url")
    return ap


HANDLERS = {"gsc-report": cmd_gsc_report, "page-report": cmd_page_report, "prepublish-check": cmd_prepublish,
            "pattern-queue": cmd_pattern_queue, "live-diff": cmd_live_diff}


def json_to_argv(text):
    """Crewly skills receive one JSON argument: {"command": "...", "config": "...", ...} -> argv."""
    obj = json.loads(text)
    argv = []
    if obj.get("config"):
        argv += ["--config", str(obj.pop("config"))]
    cmd = obj.pop("command", None)
    if not cmd:
        raise SeoOpsError("JSON input needs a \"command\" (gsc-report, page-report, prepublish-check, pattern-queue, live-diff).")
    argv.append(cmd)
    action = obj.pop("action", None)
    if action:
        argv.append(str(action))
    for k, v in obj.items():
        flag = "--" + re.sub(r"([A-Z])", lambda m: "-" + m.group(1).lower(), k)
        if v is True:
            argv.append(flag)
        elif isinstance(v, list):
            for x in v:
                argv += [flag, str(x)]
        elif v not in (None, False):
            argv += [flag, str(v)]
    return argv


def main(argv=None, net=None, today=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        if sys.version_info < (3, 8):
            raise SeoOpsError("python3 >= 3.8 is required (found %d.%d)." % sys.version_info[:2])
        if len(argv) == 1 and argv[0].lstrip().startswith("{"):
            try:
                argv = json_to_argv(argv[0])
            except json.JSONDecodeError as e:
                raise SeoOpsError("Input looks like JSON but is not valid: %s" % e)
        args = build_parser().parse_args(argv)
        if args.command == "live-diff" and not args.config:
            cfg = deep_merge(DEFAULTS, {})  # live-diff needs no site config
        else:
            cfg = load_config(args.config)
        net = net or Net(cfg)
        return HANDLERS[args.command](args, cfg, net, today)
    except SeoOpsError as e:
        print("seo-ops: %s" % e, file=sys.stderr)
        return e.code
    except BrokenPipeError:
        return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
