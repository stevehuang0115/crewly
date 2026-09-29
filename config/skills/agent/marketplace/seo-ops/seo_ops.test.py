#!/usr/bin/env python3
"""Offline tests for seo_ops.py (no network). Run: python3 seo_ops.test.py"""
import base64
import contextlib
import datetime as dt
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import seo_ops as S  # noqa: E402

TODAY = dt.date(2026, 9, 29)


class FakeNet:
    """Serves canned GET pages and Search Console rows keyed by dimensions."""

    def __init__(self, pages=None, gsc=None, ga4=None):
        self.pages, self.gsc, self.ga4 = pages or {}, gsc or {}, ga4
        self.gets = []
        self.ga4_bodies = []

    def get(self, url, timeout=30):
        self.gets.append(url)
        v = self.pages.get(url)
        if v is None:
            return 404, ""
        return 200, v

    def post_json(self, url, body, scope, what, email_hint=None):
        if "analyticsdata" in url:
            self.ga4_bodies.append(body)
            return self.ga4
        rows = self.gsc.get(tuple(body["dimensions"]), [])
        if body["startDate"] < self.gsc.get("_split", "0000"):
            rows = self.gsc.get(("prev",) + tuple(body["dimensions"]), rows if not self.gsc.get("_prev_empty") else [])
        return {"rows": rows}

    def service_account_email(self):
        return "sa@example.iam.gserviceaccount.com"


def row(keys, imp, clk, pos):
    return {"keys": keys, "impressions": imp, "clicks": clk, "ctr": clk / imp if imp else 0, "position": pos}


def run(argv, net, cfg_path, today=TODAY):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = S.main(["--config", cfg_path] + argv, net=net, today=today)
    return code, out.getvalue(), err.getvalue()


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def write(path, text):
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.cfg = {"siteUrl": "https://example.com", "gscProperty": "sc-domain:example.com",
                    "credentialsPath": "SEO_OPS_TEST_CREDS", "sitemapUrl": "https://example.com/sitemap.xml",
                    "publishMethod": "open a PR", "maxPagesPerDay": 1}

    def cfg_file(self, extra=None):
        p = os.path.join(self.tmp, "cfg.json")
        write(p, json.dumps(S.deep_merge(self.cfg, extra or {})))
        return p


# ------------------------------------------------------------------ cannibalization
class TestCannibalization(Base):
    def test_detects_query_served_by_two_pages(self):
        rows = [row(["best crm", "https://example.com/a"], 60, 5, 4),
                row(["best crm", "https://example.com/b"], 40, 2, 9)]
        found, examined = S.find_cannibalization(rows, 10, 30)
        self.assertEqual(examined, 1)
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["query"], "best crm")
        self.assertEqual([p["page"] for p in found[0]["pages"]], ["https://example.com/a", "https://example.com/b"])

    def test_ignores_query_served_by_one_page(self):
        rows = [row(["solo query", "https://example.com/a"], 500, 50, 2)]
        found, examined = S.find_cannibalization(rows, 10, 30)
        self.assertEqual((found, examined), ([], 1))

    def test_same_page_url_variants_are_one_page(self):
        rows = [row(["q", "https://example.com/a"], 50, 1, 3), row(["q", "https://example.com/a/#top"], 50, 1, 3)]
        self.assertEqual(S.find_cannibalization(rows, 10, 30)[0], [])

    def test_ignores_pages_below_min_impressions(self):
        rows = [row(["q", "https://example.com/a"], 500, 1, 3), row(["q", "https://example.com/b"], 2, 0, 30)]
        self.assertEqual(S.find_cannibalization(rows, 10, 30)[0], [])


# ------------------------------------------------------------------ urlNormalize
NORM = {"stripScheme": True, "localePrefixes": ["en", "zh"]}


