#!/usr/bin/env python3
"""Offline tests for signal_digest.py (no network). Run: python3 signal_digest.test.py"""
import contextlib
import datetime as dt
import io
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import signal_digest as D  # noqa: E402

SO = D.load_seo_ops()
TODAY = dt.date(2026, 10, 3)
SITE = "https://visa.careerengine.us"


class FakeNet:
    """Canned GA4 reports (by first dimension), GSC rows (by dimensions, now/prev) and GET pages."""

    def __init__(self, ga4=None, gsc=None, pages=None, fail_gsc=False, crash_ga4=None):
        self.ga4, self.gsc, self.pages, self.fail_gsc = ga4 or {}, gsc or {}, pages or {}, fail_gsc
        self.crash_ga4 = crash_ga4
        self.gets = []
        self.ga4_bodies = []

    def get(self, url, timeout=30):
        self.gets.append(url)
        v = self.pages.get(url)
        if v is None:
            return 404, ""
        if isinstance(v, int):
            return v, ""
        return 200, v

    def post_json(self, url, body, scope, what, email_hint=None):
        if "analyticsdata" in url:
            if self.crash_ga4:
                raise self.crash_ga4
            self.ga4_bodies.append(body)
            return self.ga4.get(body["dimensions"][0]["name"], {"rows": []})
        if self.fail_gsc:
            raise SO.SeoOpsError("sa@x is not authorized for Search Console property (HTTP 403).", 3)
        start, end, _, _ = SO.windows(7, TODAY)
        rng = "now" if body["startDate"] == str(start) else "prev"
        return {"rows": self.gsc.get((rng,) + tuple(body["dimensions"]), [])}

    def service_account_email(self):
        return "sa@example.iam.gserviceaccount.com"


def gsc_row(keys, imp, clk, pos):
    return {"keys": keys, "impressions": imp, "clicks": clk, "ctr": clk / imp if imp else 0, "position": pos}


def ga4_rows(rows):
    return {"rows": [{"dimensionValues": [{"value": d} for d in dims], "metricValues": [{"value": str(m)} for m in mets]} for dims, mets in rows]}


GA4 = {
    "sessionDefaultChannelGroup": ga4_rows([
        (["Organic Search", "now"], [300, 6]), (["Direct", "now"], [100, 2]),
        (["Organic Search", "prev"], [320, 12]), (["Direct", "prev"], [110, 3]),
    ]),
    "eventName": ga4_rows([(["generate_lead", "now"], [6]), (["generate_lead", "prev"], [13]), (["scroll", "now"], [50])]),
}

GSC = {
    ("now", "query"): [
        gsc_row(["h1b visa fee"], 900, 36, 2.1),      # low CTR in the top 3
        gsc_row(["opt extension"], 400, 8, 7.5),      # near miss
        gsc_row(["eb2 niw timeline"], 220, 11, 5.2),  # near miss + rising
        gsc_row(["careerengine login"], 999, 400, 1.0),  # excluded (brand)
        gsc_row(["i140 premium processing"], 30, 0, 25.0),  # new, no page ranks for it yet
    ],
    ("prev", "query"): [gsc_row(["h1b visa fee"], 880, 35, 2.2), gsc_row(["opt extension"], 380, 8, 7.9)],
    ("now", "query", "page"): [
        gsc_row(["h1b visa fee", SITE + "/h1b-fee"], 850, 34, 2.0),
        gsc_row(["opt extension", SITE + "/opt"], 300, 6, 7.0),
        gsc_row(["opt extension", SITE + "/opt-stem"], 100, 2, 9.0),
        gsc_row(["eb2 niw timeline", SITE + "/eb2-niw"], 220, 11, 5.2),
    ],
}

SITEMAP = "<urlset><url><loc>%s/h1b-fee</loc></url><url><loc>%s/old-page</loc></url><url><loc>%s/opt</loc></url></urlset>" % (SITE, SITE, SITE)


