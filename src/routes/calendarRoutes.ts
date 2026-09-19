const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const calendar = require('../services/googleCalendar.service');
const router = express.Router();

router.get('/auth-url', authenticateToken, (req, res, next) => {
  try { res.json({ url: calendar.getGoogleCalendarAuthUrl(req.user.id) }); } catch (error) { next(error); }
});

router.get('/callback', async (req, res) => {
  try {
    await calendar.handleGoogleCalendarCallback(String(req.query.code || ''), String(req.query.state || ''));
    res.redirect(`${process.env.CLIENT_URL || 'http://localhost:3000'}/calendar?google_calendar=connected`);
  } catch (error) {
    const message = encodeURIComponent(error.message || 'Google Calendar OAuth не выполнен');
    res.redirect(`${process.env.CLIENT_URL || 'http://localhost:3000'}/calendar?google_calendar=error&message=${message}`);
  }
});

router.get('/status', authenticateToken, async (req, res, next) => {
  try { res.json(await calendar.getGoogleCalendarStatus(req.user.id)); } catch (error) { next(error); }
});

router.get('/events', authenticateToken, async (req, res, next) => {
  try {
    const events = await calendar.listGoogleCalendarEvents(req.user.id, { timeMin: req.query.timeMin, timeMax: req.query.timeMax });
    if (!events) return res.status(409).json({ connected: false, error: 'Google Calendar не подключён' });
    res.json({ connected: true, events });
  } catch (error) { next(error); }
});

router.post('/events', authenticateToken, async (req, res, next) => {
  try { const event = await calendar.createGoogleCalendarEvent(req.user.id, req.body); if (!event) return res.status(409).json({ error: 'Google Calendar не подключён' }); res.status(201).json({ event }); } catch (error) { next(error); }
});
router.patch('/events/:id', authenticateToken, async (req, res, next) => {
  try { const event = await calendar.updateGoogleCalendarEvent(req.user.id, req.params.id, req.body); if (!event) return res.status(409).json({ error: 'Google Calendar не подключён' }); res.json({ event }); } catch (error) { next(error); }
});
router.delete('/events/:id', authenticateToken, async (req, res, next) => {
  try { const deleted = await calendar.deleteGoogleCalendarEvent(req.user.id, req.params.id); if (!deleted) return res.status(409).json({ error: 'Google Calendar не подключён' }); res.status(204).end(); } catch (error) { next(error); }
});

module.exports = router;