class TestUrlNormalize(Base):
    def test_norm_url_scheme_and_locale_variants_are_one_page(self):
        keys = {S.norm_url(u, NORM) for u in ("http://example.com/x", "https://example.com/en/x/",
                                              "https://example.com/zh/x", "https://example.com/x#a")}
        self.assertEqual(keys, {"https://example.com/x"})
        self.assertEqual(S.norm_url("https://example.com/en", NORM), "https://example.com/")
        self.assertNotEqual(S.norm_url("https://example.com/english", NORM), "https://example.com/")
        self.assertNotEqual(S.norm_url("https://example.com/es/x", NORM), S.norm_url("https://example.com/x", NORM))

    def test_default_keeps_variants_separate(self):
        self.assertNotEqual(S.norm_url("http://example.com/x"), S.norm_url("https://example.com/x"))
        self.assertNotEqual(S.norm_url("https://example.com/en/x"), S.norm_url("https://example.com/x"))

    def test_cannibalization_ignores_scheme_and_locale_variants_of_one_page(self):
        rows = [row(["crewly", "https://example.com/"], 100, 5, 3), row(["crewly", "http://example.com/en"], 60, 2, 4),
                row(["crewly", "https://example.com/zh/"], 40, 1, 5)]
        self.assertEqual(len(S.find_cannibalization(rows, 10, 30)[0]), 1)             # noisy without the option
        self.assertEqual(S.find_cannibalization(rows, 10, 30, NORM)[0], [])            # one page with it
        rows.append(row(["crewly", "https://example.com/portal"], 50, 2, 6))
        found = S.find_cannibalization(rows, 10, 30, NORM)[0]
        self.assertEqual(len(found[0]["pages"]), 2)                                    # real 2nd page still caught
        self.assertEqual(found[0]["pages"][0]["impressions"], 200)                     # variants summed

    def test_page_report_merges_variants_into_one_card(self):
        sm = "<urlset><url><loc>https://example.com/x</loc><lastmod>2026-08-01</lastmod></url></urlset>"
        gsc = {("page",): [row(["https://example.com/x"], 100, 5, 3.0), row(["http://example.com/en/x"], 100, 5, 5.0)]}
        net = FakeNet(pages={"https://example.com/sitemap.xml": sm}, gsc=gsc)
        code, out, _ = run(["page-report", "--url", "http://example.com/en/x"], net, self.cfg_file({"urlNormalize": NORM}))
        self.assertEqual(code, 0)
        self.assertIn("/x  imp 200  clicks 10  pos 4.0", out)
        self.assertIn("examined: 1 URL(s) (1 in sitemap, 1 with Search Console rows)", out)


# ------------------------------------------------------------------ gsc-report
class TestGscReport(Base):
    def gsc(self):
        return {
            ("query",): [row(["brand name"], 900, 800, 1.0), row(["low ctr term"], 500, 40, 2.1),
                         row(["near miss term"], 120, 3, 9.0), row(["site:example.com"], 999, 0, 1.0),
                         row(["rising term"], 300, 10, 5.0), row(["tiny"], 5, 0, 8.0)],
            ("prev", "query"): [row(["low ctr term"], 480, 40, 2.0), row(["rising term"], 20, 1, 9.0)],
            ("query", "page"): [row(["shared term", "https://example.com/a"], 80, 4, 4.0),
                                row(["shared term", "https://example.com/b"], 70, 3, 6.0),
                                row(["low ctr term", "https://example.com/a"], 500, 40, 2.1)],
            "_split": "2026-08-30",
        }

    def test_four_patterns_and_exclusions(self):
        cfgp = self.cfg_file({"exclusions": {"queries": ["^site:", "^brand name$"]}})
        code, out, _ = run(["gsc-report"], FakeNet(gsc=self.gsc()), cfgp)
        self.assertEqual(code, 0)
        self.assertIn("low ctr term", out)
        self.assertIn("near miss term", out)
        self.assertIn("rising term", out)
        self.assertIn("20 ->", out)
        self.assertIn("shared term", out)
        self.assertNotIn("site:example.com", out)
        self.assertNotIn("brand name", out)
        self.assertIn("Cannibalization checked 2 distinct queries", out)
        self.assertIn("open a PR", out)

    def test_empty_data_refuses_to_report_clean(self):
        code, out, _ = run(["gsc-report"], FakeNet(gsc={}), self.cfg_file())
        self.assertEqual(code, S.EXIT_GATE)
        self.assertIn("0 queries", out)


