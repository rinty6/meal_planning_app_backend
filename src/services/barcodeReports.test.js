/**
 * Label reports: validation, the upsert, and the promise that a dead mail
 * provider cannot cost a user their report.
 *
 *   node --test src/services/barcodeReports.test.js
 *
 * The upsert tests write to the live Neon table named by ENV.DB_URL and clean
 * up after themselves; they use a reporter id no human has.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { db } from "../config/db.js";
import {
  buildReportEmail,
  notifyReport,
  parseReport,
  saveReport,
  submitReport,
} from "./barcodeReports.js";

const REPORTER = "user_test_barcode_reports";
const BARCODE = "9999999999999";

const input = (overrides = {}) => ({
  barcode: BARCODE,
  barcodeType: "EAN13",
  productName: "Rice Crackers",
  brand: "Want Want",
  servingSize: 30,
  servingUnit: "g",
  energyKj: 470,
  proteinG: 3.3,
  carbohydrateG: 76.7,
  fatG: 16.7,
  ...overrides,
});

const parse = (overrides = {}, context = { reportedBy: REPORTER }) =>
  parseReport(input(overrides), context);

after(async () => {
  await db.execute(sql`delete from catalog_barcode_reports where reported_by = ${REPORTER}`);
});

// --- validation (no database) ----------------------------------------------

test("a complete report parses into a row", () => {
  const result = parse();
  assert.equal(result.ok, true, result.error);
  assert.equal(result.report.barcode, BARCODE);
  assert.equal(result.report.productName, "Rice Crackers");
  assert.equal(result.report.servingUnit, "g");
  assert.equal(result.report.reportedBy, REPORTER);
});

test("snake_case input from the client is accepted too", () => {
  const result = parseReport(
    { barcode: BARCODE, product_name: "Rice Crackers", serving_size: "30", energy_kj: "470", app_version: "1.4.0" },
    { reportedBy: REPORTER },
  );
  assert.equal(result.ok, true, result.error);
  assert.equal(result.report.energyKj, 470);
  assert.equal(result.report.appVersion, "1.4.0");
});

test("the three required fields are required", () => {
  assert.equal(parse({ productName: "   " }).ok, false);
  assert.equal(parse({ servingSize: null }).ok, false);
  assert.equal(parse({ energyKj: "" }).ok, false);
  assert.equal(parse({ barcode: "12" }).ok, false);
});

test("an optional macro may be left out but not be nonsense", () => {
  assert.equal(parse({ proteinG: null }).ok, true, "a blank optional field is fine");
  assert.equal(parse({ proteinG: "" }).ok, true);
  assert.equal(parse({ proteinG: "abc" }).ok, false, "a value that was typed must be a number");
  assert.equal(parse({ proteinG: -1 }).ok, false);
});

test("a panel no label could carry is rejected", () => {
  assert.equal(parse({ energyKj: 90000 }).ok, false, "20,000 kJ is already five times the densest 100 g");
  assert.equal(parse({ servingSize: 0 }).ok, false);
  assert.equal(parse({ servingSize: 9000 }).ok, false);
});

test("serving unit is g or ml, nothing else", () => {
  assert.equal(parse({ servingUnit: "ml" }).ok, true);
  assert.equal(parse({ servingUnit: "ML" }).ok, true);
  assert.equal(parse({ servingUnit: "cups" }).ok, false);
});

test("the reporter comes from auth, never from the body", () => {
  assert.equal(parseReport(input(), {}).ok, false, "no reporter, no report");
  const spoofed = parseReport({ ...input(), reportedBy: "user_someone_else" }, { reportedBy: REPORTER });
  assert.equal(spoofed.report.reportedBy, REPORTER);
});

test("a photo URL must be one we issued, not merely a URL", () => {
  // It is rendered as a link in the mail we send ourselves, so an arbitrary
  // host is not acceptable just because it parses.
  assert.equal(parse({ photoUrl: "https://res.cloudinary.com/ghm/image/upload/v1/panel.jpg" }).ok, true);
  assert.equal(parse({ photoUrl: "https://example.com/panel.jpg" }).ok, false);
  assert.equal(parse({ photoUrl: "http://res.cloudinary.com/ghm/panel.jpg" }).ok, false, "https only");
  assert.equal(parse({ photoUrl: "javascript:alert(1)" }).ok, false);
  assert.equal(parse({ photoUrl: "https://res.cloudinary.com.evil.test/panel.jpg" }).ok, false, "suffix, not substring");
  assert.equal(parse({ photoUrl: null }).ok, true);
});

test("text fields are trimmed and capped", () => {
  const { report } = parse({ productName: `  Rice   Crackers  ${"x".repeat(400)}` });
  assert.equal(report.productName.length, 200);
  assert.ok(report.productName.startsWith("Rice Crackers"));
});

// --- storage ---------------------------------------------------------------

test("a first report inserts, a second from the same person corrects it", async () => {
  await db.execute(sql`delete from catalog_barcode_reports where reported_by = ${REPORTER}`);

  const first = await saveReport(parse().report);
  assert.equal(first.created, true);
  assert.equal(first.report.status, "new");

  const second = await saveReport(parse({ productName: "Rice Crackers Original", energyKj: 480 }).report);
  assert.equal(second.created, false, "same barcode + same reporter is one row");
  assert.equal(second.report.id, first.report.id);

  const rows = await db.execute(
    sql`select product_name, energy_kj::float8 as energy_kj, count(*) over ()::int as n
        from catalog_barcode_reports where reported_by = ${REPORTER}`,
  );
  const list = rows?.rows ?? rows;
  assert.equal(list.length, 1);
  assert.equal(list[0].product_name, "Rice Crackers Original");
  assert.equal(list[0].energy_kj, 480);
});

test("a correction goes back to 'new' so an old verdict is not inherited", async () => {
  await db.execute(
    sql`update catalog_barcode_reports set status = 'rejected' where reported_by = ${REPORTER}`,
  );
  const again = await saveReport(parse().report);
  assert.equal(again.report.status, "new");
});

test("two different people reporting the same pack make two rows", async () => {
  const other = `${REPORTER}_2`;
  try {
    const mine = await saveReport(parse().report);
    const theirs = await saveReport(parse({}, { reportedBy: other }).report);
    assert.notEqual(mine.report.id, theirs.report.id);
    // Agreement between strangers is the signal we review on; it must survive.
    const rows = await db.execute(
      sql`select count(*)::int as n from catalog_barcode_reports where barcode = ${BARCODE}`,
    );
    assert.ok(((rows?.rows ?? rows)[0].n) >= 2);
  } finally {
    await db.execute(sql`delete from catalog_barcode_reports where reported_by = ${other}`);
  }
});

// --- notification ----------------------------------------------------------

test("the email names the product, the barcode and every value", () => {
  const { subject, html } = buildReportEmail(parse().report, { id: 42 });
  assert.match(subject, /Rice Crackers/);
  assert.match(subject, new RegExp(BARCODE));
  assert.match(html, /470/);
  assert.match(html, /Report #42/);
  assert.match(html, /No panel photo attached/);
});

test("the email escapes what the user typed", () => {
  const { html } = buildReportEmail(parse({ productName: "<script>alert(1)</script>" }).report, { id: 1 });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("a mail provider that throws or errors never throws at the caller", async () => {
  const throwing = () => ({ emails: { send: () => Promise.reject(new Error("resend down")) } });
  const erroring = () => ({ emails: { send: () => Promise.resolve({ error: { message: "bad key" } }) } });
  for (const resendFactory of [throwing, erroring]) {
    assert.equal(await notifyReport(parse().report, { id: 1 }, { resendFactory }), false);
  }
});

test("submitReport stores the report even when the email fails", async () => {
  await db.execute(sql`delete from catalog_barcode_reports where reported_by = ${REPORTER}`);
  const result = await submitReport(parse().report, {
    resendFactory: () => ({ emails: { send: () => Promise.reject(new Error("down")) } }),
  });
  assert.equal(result.created, true);
  assert.equal(result.notified, false, "the report survived; only the bell did not ring");
  assert.ok(result.report.id > 0);
});

test("a correction does not ring the bell a second time", async () => {
  let sends = 0;
  const resendFactory = () => ({ emails: { send: () => { sends += 1; return Promise.resolve({ data: { id: "x" } }); } } });
  await db.execute(sql`delete from catalog_barcode_reports where reported_by = ${REPORTER}`);

  const first = await submitReport(parse().report, { resendFactory });
  assert.equal(first.created, true);
  assert.equal(first.notified, true);

  const second = await submitReport(parse({ energyKj: 475 }).report, { resendFactory });
  assert.equal(second.created, false);
  assert.equal(second.notified, false);
  assert.equal(sends, 1);
});
