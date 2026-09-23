/**
 * Label reports from the barcode scanner (checklist b2-03 … b2-05). A user met
 * a pack we do not hold, typed what the label says, and sent it. This file
 * validates that claim, stores it, and tells the owner one report arrived.
 *
 * Two rules shape everything here:
 *
 *   1. A report is a CLAIM, not data. It lands in catalog_barcode_reports with
 *      status 'new' and never touches catalog_foods. Rejecting an impossible
 *      panel at this boundary is what keeps the review queue worth reading:
 *      the same physiological ceilings the importer uses (tools/off_extract/
 *      extract.py) apply, so a typo cannot become a food.
 *   2. Sending the report must NEVER be able to break the user's own meal log
 *      (checklist b0-09). The route that calls this returns the stored row and
 *      nothing else; the email is fire-and-forget and a dead mail provider is
 *      logged, not thrown. The client, in turn, treats a failed report as
 *      silent: their food is already logged and there is nothing for them to
 *      do about our inbox.
 *
 * Energy arrives and is stored in kJ, exactly as typed, because that is what
 * an Australian label prints. Converting on the way in would hide a typo
 * behind a rounding, and the reviewer needs to see what the person saw.
 *
 * REVIEWING REPORTS (checklist b2-07). There is no admin page yet, on purpose:
 * reports nobody reads are worse than no reports, and a page nobody needs is
 * worse still. Until the volume justifies one, this is the queue.
 *
 *   -- what is waiting, oldest first
 *   select id, created_at::date as day, barcode, product_name, brand,
 *          serving_size || ' ' || serving_unit as serving,
 *          energy_kj, protein_g, carbohydrate_g, fat_g, photo_url
 *     from catalog_barcode_reports
 *    where status = 'new'
 *    order by created_at;
 *
 *   -- packs more than one person has reported: strangers agreeing is the
 *   -- strongest signal we get, and a disagreement is worth a closer look
 *   select barcode, count(*) as reports, count(distinct reported_by) as people,
 *          round(stddev_pop(energy_kj), 1) as energy_spread,
 *          array_agg(distinct product_name) as names
 *     from catalog_barcode_reports
 *    group by barcode having count(distinct reported_by) > 1
 *    order by people desc;
 *
 *   -- after acting on one
 *   update catalog_barcode_reports
 *      set status = 'added', review_note = 'imported 2026-09-23', updated_at = now()
 *    where id = $1;   -- 'rejected' when the numbers did not hold up
 *
 * A report never edits catalog_foods by itself. Adding the product means a
 * normal import run, with the report as the evidence.
 */

import { Resend } from "resend";
import { sql } from "drizzle-orm";

import { db } from "../config/db.js";
import { ENV } from "../config/env.js";
import { catalogBarcodeReportsTable } from "../db/food_schema.js";
import { normalizeBarcode, BARCODE_MIN_LENGTH } from "./catalogBarcode.js";

const MAX_TEXT = { productName: 200, brand: 120, appVersion: 40, barcodeType: 20 };
const SERVING_UNITS = new Set(["g", "ml"]);

// A serving panel is per serving, not per 100 g, so these are generous: a
// 5,000 g serving is not a food, and 20,000 kJ is about five times the most
// energy-dense 100 g that exists. Anything past them is a typo or a joke.
const LIMITS = {
  servingSize: { min: 0.1, max: 5000 },
  energyKj: { min: 0, max: 20000 },
  proteinG: { min: 0, max: 5000 },
  carbohydrateG: { min: 0, max: 5000 },
  fatG: { min: 0, max: 5000 },
};

const UPLOAD_HOST = "res.cloudinary.com";

const isUploadedImageUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === UPLOAD_HOST || url.hostname.endsWith(`.${UPLOAD_HOST}`));
  } catch {
    return false;
  }
};

const text = (value, max) => {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, max);
};

const numberOrNull = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN; // NaN marks "given but unusable"
};

/**
 * Turn raw request input into a row, or explain why it cannot be one.
 * @returns {{ ok: true, report: object } | { ok: false, error: string }}
 */