# ------------------------------------------------------------------ credentials
class TestCredentials(Base):
    def test_env_var_unset_is_actionable(self):
        os.environ.pop("SEO_OPS_TEST_CREDS", None)
        with self.assertRaises(S.SeoOpsError) as cm:
            S.load_service_account(self.cfg)
        self.assertIn("export SEO_OPS_TEST_CREDS=", str(cm.exception))

    def test_config_must_hold_env_var_name_not_a_path(self):
        with self.assertRaises(S.SeoOpsError) as cm:
            S.load_service_account({"credentialsPath": "/home/me/key.json"})
        self.assertIn("NAME", str(cm.exception))

    def test_missing_file_and_bad_json(self):
        os.environ["SEO_OPS_TEST_CREDS"] = os.path.join(self.tmp, "nope.json")
        with self.assertRaises(S.SeoOpsError) as cm:
            S.load_service_account(self.cfg)
        self.assertIn("does not exist", str(cm.exception))
        bad = os.path.join(self.tmp, "bad.json")
        write(bad, "not json")
        os.environ["SEO_OPS_TEST_CREDS"] = bad
        with self.assertRaises(S.SeoOpsError) as cm:
            S.load_service_account(self.cfg)
        self.assertIn("not a valid service-account", str(cm.exception))
        os.environ.pop("SEO_OPS_TEST_CREDS")

    def test_cli_prints_message_not_stack_trace(self):
        os.environ.pop("SEO_OPS_TEST_CREDS", None)
        code, _, err = run(["gsc-report"], S.Net(self.cfg), self.cfg_file())
        self.assertEqual(code, S.EXIT_SETUP)
        self.assertIn("seo-ops: Environment variable SEO_OPS_TEST_CREDS is not set", err)
        self.assertNotIn("Traceback", err)

    @unittest.skipUnless(shutil.which("openssl"), "openssl needed")
    def test_jwt_signature_verifies_with_public_key(self):
        priv = os.path.join(self.tmp, "k.pem")
        subprocess.run(["openssl", "genrsa", "-out", priv, "2048"], capture_output=True, check=True)
        pub = os.path.join(self.tmp, "k.pub")
        subprocess.run(["openssl", "rsa", "-in", priv, "-pubout", "-out", pub], capture_output=True, check=True)
        key = {"client_email": "sa@x.iam.gserviceaccount.com", "private_key": read(priv)}
        jwt = S.sign_jwt(key, S.GSC_SCOPE, now=1000)
        head, claims, sig = jwt.split(".")
        pad = lambda s: s + "=" * (-len(s) % 4)
        self.assertEqual(json.loads(base64.urlsafe_b64decode(pad(claims)))["scope"], S.GSC_SCOPE)
        sigfile = os.path.join(self.tmp, "sig")
        with open(sigfile, "wb") as f:
            f.write(base64.urlsafe_b64decode(pad(sig)))
        r = subprocess.run(["openssl", "dgst", "-sha256", "-verify", pub, "-signature", sigfile],
                           input=("%s.%s" % (head, claims)).encode(), capture_output=True)
        self.assertEqual(r.returncode, 0, r.stderr)


# ------------------------------------------------------------------ page-report
SITEMAP = """<urlset><url><loc>https://example.com/old</loc><lastmod>2026-08-01</lastmod></url>
<url><loc>https://example.com/new</loc><lastmod>2026-09-27</lastmod></url>
<url><loc>https://example.com/lowctr</loc><lastmod>2026-08-01</lastmod></url>
<url><loc>https://example.com/deep</loc><lastmod>2026-08-01</lastmod></url></urlset>"""


class TestPageReport(Base):
    def test_report_card_verdicts(self):
        gsc = {("page",): [row(["https://example.com/lowctr"], 400, 4, 2.0), row(["https://example.com/deep"], 90, 1, 31.0),
                           row(["https://example.com/orphan"], 10, 0, 3.0)]}
        net = FakeNet(pages={"https://example.com/sitemap.xml": SITEMAP}, gsc=gsc)
        code, out, _ = run(["page-report", "--url", "https://example.com/old", "--url", "https://example.com/new",
                            "--url", "https://example.com/lowctr", "--url", "https://example.com/deep",
                            "--url", "https://example.com/orphan"], net, self.cfg_file())
        self.assertEqual(code, 0)
        self.assertIn("examined: 5 URL(s)", out)
        self.assertIn("[no-impressions]", out.split("/old")[1].split("/new")[0])
        self.assertIn("[too-new]", out.split("/new")[1].split("/lowctr")[0])
        self.assertIn("[low-ctr]", out.split("/lowctr")[1].split("/deep")[0])
        self.assertIn("[bad-position]", out.split("/deep")[1].split("/orphan")[0])
        self.assertIn("[not-in-sitemap]", out.split("/orphan")[1])

    def test_zero_urls_refuses(self):
        net = FakeNet(pages={"https://example.com/sitemap.xml": SITEMAP}, gsc={})
        code, out, _ = run(["page-report", "--include", "^nomatch$"], net, self.cfg_file())
        self.assertEqual(code, S.EXIT_GATE)
        self.assertIn("0 URLs", out)