def config(extra=None, sd=None):
    cfg = {
        "siteUrl": SITE, "gscProperty": "sc-domain:visa.careerengine.us", "ga4PropertyId": "42",
        "sitemapUrl": SITE + "/sitemap.xml", "exclusions": {"queries": ["careerengine"]},
        "signalDigest": dict({"project": "CE site", "ga4": {"conversionEvents": ["generate_lead"]}}, **(sd or {})),
    }
    cfg.update(extra or {})
    return SO.deep_merge(SO.DEFAULTS, cfg)


def net(**kw):
    pages = {SITE + "/sitemap.xml": SITEMAP, SITE + "/h1b-fee": "<html/>", SITE + "/opt": "<html/>"}
    return FakeNet(ga4=GA4, gsc=GSC, pages=pages, **kw)


class Collect(unittest.TestCase):
    def test_signals_and_ranked_candidates(self):
        out = D.collect(SO, config(), net(), TODAY)
        self.assertEqual(out["site"], "visa.careerengine.us")
        self.assertEqual(out["project"], "CE site")
        self.assertEqual(out["sources"], {"ga4": "ok", "gsc": "ok", "inbox": "not configured", "errors": "ok"})
        self.assertEqual(out["ga4"]["keyEvents"], {"now": 6, "prev": 13, "changePct": -53.8})
        self.assertEqual(out["ga4"]["organicSessions"], {"now": 300, "prev": 320, "changePct": -6.2})
        self.assertEqual([e["event"] for e in out["ga4"]["byEvent"]], ["generate_lead"])
        self.assertEqual([r["query"] for r in out["gsc"]["lowCtrTop3"]], ["h1b visa fee"])
        self.assertEqual(out["gsc"]["lowCtrTop3"][0]["page"], SITE + "/h1b-fee")
        self.assertNotIn("careerengine login", json.dumps(out["gsc"]))
        self.assertEqual(out["errors"]["brokenPages"], [{"url": SITE + "/old-page", "status": 404}])
        keys = [c["key"] for c in out["candidates"]]
        # The conversion drop outranks everything; every candidate is complete.
        self.assertEqual(keys[0], "ga4:key-events-drop")
        self.assertIn("gsc:low-ctr:h1b visa fee", keys)
        self.assertIn("gsc:near-miss:opt extension", keys)
        self.assertIn("errors:broken:/old-page", keys)
        self.assertIn("gsc:cannibal:opt extension", keys)
        # Rising queries the site already ranks for (or that another action covers) are not topics.
        self.assertNotIn("gsc:rising:h1b visa fee", keys)
        self.assertNotIn("gsc:rising:opt extension", keys)
        self.assertNotIn("gsc:rising:eb2 niw timeline", keys)  # its near-miss action covers it
        self.assertIn("gsc:rising:i140 premium processing", keys)
        for c in out["candidates"]:
            for f in ("key", "source", "signal", "proposal", "expectedEffect", "effort"):
                self.assertTrue(c[f], (c["key"], f))
            self.assertNotIn("subject", c)
        low = next(c for c in out["candidates"] if c["key"] == "gsc:low-ctr:h1b visa fee")
        self.assertIn("/h1b-fee", low["proposal"])
        self.assertRegex(low["expectedEffect"], r"CTR 4\.0% → ~16%: about \+\d+ clicks a week")

    def test_history_and_experiment_log_drop_drafts(self):
        history = {"success": True, "data": {"site": "visa.careerengine.us", "entries": [
            {"key": "GSC:Low-CTR:h1b visa fee", "status": "do", "at": "2026-09-30T12:00:00Z", "digestId": "SD-2"},
            {"key": "errors:broken:/old-page", "status": "skip", "at": "2026-10-01T12:00:00Z", "digestId": "SD-3"},
            {"key": "gsc:near-miss:eb2 niw timeline", "status": "open", "at": "2026-10-02T12:00:00Z", "digestId": "SD-4"},
        ]}}
        with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as f:
            f.write("## 2026-09-20 OPT Extension page rewrite\nResult: inconclusive\n")
        try:
            out = D.collect(SO, config(sd={"experimentLog": f.name}), net(), TODAY, history=history)
        finally:
            os.unlink(f.name)
        keys = [c["key"] for c in out["candidates"]]
        self.assertNotIn("gsc:low-ctr:h1b visa fee", keys)
        self.assertNotIn("errors:broken:/old-page", keys)
        self.assertNotIn("gsc:near-miss:opt extension", keys)
        self.assertIn("gsc:near-miss:eb2 niw timeline", keys)
        self.assertNotIn("gsc:rising:eb2 niw timeline", keys)  # the near-miss action covers it
        whys = {t["key"]: t["why"] for t in out["alreadyTried"]}
        self.assertEqual(whys["gsc:low-ctr:h1b visa fee"], "owner chose Do on 2026-09-30 (SD-2)")
        self.assertEqual(whys["errors:broken:/old-page"], "owner chose Skip on 2026-10-01 (SD-3)")
        self.assertEqual(whys["gsc:near-miss:opt extension"], "mentioned in the experiment log")
        # Open = still on the owner's card: reported, not blocked (the next digest replaces that card).
        self.assertEqual(out["pendingOnOwner"], [{"key": "gsc:near-miss:eb2 niw timeline", "digestId": "SD-4"}])

    def test_a_failing_source_is_reported_and_the_rest_still_runs(self):
        out = D.collect(SO, config(), net(fail_gsc=True), TODAY)
        self.assertTrue(out["sources"]["gsc"].startswith("error: sa@x is not authorized"))
        self.assertEqual(out["sources"]["ga4"], "ok")
        self.assertNotIn("gsc", out)
        self.assertEqual(out["candidates"][0]["key"], "ga4:key-events-drop")

    def test_an_unexpected_exception_in_one_source_does_not_kill_collect(self):
        out = D.collect(SO, config(), net(crash_ga4=KeyError("rows")), TODAY)
        self.assertEqual(out["sources"]["ga4"], "error: 'rows'")
        self.assertEqual(out["sources"]["gsc"], "ok")
        self.assertTrue(out["candidates"])
        out = D.collect(SO, config(), net(crash_ga4=RuntimeError()), TODAY)
        self.assertEqual(out["sources"]["ga4"], "error: RuntimeError")

    def test_sitemap_is_checked_in_rotating_slices(self):
        urls = ["%s/p%02d" % (SITE, i) for i in range(10)]
        self.assertEqual(D.sitemap_slice(urls, 20, TODAY), (urls, 0))
        seen, offsets = set(), []
        for d in range(4):
            got, offset = D.sitemap_slice(list(reversed(urls)), 3, TODAY + dt.timedelta(days=d))
            self.assertEqual(len(got), 3)
            seen.update(got)
            offsets.append(offset)
        self.assertEqual(len(set(offsets)), 4)  # a different slice each day
        self.assertEqual(seen, set(urls))  # the whole sitemap within ceil(10/3) = 4 days
        sm = "<urlset>%s</urlset>" % "".join("<url><loc>%s</loc></url>" % u for u in urls)
        n = net()
        n.pages[SITE + "/sitemap.xml"] = sm
        a = D.collect(SO, config(sd={"errors": {"maxUrls": 3}}), n, TODAY)["errors"]
        b = D.collect(SO, config(sd={"errors": {"maxUrls": 3}}), n, TODAY + dt.timedelta(days=1))["errors"]
        self.assertEqual((a["checked"], a["sitemapUrls"]), (3, 10))
        self.assertNotEqual(a["sitemapOffset"], b["sitemapOffset"])

    def test_inbox_summary_and_failure(self):
        inbox = {"query": "to:visa@", "count": 1, "messages": [{"from": "a@b", "subject": "H1B question", "date": "d", "snippet": "hi", "id": "x"}]}
        out = D.collect(SO, config(), net(), TODAY, inbox=inbox)
        self.assertEqual(out["inbox"], {"query": "to:visa@", "count": 1, "messages": [{"from": "a@b", "subject": "H1B question", "date": "d", "snippet": "hi"}]})
        bad = D.collect(SO, config(), net(), TODAY, inbox={"success": False, "reason": "not_connected", "message": "connect Google"})
        self.assertEqual(bad["sources"]["inbox"], "error: inbox search failed: not_connected connect Google")

    def test_js_errors_from_a_url(self):
        pages = {SITE + "/errs": json.dumps({"errors": [{"message": "TypeError: x is undefined", "count": 12, "url": SITE + "/form"}, {"message": "rare", "count": 1}]})}
        n = net()
        n.pages.update(pages)
        out = D.collect(SO, config(sd={"errors": {"checkSitemap": False, "url": SITE + "/errs"}}), n, TODAY)
        self.assertEqual(out["errors"]["jsErrors"][0], {"message": "TypeError: x is undefined", "count": 12, "url": SITE + "/form"})
        js = [c for c in out["candidates"] if c["key"].startswith("errors:js:")]
        self.assertEqual(js[0]["signal"], "JS error 'TypeError: x is undefined' ×12 on /form")

    def test_candidates_carry_the_experiment_a_do_creates(self):
        out = D.collect(SO, config(), net(), TODAY)
        by_key = {c["key"]: c for c in out["candidates"]}
        self.assertEqual(by_key["gsc:low-ctr:h1b visa fee"]["experiment"],
                         {"source": "gsc", "measure": "ctr", "query": "h1b visa fee", "page": SITE + "/h1b-fee"})
        self.assertEqual(by_key["gsc:near-miss:opt extension"]["experiment"]["measure"], "position")
        self.assertEqual(by_key["gsc:rising:i140 premium processing"]["experiment"], {"source": "gsc", "measure": "clicks", "query": "i140 premium processing"})
        # One configured conversion event → the drop is measured on it (as a key event), across all channels.
        self.assertEqual(by_key["ga4:key-events-drop"]["experiment"], {"source": "ga4", "measure": "conversions", "event": "generate_lead", "channel": "all"})
        self.assertNotIn("experiment", by_key["errors:broken:/old-page"])

    def test_two_conversion_events_measure_all_key_events(self):
        out = D.collect(SO, config(sd={"ga4": {"conversionEvents": ["generate_lead", "form_submit"]}}), net(), TODAY)
        drop = next(c for c in out["candidates"] if c["key"] == "ga4:key-events-drop")
        self.assertEqual(drop["experiment"], {"source": "ga4", "measure": "conversions", "channel": "all"})

    def test_experiment_cards_cover_their_query_and_page(self):
        experiments = {"success": True, "data": [
            {"id": "EXP-1", "status": "running", "metric": {"query": "Opt Extension"}, "updatedAt": "2026-10-01T00:00:00Z"},
            {"id": "EXP-2", "status": "done", "metric": {"page": SITE + "/h1b-fee"}, "updatedAt": "2026-09-20T00:00:00Z"},
            {"id": "EXP-3", "status": "done", "metric": {"query": "i140 premium processing"}, "updatedAt": "2026-05-01T00:00:00Z"},
            {"id": "EXP-4", "status": "cancelled", "metric": {"query": "eb2 niw timeline"}, "updatedAt": "2026-10-01T00:00:00Z"},
        ]}
        out = D.collect(SO, config(), net(), TODAY, experiments=experiments)
        keys = [c["key"] for c in out["candidates"]]
        whys = {t["key"]: t["why"] for t in out["alreadyTried"]}
        self.assertEqual(whys["gsc:near-miss:opt extension"], "experiment EXP-1 (running)")
        self.assertEqual(whys["gsc:cannibal:opt extension"], "experiment EXP-1 (running)")
        self.assertEqual(whys["gsc:low-ctr:h1b visa fee"], "experiment EXP-2 (done)")
        self.assertIn("gsc:rising:i140 premium processing", keys)  # finished more than 90 days ago
        self.assertIn("gsc:near-miss:eb2 niw timeline", keys)  # cancelled

    def test_ga4_host_filter(self):
        n = net()
        D.collect(SO, config(extra={"ga4HostName": "visa.careerengine.us"}), n, TODAY)
        self.assertTrue(n.ga4_bodies)
        for body in n.ga4_bodies:
            self.assertEqual(body["dimensionFilter"]["filter"]["stringFilter"]["value"], "visa.careerengine.us")
        n2 = net()
        D.collect(SO, config(), n2, TODAY)
        self.assertNotIn("dimensionFilter", n2.ga4_bodies[0])

    def test_sitemap_check_without_a_sitemap_is_not_configured(self):
        out = D.collect(SO, config(extra={"sitemapUrl": ""}), net(), TODAY)
        self.assertEqual(out["sources"]["errors"], "not configured")

    def test_nothing_configured(self):
        out = D.collect(SO, config(extra={"gscProperty": "", "ga4PropertyId": "", "sitemapUrl": ""}, sd={"errors": {"checkSitemap": False}}), net(), TODAY)
        self.assertEqual(set(out["sources"].values()), {"not configured"})
        self.assertEqual(out["candidates"], [])


