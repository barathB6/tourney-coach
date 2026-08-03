// Interactive credential setup. The user types/pastes secrets into their OWN
// terminal; values go straight to .env (chmod 600) and never anywhere else.
//
// One readline interface is shared across every prompt on purpose: creating a
// second interface on the same stdin consumes the stream and the next prompt
// resolves instantly with an empty answer.

import fs from 'node:fs';
import readline from 'node:readline';

/** Read piped stdin to EOF and hand out its lines one prompt at a time.
 *  readline drops lines that arrive while no question is pending, which makes
 *  `printf 'a\nb\n' | bot --setup` hang on the second prompt. */
async function queuedPrompter() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const lines = Buffer.concat(chunks).toString('utf8').split('\n');
  let i = 0;
  const next = (question) => {
    const value = (lines[i++] ?? '').trim();
    process.stdout.write(`${question}${value ? '(from stdin)' : ''}\n`);
    return value;
  };
  return {
    ask: async (q, fallback = '') => next(q) || fallback,
    askHidden: async (q) => next(q),
    close: () => {},
  };
}

function createPrompter() {
  if (!process.stdin.isTTY) return queuedPrompter();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const ask = (question, fallback = '') =>
    new Promise((resolve) => rl.question(question, (a) => resolve(a.trim() || fallback)));

  /** Same prompt, but keystrokes aren't echoed. No-op when stdin isn't a TTY. */
  const askHidden = (question) =>
    new Promise((resolve) => {
      const original = rl._writeToOutput.bind(rl);
      rl._writeToOutput = (str) => {
        // Echo the prompt itself, swallow everything the user types.
        if (str.includes(question)) original(str);
        else if (str === '\r\n' || str === '\n') original(str);
      };
      rl.question(question, (a) => {
        rl._writeToOutput = original;
        process.stdout.write('\n');
        resolve(a.trim());
      });
    });

  return { ask, askHidden, close: () => rl.close() };
}

/** Merge key=value pairs into an existing .env, preserving unrelated lines. */
export function mergeEnvFile(envPath, updates) {
  const lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').split('\n') : [];
  const written = new Set();

  const out = lines.map((line) => {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/i.exec(line);
    if (m && updates[m[1]] !== undefined) {
      written.add(m[1]);
      return `${m[1]}=${updates[m[1]]}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!written.has(key)) out.push(`${key}=${value}`);
  }

  fs.writeFileSync(envPath, out.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
  fs.chmodSync(envPath, 0o600);
}

export async function runSetup(envPath, defaults = {}) {
  const p = await createPrompter();
  try {
    console.log('bme-internship-bot setup — values are saved to .env (never committed).\n');

    const fallbackUser = defaults.user || 'barathb2306@gmail.com';
    const user = await p.ask(`Gmail address [${fallbackUser}]: `, fallbackUser);

    console.log(
      '\nPaste the 16-character app password from https://myaccount.google.com/apppasswords',
    );
    console.log('(input is hidden; spaces are stripped automatically)');
    const pass = (await p.askHidden('App password: ')).replace(/\s+/g, '');

    if (!pass) {
      console.log('\nNo password entered — nothing changed.');
      return false;
    }
    if (pass.length !== 16) {
      console.log(
        `\nNote: Gmail app passwords are exactly 16 characters; got ${pass.length}. ` +
          'Saving anyway — rerun --setup if the test below fails.',
      );
    }

    console.log('\nOptional — Reddit API (press Enter to skip; job boards work without it)');
    const redditId = await p.ask('Reddit client id []: ', '');
    const redditSecret = redditId ? await p.askHidden('Reddit client secret: ') : '';

    const updates = { SMTP_USER: user, SMTP_PASS: pass, NOTIFY_TO: defaults.notifyTo || user };
    if (redditId) {
      updates.REDDIT_CLIENT_ID = redditId;
      updates.REDDIT_CLIENT_SECRET = redditSecret;
    }

    mergeEnvFile(envPath, updates);
    for (const [k, v] of Object.entries(updates)) process.env[k] = v; // take effect this run

    console.log(`\nSaved to ${envPath} (permissions 600).`);
    return true;
  } finally {
    p.close();
  }
}
