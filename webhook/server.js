require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();

const SLACK_BOT_TOKEN    = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const POOJA_USER_ID      = process.env.SLACK_USER_ID || 'U0AFQMRGPAQ';

const DATA           = path.join(__dirname, '../data');
const QUESTIONS_PATH = path.join(DATA, 'questions.json');
const STATE_PATH     = path.join(DATA, 'state.json');
const STYLE_PATH     = path.join(DATA, 'style_guide.md');
const LOG_PATH       = path.join(DATA, 'post_log.json');

// --- File helpers ---

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return fallback; }
}
function writeJson(p, data) { fs.writeFileSync(p, JSON.stringify(data, null, 2)); }
function readStyle()        { try { return fs.readFileSync(STYLE_PATH, 'utf8'); } catch { return ''; } }
function writeStyle(s)      { fs.writeFileSync(STYLE_PATH, s); }
function appendLog(entry)   {
  const log = readJson(LOG_PATH, []);
  log.push({ date: new Date().toISOString(), ...entry });
  writeJson(LOG_PATH, log);
}

// --- Question selection ---

function nextQuestion() {
  const questions = readJson(QUESTIONS_PATH, []);
  const unasked = questions.filter(q => !q.asked);

  if (unasked.length === 0) {
    questions.forEach(q => { q.asked = false; q.asked_date = null; });
    writeJson(QUESTIONS_PATH, questions);
    return questions[0];
  }

  const { last_theme } = readJson(STATE_PATH, {});
  const diffTheme = unasked.filter(q => q.theme !== last_theme);
  const pool = diffTheme.length > 0 ? diffTheme : unasked;
  return pool[Math.floor(Math.random() * pool.length)];
}

function markAsked(id) {
  const questions = readJson(QUESTIONS_PATH, []);
  const q = questions.find(q => q.id === id);
  if (q) { q.asked = true; q.asked_date = new Date().toISOString().split('T')[0]; }
  writeJson(QUESTIONS_PATH, questions);
}

// --- Slack API ---

async function slackApi(endpoint, body) {
  const res = await fetch(`https://slack.com/api/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function sendMessage(channel, text, blocks, thread_ts) {
  const payload = { channel, text };
  if (blocks) payload.blocks = blocks;
  if (thread_ts) payload.thread_ts = thread_ts;
  return slackApi('chat.postMessage', payload);
}

async function updateMessage(channel, ts, text) {
  return slackApi('chat.update', { channel, ts, text, blocks: [] });
}

// --- Signature verification ---

function verifySlack(req) {
  const ts  = req.headers['x-slack-request-timestamp'];
  const sig = req.headers['x-slack-signature'];
  if (!ts || !sig || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const computed = 'v0=' + crypto.createHmac('sha256', SLACK_SIGNING_SECRET)
    .update(`v0:${ts}:${req.body.toString()}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(sig));
}

// --- Express ---

app.use('/slack/events',  express.raw({ type: '*/*' }));
app.use('/slack/actions', express.raw({ type: 'application/x-www-form-urlencoded' }));
app.use(express.json());

// --- Routes: routine-facing ---

app.get('/', (req, res) => res.send('linkedin-bot running'));

// Question routine calls this to get today's question
app.get('/questions/next', (req, res) => {
  const q = nextQuestion();
  res.json(q || { error: 'no questions available' });
});

// Question routine calls this after sending the Slack DM
app.post('/log-question', (req, res) => {
  const { question_id, question, theme, thread_ts, channel } = req.body;
  if (!question_id || !thread_ts || !channel) {
    return res.status(400).json({ error: 'question_id, thread_ts, and channel required' });
  }
  markAsked(question_id);
  const state = readJson(STATE_PATH, {});
  state.pending = {
    question_id, question, theme, thread_ts, channel,
    answer: null, answer_processed: false,
    draft: null,
    edit: null, edit_processed: false,
    awaiting_edit: false,
  };
  state.last_theme = theme;
  writeJson(STATE_PATH, state);
  res.json({ ok: true });
});

