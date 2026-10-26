'use strict';
// Minimal Telegram Bot API client (no dependencies). Used for CRM reminders.
// Env: TELEGRAM_BOT_TOKEN (from @BotFather). The chat is paired from the CRM page (Reminders box).

const crypto = require('node:crypto');

const enabled = () => !!process.env.TELEGRAM_BOT_TOKEN;
const escapeHtml = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

async function call(method, body = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  let j = null; try { j = await r.json(); } catch { /* not json */ }
  if (!r.ok || !j?.ok) throw new Error(`Telegram ${method}: ${j?.description || r.status}`);
  return j.result;
}

/** text is Telegram-HTML (escape user content with escapeHtml). buttons: [[{text, data|url}]] */
function sendMessage(chatId, text, { buttons } = {}) {
  const body = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true };
  if (buttons?.length) body.reply_markup = { inline_keyboard: buttons.map((row) => row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data }))) };
  return call('sendMessage', body);
}
const answerCallback = (id, text) => call('answerCallbackQuery', { callback_query_id: id, text: text || undefined }).catch(() => {});
const editMessage = (chatId, messageId, text) => call('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => {});
const getMe = () => call('getMe');
const setWebhook = (url, secret) => call('setWebhook', { url, secret_token: secret, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
const deleteWebhook = () => call('deleteWebhook', { drop_pending_updates: true });

// Telegram echoes this header on every webhook call; derived from the session secret so nothing extra to configure.
const webhookSecret = (config) => crypto.createHash('sha256').update('tg-webhook:' + config.sessionSecret).digest('hex').slice(0, 40);
const safeEqual = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };

module.exports = { enabled, escapeHtml, sendMessage, answerCallback, editMessage, getMe, setWebhook, deleteWebhook, webhookSecret, safeEqual };
