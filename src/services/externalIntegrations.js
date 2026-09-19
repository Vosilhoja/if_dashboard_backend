const todoistService = require('./todoist.service');

async function listTodoistTasksLegacy() {
  const token = String(process.env.TODOIST_API_TOKEN || '').trim();
  if (!token) throw new Error('TODOIST_API_TOKEN не настроен');
  const response = await fetch('https://api.todoist.com/rest/v2/tasks', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await response.json().catch(() => []);
  if (!response.ok) throw new Error(data?.message || 'Todoist API недоступен');
  return data.map((task) => ({
    id: `todoist-${task.id}`,
    title: task.content,
    notes: task.description || '',
    status: task.is_completed ? 'done' : 'open',
    priority: task.priority === 4 ? 'urgent' : task.priority === 3 ? 'high' : task.priority === 2 ? 'medium' : 'low',
    dueAt: task.due?.datetime || task.due?.date || null,
    category: 'Todoist',
    tags: task.labels || [],
    source: 'todoist',
    externalId: task.id,
    projectId: task.project_id,
    url: task.url,
  }));
}

async function listCalendarEvents({ timeMin, timeMax } = {}) {
  const token = String(process.env.GOOGLE_CALENDAR_ACCESS_TOKEN || '').trim();
  const calendarId = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID || 'primary');
  if (!token) throw new Error('GOOGLE_CALENDAR_ACCESS_TOKEN не настроен');
  const params = new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '100',
    ...(timeMin ? { timeMin: new Date(timeMin).toISOString() } : {}),
    ...(timeMax ? { timeMax: new Date(timeMax).toISOString() } : {}),
  });
  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || 'Google Calendar API недоступен');
  return (data.items || []).map((event) => ({
    id: event.id,
    title: event.summary || 'Без названия',
    description: event.description || '',
    start: event.start?.dateTime || event.start?.date || null,
    end: event.end?.dateTime || event.end?.date || null,
    location: event.location || '',
    url: event.htmlLink || '',
  }));
}

module.exports = { listTodoistTasks: todoistService.listTodoistTasks, listCalendarEvents };
