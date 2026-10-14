const jsonBody = (example: unknown) => ({
  required: true,
  content: { 'application/json': { schema: { type: 'object' }, example } },
});

const pathUuid = (name: string, example: string) => ({
  name,
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
  example,
});

const bearer = [{ bearerAuth: [] }];
const demoEventId = 'bad631ad-8f0c-41a1-8a4d-8831e35bed66';
const demoTierId = '15250b48-3a01-48cc-9095-adf2eb310a1d';
const demoOrderId = '30fdbaa8-10c8-404c-b015-15845ae9f2ba';
const demoRefundId = 'f99ff45a-098f-41b8-a62f-374ca4a2a9da';

export const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'EventGate API',
    version: '1.0.0',
    description:
      'Event ticketing, verified payments, QR admission, refunds, and role-based administration. Use the Try it out buttons from top to bottom for the video walkthrough.',
  },
  servers: [{ url: '/api/v1', description: 'Current server' }],
  tags: [
    { name: '01 Health' },
    { name: '02 Authentication' },
    { name: '03 Public discovery' },
    { name: '04 Organizer lifecycle' },
    { name: '05 Orders and payment' },
    { name: '06 Tickets and check-in' },
    { name: '07 Refunds' },
    { name: '08 Reports' },
    { name: '09 Preferences and recommendations' },
  ],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          message: { type: 'string' },
          errors: { type: 'array', items: { type: 'object' } },
        },
      },
    },
  },
  paths: {
    '/health/live': {
      get: {
        tags: ['01 Health'],
        summary: 'Liveness check',
        responses: { '200': { description: 'Service is live' } },
      },
    },
    '/health/ready': {
      get: {
        tags: ['01 Health'],
        summary: 'Database readiness check',
        responses: {
          '200': { description: 'Database connected and ready' },
          '503': { description: 'Database unavailable' },
        },
      },
    },
    '/auth/register': {
      post: {
        tags: ['02 Authentication'],
        summary: 'Register attendee',
        requestBody: jsonBody({
          email: 'video.attendee@example.com',
          displayName: 'Video Attendee',
          password: 'CorrectHorseBattery1',
        }),
        responses: {
          '201': { description: 'Registered' },
          '400': { description: 'Validation error' },
        },
      },
    },
    '/auth/login': {
      post: {
        tags: ['02 Authentication'],
        summary: 'Password login',
        requestBody: jsonBody({
          email: 'attendee@eventgate.local',
          password: 'cc88e5bf3bb34de0e07866f7',
        }),
        responses: {
          '200': { description: 'Access and refresh tokens issued' },
          '401': { description: 'Invalid credentials' },
          '403': { description: 'Browser origin is not allowed by CORS' },
        },
      },
    },
    '/auth/google': {
      post: {
        tags: ['02 Authentication'],
        summary: 'Login with Google ID token',
        requestBody: jsonBody({ idToken: 'PASTE_GOOGLE_ID_TOKEN_HERE' }),
        responses: {
          '200': { description: 'Tokens issued' },
          '401': { description: 'Invalid Google token' },
        },
      },
    },
    '/auth/refresh': {
      post: {
        tags: ['02 Authentication'],
        summary: 'Rotate refresh token',
        requestBody: jsonBody({ refreshToken: 'PASTE_REFRESH_TOKEN_FROM_LOGIN_HERE' }),
        responses: {
          '200': { description: 'Rotated tokens' },
          '401': { description: 'Invalid or reused token' },
        },
      },
    },
    '/auth/logout': {
      post: {
        tags: ['02 Authentication'],
        summary: 'Revoke refresh session',
        requestBody: jsonBody({ refreshToken: 'PASTE_REFRESH_TOKEN_HERE' }),
        responses: {
          '204': { description: 'Logged out' },
          '401': { description: 'Invalid token' },
        },
      },
    },
    '/events': {
      get: {
        tags: ['03 Public discovery'],
        summary: 'Browse published events',
        parameters: [
          { name: 'search', in: 'query', schema: { type: 'string' }, example: 'launch' },
          { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 }, example: 1 },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 100 },
            example: 20,
          },
        ],
        responses: { '200': { description: 'Paginated public event list' } },
      },
    },
    '/events/{slug}': {
      get: {
        tags: ['03 Public discovery'],
        summary: 'Read public event detail',
        parameters: [
          {
            name: 'slug',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            example: 'eventgate-launch-demo',
          },
        ],
        responses: {
          '200': { description: 'Event with available ticket tiers' },
          '404': { description: 'Not found' },
        },
      },
    },
    '/events/recommended': {
      get: {
        tags: ['09 Preferences and recommendations'],
        summary: 'Read private attendee recommendations',
        description:
          'Authenticated ATTENDEE only. Private no-store response; limit is 1–12, default 6. Ranking uses explicit preferences and saved upcoming event categories only.',
        security: bearer,
        parameters: [
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 12, default: 6 },
          },
        ],
        responses: {
          '200': {
            description: 'Recommended events with a truthful explanation and current sale state',
          },
          '401': { description: 'Authentication required' },
          '403': { description: 'Attendee role required' },
          '429': { description: 'Rate limit exceeded' },
          '503': { description: 'Database temporarily unavailable' },
        },
      },
    },
    '/users/me/event-preferences': {
      get: {
        tags: ['09 Preferences and recommendations'],
        summary: 'Read event preference profile and current category/city options',
        security: bearer,
        responses: {
          '200': { description: 'Private no-store preference profile' },
          '401': { description: 'Authentication required' },
          '403': { description: 'Attendee role required' },
          '429': { description: 'Rate limit exceeded' },
          '503': { description: 'Database temporarily unavailable' },
        },
      },
      patch: {
        tags: ['09 Preferences and recommendations'],
        summary: 'Save explicit event preferences',
        description:
          'Provide preferredCity (existing distinct city or null), up to five existing category values, and personalizationEnabled. Categories and cities match case-insensitively.',
        security: bearer,
        requestBody: jsonBody({
          preferredCity: 'Dhaka',
          preferredCategories: ['Music'],
          personalizationEnabled: true,
        }),
        responses: {
          '200': { description: 'Saved private preference profile' },
          '400': { description: 'Invalid category/city or more than five categories' },
          '401': { description: 'Authentication required' },
          '403': { description: 'Attendee role required' },
          '429': { description: 'Rate limit exceeded' },
          '503': { description: 'Database temporarily unavailable' },
        },
      },
    },
    '/organizer/events': {
      get: {
        tags: ['04 Organizer lifecycle'],
        summary: 'List managed events',
        security: bearer,
        responses: { '200': { description: 'Events' } },
      },
      post: {
        tags: ['04 Organizer lifecycle'],
        summary: 'Create draft event (ORGANIZER/ADMIN)',
        security: bearer,
        requestBody: jsonBody({
          title: 'EventGate Launch',
          slug: 'eventgate-launch-demo',
          description: 'A demonstration event for the EventGate ticketing platform.',
          category: 'Technology',
          venue: 'Main Hall',
          city: 'Dhaka',
          address: '123 Demo Road',
          startAt: '2030-01-10T10:00:00.000Z',
          endAt: '2030-01-10T14:00:00.000Z',
          imageUrl: null,
        }),
        responses: {
          '201': { description: 'Draft created' },
          '400': { description: 'Validation error' },
        },
      },
    },
    '/organizer/events/{eventId}': {
      patch: {
        tags: ['04 Organizer lifecycle'],
        summary: 'Update an event',
        security: bearer,
        parameters: [pathUuid('eventId', demoEventId)],
        requestBody: jsonBody({ title: 'Updated EventGate Launch', venue: 'Main Hall' }),
        responses: { '200': { description: 'Updated' }, '403': { description: 'Forbidden' } },
      },
      delete: {
        tags: ['04 Organizer lifecycle'],
        summary: 'Soft-delete an event',
        security: bearer,
        parameters: [pathUuid('eventId', demoEventId)],
        responses: { '204': { description: 'Deleted' }, '403': { description: 'Forbidden' } },
      },
    },
    '/organizer/events/{eventId}/publish': {
      post: {
        tags: ['04 Organizer lifecycle'],
        summary: 'Publish event',
        security: bearer,
        parameters: [pathUuid('eventId', demoEventId)],
        responses: {
          '200': { description: 'Published' },
          '409': { description: 'Invalid lifecycle transition' },
        },
      },
    },
    '/organizer/events/{eventId}/cancel': {
      post: {
        tags: ['04 Organizer lifecycle'],
        summary: 'Cancel event',
        security: bearer,
        parameters: [pathUuid('eventId', demoEventId)],
        responses: { '200': { description: 'Cancellation requested' } },
      },
    },
    '/organizer/events/{eventId}/ticket-tiers': {
      post: {
        tags: ['04 Organizer lifecycle'],
        summary: 'Create ticket tier',
        security: bearer,
        parameters: [pathUuid('eventId', demoEventId)],
        requestBody: jsonBody({
          name: 'General Admission',
          pricePaisa: 50000,
          capacity: 100,
          salesStartAt: '2029-12-01T00:00:00.000Z',
          salesEndAt: '2030-01-09T23:59:59.000Z',
        }),
        responses: {
          '201': { description: 'Tier created' },
          '400': { description: 'Validation error' },
        },
      },
    },
    '/organizer/events/{eventId}/ticket-tiers/{tierId}': {
      patch: {
        tags: ['04 Organizer lifecycle'],
        summary: 'Update ticket tier',
        security: bearer,
        parameters: [pathUuid('eventId', demoEventId), pathUuid('tierId', demoTierId)],
        requestBody: jsonBody({ pricePaisa: 60000, capacity: 100 }),
        responses: { '200': { description: 'Updated' } },
      },
      delete: {
        tags: ['04 Organizer lifecycle'],
        summary: 'Delete ticket tier',
        security: bearer,
        parameters: [pathUuid('eventId', demoEventId), pathUuid('tierId', demoTierId)],
        responses: { '204': { description: 'Deleted' } },
      },
    },
    '/orders': {
      post: {
        tags: ['05 Orders and payment'],
        summary: 'Reserve tickets (ATTENDEE)',
        security: bearer,
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            schema: { type: 'string' },
            example: 'video-order-001',
          },
        ],
        requestBody: jsonBody({ ticketTierId: demoTierId, quantity: 1 }),
        responses: {
          '201': { description: 'Order reserved' },
          '409': { description: 'Inventory or idempotency conflict' },
        },
      },
      get: {
        tags: ['05 Orders and payment'],
        summary: 'List own orders',
        security: bearer,
        parameters: [
          { name: 'page', in: 'query', schema: { type: 'integer' }, example: 1 },
          { name: 'limit', in: 'query', schema: { type: 'integer' }, example: 20 },
          {
            name: 'status',
            in: 'query',
            schema: { type: 'string', enum: ['PENDING_PAYMENT', 'PAID', 'CANCELLED', 'REFUNDED'] },
            example: 'PAID',
          },
        ],
        responses: { '200': { description: 'Orders' } },
      },
    },
    '/orders/{orderId}': {
      get: {
        tags: ['05 Orders and payment'],
        summary: 'Read one order',
        security: bearer,
        parameters: [pathUuid('orderId', demoOrderId)],
        responses: { '200': { description: 'Order detail' }, '404': { description: 'Not found' } },
      },
    },
    '/orders/{orderId}/cancel': {
      post: {
        tags: ['05 Orders and payment'],
        summary: 'Cancel pending order',
        security: bearer,
        parameters: [pathUuid('orderId', demoOrderId)],
        responses: {
          '200': { description: 'Cancelled' },
          '409': { description: 'Order cannot be cancelled' },
        },
      },
    },
    '/payments/orders/{orderId}/checkout': {
      post: {
        tags: ['05 Orders and payment'],
        summary: 'Start hosted SSLCommerz checkout',
        security: bearer,
        parameters: [
          pathUuid('orderId', demoOrderId),
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            schema: { type: 'string' },
            example: 'video-payment-001',
          },
        ],
        responses: {
          '200': {
            description:
              'AVAILABLE: persisted safe checkout URL and expiry; same key replays without another provider call',
          },
          '202': {
            description:
              'PROCESSING: paymentAttemptId, paymentStatus and owner-only statusPath; do not create another payment while uncertain',
          },
          '409': { description: 'Different payload reused the key, or the order is not payable' },
          '503': { description: 'Gateway unavailable' },
        },
      },
    },
    '/tickets': {
      get: {
        tags: ['06 Tickets and check-in'],
        summary: 'List own tickets',
        security: bearer,
        responses: { '200': { description: 'Tickets' } },
      },
    },
    '/tickets/{ticketId}': {
      get: {
        tags: ['06 Tickets and check-in'],
        summary: 'Read own ticket',
        security: bearer,
        parameters: [pathUuid('ticketId', 'PASTE_TICKET_ID_FROM_PAID_ORDER')],
        responses: { '200': { description: 'Ticket' }, '404': { description: 'Not found' } },
      },
    },
    '/payments/attempts/{attemptId}': {
      get: {
        tags: ['05 Payments'],
        summary: 'Read own payment attempt state without provider credentials',
        security: bearer,
        parameters: [pathUuid('attemptId', 'PASTE_PAYMENT_ATTEMPT_ID')],
        responses: {
          '200': { description: 'Safe attempt in a JSON envelope; private,no-store' },
          '404': { description: 'Not owned or unavailable' },
        },
      },
    },
    '/tickets/{ticketId}/qr': {
      get: {
        tags: ['06 Tickets and check-in'],
        summary: 'Get own private QR PNG in a JSON envelope',
        security: bearer,
        parameters: [pathUuid('ticketId', 'PASTE_TICKET_ID_FROM_PAID_ORDER')],
        responses: {
          '200': {
            description:
              'Private, no-store JSON PNG QR. The browser BFF uses the same contract; deploy both revisions together.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['success', 'message', 'data'],
                  properties: {
                    success: { type: 'boolean', enum: [true] },
                    message: { type: 'string' },
                    data: {
                      type: 'object',
                      required: ['ticketId', 'mimeType', 'dataUrl'],
                      properties: {
                        ticketId: { type: 'string', format: 'uuid' },
                        mimeType: { type: 'string', enum: ['image/png'] },
                        dataUrl: {
                          type: 'string',
                          pattern: '^data:image/png;base64,',
                          description: 'PNG data URL, never the raw QR credential',
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '404': { description: 'Not owned or unavailable' },
        },
      },
    },
    '/organizer/events/{eventId}/check-ins': {
      post: {
        tags: ['06 Tickets and check-in'],
        summary: 'Check in a QR ticket',
        security: bearer,
        parameters: [pathUuid('eventId', demoEventId)],
        requestBody: jsonBody({ qrToken: 'PASTE_QR_TOKEN_FROM_TICKET_HERE' }),
        responses: {
          '200': { description: 'Checked in' },
          '409': { description: 'Already used or blocked' },
        },
      },
      get: {
        tags: ['06 Tickets and check-in'],
        summary: 'Check-in history',
        security: bearer,
        parameters: [
          pathUuid('eventId', demoEventId),
          { name: 'page', in: 'query', schema: { type: 'integer' }, example: 1 },
          { name: 'limit', in: 'query', schema: { type: 'integer' }, example: 25 },
        ],
        responses: { '200': { description: 'History' } },
      },
    },
    '/orders/{orderId}/refund-requests': {
      post: {
        tags: ['07 Refunds'],
        summary: 'Request whole-order refund',
        security: bearer,
        parameters: [pathUuid('orderId', demoOrderId)],
        requestBody: jsonBody({ userMessage: 'My plans changed.' }),
        responses: {
          '201': { description: 'Refund requested' },
          '409': { description: 'Ineligible or already requested' },
        },
      },
    },
    '/refund-requests': {
      get: {
        tags: ['07 Refunds'],
        summary: 'List own refund requests',
        security: bearer,
        responses: { '200': { description: 'Refund requests' } },
      },
    },
    '/admin/refunds': {
      get: {
        tags: ['07 Refunds'],
        summary: 'List refund requests (ADMIN)',
        security: bearer,
        responses: {
          '200': { description: 'Refund queue' },
          '403': { description: 'Admin role required' },
        },
      },
    },
    '/admin/refunds/{refundId}': {
      patch: {
        tags: ['07 Refunds'],
        summary: 'Approve or reject refund',
        security: bearer,
        parameters: [pathUuid('refundId', demoRefundId)],
        requestBody: jsonBody({
          decision: 'approve',
          reviewerNote: 'Eligible unused passes. A note is required when rejecting.',
        }),
        responses: {
          '200': { description: 'Reviewed' },
          '409': { description: 'Refund is not reviewable' },
        },
      },
    },
    '/admin/refunds/{refundId}/retry': {
      post: {
        tags: ['07 Refunds'],
        summary:
          'Initiate approved refund or retry a provider-confirmed failure; UNKNOWN is never blindly retried',
        security: bearer,
        parameters: [pathUuid('refundId', demoRefundId)],
        responses: {
          '202': { description: 'Initiation claimed' },
          '409': { description: 'Uncertain capture requires investigation/reconciliation' },
        },
      },
    },
    '/organizer/events/{eventId}/reports/orders': {
      get: {
        tags: ['08 Reports'],
        summary: 'Event orders report',
        security: bearer,
        parameters: [pathUuid('eventId', demoEventId)],
        responses: { '200': { description: 'Event orders' } },
      },
    },
    '/organizer/events/{eventId}/reports/statistics': {
      get: {
        tags: ['08 Reports'],
        summary: 'Event statistics',
        security: bearer,
        parameters: [pathUuid('eventId', demoEventId)],
        responses: { '200': { description: 'Event statistics' } },
      },
    },
    '/admin/reports/statistics': {
      get: {
        tags: ['08 Reports'],
        summary: 'Platform statistics',
        security: bearer,
        responses: {
          '200': { description: 'Statistics' },
          '403': { description: 'Admin role required' },
        },
      },
    },
    '/admin/reports/operations': {
      get: {
        tags: ['08 Reports'],
        summary: 'Operations report',
        security: bearer,
        responses: { '200': { description: 'Operations' } },
      },
    },
    '/admin/reports/audit-logs': {
      get: {
        tags: ['08 Reports'],
        summary: 'Audit log report',
        security: bearer,
        parameters: [
          { name: 'page', in: 'query', schema: { type: 'integer' }, example: 1 },
          { name: 'limit', in: 'query', schema: { type: 'integer' }, example: 25 },
        ],
        responses: { '200': { description: 'Audit logs' } },
      },
    },
  },
} as const;
