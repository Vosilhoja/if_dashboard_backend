const express = require('express');
const { z } = require('zod');
const { authenticateToken } = require('../middleware/auth');
const { createCall } = require('../controllers/call.controller');

const router = express.Router();
const callSchema = z.object({
  operatorId: z.union([z.string(), z.number()]).transform(String),
  phone: z.string().min(3).max(32),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),
  status: z.string().min(1).max(64),
  comment: z.string().max(2_000).optional(),
  clientName: z.string().max(200).optional(),
  metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  idempotencyKey: z.string().max(128).optional(),
});

router.post('/', authenticateToken, (req, res, next) => {
  const parsed = callSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      status: 'fail',
      error: 'Некорректные данные звонка',
      details: parsed.error.flatten(),
    });
  }
  req.body = parsed.data;
  return createCall(req, res, next);
});

module.exports = router;