export const parseReport = (input = {}, context = {}) => {
  const barcode = normalizeBarcode(input.barcode ?? input.code);
  if (barcode.length < BARCODE_MIN_LENGTH) {
    return { ok: false, error: "That does not look like a barcode." };
  }

  const productName = text(input.productName ?? input.product_name, MAX_TEXT.productName);
  if (!productName) return { ok: false, error: "Product name is required." };

  const numeric = {
    servingSize: numberOrNull(input.servingSize ?? input.serving_size),
    energyKj: numberOrNull(input.energyKj ?? input.energy_kj),
    proteinG: numberOrNull(input.proteinG ?? input.protein_g),
    carbohydrateG: numberOrNull(input.carbohydrateG ?? input.carbohydrate_g),
    fatG: numberOrNull(input.fatG ?? input.fat_g),
  };

  for (const field of ["servingSize", "energyKj"]) {
    if (numeric[field] === null) {
      return { ok: false, error: field === "servingSize" ? "Serving size is required." : "Energy is required." };
    }
  }

  for (const [field, value] of Object.entries(numeric)) {
    if (value === null) continue;
    const { min, max } = LIMITS[field];
    if (Number.isNaN(value) || value < min || value > max) {
      return { ok: false, error: `${field} is not a number a food label would carry.` };
    }
  }

  const servingUnit = String(input.servingUnit ?? input.serving_unit ?? "g").trim().toLowerCase();
  if (!SERVING_UNITS.has(servingUnit)) {
    return { ok: false, error: "Serving unit must be g or ml." };
  }

  const reportedBy = text(context.reportedBy, 120);
  if (!reportedBy) return { ok: false, error: "Missing reporter." };

  // The photo URL is rendered as a link in the email we send ourselves, so it
  // must be one WE issued, not merely something that parses as a URL. Only an
  // https Cloudinary asset qualifies, which is what POST /api/favorites/
  // upload-image returns for folder "barcode-reports".
  const photoUrl = text(input.photoUrl ?? input.photo_url, 2048);
  if (photoUrl && !isUploadedImageUrl(photoUrl)) {
    return { ok: false, error: "Photo must be an image uploaded through the app." };
  }

  return {
    ok: true,
    report: {
      barcode,
      barcodeType: text(input.barcodeType ?? input.barcode_type, MAX_TEXT.barcodeType),
      productName,
      brand: text(input.brand, MAX_TEXT.brand),
      servingSize: numeric.servingSize,
      servingUnit,
      energyKj: numeric.energyKj,
      proteinG: numeric.proteinG,
      carbohydrateG: numeric.carbohydrateG,
      fatG: numeric.fatG,
      photoUrl,
      reportedBy,
      appVersion: text(input.appVersion ?? input.app_version, MAX_TEXT.appVersion),
    },
  };
};

const toNumeric = (value) => (value === null || value === undefined ? null : String(value));

/**
 * Store the claim. A second send from the same person for the same pack
 * corrects their first rather than piling up; the row goes back to 'new' so a
 * correction is reviewed again rather than inheriting an old verdict.
 * @returns {Promise<{ report: object, created: boolean }>}
 */