GA4_DATA = {"rows": [{"dimensionValues": [{"value": "/en/x"}], "metricValues": [{"value": "12"}]}]}


class TestPageReportGa4AndJson(Base):
    def _net(self):
        return FakeNet(pages={"https://example.com/sitemap.xml": SITEMAP}, gsc={}, ga4=GA4_DATA)

    def test_ga4_request_carries_hostname_filter_when_configured(self):
        net = self._net()
        code, out, _ = run(["page-report", "--url", "https://example.com/old", "--ga4"], net,
                           self.cfg_file({"ga4PropertyId": "1", "ga4HostName": "crewlyai.com"}))
        self.assertEqual(code, 0)
        flt = json.dumps(net.ga4_bodies[0]["dimensionFilter"])
        self.assertIn('"fieldName": "hostName"', flt)
        self.assertIn('"matchType": "EXACT"', flt)
        self.assertIn('"value": "crewlyai.com"', flt)
        self.assertIn("Organic Search", flt)  # the channel filter is kept
        self.assertIn("host crewlyai.com", out)

    def test_ga4_request_has_no_hostname_filter_when_unset(self):
        net = self._net()
        run(["page-report", "--url", "https://example.com/old", "--ga4"], net, self.cfg_file({"ga4PropertyId": "1"}))
        self.assertEqual(len(net.ga4_bodies), 1)
        self.assertNotIn("hostName", json.dumps(net.ga4_bodies[0]))

    def test_json_output_is_parseable_and_has_the_page_rows(self):
        gsc = {("page",): [row(["https://example.com/lowctr"], 400, 4, 2.0)]}
        net = FakeNet(pages={"https://example.com/sitemap.xml": SITEMAP}, gsc=gsc, ga4=GA4_DATA)
        out_path = os.path.join(self.tmp, "pages.json")
        code, _, _ = run(["page-report", "--url", "https://example.com/lowctr", "--url", "https://example.com/old",
                          "--ga4", "--json", out_path], net, self.cfg_file({"ga4PropertyId": "1"}))
        self.assertEqual(code, 0)
        data = json.loads(read(out_path))
        self.assertEqual(data["examined"], 2)
        by_url = {p["url"]: p for p in data["pages"]}
        self.assertEqual(by_url["https://example.com/lowctr"]["impressions"], 400)
        self.assertIn("low-ctr", [v["code"] for v in by_url["https://example.com/lowctr"]["verdicts"]])
        self.assertIsNone(by_url["https://example.com/old"]["position"])
        self.assertEqual(data["ga4"], [{"path": "/en/x", "sessions": 12}])

    def test_prepublish_self_link_is_excluded_under_url_normalize(self):
        html = GOOD.replace("</body>", '<a href="https://example.com/best-crm">self</a></body>')
        cfg = S.deep_merge(S.DEFAULTS, {"urlNormalize": NORM})
        a = S.prepublish(html, "https://example.com/en/best-crm", cfg, None, today=TODAY)
        b = S.prepublish(html, "https://example.com/en/best-crm", S.DEFAULTS, None, today=TODAY)
        n = lambda rep: next(x for x in rep.rows if x[1] == "internal links")  # noqa: E731
        self.assertEqual(n(a)[3], "2")  # the self-link (un-prefixed spelling) is not counted
        self.assertEqual(n(b)[3], "3")  # without urlNormalize it is, by design


# ------------------------------------------------------------------ prepublish
GOOD = """<html><head><title>Best CRM tools 2026: compared</title>
<meta name="description" content="%s"><link rel="canonical" href="https://example.com/best-crm">
<script type="application/ld+json">{"@type":"Article","headline":"x"}</script></head><body><article>
<h1>Best CRM tools</h1><p>Short answer: 3 tools win in 2026. %s</p>
<h2>What is a CRM?</h2><h2>How do we test?</h2><h2>Pricing</h2>
<a href="/a">a</a><a href="/b">b</a><a href="https://www.irs.gov/x">src</a></article></body></html>""" % ("d" * 90, "word " * 900)


