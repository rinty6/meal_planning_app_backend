export const createSingleFlight = ({ normalizeKey } = {}) => {
  const inFlight = new Map();

  return async (key, work) => {
    const normalizedKey = normalizeKey ? normalizeKey(key) : key;

    if (!normalizedKey) {
      return work();
    }

    const existing = inFlight.get(normalizedKey);
    if (existing) {
      return existing;
    }

    // Reuse the same in-flight work so duplicate callers do not race each other.
    const pending = Promise.resolve().then(() => work());
    inFlight.set(normalizedKey, pending);

    try {
      return await pending;
    } finally {
      if (inFlight.get(normalizedKey) === pending) {
        inFlight.delete(normalizedKey);
      }
    }
  };
};