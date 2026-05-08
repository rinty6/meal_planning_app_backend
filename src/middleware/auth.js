import { verifyToken } from "@clerk/backend";
import { db } from "../config/db.js";
import { usersTable } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { ENV } from "../config/env.js";

const getBearerToken = (req) => {
  const raw = req.headers.authorization || "";
  if (!raw.startsWith("Bearer ")) return null;
  return raw.slice("Bearer ".length).trim();
};

const getClerkIdFallback = (req) => {
  const fromHeader = req.headers["x-clerk-id"];
  const fromBody = req.body?.clerkId;
  const fromParams = req.params?.clerkId;
  return String(fromHeader || fromBody || fromParams || "").trim() || null;
};

const shouldLogBootstrapAuth = (req) => {
  const requestPath = req.originalUrl || req.url || "";
  return requestPath.includes("/api/users/bootstrap");
};

const logBootstrapAuth = (req, payload) => {
  if (!shouldLogBootstrapAuth(req)) return;

  console.log("user.bootstrap.auth", {
    path: req.originalUrl || req.url || null,
    ...payload,
  });
};

export const requireClerkAuth = async (req, res, next) => {
  const authStartedAt = Date.now();

  try {
    const hasSecretKey =
      !!ENV.CLERK_SECRET_KEY && ENV.CLERK_SECRET_KEY.startsWith("sk_");
    const devFallbackAllowed = ENV.NODE_ENV !== "production";
    const fallbackClerkId = getClerkIdFallback(req);

    // Fallback for environments that do not provide a Clerk secret key.
    // This supports local/dev setups using only publishable key config.
    if (!hasSecretKey) {
      // Log missing production auth config without printing secrets.
      logBootstrapAuth(req, {
        phase: 'missing-secret-key',
        durationMs: Date.now() - authStartedAt,
        fallbackClerkIdPresent: !!fallbackClerkId,
      });

      if (!fallbackClerkId) {
        return res
          .status(401)
          .json({
            error:
              "Missing valid Clerk auth. Provide a Bearer token with CLERK_SECRET_KEY=sk_* or send x-clerk-id/body.clerkId/params.clerkId fallback.",
          });
      }

      req.auth = { clerkId: fallbackClerkId, sessionClaims: null, insecureFallback: true };
      return next();
    }

    const token = getBearerToken(req);
    logBootstrapAuth(req, {
      phase: 'verify-start',
      hasSecretKey,
      hasBearerToken: !!token,
      devFallbackAllowed,
    });

    if (!token && devFallbackAllowed && fallbackClerkId) {
      req.auth = { clerkId: fallbackClerkId, sessionClaims: null, insecureFallback: true };
      logBootstrapAuth(req, {
        phase: 'dev-fallback',
        durationMs: Date.now() - authStartedAt,
        fallbackClerkId,
      });
      return next();
    }
    if (!token) {
      logBootstrapAuth(req, {
        phase: 'missing-bearer-token',
        durationMs: Date.now() - authStartedAt,
      });
      return res.status(401).json({ error: "Missing Bearer token" });
    }

    try {
      const payload = await verifyToken(token, { secretKey: ENV.CLERK_SECRET_KEY });
      const clerkId = payload?.sub;
      if (!clerkId) {
        logBootstrapAuth(req, {
          phase: 'invalid-payload',
          durationMs: Date.now() - authStartedAt,
        });
        return res.status(401).json({ error: "Invalid auth token payload" });
      }

      req.auth = { clerkId, sessionClaims: payload };
      logBootstrapAuth(req, {
        phase: 'verify-success',
        durationMs: Date.now() - authStartedAt,
        clerkId,
      });
      return next();
    } catch (verifyError) {
      if (devFallbackAllowed && fallbackClerkId) {
        console.warn("Clerk verify failed in dev. Falling back to clerkId header/body/params.");
        req.auth = { clerkId: fallbackClerkId, sessionClaims: null, insecureFallback: true };
        logBootstrapAuth(req, {
          phase: 'dev-fallback-after-verify-error',
          durationMs: Date.now() - authStartedAt,
          fallbackClerkId,
          error: verifyError?.message || 'Unknown verify error',
        });
        return next();
      }
      logBootstrapAuth(req, {
        phase: 'verify-error',
        durationMs: Date.now() - authStartedAt,
        error: verifyError?.message || 'Unknown verify error',
      });
      console.error("Clerk auth verify error:", verifyError);
      return res.status(401).json({ error: "Unauthorized" });
    }
  } catch (error) {
    logBootstrapAuth(req, {
      phase: 'auth-exception',
      durationMs: Date.now() - authStartedAt,
      error: error?.message || 'Unknown auth exception',
    });
    console.error("Clerk auth error:", error);
    return res.status(401).json({ error: "Unauthorized" });
  }
};

export const attachUserFromAuth = async (req, res, next) => {
  try {
    if (!req.auth?.clerkId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const users = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.clerkId, req.auth.clerkId))
      .limit(1);

    if (users.length === 0) {
      return res.status(404).json({
        error: "User not found",
        code: "USER_NOT_BOOTSTRAPPED",
      });
    }

    req.dbUser = users[0];
    next();
  } catch (error) {
    console.error("Attach user error:", error);
    return res.status(500).json({ error: "Server error" });
  }
};

export const ensureClerkIdMatch = (source = "params") => (req, res, next) => {
  const providedClerkId =
    source === "body" ? req.body?.clerkId : req.params?.clerkId;

  if (!providedClerkId) {
    return res.status(400).json({ error: "Missing clerkId" });
  }

  if (String(providedClerkId) !== String(req.auth?.clerkId)) {
    return res.status(403).json({ error: "Forbidden: clerkId mismatch" });
  }

  next();
};
