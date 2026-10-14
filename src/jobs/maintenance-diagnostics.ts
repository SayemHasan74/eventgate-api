export const maintenanceFailureSummary = (stage: string, error: unknown): string => {
  const failure = error as
    | {
        name?: unknown;
        code?: unknown;
        meta?: { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } };
      }
    | null
    | undefined;
  const identifiers = [
    failure?.name,
    failure?.code,
    failure?.meta?.code,
    failure?.meta?.driverAdapterError?.cause?.originalCode,
  ].filter(
    (value): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value),
  );
  // Persist diagnostic identifiers, never provider payloads or error messages.
  return `Maintenance failed during ${stage} (${[...new Set(identifiers)].join('/') || 'unknown error'}).`.slice(
    0,
    255,
  );
};
