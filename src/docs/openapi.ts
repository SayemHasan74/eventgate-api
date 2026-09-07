export const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'EventGate API',
    version: '1.0.0',
    description: 'Event ticketing, verified payments, QR admission, and refunds.',
  },
  servers: [{ url: '/api/v1', description: 'Current server' }],
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
      get: { summary: 'Liveness check', responses: { '200': { description: 'Live' } } },
    },
    '/health/ready': {
      get: {
        summary: 'Database readiness check',
        responses: {
          '200': { description: 'Ready' },
          '503': { description: 'Database unavailable' },
        },
      },
    },
    '/auth/register': {
      post: {
        summary: 'Register attendee',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              example: {
                email: 'attendee@example.com',
                displayName: 'Attendee',
                password: 'CorrectHorseBattery1',
              },
            },
          },
        },
        responses: {
          '201': { description: 'Registered' },
          '400': { description: 'Validation error' },
        },
      },
    },
    '/auth/login': {
      post: {
        summary: 'Password login',
        responses: {
          '200': { description: 'Tokens issued' },
          '401': { description: 'Invalid credentials' },
        },
      },
    },
    '/auth/refresh': {
      post: {
        summary: 'Rotate refresh token',
        responses: {
          '200': { description: 'Rotated' },
          '401': { description: 'Invalid or reused token' },
        },
      },
    },
    '/events': {
      get: {
        summary: 'Public event discovery',
        parameters: [
          { name: 'search', in: 'query', schema: { type: 'string' } },
          { name: 'page', in: 'query', schema: { type: 'integer' } },
        ],
        responses: { '200': { description: 'Events' } },
      },
    },
    '/events/{slug}': {
      get: {
        summary: 'Public event detail',
        parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Event' }, '404': { description: 'Not found' } },
      },
    },
    '/orders': {
      post: {
        summary: 'Reserve tickets (ATTENDEE)',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '201': { description: 'Reserved' },
          '409': { description: 'Inventory or idempotency conflict' },
        },
      },
      get: {
        summary: 'List own orders (ATTENDEE)',
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'Orders' } },
      },
    },
    '/orders/{orderId}/checkout': {
      post: {
        summary: 'Start SSLCommerz checkout (ATTENDEE)',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '201': { description: 'Hosted checkout URL' },
          '400': { description: 'Missing idempotency key' },
          '503': { description: 'Gateway not configured' },
        },
      },
    },
    '/tickets': {
      get: {
        summary: 'List own tickets (ATTENDEE)',
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'Tickets' } },
      },
    },
    '/tickets/{ticketId}/qr': {
      get: {
        summary: 'Get own QR SVG (ATTENDEE)',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'SVG QR image', content: { 'image/svg+xml': {} } },
          '404': { description: 'Not owned or unavailable' },
        },
      },
    },
    '/organizer/events/{eventId}/check-ins': {
      post: {
        summary: 'Check in a QR ticket (event owner or ADMIN)',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Checked in' },
          '409': { description: 'Already used or blocked' },
        },
      },
      get: {
        summary: 'Check-in history',
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'History' } },
      },
    },
    '/orders/{orderId}/refund-requests': {
      post: {
        summary: 'Request whole-order refund (ATTENDEE)',
        security: [{ bearerAuth: [] }],
        responses: { '201': { description: 'Requested' }, '409': { description: 'Ineligible' } },
      },
    },
    '/admin/refunds/{refundId}': {
      patch: {
        summary: 'Approve or reject refund (ADMIN)',
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'Reviewed' } },
      },
    },
    '/admin/reports/statistics': {
      get: {
        summary: 'Platform statistics (ADMIN)',
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'Statistics' } },
      },
    },
  },
} as const;
