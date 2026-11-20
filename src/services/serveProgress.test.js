// Coverage for task T5 (2026-11-21, m6-03): the serve progress endpoint,
// behind SERVE_PROGRESS. Throwaway sprint test (checklist m7-06).
import test from "node:test";
import assert from "node:assert/strict";

import { buildServeProgress, isServeProgressEnabled, serveProgressGate } from "./serveProgress.js";

/** A db that fails the test if anything touches it. */
const untouchableDb = () => new Proxy({}, {
  get: (_t, key) => {
    throw new Error(`the database was touched (${String(key)})`);
  },
});

const fakeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (code) => ((res.statusCode = code), res);
  res.json = (body) => ((res.body = body), res);
  return res;
};

test("only SERVE_PROGRESS=on enables it", () => {
  assert.equal(isServeProgressEnabled({ SERVE_PROGRESS: "on" }), true);
  assert.equal(isServeProgressEnabled({ SERVE_PROGRESS: " ON " }), true);
  for (const value of [undefined, "", "off", "true", "1"]) {
    assert.equal(isServeProgressEnabled({ SERVE_PROGRESS: value }), false, String(value));
  }
});

test("flag off: 404 Not enabled, and nothing after the gate runs", () => {
  const res = fakeRes();
  let nextCalled = false;
  const req = { db: untouchableDb() };
  serveProgressGate({})(req, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: "Not enabled" });
  assert.equal(nextCalled, false);
});

test("flag on: the gate passes the request on", () => {
  let nextCalled = false;
  serveProgressGate({ SERVE_PROGRESS: "on" })({}, fakeRes(), () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test("flag read per request: turning it on later needs no restart", () => {
  const env = {};
  const gate = serveProgressGate(env);
  const first = fakeRes();
  gate({}, first, () => {});
  assert.equal(first.statusCode, 404);
  env.SERVE_PROGRESS = "on";
  let nextCalled = false;
  gate({}, fakeRes(), () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test("the body: targets, eaten, rows and rows without serves", async () => {
  const porridge = {
    publicId: "food_porridge", per100g: { calories_kcal: 100 },
    serves100g: { grain: 0.5, vegetable: 0, fruit: 0, dairy: 0.4, protein: 0 },
  };
  const logs = [
    { mealType: "breakfast", calories: 300, externalId: "food_porridge", source: "catalog" },
    { mealType: "lunch", calories: 450, externalId: "12345", source: "fatsecret" },
  ];
  const seen = [];
  const body = await buildServeProgress({
    db: { fake: true },
    userId: 7,
    dateStr: "2026-11-21",
    getTargetContext: async (args) => (seen.push(["target", args.userId, args.dateStr]),
      { serveTargets: { vegetable: 5, fruit: 2, grain: 6, protein: 2.5, dairy: 2.5, row: "woman_19_50" } }),
    getPool: async () => [porridge],
    readLogs: async (args) => (seen.push(["logs", args.userId, args.dateStr]), logs),
  });
  assert.deepEqual(body, {
    date: "2026-11-21",
    targets: { vegetable: 5, fruit: 2, grain: 6, protein: 2.5, dairy: 2.5 },
    eaten: { vegetable: 0, fruit: 0, grain: 1.5, protein: 0, dairy: 1.2 },
    rowsWithoutServes: 1,
    rows: 2,
  });
  assert.deepEqual(seen.sort(), [["logs", 7, "2026-11-21"], ["target", 7, "2026-11-21"]]);
});