class Helpers(unittest.TestCase):
    def test_site_from_site_url(self):
        self.assertEqual(D.digest_settings({"siteUrl": "https://example.com/x"})["site"], "example.com")
        with self.assertRaises(D.DigestError):
            D.digest_settings({})

    def test_parse_error_list(self):
        self.assertEqual(D.parse_error_list('[{"message":"a","count":2},{"nope":1},{"message":"b"}]'),
                         [{"message": "a", "count": 2}, {"message": "b", "count": 1}])
        with self.assertRaises(ValueError):
            D.parse_error_list('{"errors": 3}')

    def test_normalize_key_and_change(self):
        self.assertEqual(D.normalize_key("  GSC:Low   CTR "), "gsc:low ctr")
        self.assertIsNone(D.change_pct(5, 0))
        self.assertEqual(D.change_pct(50, 100), -50.0)

    def test_load_seo_ops_missing(self):
        with self.assertRaises(D.DigestError):
            D.load_seo_ops(["/nope/seo_ops.py"])


class Main(unittest.TestCase):
    def run_main(self, cfg, n):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(cfg, f)
        out, err = io.StringIO(), io.StringIO()
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = D.main(["collect", "--config", f.name], net=n, today=TODAY, so=SO)
        finally:
            os.unlink(f.name)
        return code, out.getvalue(), err.getvalue()

    def test_prints_json_and_exits_0(self):
        raw = {"siteUrl": SITE, "gscProperty": "sc-domain:x", "exclusions": {"queries": ["careerengine"]}, "signalDigest": {"errors": {"checkSitemap": False}}}
        code, out, _ = self.run_main(raw, net())
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["sources"]["gsc"], "ok")

    def test_exit_1_when_nothing_could_be_examined(self):
        code, out, err = self.run_main({"siteUrl": SITE, "signalDigest": {"errors": {"checkSitemap": False}}}, net())
        self.assertEqual(code, 1)
        self.assertIn("no source could be examined", err)
        self.assertEqual(json.loads(out)["candidates"], [])

    def test_exit_2_on_setup_problem(self):
        code, _, err = self.run_main({"gscProperty": "x"}, net())
        self.assertEqual(code, 2)
        self.assertIn("signalDigest.site", err)


if __name__ == "__main__":
    unittest.main()
