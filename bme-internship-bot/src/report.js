// Renders the digest in three forms: terminal, plain-text email, HTML email.

const escape = (s = '') =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const SOURCE_LABEL = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  smartrecruiters: 'SmartRecruiters',
  'github-list': 'Community list',
  usajobs: 'USAJOBS',
};

const label = (job) =>
  SOURCE_LABEL[job.source] || (job.source.startsWith('reddit') ? job.source : job.source);

function group(jobs) {
  const reddit = jobs.filter((j) => j.source.startsWith('reddit'));
  const boards = jobs.filter((j) => !j.source.startsWith('reddit'));
  return { boards, reddit };
}

export function toConsole(jobs) {
  if (!jobs.length) return 'No new matches.';
  return jobs
    .map(
      (j, i) =>
        `${String(i + 1).padStart(2)}. [${j.score}] ${j.title}\n` +
        `     ${j.company}${j.location ? ` — ${j.location}` : ''}  (${label(j)})\n` +
        `     ${j.url}`,
    )
    .join('\n');
}

export function toPlainText(jobs, season) {
  const { boards, reddit } = group(jobs);
  const section = (name, list) =>
    !list.length
      ? ''
      : `\n${name.toUpperCase()}\n${'='.repeat(name.length)}\n` +
        list
          .map(
            (j) =>
              `\n${j.title}\n${j.company}${j.location ? ` — ${j.location}` : ''}\n` +
              `Score ${j.score} · ${label(j)}\n${j.url}\n`,
          )
          .join('');

  return (
    `${jobs.length} new biomedical engineering internship lead${jobs.length === 1 ? '' : 's'}` +
    ` (${season}).\n` +
    section('Company job boards', boards) +
    section('Reddit', reddit) +
    `\n--\nbme-internship-bot`
  );
}

export function toHTML(jobs, season) {
  const { boards, reddit } = group(jobs);

  const card = (j) => `
    <tr><td style="padding:0 0 14px">
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e3e8ee;border-radius:10px">
        <tr><td style="padding:14px 16px">
          <a href="${escape(j.url)}" style="font:600 15px/1.35 -apple-system,Segoe UI,Roboto,sans-serif;color:#0b57d0;text-decoration:none">${escape(j.title)}</a>
          <div style="font:400 13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#3c4858;margin-top:4px">
            ${escape(j.company)}${j.location ? ` &middot; ${escape(j.location)}` : ''}
          </div>
          <div style="font:400 12px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#6b7785;margin-top:6px">
            <span style="background:#eef3ff;color:#0b57d0;border-radius:4px;padding:2px 6px">score ${j.score}</span>
            &nbsp;${escape(label(j))}${j.postedAt ? ` &middot; posted ${escape(j.postedAt.slice(0, 10))}` : ''}
          </div>
        </td></tr>
      </table>
    </td></tr>`;

  const section = (name, list) =>
    !list.length
      ? ''
      : `<tr><td style="font:600 12px/1 -apple-system,Segoe UI,Roboto,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#6b7785;padding:10px 0 12px">${escape(name)} (${list.length})</td></tr>
         ${list.map(card).join('')}`;

  return `<!doctype html><html><body style="margin:0;background:#f6f8fb;padding:24px">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%">
      <tr><td style="padding-bottom:6px">
        <div style="font:700 20px/1.3 -apple-system,Segoe UI,Roboto,sans-serif;color:#0f1b2d">
          ${jobs.length} new BME internship lead${jobs.length === 1 ? '' : 's'}
        </div>
        <div style="font:400 13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#6b7785">
          Target season: ${escape(season)} &middot; ${new Date().toISOString().slice(0, 10)}
        </div>
      </td></tr>
      ${section('Company job boards', boards)}
      ${section('Reddit', reddit)}
      <tr><td style="font:400 11px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#9aa5b1;padding-top:14px;border-top:1px solid #e3e8ee">
        Sent by bme-internship-bot. Tune keywords and sources in config.json.
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
}
