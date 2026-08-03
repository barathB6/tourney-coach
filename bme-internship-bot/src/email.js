// Minimal SMTP-over-TLS client (no dependencies) plus an optional Resend
// HTTP fallback. Only ever sends to the address in NOTIFY_TO.

import tls from 'node:tls';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

function smtpSession(host, port) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host }, () => resolve(wrap(socket)));
    socket.setEncoding('utf8');
    socket.setTimeout(20_000, () => socket.destroy(new Error('SMTP timeout')));
    socket.once('error', reject);
  });
}

function wrap(socket) {
  let buffer = '';
  let pending = null;

  socket.on('data', (chunk) => {
    buffer += chunk;
    // A reply is complete when the last line is "NNN <space>..."
    const lines = buffer.split(/\r?\n/).filter(Boolean);
    const last = lines[lines.length - 1];
    if (!last || !/^\d{3}[ ]/.test(last)) return;
    const reply = buffer;
    buffer = '';
    const p = pending;
    pending = null;
    if (!p) return;
    const code = Number(last.slice(0, 3));
    if (code >= 400) p.reject(new Error(`SMTP ${code}: ${reply.trim()}`));
    else p.resolve({ code, reply });
  });

  const expect = () => new Promise((resolve, reject) => (pending = { resolve, reject }));

  return {
    greeting: () => expect(),
    async cmd(line, { secret = false } = {}) {
      if (process.env.BOT_DEBUG_SMTP) console.error('> ' + (secret ? '***' : line));
      socket.write(line + '\r\n');
      return expect();
    },
    end() {
      socket.end();
    },
  };
}

function encodeHeader(text) {
  // RFC 2047 for non-ASCII subjects.
  return /^[\x20-\x7E]*$/.test(text) ? text : `=?UTF-8?B?${b64(text)}?=`;
}

function buildMessage({ from, to, subject, text, html }) {
  const boundary = `----bmebot${Date.now().toString(36)}`;
  const headers = [
    `From: BME Internship Bot <${from}>`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].join('\r\n');

  const body = [
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(text).replace(/(.{76})/g, '$1\r\n'),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(html).replace(/(.{76})/g, '$1\r\n'),
    `--${boundary}--`,
    '',
  ].join('\r\n');

  // Dot-stuffing so a lone "." in the body can't terminate DATA early.
  return (headers + '\r\n' + body).replace(/\r\n\./g, '\r\n..');
}

async function sendViaSMTP({ to, subject, text, html }) {
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || user;
  if (!user || !pass) throw new Error('SMTP_USER / SMTP_PASS not set');

  const s = await smtpSession(host, port);
  try {
    await s.greeting();
    await s.cmd(`EHLO ${host}`);
    await s.cmd('AUTH LOGIN');
    await s.cmd(b64(user), { secret: true });
    await s.cmd(b64(pass), { secret: true });
    await s.cmd(`MAIL FROM:<${from}>`);
    await s.cmd(`RCPT TO:<${to}>`);
    await s.cmd('DATA');
    await s.cmd(buildMessage({ from, to, subject, text, html }) + '\r\n.');
    await s.cmd('QUIT').catch(() => {});
  } finally {
    s.end();
  }
  return `smtp:${host}`;
}

async function sendViaResend({ to, subject, text, html }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM || 'onboarding@resend.dev';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: `BME Internship Bot <${from}>`, to: [to], subject, text, html }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  return 'resend';
}

export function emailConfigured() {
  return Boolean((process.env.SMTP_USER && process.env.SMTP_PASS) || process.env.RESEND_API_KEY);
}

export async function sendEmail({ to, subject, text, html }) {
  const provider = process.env.EMAIL_PROVIDER || (process.env.RESEND_API_KEY ? 'resend' : 'smtp');
  return provider === 'resend'
    ? sendViaResend({ to, subject, text, html })
    : sendViaSMTP({ to, subject, text, html });
}
