const { enqueueCall } = require('../services/queue.service');

async function createCall(req, res, next) {
  try {
    const result = await enqueueCall(req.body);
    return res.status(202).json({
      status: 'queued',
      message: 'Успешно добавлено в очередь',
      ...result,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  createCall,
};
