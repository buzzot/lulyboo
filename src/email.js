'use strict';
// Transactional email via Resend's HTTPS API (no SMTP needed on Railway).
// Without RESEND_API_KEY nothing is sent. Emails (which contain codes and links) are written to the
// server log ONLY when EMAIL_DEV_LOG=true is set explicitly, for local testing. Never enable it in production.

const m = (en, zh) => `⟪${en}⟫⟦${zh}⟧`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const emailConfigured = () => !!process.env.RESEND_API_KEY;

async function sendEmail(config, { to, subject, text, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    if (process.env.EMAIL_DEV_LOG === 'true') {
      console.log(`[email:dev] to=${to} subject="${subject}"\n${text}`);
      return { dev: true };
    }
    const err = new Error(m('Email is not set up on this portal yet, so we cannot send your code. Please contact Lulyboo.', '平台邮件功能尚未开通，无法发送验证码，请联系 Lulyboo。'));
    err.status = 503;
    throw err;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.EMAIL_FROM || 'Lulyboo <onboarding@resend.dev>', to: [to], subject, text, html, reply_to: process.env.EMAIL_REPLY_TO || undefined }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    console.error('Email send failed', res.status, t.slice(0, 300));
    const err = new Error(m('We could not send the email. Please try again later.', '邮件发送失败，请稍后再试。'));
    err.status = 502;
    throw err;
  }
  return { dev: false };
}

const FONT = "Arial,'Microsoft YaHei','PingFang SC',sans-serif";

/** Shared layout: brand header, body rows, footer. `preheader` is the hidden inbox preview text. */
const layout = ({ preheader, body }) => `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Lulyboo</title></head>
<body style="margin:0;padding:0;background-color:#ffffff;font-family:${FONT};color:#292c30;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#ffffff;"><tr><td align="center" style="padding:40px 20px;">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:560px;">
<tr><td style="padding:0 0 25px;border-bottom:1px solid #e8e9eb;"><span style="color:#de7367;font-size:30px;line-height:36px;font-weight:700;">Lulyboo</span>
<div style="margin-top:6px;font-size:12px;line-height:18px;color:#73777d;">SUPPLIER PORTAL · 供应商平台</div></td></tr>
${body}
<tr><td style="border-top:1px solid #e8e9eb;padding:22px 0 0;">
<p style="margin:0;font-size:11px;line-height:19px;color:#858990;">If you weren't expecting this email, you can ignore it.</p>
<p style="margin:4px 0 0;font-size:11px;line-height:19px;color:#858990;" lang="zh-CN">如果您未预期收到此邮件，请忽略本邮件。</p>
<p style="margin:19px 0 0;font-size:11px;line-height:19px;color:#858990;">Lulyboo · Supplier Portal / 供应商平台</p></td></tr>
</table></td></tr></table></body></html>`;

function codeEmail({ code, purpose, minutes }) {
  const what = purpose === 'reset' ? 'reset your password' : 'verify your email';
  const whatZh = purpose === 'reset' ? '重置密码' : '验证邮箱';
  return {
    subject: `${code} is your Lulyboo verification code · 验证码`,
    text: `Your Lulyboo code to ${what}: ${code}\nIt expires in ${minutes} minutes.\n\n您的 Lulyboo ${whatZh}验证码：${code}\n验证码 ${minutes} 分钟内有效。`,
    html: layout({
      preheader: `Your code: ${code} · 您的验证码：${code}`,
      body: `<tr><td style="padding:32px 0 0;"><h1 style="margin:0;font-size:27px;line-height:36px;font-weight:600;">Your verification code</h1>
<p style="margin:8px 0 0;font-size:18px;line-height:28px;color:#73777d;" lang="zh-CN">您的验证码</p></td></tr>
<tr><td style="padding:25px 0 0;"><p style="margin:0;font-size:15px;line-height:25px;">Use this code to ${esc(what)}:</p>
<p style="margin:0;font-size:15px;line-height:26px;color:#62676e;" lang="zh-CN">请使用此验证码${whatZh}：</p>
<div style="margin:20px 0 0;padding:18px 0;background:#faf6f5;border:1px solid #f0dcd9;border-radius:6px;text-align:center;font-size:34px;line-height:40px;font-weight:700;letter-spacing:8px;font-family:Menlo,Consolas,monospace;color:#292c30;">${esc(code)}</div>
<p style="margin:13px 0 0;font-size:12px;line-height:20px;color:#73777d;">Expires in ${minutes} minutes · ${minutes} 分钟内有效</p></td></tr>
<tr><td style="padding:29px 0 30px;"></td></tr>`,
    }),
  };
}

function inviteEmail({ link, companyName, days }) {
  const hello = companyName ? `Hello ${esc(companyName)},` : 'Hello,';
  return {
    subject: 'Invitation to the Lulyboo Supplier Portal · Lulyboo 供应商平台邀请',
    text: `Hello${companyName ? ` ${companyName}` : ''},\n\nLulyboo invites you to join our supplier portal to submit your products, quotations, and photos.\nCreate your account (valid ${days} days):\n${link}\n\n您好，Lulyboo 诚邀您加入供应商平台，提交产品资料、报价及照片。\n请点击以下链接完成注册（${days} 天内有效）：\n${link}`,
    html: layout({
      preheader: "You're invited to the Lulyboo Supplier Portal · 您受邀加入 Lulyboo 供应商平台。",
      body: `<tr><td style="padding:32px 0 0;"><h1 style="margin:0;font-size:27px;line-height:36px;font-weight:600;">You're invited.</h1>
<p style="margin:8px 0 0;font-size:18px;line-height:28px;color:#73777d;" lang="zh-CN">诚邀您加入</p></td></tr>
<tr><td style="padding:25px 0 0;"><p style="margin:0 0 12px;font-size:15px;line-height:25px;">${hello}</p>
<p style="margin:0;font-size:15px;line-height:25px;">Lulyboo invites you to join our supplier portal to submit your products, quotations, and photos.</p>
<p style="margin:18px 0 0;font-size:15px;line-height:26px;color:#62676e;" lang="zh-CN">您好，Lulyboo 诚邀您加入供应商平台，提交产品资料、报价及照片。</p></td></tr>
<tr><td style="padding:30px 0 0;"><table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td align="center" bgcolor="#de7367" style="border-radius:6px;">
<a href="${esc(link)}" target="_blank" style="display:inline-block;padding:15px 25px;border:1px solid #de7367;border-radius:6px;font-size:15px;line-height:22px;font-weight:600;color:#ffffff;text-decoration:none;">Create your account · 立即注册</a></td></tr></table>
<p style="margin:13px 0 0;font-size:12px;line-height:20px;color:#73777d;">Invitation valid for ${days} days · 邀请链接 ${days} 天内有效</p></td></tr>
<tr><td style="padding:29px 0 30px;"><p style="margin:0;font-size:12px;line-height:21px;color:#73777d;">If the button doesn't work, <a href="${esc(link)}" style="color:#62676e;text-decoration:underline;">open your registration link</a>.</p>
<p style="margin:3px 0 0;font-size:12px;line-height:21px;color:#73777d;" lang="zh-CN">如果按钮无法打开，请<a href="${esc(link)}" style="color:#62676e;text-decoration:underline;">点击此处注册</a>。</p></td></tr>`,
    }),
  };
}

module.exports = { sendEmail, codeEmail, inviteEmail, emailConfigured };
