import { Request, Response, NextFunction } from 'express';
import { enqueueCall, CallQueuePayload } from '../services/queue.service';

export async function createCall(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const result = await enqueueCall(req.body as CallQueuePayload);
    return res.status(202).json({
      status: 'queued',
      message: 'Успешно добавлено в очередь',
      ...result,
    });
  } catch (error) {
    return next(error);
  }
}
