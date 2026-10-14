import { describe, expect, it } from 'vitest';
import { demoLoginSchema } from '../../src/modules/auth/auth.schemas.js';
import { createRefreshToken } from '../../src/modules/auth/token.service.js';

describe('public recruiter demo access boundaries', () => {
  it('accepts only attendee and organizer role selectors, never caller-supplied identity', () => {
    expect(demoLoginSchema.safeParse({ role: 'ATTENDEE' }).success).toBe(true);
    expect(demoLoginSchema.safeParse({ role: 'ORGANIZER' }).success).toBe(true);
    expect(demoLoginSchema.safeParse({ role: 'ADMIN' }).success).toBe(false);
    expect(demoLoginSchema.safeParse({ role: 'ATTENDEE', email: 'owner@example.com' }).success).toBe(false);
    expect(demoLoginSchema.safeParse({ role: 'ATTENDEE', accountId: 'owner-id' }).success).toBe(false);
  });

  it('issues independent refresh-token families for separate visitors', () => {
    const first = createRefreshToken();
    const second = createRefreshToken();
    expect(first.familyId).not.toBe(second.familyId);
    expect(first.token).not.toBe(second.token);
  });
});