class TestPrepublish(Base):
    def test_year_missing_warns_on_best_intent_page(self):
        html = GOOD.replace("Best CRM tools 2026: compared", "Best CRM tools compared")
        rep = S.prepublish(html, "https://example.com/best-crm", S.DEFAULTS, None, today=TODAY)
        row_ = [r for r in rep.rows if r[1] == "current year in title"][0]
        self.assertEqual(row_[2], "WARN")
        self.assertIn("lacks 2026", row_[3])

    def test_year_present_passes_and_non_intent_is_na(self):
        rep = S.prepublish(GOOD, "https://example.com/best-crm", S.DEFAULTS, None, today=TODAY)
        self.assertEqual([r for r in rep.rows if r[1] == "current year in title"][0][2], "PASS")
        plain = GOOD.replace("Best CRM tools 2026: compared", "How we work").replace("Best CRM tools", "How we work")
        rep = S.prepublish(plain, "https://example.com/about", S.DEFAULTS, None, today=TODAY)
        self.assertIn("n/a", [r for r in rep.rows if r[1] == "current year in title"][0][3])

    def test_good_page_has_no_fail_and_thin_page_fails(self):
        self.assertEqual(S.prepublish(GOOD, "https://example.com/best-crm", S.DEFAULTS, None, today=TODAY).fails, 0)
        thin = "<html><head><title>t</title></head><body><p>hi</p></body></html>"
        rep = S.prepublish(thin, "https://example.com/x", S.DEFAULTS, None, today=TODAY)
        self.assertGreaterEqual(rep.fails, 4)

    def test_cli_exit_code_follows_fail(self):
        f = os.path.join(self.tmp, "d.html")
        write(f, "<html><head><title>t</title></head><body>x</body></html>")
        code, out, _ = run(["prepublish-check", "--file", f, "--canonical-url", "https://example.com/x"],
                           FakeNet(pages={"https://example.com/sitemap.xml": SITEMAP}), self.cfg_file())
        self.assertEqual(code, S.EXIT_GATE)
        self.assertIn("checks:", out)


# ------------------------------------------------------------------ live-diff
LIVE = """<html><body><article><h1>Title</h1><h2>Cut-off dates</h2>
<table><tr><th>Category</th><th>Date</th></tr><tr><td>EB-1</td><td>Current</td></tr></table>
<p>Some body text that is long enough to matter for the length comparison, repeated. %s</p>
<a href="/related">related</a><a href="https://travel.state.gov/x">source</a>
<script type="application/ld+json">{"@type":"Article","headline":"H","author":"A"}</script></article></body></html>""" % ("text " * 40)


class TestLiveDiff(Base):
    def test_removed_table_fails_needs_approval(self):
        proposed = LIVE.replace("<table><tr><th>Category</th><th>Date</th></tr><tr><td>EB-1</td><td>Current</td></tr></table>", "")
        res = S.live_diff(LIVE, proposed, "https://example.com/p", S.DEFAULTS)
        self.assertFalse(res["pass"])
        self.assertIn("table", res["removed"])
        self.assertIn("REMOVED", res["reasons"][0])

    def test_pure_text_edit_passes(self):
        proposed = LIVE.replace("Some body text", "Some fresher body text")
        res = S.live_diff(LIVE, proposed, "https://example.com/p", S.DEFAULTS)
        self.assertTrue(res["pass"], res)
        self.assertGreater(res["compared"]["live"], 0)

    def test_table_cell_update_is_not_a_removal(self):
        res = S.live_diff(LIVE, LIVE.replace("Current", "01JAN25"), "https://example.com/p", S.DEFAULTS)
        self.assertTrue(res["pass"])

    def test_zero_parsed_elements_fails(self):
        for live, prop in (("<html><body>plain</body></html>", LIVE), (LIVE, "<html><body>plain</body></html>"),
                           ("", "")):
            res = S.live_diff(live, prop, "https://example.com/p", S.DEFAULTS)
            self.assertFalse(res["pass"])
            self.assertIn("0 elements parsed", res["reasons"][0])

    def test_removed_heading_link_and_structured_data_property(self):
        proposed = LIVE.replace("<h2>Cut-off dates</h2>", "").replace('<a href="/related">related</a>', "") \
            .replace(',"author":"A"', "")
        res = S.live_diff(LIVE, proposed, "https://example.com/p", S.DEFAULTS)
        self.assertIn("heading", res["removed"])
        self.assertIn("link", res["removed"])
        self.assertIn("jsonld: Article.author", res["removed"]["structured-data"])

    def test_big_text_shrink_needs_approval(self):
        proposed = LIVE.replace("text " * 40, "")
        res = S.live_diff(LIVE, proposed, "https://example.com/p", S.DEFAULTS)
        self.assertFalse(res["pass"])
        self.assertTrue(any("shrank" in r for r in res["reasons"]))

    def test_cli_exit_codes_and_message(self):
        f = os.path.join(self.tmp, "p.html")
        write(f, LIVE.replace("<h2>Cut-off dates</h2>", ""))
        net = FakeNet(pages={"https://example.com/p": LIVE})
        code, out, _ = run(["live-diff", "--url", "https://example.com/p", "--proposed-file", f], net, self.cfg_file())
        self.assertEqual(code, S.EXIT_GATE)
        self.assertIn("NEEDS HUMAN APPROVAL", out)
        self.assertIn("compared:", out)
        write(f, LIVE)
        code, out, _ = run(["live-diff", "--url", "https://example.com/p", "--proposed-file", f], net, self.cfg_file())
        self.assertEqual(code, 0)
        self.assertIn("RESULT: PASS", out)


