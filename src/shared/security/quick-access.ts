import { env } from '../../config/env.js';

export const quickAccessEmail = (role: 'ATTENDEE' | 'ORGANIZER'): string =>
  role === 'ATTENDEE'
    ? (env.DEMO_ATTENDEE_EMAIL ?? 'demo.attendee@eventgate.invalid')
    : (env.DEMO_ORGANIZER_EMAIL ?? 'demo.organizer@eventgate.invalid');

export const isQuickAccessAccount = (
  user: { email?: string; role?: string } | null | undefined,
): boolean =>
  !!user?.email &&
  (user.role === 'ATTENDEE' || user.role === 'ORGANIZER') &&
  user.email.toLowerCase() === quickAccessEmail(user.role).toLowerCase();
