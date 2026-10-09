'use strict';
// Transactional email via Resend's HTTPS API (no SMTP needed on Railway).
// Without RESEND_API_KEY the email is printed to the server log instead (development).

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function sendEmail(config, { to, subject, text, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log(`[email:dev] to=${to} subject="${subject}"\n${text}`);
    return { dev: true };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.EMAIL_FROM || 'Lulyboo <onboarding@resend.dev>', to: [to], subject, text, html, reply_to: process.env.EMAIL_REPLY_TO || undefined }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    console.error('Email send failed', res.status, t.slice(0, 300));
    const err = new Error('We could not send the email. Please try again later. 邮件发送失败，请稍后再试。');
    err.status = 502;
    throw err;
  }
  return { dev: false };
}

const wrap = (inner) => `<!doctype html><html><body style="margin:0;background:#faf8f6;font-family:-apple-system,Segoe UI,Roboto,'PingFang SC','Microsoft YaHei',sans-serif;color:#2b2623">
<div style="max-width:520px;margin:0 auto;padding:28px 20px"><div style="font-weight:700;color:#d9776a;font-size:20px;margin-bottom:16px">Lulyboo</div>
<div style="background:#fff;border:1px solid #ebe5e0;border-radius:10px;padding:22px">${inner}</div>
<p style="color:#7a716b;font-size:12px;margin-top:16px">If you did not expect this email, you can ignore it. 如果您没有进行此操作，请忽略本邮件。</p></div></body></html>`;

function codeEmail({ code, purpose, minutes }) {
  const what = purpose === 'reset' ? 'reset your password · 重置密码' : 'verify your email · 验证邮箱';
  return {
    subject: `${code} is your Lulyboo verification code · 验证码`,
    text: `Your Lulyboo code to ${what}: ${code}\nIt expires in ${minutes} minutes. 验证码 ${minutes} 分钟内有效。`,
    html: wrap(`<p style="margin:0 0 6px">Your code to ${esc(what)}:</p>
      <div style="font-size:32px;font-weight:700;letter-spacing:8px;margin:12px 0;font-family:ui-monospace,Menlo,monospace">${esc(code)}</div>
      <p style="margin:0;color:#7a716b">Expires in ${minutes} minutes · ${minutes} 分钟内有效</p>`),
  };
}

function inviteEmail({ link, companyName, days }) {
  return {
    subject: 'Invitation to the Lulyboo Supplier Portal · Lulyboo 供应商平台邀请',
    text: `Hello${companyName ? ` ${companyName}` : ''},\n\nLulyboo invites you to submit your products and quotations in our supplier portal.\nOpen this link to register (valid ${days} days):\n${link}\n\n您好，Lulyboo 邀请您在供应商平台提交产品和报价。请点击以下链接完成注册（${days} 天内有效）：\n${link}`,
    html: wrap(`<p style="margin:0 0 10px">Hello${companyName ? ` ${esc(companyName)}` : ''},</p>
      <p>Lulyboo invites you to submit your products and quotations in our supplier portal.</p>
      <p>您好，Lulyboo 邀请您在供应商平台提交产品和报价。</p>
      <p style="margin:20px 0"><a href="${esc(link)}" style="background:#d9776a;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:600;display:inline-block">Register · 立即注册</a></p>
      <p style="color:#7a716b;font-size:13px">Valid for ${days} days · ${days} 天内有效<br><span style="word-break:break-all">${esc(link)}</span></p>`),
  };
}

module.exports = { sendEmail, codeEmail, inviteEmail };