# ------------------------------------------------------------------ pattern-queue
TEMPLATE = "# {{category}} {{country}} [{{locale}}]\nCutoff {{data.cutoff}} as of {{data.asof}}\n"


class TestPatternQueue(Base):
    def setUp(self):
        super().setUp()
        self.template = os.path.join(self.tmp, "tpl.md")
        write(self.template, TEMPLATE)
        self.state = os.path.join(self.tmp, "state.json")
        self.data = {
            "https://d/EB-1/China": {"label": "a", "cutoff": "2023-01", "asof": "2026-09"},
            "https://d/EB-1/India": {"label": "b", "cutoff": "2013-05", "asof": "2026-09"},
            "https://d/F2A/China": {"label": "c", "cutoff": "2023-01", "asof": "2026-09"},   # dup of EB-1 China
            "https://d/F2A/India": {"label": "d", "cutoff": "2022-02", "asof": "2026-09"},
        }
        self.extra = {"patternQueue": {
            "statePath": self.state, "template": self.template,
            "variables": {"category": ["EB-1", "F2A"], "country": [{"value": "China", "aliases": ["china"]}, "India"], "locale": ["en", "zh"]},
            "demand": {"days": 28, "minImpressions": 50}, "similarity": {"threshold": 0.9, "ignoreKeys": ["label"]},
            "dataSource": {"url": "https://d/{category}/{country}"}}}
        self.gsc = {("query",): [row(["eb-1 china green card"], 200, 5, 6.0), row(["eb-1 india wait"], 300, 9, 7.0),
                                 row(["f2a india"], 10, 0, 9.0), row(["f2a china cutoff"], 400, 10, 5.0)]}

    def net(self):
        return FakeNet(pages={k: json.dumps(v) for k, v in self.data.items()}, gsc=self.gsc)

    def plan(self, extra=None):
        return run(["pattern-queue", "plan"], self.net(), self.cfg_file(S.deep_merge(self.extra, extra or {})))

    def test_zero_demand_candidate_is_skipped_with_count(self):
        code, out, _ = self.plan()
        self.assertEqual(code, 0)
        line = [l for l in out.splitlines() if "category=F2A|country=India" in l][0]
        self.assertIn("skip", line)
        self.assertIn("1 matched queries, 10 impressions (below the 50 threshold)", line)

    def test_no_query_at_all_reports_zero_matched(self):
        self.gsc[("query",)] = [row(["unrelated"], 500, 5, 3.0)]
        _, out, _ = self.plan()
        self.assertIn("0 matched queries in 28 days: no demand", out)

    def test_near_duplicate_skipped_with_score_and_target(self):
        code, out, _ = self.plan()
        line = [l for l in out.splitlines() if "category=EB-1|country=China" in l][0]
        self.assertIn("skip", line)
        self.assertIn("near-duplicate of category=F2A|country=China: similarity 1.00 >= 0.90", line)
        self.assertIn("BUILD #1  category=F2A|country=China", out)

    def test_build_ranked_by_demand(self):
        _, out, _ = self.plan()
        builds = [l for l in out.splitlines() if "BUILD" in l]
        self.assertIn("category=F2A|country=China", builds[0])  # 400 impressions beats 300
        self.assertIn("category=EB-1|country=India", builds[1])

    def test_seed_bypasses_demand_gate(self):
        self.gsc[("query",)] = [row(["unrelated"], 500, 5, 3.0)]
        _, out, _ = self.plan({"patternQueue": {"seeds": [{"category": "EB-1", "country": "China"}]}})
        self.assertIn("BUILD #1  category=EB-1|country=China", out)
        self.assertIn("seed", out)

    def test_template_without_bindings_is_rejected(self):
        write(self.template, "# {{category}} {{country}}\nstatic text only\n")
        code, _, err = self.plan()
        self.assertEqual(code, S.EXIT_SETUP)
        self.assertIn("REJECTED", err)
        self.assertIn("no data bindings", err)

    def test_template_bindings_without_datasource_is_rejected(self):
        self.extra["patternQueue"].pop("dataSource")
        code, _, err = self.plan()
        self.assertEqual(code, S.EXIT_SETUP)
        self.assertIn("dataSource is not configured", err)

    def test_unresolved_binding_fails_render_and_keeps_the_daily_slot(self):
        del self.data["https://d/F2A/China"]["asof"]
        cfgp = self.cfg_file(self.extra)
        code, out, err = run(["pattern-queue", "next"], self.net(), cfgp)
        self.assertEqual(code, S.EXIT_GATE)
        self.assertIn("unresolved data binding(s): asof", err)
        self.assertFalse(os.path.exists(self.state))  # nothing recorded, slot not consumed

    def test_render_helper_raises_on_unresolved(self):
        with self.assertRaises(S.SeoOpsError):
            S.render_page(TEMPLATE, {"category": "x", "country": "y"}, {"cutoff": "1"}, "en")
        self.assertIn("Cutoff 1 as of 2", S.render_page(TEMPLATE, {"category": "x", "country": "y"}, {"cutoff": "1", "asof": "2"}, "en"))

    def test_second_release_same_day_refused_then_allowed_next_day(self):
        cfgp = self.cfg_file(self.extra)
        code, out, _ = run(["pattern-queue", "next"], self.net(), cfgp)
        self.assertEqual(code, 0)
        self.assertIn("released category=F2A|country=China", out)
        self.assertIn("[en]", out)
        self.assertIn("[zh]", out)  # locales count together: one release, both locales
        self.assertEqual(len(json.loads(read(self.state))["released"]), 1)
        net2 = self.net()
        code, out, _ = run(["pattern-queue", "next"], net2, cfgp)
        self.assertEqual(code, S.EXIT_GATE)
        self.assertIn("REFUSED", out)
        self.assertEqual(net2.gets, [])  # refused before any network call
        code, out, _ = run(["pattern-queue", "next"], self.net(), cfgp, today=TODAY + dt.timedelta(days=1))
        self.assertEqual(code, 0)
        self.assertIn("released category=EB-1|country=India", out)

    def test_locales_counted_separately_when_configured(self):
        cfgp = self.cfg_file(S.deep_merge(self.extra, {"patternQueue": {"localesCountTogether": False}}))
        code, out, _ = run(["pattern-queue", "next"], self.net(), cfgp)
        self.assertEqual(code, 0)
        self.assertEqual(out.count("--- page"), 1)
        code, out, _ = run(["pattern-queue", "next"], self.net(), cfgp)
        self.assertEqual(code, S.EXIT_GATE)

    def test_already_released_is_not_released_again_and_dupes_against_released(self):
        cfgp = self.cfg_file(self.extra)
        run(["pattern-queue", "next"], self.net(), cfgp)
        _, out, _ = run(["pattern-queue", "plan"], self.net(), cfgp)
        self.assertIn("already released", out)


class TestJsonInput(unittest.TestCase):
    def test_json_to_argv(self):
        argv = S.json_to_argv('{"command":"pattern-queue","action":"plan","config":"c.json","out":"o"}')
        self.assertEqual(argv, ["--config", "c.json", "pattern-queue", "plan", "--out", "o"])
        argv = S.json_to_argv('{"command":"prepublish-check","file":"d.html","target":["a","b"],"brief":true,"canonicalUrl":"u"}')
        self.assertEqual(argv, ["prepublish-check", "--file", "d.html", "--target", "a", "--target", "b", "--brief", "--canonical-url", "u"])


if __name__ == "__main__":
    unittest.main(verbosity=1)
