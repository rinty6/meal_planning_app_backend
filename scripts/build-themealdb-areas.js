// Offline precompute: which TheMealDB areas actually have recipes (+ counts).
//
// TheMealDB's list.php?a=list returns ~192 geographic countries, but only ~29
// have any recipes under our premier key. Probing all 192 at runtime is both
// slow and blocked by our rate limiter, so we derive the real set ONCE here and
// commit the result. The backend serves /api/themealdb/areas straight from this
// file. Re-run after TheMealDB adds cuisines:  node scripts/build-themealdb-areas.js
//
// Reads MEALDB_API_KEY from backend/.env (falls back to the public test key "1").

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const readKey = () => {
  if (process.env.MEALDB_API_KEY) return process.env.MEALDB_API_KEY.trim();
  try {
    const env = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
    const m = env.match(/^\s*MEALDB_API_KEY\s*=\s*"?([^"\n\r]+)"?/m);
    if (m) return m[1].trim();
  } catch { /* no .env */ }
  return "1";
};

const KEY = readKey();
const VERSION = KEY === "1" ? "v1" : "v2";
const BASE = `https://www.themealdb.com/api/json/${VERSION}/${KEY}`;

const getJson = async (url) => {
  const resp = await fetch(url, { headers: { "User-Agent": "GoodHealthMate/1.0" } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.json();
};

const mapWithConcurrency = async (items, limit, fn) => {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
};

const main = async () => {
  console.log(`Probing TheMealDB areas (${KEY === "1" ? "test" : "premier"} key)...`);
  const list = await getJson(`${BASE}/list.php?a=list`);
  const names = [...new Set(
    (list.meals || [])
      .map((m) => String(m.strArea || "").trim())
      .filter((a) => a && a !== "Unknown")
  )].sort();

  // Be gentle: TheMealDB throttles bursts. Low concurrency + exponential backoff.
  const counts = await mapWithConcurrency(names, 3, async (area) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const d = await getJson(`${BASE}/filter.php?a=${encodeURIComponent(area)}`);
        return { area, count: Array.isArray(d.meals) ? d.meals.length : 0 };
      } catch {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    return { area, count: -1 };
  });

  const errors = counts.filter((c) => c.count < 0).map((c) => c.area);
  if (errors.length) throw new Error(`Failed to probe: ${errors.join(", ")}`);

  const areas = counts.filter((c) => c.count > 0).sort((a, b) => a.area.localeCompare(b.area));
  const payload = {
    generatedAt: new Date().toISOString(),
    source: "themealdb",
    totalAreasListed: names.length,
    areas,
  };

  const outDir = path.join(ROOT, "src", "data");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "themealdb_areas.json");
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${areas.length} cuisines (of ${names.length} listed) -> ${outFile}`);
};

main().catch((e) => { console.error(e); process.exit(1); });