export const saveReport = async (report) => {
  const rows = await db
    .insert(catalogBarcodeReportsTable)
    .values({
      barcode: report.barcode,
      barcodeType: report.barcodeType,
      productName: report.productName,
      brand: report.brand,
      servingSize: toNumeric(report.servingSize),
      servingUnit: report.servingUnit,
      energyKj: toNumeric(report.energyKj),
      proteinG: toNumeric(report.proteinG),
      carbohydrateG: toNumeric(report.carbohydrateG),
      fatG: toNumeric(report.fatG),
      photoUrl: report.photoUrl,
      reportedBy: report.reportedBy,
      appVersion: report.appVersion,
    })
    .onConflictDoUpdate({
      target: [catalogBarcodeReportsTable.barcode, catalogBarcodeReportsTable.reportedBy],
      set: {
        barcodeType: sql`excluded.barcode_type`,
        productName: sql`excluded.product_name`,
        brand: sql`excluded.brand`,
        servingSize: sql`excluded.serving_size`,
        servingUnit: sql`excluded.serving_unit`,
        energyKj: sql`excluded.energy_kj`,
        proteinG: sql`excluded.protein_g`,
        carbohydrateG: sql`excluded.carbohydrate_g`,
        fatG: sql`excluded.fat_g`,
        photoUrl: sql`excluded.photo_url`,
        appVersion: sql`excluded.app_version`,
        status: sql`'new'`,
        reviewNote: sql`null`,
        updatedAt: sql`now()`,
      },
    })
    .returning({
      id: catalogBarcodeReportsTable.id,
      barcode: catalogBarcodeReportsTable.barcode,
      status: catalogBarcodeReportsTable.status,
      createdAt: catalogBarcodeReportsTable.createdAt,
      updatedAt: catalogBarcodeReportsTable.updatedAt,
    });

  const saved = rows[0];
  // created_at survives the update, so equal timestamps mean a fresh insert.
  const created = Number(new Date(saved.createdAt)) === Number(new Date(saved.updatedAt));
  return { report: saved, created };
};

// ---------------------------------------------------------------------------
// Notification
// ---------------------------------------------------------------------------

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export const buildReportEmail = (report, saved) => {
  const row = (label, value, unit = "") =>
    `<tr><td style="padding:4px 12px 4px 0;color:#6B7280">${escapeHtml(label)}</td>` +
    `<td style="padding:4px 0;font-weight:600">${value === null || value === undefined ? "&mdash;" : escapeHtml(value) + unit}</td></tr>`;

  return {
    subject: `Barcode report: ${report.productName} (${report.barcode})`,
    html: [
      `<h2 style="margin:0 0 4px">${escapeHtml(report.productName)}</h2>`,
      `<p style="margin:0 0 12px;color:#6B7280">Report #${saved.id} &middot; barcode ${escapeHtml(report.barcode)}</p>`,
      '<table style="border-collapse:collapse;font-family:system-ui,sans-serif;font-size:14px">',
      row("Brand", report.brand),
      row("Serving", `${report.servingSize} ${report.servingUnit}`),
      row("Energy", report.energyKj, " kJ"),
      row("Protein", report.proteinG, " g"),
      row("Carbs", report.carbohydrateG, " g"),
      row("Fat", report.fatG, " g"),
      row("Reported by", report.reportedBy),
      row("App version", report.appVersion),
      "</table>",
      report.photoUrl
        ? `<p style="margin:14px 0 0"><a href="${escapeHtml(report.photoUrl)}">Photo of the nutrition panel</a></p>`
        : '<p style="margin:14px 0 0;color:#B45309">No panel photo attached.</p>',
      `<p style="margin:16px 0 0;color:#6B7280;font-size:12px">Review: select * from catalog_barcode_reports where id = ${saved.id};</p>`,
    ].join("\n"),
  };
};

/**
 * Tell the owner. Fire-and-forget by contract: every failure path here returns
 * false instead of throwing, because a mail outage must not cost a user their
 * report (b2-05).
 */
export const notifyReport = async (report, saved, { resendFactory = (key) => new Resend(key) } = {}) => {
  const apiKey = String(ENV.RESEND_API_KEY ?? "").trim();
  const from = String(ENV.FEEDBACK_FROM_EMAIL ?? "").trim();
  const to = String(ENV.FEEDBACK_TO_EMAIL ?? "").trim();
  if (!apiKey || !from || !to) return false;

  try {
    const { subject, html } = buildReportEmail(report, saved);
    const { error } = await resendFactory(apiKey).emails.send({ from, to: [to], subject, html });
    if (error) {
      console.warn("Barcode report email failed:", error?.message ?? error);
      return false;
    }
    return true;
  } catch (error) {
    console.warn("Barcode report email threw:", error?.message ?? error);
    return false;
  }
};

/**
 * Store, then notify only on a first report for that person and pack: a
 * correction should not ring the bell twice.
 */
export const submitReport = async (report, options = {}) => {
  const { report: saved, created } = await saveReport(report);
  const notified = created ? await notifyReport(report, saved, options) : false;
  return { report: saved, created, notified };
};