// Processor routine polls this to find pending work
app.get('/pending', (req, res) => {
  const { pending } = readJson(STATE_PATH, {});
  if (!pending) return res.json({ type: null });

  if (pending.edit && !pending.edit_processed) {
    return res.json({
      type: 'edit',
      question:       pending.question,
      original_draft: pending.draft,
      edit:           pending.edit,
      thread_ts:      pending.thread_ts,
      channel:        pending.channel,
    });
  }
  if (pending.answer && !pending.answer_processed) {
    return res.json({
      type:      'answer',
      question:  pending.question,
      theme:     pending.theme,
      answer:    pending.answer,
      thread_ts: pending.thread_ts,
      channel:   pending.channel,
    });
  }
  return res.json({ type: null });
});

// Processor routine calls this after generating the draft or updating style
app.post('/processed', (req, res) => {
  const { type, draft, style_guide } = req.body;
  const state = readJson(STATE_PATH, {});
  if (!state.pending) return res.status(400).json({ error: 'no pending state' });

  if (type === 'answer' && draft) {
    state.pending.answer_processed = true;
    state.pending.draft = draft;
    appendLog({ type: 'draft', question: state.pending.question, theme: state.pending.theme, answer: state.pending.answer, draft });
  } else if (type === 'edit' && style_guide) {
    state.pending.edit_processed = true;
    writeStyle(style_guide);
    appendLog({ type: 'edit', question: state.pending.question, original_draft: state.pending.draft, edit: state.pending.edit });
  }

  writeJson(STATE_PATH, state);
  res.json({ ok: true });
});

// Processor routine reads this to apply past style learnings when drafting
app.get('/style-guide', (req, res) => {
  res.type('text/plain').send(readStyle());
});

app.get('/state', (req, res) => res.json(readJson(STATE_PATH, {})));

// --- Slack Events ---

app.post('/slack/events', async (req, res) => {
  if (req.headers['x-slack-retry-num']) return res.sendStatus(200);

  const body = JSON.parse(req.body.toString());
  if (body.type === 'url_verification') return res.json({ challenge: body.challenge });

  if (!verifySlack(req)) return res.status(401).send('Unauthorized');

  res.sendStatus(200);

  const event = body.event;
  if (!event || event.type !== 'message') return;
  if (event.bot_id || event.subtype)      return;
  if (event.user !== POOJA_USER_ID)       return;
  if (!event.thread_ts)                   return;

  const state = readJson(STATE_PATH, {});
  const pending = state.pending;
  if (!pending || event.thread_ts !== pending.thread_ts) return;

  // Awaiting her edited LinkedIn post
  if (pending.awaiting_edit) {
    state.pending.edit = event.text;
    state.pending.edit_processed = false;
    state.pending.awaiting_edit = false;
    writeJson(STATE_PATH, state);
    await sendMessage(event.channel, '✅ Got it — style notes will update on the next run.', null, event.thread_ts);
    return;
  }

  // Draft already sent — nudge to use button
  if (pending.draft) {
    await sendMessage(event.channel, 'Tap "Share my edited version" on the draft above when you\'re ready.', null, event.thread_ts);
    return;
  }

  // Answer already received but not yet processed
  if (pending.answer) {
    await sendMessage(event.channel, 'Your answer is queued — draft coming shortly.', null, event.thread_ts);
    return;
  }

  // First reply = her answer
  state.pending.answer = event.text;
  state.pending.answer_processed = false;
  writeJson(STATE_PATH, state);
  await sendMessage(event.channel, '👍 Got it — draft coming shortly.', null, event.thread_ts);
});

// --- Slack Actions ---

app.post('/slack/actions', async (req, res) => {
  if (!verifySlack(req)) return res.status(401).send('Unauthorized');

  const payload = JSON.parse(new URLSearchParams(req.body.toString()).get('payload'));
  const action    = payload.actions[0];
  const channelId = payload.channel.id;
  const messageTs = payload.message.ts;

  res.sendStatus(200);

  if (action.action_id === 'share_edit') {
    const state = readJson(STATE_PATH, {});
    if (state.pending) {
      state.pending.awaiting_edit = true;
      writeJson(STATE_PATH, state);
    }
    await updateMessage(channelId, messageTs, payload.message.text + '\n\n_[Waiting for your edit]_');
    await sendMessage(channelId, 'Paste your final LinkedIn post as a reply in this thread:', null, messageTs);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`linkedin-bot running on port ${PORT}`));
