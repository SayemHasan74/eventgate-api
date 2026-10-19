import { Router } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { env } from '../../config/env.js';
import { validate } from '../../middleware/validate.js';
import { sendSuccess, sendError } from '../../shared/responses/api-response.js';
import { emptyQuerySchema } from '../../shared/responses/read-contracts.js';
import { verifiedVisitorIp } from '../../shared/security/proxy-identity.js';
import { aiQuestionSchema, eventQuestionSchema } from './ai.schemas.js';
import { answerEventQuestion, interpretSearch } from './ai.service.js';

export const aiRouter = Router();
aiRouter.get('/config', validate({ query: emptyQuerySchema }), (_r, s) =>
  sendSuccess(s, 200, 'AI availability', { enabled: !!env.GEMINI_API_KEY }),
);
aiRouter.use(
  rateLimit({
    windowMs: 60_000,
    limit: 6,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (request) =>
      ipKeyGenerator(verifiedVisitorIp(request) ?? request.ip ?? 'unknown'),
    handler: (_r, s) =>
      sendError(
        s,
        429,
        'Please wait before asking AI again. Standard search and event details remain available.',
        [{ code: 'AI_RATE_LIMITED', message: 'Please wait one minute before asking AI again.' }],
      ),
  }),
);
aiRouter.post(
  '/search',
  validate({ body: aiQuestionSchema, query: emptyQuerySchema }),
  async (r, s) =>
    sendSuccess(
      s,
      200,
      'Search interpreted',
      await interpretSearch(aiQuestionSchema.parse(r.body).question),
    ),
);
aiRouter.post(
  '/ask',
  validate({ body: eventQuestionSchema, query: emptyQuerySchema }),
  async (r, s) => {
    const input = eventQuestionSchema.parse(r.body);
    sendSuccess(
      s,
      200,
      'Event answer retrieved',
      await answerEventQuestion(input.slug, input.question),
    );
  },
);
