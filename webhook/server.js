require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const POOJA_USER_ID = process.env.SLACK_USER_ID || 'U0AFQMRGPAQ';

const DATA = path.join(__dirname, '../data');
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

// --- Claude: draft generation ---

async function generateDraft(question, theme, answer) {
  const style = readStyle().trim();
  const styleSection = style && !style.startsWith('(No style notes')
    ? `\nStyle notes from Pooja's past edits — apply these:\n${style}\n`
    : '';

  const res = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `You are a LinkedIn ghostwriter for Pooja Agarwal, founder of Magnent — an AEO (Answer Engine Optimization) agency in India.

Pooja's voice: Direct, grounded, India-context-aware. She's a practitioner, not a theorist. She speaks from real client experience. She doesn't use jargon for its own sake. She's comfortable being contrarian when she has evidence.

LinkedIn audience: Founders, CMOs, growth leaders, agency peers, fintech operators — mostly India-based, some global.

Theme: ${theme}
Question she answered: ${question}

Her raw answer:
---
${answer}
---
${styleSection}
Write a LinkedIn post (250–400 words) based on her answer.

Rules:
- Open with a hook that does NOT start with "I" — use a scene, a question, or a provocation
- First person, Pooja's voice throughout
- No bullet lists unless her answer was explicitly list-form
- No hashtags (she'll add her own)
- No em-dashes
- End with something that invites reflection — not a call to follow or like
- Keep her specific details, numbers, and examples — don't genericize
- Don't add things she didn't say

Output only the post. No preamble.`,
    }],
  });
  return res.content[0].text;
}

// --- Claude: style learning ---

async function learnFromEdit(question, originalDraft, editedPost) {
  const currentStyle = readStyle();

  const res = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: `You are analyzing edits Pooja Agarwal made to a LinkedIn post draft, to extract her writing style preferences.

Question she answered: ${question}

Original draft:
---
${originalDraft}
---

Her final edited version:
---
${editedPost}
---

Existing style notes:
---
${currentStyle || '(none yet)'}
---

Compare the original and her edit. Identify concrete, actionable patterns in what she changed — tone, structure, vocabulary, length, openings, closings, phrasing preferences, etc.

Output ONLY the updated style notes (full list, old + new learnings merged). One note per bullet. No meta-commentary.`,
    }],
  });
  writeStyle(res.content[0].text);
}

// --- Slack signature verification ---

function verifySlack(req) {
  const ts = req.headers['x-slack-request-timestamp'];
  const sig = req.headers['x-slack-signature'];
  if (!ts || !sig || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const computed = 'v0=' + crypto.createHmac('sha256', SLACK_SIGNING_SECRET)
    .update(`v0:${ts}:${req.body.toString()}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(sig));
}

// --- Express setup ---

app.use('/slack/events',  express.raw({ type: '*/*' }));
app.use('/slack/actions', express.raw({ type: 'application/x-www-form-urlencoded' }));
app.use(express.json());

// --- Routes ---

app.get('/', (req, res) => res.send('linkedin-bot running'));

// Routine calls this to get the next question to ask
app.get('/questions/next', (req, res) => {
  const q = nextQuestion();
  res.json(q || { error: 'no questions available' });
});

// Routine calls this after sending the question to Slack
app.post('/log-question', (req, res) => {
  const { question_id, question, theme, thread_ts, channel } = req.body;
  if (!question_id || !thread_ts || !channel) {
    return res.status(400).json({ error: 'question_id, thread_ts, and channel required' });
  }
  markAsked(question_id);
  const state = readJson(STATE_PATH, {});
  state.pending = { question_id, question, theme, thread_ts, channel, draft: null, awaiting_edit: false };
  state.last_theme = theme;
  writeJson(STATE_PATH, state);
  res.json({ ok: true });
});

// Utility: current state
app.get('/state', (req, res) => res.json(readJson(STATE_PATH, {})));

// --- Slack Events ---

app.post('/slack/events', async (req, res) => {
  if (req.headers['x-slack-retry-num']) return res.sendStatus(200);

  const body = JSON.parse(req.body.toString());

  // Challenge must be answered before signature check (signing secret may not be set yet)
  if (body.type === 'url_verification') return res.json({ challenge: body.challenge });

  if (!verifySlack(req)) return res.status(401).send('Unauthorized');

  res.sendStatus(200); // acknowledge before async work

  const event = body.event;
  if (!event || event.type !== 'message') return;
  if (event.bot_id || event.subtype) return;
  if (event.user !== POOJA_USER_ID) return;
  if (!event.thread_ts) return; // only thread replies

  const state = readJson(STATE_PATH, {});
  const pending = state.pending;
  if (!pending) return;
  if (event.thread_ts !== pending.thread_ts) return;

  // Case 1: awaiting her edited LinkedIn post
  if (pending.awaiting_edit) {
    const editedPost = event.text;
    try {
      await learnFromEdit(pending.question, pending.draft, editedPost);
      appendLog({ type: 'edit', question: pending.question, theme: pending.theme, original_draft: pending.draft, edited_post: editedPost });
      state.pending.awaiting_edit = false;
      writeJson(STATE_PATH, state);
      await sendMessage(event.channel, '✅ Style notes updated — future drafts will reflect your edits.', null, event.thread_ts);
    } catch (err) {
      console.error('Style learning failed:', err);
      await sendMessage(event.channel, '⚠️ Could not process your edit. Try again.', null, event.thread_ts);
    }
    return;
  }

  // Case 2: draft already sent — nudge to use the button
  if (pending.draft) {
    await sendMessage(event.channel, 'Tap "Share my edited version" on the draft above when you\'re ready to submit your edit.', null, event.thread_ts);
    return;
  }

  // Case 3: this is her raw answer — generate draft
  const answer = event.text;
  try {
    const draft = await generateDraft(pending.question, pending.theme, answer);
    state.pending.draft = draft;
    writeJson(STATE_PATH, state);
    appendLog({ type: 'draft', question: pending.question, theme: pending.theme, answer, draft });

    await sendMessage(event.channel, draft, [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Draft — ${pending.theme}*\n\n${draft}` },
      },
      {
        type: 'actions',
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: '📝 Share my edited version' },
          action_id: 'share_edit',
        }],
      },
    ], pending.thread_ts);
  } catch (err) {
    console.error('Draft generation failed:', err);
    await sendMessage(event.channel, '⚠️ Draft generation failed. Try again in a moment.', null, pending.thread_ts);
  }
});

// --- Slack Actions (button clicks) ---

app.post('/slack/actions', async (req, res) => {
  if (!verifySlack(req)) return res.status(401).send('Unauthorized');

  const payload = JSON.parse(new URLSearchParams(req.body.toString()).get('payload'));
  const action = payload.actions[0];
  const channelId = payload.channel.id;
  const messageTs = payload.message.ts;

  res.sendStatus(200);

  if (action.action_id === 'share_edit') {
    const state = readJson(STATE_PATH, {});
    if (state.pending) {
      state.pending.awaiting_edit = true;
      writeJson(STATE_PATH, state);
    }
    await updateMessage(channelId, messageTs, payload.message.text + '\n\n_[Edit submitted — waiting for paste]_');
    await sendMessage(channelId, 'Paste your final LinkedIn post as a reply in this thread:', null, messageTs);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`linkedin-bot running on port ${PORT}`));
