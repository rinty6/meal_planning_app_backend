/**
 * /api/catalog — read-only routes over the self-owned food & recipe catalogue
 * (catalog_* tables in Neon). First consumer: the Add Food modal
 * (meal_app/api/addFood/). Replaces the FatSecret proxy in routes/fatsecret.js
 * one consumer at a time; that file stays until its last importer is gone.
 *
 *   GET /foods/search?q=&segment=&segment=&source=&limit=&offset=
 *   GET /foods/barcode/:code
 *   POST /barcode/reports
 *
 * Auth: requireClerkAuth on every route (decided 2026-09-18, checklist p0-07):
 * the app is login-only, per-user identity makes the rate bucket fair under
 * carrier NAT, and it keeps the 49k-row catalogue from being scraped
 * anonymously. The ODbL bulk-export endpoint (DB plan p0-05) is the legal
 * channel for bulk access, not this search.
 *
 * Rate limiting is mounted in server.js, BEFORE this router: a request the
 * catalogSearch cache can already answer goes to cachedContentLimiter, a miss
 * to catalogLimiter (ERROR_LOG 065: never charge a cache hit full price).
 * canServeCatalogRequestFromCache() below is that probe; it MUST parse the
 * request with the same parseSearchParams the handler uses.
 *
 * Failures are distinguishable so the client can render the honest state
 * (ERROR_LOG 063): 400 bad input, 401 from auth, 429 from the limiter with
 * Retry-After, 503 { retryable: true } when the database is unreachable,
 * 500 otherwise. An empty result is a 200 with items: [].
 */

import express from "express";

import { requireClerkAuth } from "../middleware/auth.js";
import {
  hasCachedBarcodeLookup,
  lookupBarcode,
  parseBarcodeParams,
} from "../services/catalogBarcode.js";
import { parseReport, submitReport } from "../services/barcodeReports.js";
import {
  hasCachedCatalogSearch,
  parseSearchParams,
  searchCatalogFoods,
} from "../services/catalogSearch.js";

const catalogRoutes = express.Router();

// Search results change only when the catalogue is re-imported, so iOS
// NSURLCache may hold them for 10 minutes; repeats of the same query then
// cost no request at all. Same window the FatSecret proxy used.
const SEARCH_RESULT_CACHE_HEADER = "private, max-age=600";

// Express gives a repeated query key (?segment=a&segment=b) as an array and a
// single one as a string; parseSearchParams accepts both.
const searchInputFromRequest = (req) => ({
  q: req.query.q ?? req.query.query,
  segment: req.query.segment,
  source: req.query.source,
  limit: req.query.limit,
  offset: req.query.offset,
});

// "/foods/barcode/9310072010816" -> "9310072010816"
const BARCODE_PATH = /^\/foods\/barcode\/([^/]+)$/;
const REPORTS_PATH = "/barcode/reports";

/**
 * Report submissions get their own bucket in server.js rather than the
 * read-side catalogue one: this is a write that also sends an email, and the
 * two must not be able to starve each other (ERROR_LOG 063).
 */
export const isBarcodeReportRequest = (req) =>
  String(req.method || "").toUpperCase() === "POST" && String(req.path || "") === REPORTS_PATH;

/** Limiter probe, mounted in server.js. req.path is relative to /api/catalog. */
export const canServeCatalogRequestFromCache = (req) => {
  const path = String(req.path || "");

  if (path === "/foods/search") {
    const parsed = parseSearchParams(searchInputFromRequest(req));
    if (!parsed.ok) return true; // handler 400s without touching the database
    return hasCachedCatalogSearch(parsed.params);
  }

  const barcode = path.match(BARCODE_PATH);
  if (barcode) {
    const parsed = parseBarcodeParams({ code: decodeURIComponent(barcode[1]) });
    if (!parsed.ok) return true;
    return hasCachedBarcodeLookup(parsed.params);
  }

  return true; // anything else 404s cheaply
};

// Neon/driver failures that mean "try again shortly", not "bad request".
const isDatabaseUnavailable = (error) => {
  const code = String(error?.code ?? error?.cause?.code ?? "");
  if (["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "57P01", "57P02", "57P03", "53300"].includes(code)) {
    return true;
  }
  const message = String(error?.message ?? error?.cause?.message ?? "").toLowerCase();
  return message.includes("fetch failed") || message.includes("timeout") || message.includes("connection");
};

catalogRoutes.get("/foods/search", requireClerkAuth, async (req, res) => {
  const parsed = parseSearchParams(searchInputFromRequest(req));
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error });
  }

  try {
    const { cached, ...result } = await searchCatalogFoods(parsed.params);
    res.set("Cache-Control", SEARCH_RESULT_CACHE_HEADER);
    return res.status(200).json({ ...result, meta: { ...result.meta, cached } });
  } catch (error) {
    console.error("Catalog food search route error:", error);
    if (isDatabaseUnavailable(error)) {
      return res.status(503).json({ error: "Food catalogue is temporarily unavailable.", retryable: true });
    }
    return res.status(500).json({ error: "Food search failed.", retryable: false });
  }
});

/**
 * A barcode we do not hold is a 200 with found: false, NOT a 404 (checklist
 * b1-07). The client maps a 404 to a failure kind, and the scanner would then
 * show "something went wrong" where the label-report form belongs. Only a real
 * failure gets a failure status here.
 */
catalogRoutes.get("/foods/barcode/:code", requireClerkAuth, async (req, res) => {
  const parsed = parseBarcodeParams({ code: req.params.code });
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error });
  }

  try {
    const { cached, ...result } = await lookupBarcode(parsed.params);
    res.set("Cache-Control", SEARCH_RESULT_CACHE_HEADER);
    return res.status(200).json({ ...result, meta: { cached } });
  } catch (error) {
    console.error("Catalog barcode lookup route error:", error);
    if (isDatabaseUnavailable(error)) {
      return res.status(503).json({ error: "Food catalogue is temporarily unavailable.", retryable: true });
    }
    return res.status(500).json({ error: "Barcode lookup failed.", retryable: false });
  }
});

/**
 * A label report: what a user typed off a pack we do not hold.
 *
 * 201 on a first report, 200 when it corrects one they already sent. The
 * client ignores both and ignores every failure here too: their food is
 * already in their meal log by the time this runs, and a problem with our
 * inbox is not theirs to solve (checklist b0-09). We still answer honestly so
 * the failure is visible in logs and in tests.
 */
catalogRoutes.post("/barcode/reports", requireClerkAuth, async (req, res) => {
  // requireClerkAuth sets req.auth.clerkId (verified token, or the dev
  // fallback). Never read the reporter from the body: it is the one field a
  // client must not be able to choose for itself.
  const reportedBy = req.auth?.clerkId;
  const parsed = parseReport(req.body, { reportedBy });
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error });
  }

  try {
    const { report, created, notified } = await submitReport(parsed.report);
    return res.status(created ? 201 : 200).json({
      report: { id: report.id, barcode: report.barcode, status: report.status },
      created,
      notified,
    });
  } catch (error) {
    console.error("Barcode report route error:", error);
    if (isDatabaseUnavailable(error)) {
      return res.status(503).json({ error: "Could not save that report right now.", retryable: true });
    }
    return res.status(500).json({ error: "Could not save that report.", retryable: false });
  }
});

export default catalogRoutes;
