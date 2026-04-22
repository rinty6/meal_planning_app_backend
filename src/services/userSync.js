import { createClerkClient } from "@clerk/backend";
import { eq, or } from "drizzle-orm";

import { db } from "../config/db.js";
import { ENV } from "../config/env.js";
import { demographicsTable, usersTable } from "../db/schema.js";

let clerkClientInstance = null;

export const cleanText = (value) => String(value ?? "").trim();

const cleanMetadataValue = (value) => {
  if (typeof value === "string") return cleanText(value);
  return "";
};

const getClerkClient = () => {
  if (clerkClientInstance) return clerkClientInstance;

  if (!ENV.CLERK_SECRET_KEY || !ENV.CLERK_SECRET_KEY.startsWith("sk_")) {
    throw new Error("Missing valid CLERK_SECRET_KEY for server-side bootstrap.");
  }

  clerkClientInstance = createClerkClient({
    secretKey: ENV.CLERK_SECRET_KEY,
  });

  return clerkClientInstance;
};

const getMetadataName = (metadata) => {
  const candidateKeys = [
    "preferredName",
    "enteredName",
    "fullName",
    "name",
    "username",
  ];

  for (const key of candidateKeys) {
    const value = cleanMetadataValue(metadata?.[key]);
    if (value) return value;
  }

  return "";
};

export const deriveUsername = ({
  username,
  metadataName,
  fullName,
  firstName,
  email,
  clerkId,
}) => {
  const normalizedUsername = cleanText(username);
  if (normalizedUsername) return normalizedUsername;

  const normalizedMetadataName = cleanText(metadataName);
  if (normalizedMetadataName) return normalizedMetadataName;

  const normalizedFullName = cleanText(fullName);
  if (normalizedFullName) return normalizedFullName;

  const normalizedFirstName = cleanText(firstName);
  if (normalizedFirstName) return normalizedFirstName;

  const emailPrefix = cleanText(email).toLowerCase().split("@")[0];
  if (emailPrefix) return emailPrefix;

  const normalizedClerkId = cleanText(clerkId);
  if (normalizedClerkId) return `user-${normalizedClerkId.slice(-6)}`;

  return "New User";
};

export const normalizeIdentity = ({
  clerkId,
  email,
  username,
  metadataName,
  fullName,
  firstName,
}) => ({
  clerkId: cleanText(clerkId),
  email: cleanText(email).toLowerCase(),
  username: deriveUsername({
    username,
    metadataName,
    fullName,
    firstName,
    email,
    clerkId,
  }),
});

export const getUserByClerkId = async (clerkId) => {
  const normalizedClerkId = cleanText(clerkId);
  if (!normalizedClerkId) return null;

  const users = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.clerkId, normalizedClerkId))
    .limit(1);

  return users[0] || null;
};

export const getUserByEmail = async (email) => {
  const normalizedEmail = cleanText(email).toLowerCase();
  if (!normalizedEmail) return null;

  const users = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, normalizedEmail))
    .limit(1);

  return users[0] || null;
};

export const getUserByIdentity = async ({ clerkId, email }) => {
  const normalizedClerkId = cleanText(clerkId);
  const normalizedEmail = cleanText(email).toLowerCase();

  if (!normalizedClerkId && !normalizedEmail) return null;

  const clauses = [];
  if (normalizedClerkId) clauses.push(eq(usersTable.clerkId, normalizedClerkId));
  if (normalizedEmail) clauses.push(eq(usersTable.email, normalizedEmail));

  const users = await db
    .select()
    .from(usersTable)
    .where(clauses.length === 1 ? clauses[0] : or(...clauses))
    .limit(1);

  return users[0] || null;
};

export const getHasOnboarded = async (userId) => {
  if (!userId) return false;

  const demographics = await db
    .select()
    .from(demographicsTable)
    .where(eq(demographicsTable.userId, userId))
    .limit(1);

  return demographics.length > 0;
};

const recoverUserAfterWriteFailure = async ({ clerkId, email }) => {
  const recoveredUser = await getUserByIdentity({ clerkId, email });
  if (!recoveredUser) return null;

  return {
    ok: true,
    status: 200,
    action: "recovered",
    user: recoveredUser,
  };
};

