import { describe, expect, it } from 'vitest';
import { demoLoginSchema } from '../../src/modules/auth/auth.schemas.js';
import { isQuickAccessAccount, quickAccessEmail } from '../../src/shared/security/quick-access.js';

describe('production quick-access boundaries', () => {
  it('never accepts public admin or caller-selected identities', () => {
    expect(demoLoginSchema.safeParse({ role: 'ADMIN' }).success).toBe(false);
    expect(
      demoLoginSchema.safeParse({ role: 'ATTENDEE', email: 'owner@example.com' }).success,
    ).toBe(false);
    expect(demoLoginSchema.safeParse({ role: 'ORGANIZER' }).success).toBe(true);
  });
  it('protects only the configured shared accounts with matching roles', () => {
    const email = quickAccessEmail('ATTENDEE');
    expect(isQuickAccessAccount({ email, role: 'ATTENDEE' })).toBe(true);
    expect(isQuickAccessAccount({ email, role: 'ADMIN' })).toBe(false);
    expect(isQuickAccessAccount({ email: 'ordinary@example.com', role: 'ATTENDEE' })).toBe(false);
  });
});
