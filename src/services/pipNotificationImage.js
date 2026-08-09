// Maps a Pip emotional state to the public URL of its still image.
//
// A push notification cannot carry a picture: APNs caps the payload near 4KB,
// so what ships is a URL that the phone's OS fetches for itself. That fetch
// happens outside our app and without a Clerk session, which is why these live
// on an unauthenticated static route (server.js -> /pip) rather than behind the
// API.
//
// The PNGs are committed at backend/public/pip/. They are stills, not
// animations — a notification banner is drawn by the OS and cannot run the
// Reanimated rig. Source SVGs and the regeneration method are in
// claude_memory/bird_symbol/rig_reference/notification_stills/.

import { ENV } from "../config/env.js";

/** The four states that have artwork. Anything else has no image, by design. */
export const PIP_IMAGE_STATES = ["sad", "happy", "care", "confident"];

/**
 * @param {string} state one of PIP_IMAGE_STATES
 * @returns {string|null} absolute URL, or null when there is no artwork for
 *   this state or no public origin is configured (local dev). Callers must
 *   treat null as "send it as text" — the image is decoration, never the
 *   message.
 */
export const getPipImageUrl = (state) => {
  if (!ENV.PUBLIC_BASE_URL) return null;
  if (!PIP_IMAGE_STATES.includes(state)) return null;
  return `${ENV.PUBLIC_BASE_URL}/pip/${state}.png`;
};