export const syncUserRecord = async ({
  clerkId,
  email,
  username,
  metadataName,
  fullName,
  firstName,
}) => {
  const normalized = normalizeIdentity({
    clerkId,
    email,
    username,
    metadataName,
    fullName,
    firstName,
  });

  if (!normalized.clerkId || !normalized.email) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_IDENTITY",
      error: "Missing required fields (clerkId or email).",
      user: null,
    };
  }

  try {
    const [existingByClerkId, existingByEmail] = await Promise.all([
      getUserByClerkId(normalized.clerkId),
      getUserByEmail(normalized.email),
    ]);

    if (
      existingByClerkId &&
      existingByEmail &&
      existingByClerkId.userId !== existingByEmail.userId
    ) {
      return {
        ok: false,
        status: 409,
        code: "USER_IDENTITY_CONFLICT",
        error:
          "Conflicting user records found for this Clerk ID and email. Manual cleanup is required.",
        user: null,
      };
    }

    if (existingByClerkId || existingByEmail) {
      const existingUser = existingByClerkId || existingByEmail;
      const action =
        !existingByClerkId && existingByEmail
          ? "linked"
          : existingByClerkId && existingByClerkId.email !== normalized.email
            ? "updated"
            : "existing";

      const needsUpdate =
        existingUser.clerkId !== normalized.clerkId ||
        existingUser.email !== normalized.email ||
        existingUser.username !== normalized.username;

      if (!needsUpdate) {
        return {
          ok: true,
          status: 200,
          action: "existing",
          user: existingUser,
        };
      }

      const updatedUsers = await db
        .update(usersTable)
        .set({
          clerkId: normalized.clerkId,
          email: normalized.email,
          username: normalized.username,
        })
        .where(eq(usersTable.userId, existingUser.userId))
        .returning();

      return {
        ok: true,
        status: 200,
        action,
        user: updatedUsers[0],
      };
    }

    const insertedUsers = await db
      .insert(usersTable)
      .values({
        clerkId: normalized.clerkId,
        email: normalized.email,
        username: normalized.username,
      })
      .returning();

    return {
      ok: true,
      status: 201,
      action: "created",
      user: insertedUsers[0],
    };
  } catch (error) {
    const recovered = await recoverUserAfterWriteFailure({
      clerkId: normalized.clerkId,
      email: normalized.email,
    });

    if (recovered) return recovered;

    throw error;
  }
};

const getPrimaryEmailAddress = (clerkUser) => {
  const primaryEmail =
    clerkUser?.emailAddresses?.find(
      (item) => item?.id === clerkUser?.primaryEmailAddressId
    )?.emailAddress || clerkUser?.emailAddresses?.[0]?.emailAddress;

  return cleanText(primaryEmail).toLowerCase();
};

export const resolveClerkIdentity = async (clerkId) => {
  const normalizedClerkId = cleanText(clerkId);
  if (!normalizedClerkId) {
    return {
      ok: false,
      status: 400,
      code: "MISSING_CLERK_ID",
      error: "Missing Clerk user id.",
    };
  }

  try {
    const clerkUser = await getClerkClient().users.getUser(normalizedClerkId);
    const email = getPrimaryEmailAddress(clerkUser);

    if (!email) {
      return {
        ok: false,
        status: 422,
        code: "PRIMARY_EMAIL_REQUIRED",
        error: "The authenticated Clerk user does not have a primary email address.",
      };
    }

    const fullName = [cleanText(clerkUser.firstName), cleanText(clerkUser.lastName)]
      .filter(Boolean)
      .join(" ");

    const metadataName = getMetadataName(clerkUser.unsafeMetadata);

    return {
      ok: true,
      status: 200,
      identity: {
        clerkId: normalizedClerkId,
        email,
        username: cleanText(clerkUser.username),
        metadataName,
        fullName,
        firstName: cleanText(clerkUser.firstName),
      },
      clerkUser,
    };
  } catch (error) {
    const isMissingServerConfig =
      String(error?.message || "").includes("CLERK_SECRET_KEY");
    const status = Number(error?.status) || Number(error?.errors?.[0]?.meta?.status) || 502;

    return {
      ok: false,
      status: isMissingServerConfig ? 500 : status,
      code: isMissingServerConfig
        ? "CLERK_SERVER_UNAVAILABLE"
        : status === 404
          ? "CLERK_USER_NOT_FOUND"
          : "CLERK_LOOKUP_FAILED",
      error:
        error?.errors?.[0]?.message ||
        error?.message ||
        "Failed to load the authenticated user from Clerk.",
    };
  }
};

export const bootstrapUserFromClerkId = async (clerkId) => {
  const identityResult = await resolveClerkIdentity(clerkId);
  if (!identityResult.ok) {
    return identityResult;
  }

  const syncResult = await syncUserRecord(identityResult.identity);
  if (!syncResult.ok) {
    return {
      ...syncResult,
      identity: identityResult.identity,
    };
  }

  const hasOnboarded = await getHasOnboarded(syncResult.user?.userId);

  return {
    ok: true,
    status: syncResult.status,
    action: syncResult.action,
    user: syncResult.user,
    identity: identityResult.identity,
    hasOnboarded,
  };
};
