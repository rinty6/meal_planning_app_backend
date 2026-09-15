// Diagnostic: send a real Expo push to your stored device token(s) and print
// the Expo tickets + receipts. This isolates the DELIVERY layer (Expo + APNs)
// from the cron/recipient-selection layer that Errors 028 and 040 already touched.
//
// Usage (run from the backend/ folder so it picks up backend/.env):
//   node scripts/test-push.js                 -> sends to EVERY token in user_devices
//   node scripts/test-push.js <clerkId>       -> sends only to that user's devices
//   node scripts/test-push.js --token "ExponentPushToken[xxx]"  -> sends to a raw token, no DB needed
//
// Optional: set EXPO_ACCESS_TOKEN in .env if the Expo project has
// "Enhanced Security for Push Notifications" enabled.

import "dotenv/config";
import { Expo } from "expo-server-sdk";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadTokensFromDb(clerkId) {
  const { db } = await import("../src/config/db.js");
  const { userDevicesTable, usersTable } = await import("../src/db/schema.js");
  const { eq } = await import("drizzle-orm");

  if (clerkId) {
    const rows = await db
      .select({
        pushToken: userDevicesTable.pushToken,
        platform: userDevicesTable.platform,
        updatedAt: userDevicesTable.updatedAt,
        clerkId: usersTable.clerkId,
      })
      .from(userDevicesTable)
      .innerJoin(usersTable, eq(userDevicesTable.userId, usersTable.userId))
      .where(eq(usersTable.clerkId, clerkId));
    return rows;
  }

  return db
    .select({
      pushToken: userDevicesTable.pushToken,
      platform: userDevicesTable.platform,
      updatedAt: userDevicesTable.updatedAt,
    })
    .from(userDevicesTable);
}

async function main() {
  const args = process.argv.slice(2);
  const tokenFlagIdx = args.indexOf("--token");
  const rawToken = tokenFlagIdx >= 0 ? args[tokenFlagIdx + 1] : null;
  const clerkId = !rawToken && args[0] && !args[0].startsWith("--") ? args[0] : null;

  const accessToken = process.env.EXPO_ACCESS_TOKEN || undefined;
  const expo = new Expo(accessToken ? { accessToken } : undefined);
  console.log("[test-push] Expo access token present:", Boolean(accessToken));

  let deviceRows;
  if (rawToken) {
    deviceRows = [{ pushToken: rawToken, platform: "manual", updatedAt: null }];
  } else {
    deviceRows = await loadTokensFromDb(clerkId);
  }

  console.log(`[test-push] Found ${deviceRows.length} device row(s)${clerkId ? ` for clerkId=${clerkId}` : ""}.`);
  for (const row of deviceRows) {
    const t = String(row.pushToken || "");
    const masked = t.length > 24 ? `${t.slice(0, 18)}...${t.slice(-6)}` : t;
    console.log(
      `  - platform=${row.platform} updatedAt=${row.updatedAt} valid=${Expo.isExpoPushToken(t)} token=${masked}`
    );
  }

  const messages = deviceRows
    .filter((r) => Expo.isExpoPushToken(r.pushToken))
    .map((r) => ({
      to: r.pushToken,
      sound: "default",
      title: "GoodHealthMate test push",
      body: `Delivery test at ${new Date().toLocaleTimeString()}`,
      data: { type: "diagnostic_test" },
    }));

  if (!messages.length) {
    console.log("[test-push] No valid Expo tokens to send to. Stopping. (Invalid-format tokens are the problem.)");
    process.exit(0);
  }

  const chunks = expo.chunkPushNotifications(messages);
  const ticketIds = [];
  const ticketIdToToken = new Map();

  for (const chunk of chunks) {
    const tickets = await expo.sendPushNotificationsAsync(chunk);
    tickets.forEach((ticket, idx) => {
      const token = chunk[idx]?.to;
      console.log("[test-push] TICKET:", JSON.stringify(ticket));
      if (ticket.status === "ok" && ticket.id) {
        ticketIds.push(ticket.id);
        ticketIdToToken.set(ticket.id, token);
      }
    });
  }

  if (!ticketIds.length) {
    console.log("[test-push] No 'ok' tickets returned -> Expo rejected the send at submit time. See TICKET errors above.");
    process.exit(0);
  }

  console.log("[test-push] Waiting 3s for receipts...");
  await sleep(3000);

  const receiptChunks = expo.chunkPushNotificationReceiptIds(ticketIds);
  for (const chunk of receiptChunks) {
    const receipts = await expo.getPushNotificationReceiptsAsync(chunk);
    for (const [id, receipt] of Object.entries(receipts)) {
      console.log("[test-push] RECEIPT:", id, JSON.stringify(receipt));
    }
  }

  console.log("[test-push] Done. 'ok' receipt = Expo handed it to APNs/FCM. An error receipt names the real delivery failure.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[test-push] FAILED:", err);
  process.exit(1);
});
