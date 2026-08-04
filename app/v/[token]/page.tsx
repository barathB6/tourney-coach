'use client';

import React, { useCallback, useEffect, useState, use as usePromise } from 'react';
import { readCache, writeCache, enqueue, readQueue, flushQueue } from '@/lib/dayof/offlineCache';

// The volunteer app. Mobile-first, task-focused, offline-capable — this is what
// somebody actually holds while standing on the 14th tee.
//
// Six screens, one route: Welcome/Confirm → Pre-Tournament Hub → Day-Of Hub →
// Task Detail → Help/Escalate → Post-Tournament. Which one you see is decided
// by where the tournament is, not by navigation, because a volunteer on the day
// should not have to find anything.
//
// Everything renders from a localStorage snapshot FIRST and is then refreshed
// from the network. On a bad connection that ordering is the whole product:
// the checklist is on screen instantly and updates when it can.

type Task = {
  id: string; title: string; lines: string[];
  allDepths: { detailed: string[]; standard: string[]; minimal: string };
  dueAt: string | null; completedAt: string | null;
};
type Snapshot = {
  volunteerName: string; tournamentName: string; roleName: string; roleDescription: string | null;
  phase: 'planning' | 'day_of'; status: string;
  guidance: { depth: string; cadence: string; channel: string; experienceLevel: string; reasons: string[] };
  tasks: Task[];
  checkedInAt: string | null; lastPosition: string | null;
  eventDate: string | null; shotgunTime: string | null;
  contacts: { label: string; name: string | null; email: string | null; phone: string | null }[];
  firedTriggers: { kind: string; firedAt: string }[];
  inbox: { id: string; kind: string; subject: string | null; body: string | null; createdAt: string | null; deliveredVia: string }[];
  messages: { id: string; direction: string; audience: string; senderName: string | null; body: string; createdAt: string }[];
};

const TRIGGER_LABEL: Record<string, string> = {
  shotgun_started: 'Shotgun started', last_group_teed: 'Last group teed off',
  turn_reached: 'Field at the turn', first_group_finished: 'First group finished',
  kitchen_fired: 'Kitchen firing', last_group_in: 'Last group in',
  awards_starting: 'Awards starting', tournament_complete: 'Tournament complete',
};

const time = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';

export default function VolunteerApp({ params }: { params: Promise<{ token: string }> }) {
  const { token } = usePromise(params);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [screen, setScreen] = useState<'hub' | 'task' | 'help' | 'wrap'>('hub');
  const [openTask, setOpenTask] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  // Read once on mount rather than during render: Date.now() in a render body
  // is impure, and a countdown that changes on an unrelated re-render is a bug
  // a volunteer would notice.
  const [now, setNow] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/volunteer/portal?token=${encodeURIComponent(token)}`);
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        if (res.status === 404) setError(d.error || 'This link is not valid.');
        return;
      }
      const d = (await res.json()) as Snapshot;
      setSnap(d); writeCache(token, d); setCachedAt(new Date().toISOString()); setError('');
    } catch {
      // Offline. The cached snapshot is already on screen; say so rather than
      // showing an error over the top of perfectly good data.
      setOnline(false);
    } finally {
      setLoading(false);
    }
  }, [token]);

  // Paint from the cached snapshot before the network is even asked. The read
  // is synchronous (localStorage, not IndexedDB) and happens in an async
  // bootstrap so it does not fire a setState inside the effect body — one
  // microtask, which is still an eternity before a fetch resolves.
  useEffect(() => {
    let alive = true;
    (async () => {
      const c = readCache<Snapshot>(token);
      if (!alive) return;
      if (c) { setSnap(c.data); setCachedAt(c.cachedAt); setLoading(false); }
      setPending(readQueue(token).length);
      setOnline(typeof navigator === 'undefined' ? true : navigator.onLine);
      setNow(Date.now());
      await refresh();
    })();
    return () => { alive = false; };
  }, [token, refresh]);

  // Reconnect: replay anything queued, then refresh.
  useEffect(() => {
    const goOnline = async () => {
      setOnline(true);
      const r = await flushQueue(token, (body) => fetch('/api/volunteer/portal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, ...body }),
      }));
      setPending(r.remaining);
      if (r.sent) setNote(`${r.sent} update${r.sent === 1 ? '' : 's'} synced.`);
      refresh();
    };
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => { window.removeEventListener('online', goOnline); window.removeEventListener('offline', goOffline); };
  }, [token, refresh]);

  // Every mutation goes through here, so offline is never a dead end: apply
  // optimistically, queue, and replay on reconnect.
  async function act(body: Record<string, unknown>, optimistic?: (s: Snapshot) => Snapshot) {
    if (optimistic && snap) {
      const next = optimistic(snap);
      setSnap(next); writeCache(token, next);
    }
    if (!navigator.onLine) {
      enqueue(token, body);
      setPending(readQueue(token).length);
      setOnline(false);
      setNote('Saved on your phone — it will sync when you have signal.');
      return;
    }
    try {
      const res = await fetch('/api/volunteer/portal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, ...body }),
      });
      if (res.ok) {
        const d = (await res.json()) as Snapshot;
        setSnap(d); writeCache(token, d);
      } else if (res.status >= 500) {
        enqueue(token, body); setPending(readQueue(token).length);
      } else {
        const d = await res.json().catch(() => ({}));
        setError(d.error || 'That did not work.');
      }
    } catch {
      enqueue(token, body); setPending(readQueue(token).length); setOnline(false);
      setNote('Saved on your phone — it will sync when you have signal.');
    }
  }

  // Register the service worker so the shell survives a dead zone.
  useEffect(() => {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/volunteer-sw.js').catch(() => {});
  }, []);

  if (loading) return <Shell><p style={S.dim}>Loading…</p></Shell>;
  if (error && !snap) return <Shell><h1 style={S.h1}>That link didn&rsquo;t work</h1><p style={S.p}>{error}</p></Shell>;
  if (!snap) return <Shell><p style={S.dim}>Nothing to show yet.</p></Shell>;

  // ── Which screen? Decided by state, not by the volunteer navigating ───────
  const isComplete = snap.firedTriggers.some((t) => t.kind === 'tournament_complete');
  const isDayOf = snap.phase === 'day_of' && (
    snap.firedTriggers.length > 0 ||
    (snap.eventDate && now ? snap.eventDate.slice(0, 10) === new Date(now).toISOString().slice(0, 10) : false)
  );
  const task = snap.tasks.find((t) => t.id === openTask) ?? null;
  const doneCount = snap.tasks.filter((t) => t.completedAt).length;
  const nextTask = snap.tasks.find((t) => !t.completedAt) ?? null;

  return (
    <Shell>
      {/* Connection state is always visible — a volunteer needs to know whether
          what they just ticked actually left the phone. */}
      {(!online || pending > 0) && (
        <div style={S.offline}>
          {!online ? 'Offline — showing your saved copy.' : ''}
          {pending > 0 ? ` ${pending} update${pending === 1 ? '' : 's'} waiting to sync.` : ''}
          {cachedAt && !online ? ` Saved ${time(cachedAt)}.` : ''}
        </div>
      )}
      {note && <div style={S.note} onClick={() => setNote('')}>{note}</div>}
      {error && <div style={S.err} onClick={() => setError('')}>{error}</div>}

      {/* ── Screen 1: Welcome / Confirmation ─────────────────────────────── */}
      {snap.status !== 'confirmed' && snap.status !== 'completed' ? (
        <Welcome snap={snap} onAnswer={async (answer) => {
          await fetch('/api/volunteer/respond', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, answer }),
          });
          refresh();
        }} />
      ) : screen === 'help' ? (
        <Help snap={snap} onBack={() => setScreen('hub')} onSend={(b, a) => act({ action: 'message', body: b, audience: a })} />
      ) : screen === 'task' && task ? (
        <TaskDetail task={task} depth={snap.guidance.depth} onBack={() => { setScreen('hub'); setOpenTask(null); }}
          onToggle={() => act(
            { action: task.completedAt ? 'uncomplete_task' : 'complete_task', taskId: task.id },
            (s) => ({ ...s, tasks: s.tasks.map((t) => t.id === task.id ? { ...t, completedAt: t.completedAt ? null : new Date().toISOString() } : t) }),
          )} />
      ) : isComplete || screen === 'wrap' ? (
        /* ── Screen 6: Post-Tournament ──────────────────────────────────── */
        <PostTournament snap={snap} doneCount={doneCount}
          onFeedback={(fb) => act({ action: 'feedback', ...fb })}
          onBack={() => setScreen('hub')} />
      ) : isDayOf ? (
        /* ── Screen 3: Day-Of Hub ───────────────────────────────────────── */
        <DayOfHub snap={snap} nextTask={nextTask} doneCount={doneCount}
          onOpenTask={(id) => { setOpenTask(id); setScreen('task'); }}
          onToggle={(t) => act(
            { action: t.completedAt ? 'uncomplete_task' : 'complete_task', taskId: t.id },
            (s) => ({ ...s, tasks: s.tasks.map((x) => x.id === t.id ? { ...x, completedAt: x.completedAt ? null : new Date().toISOString() } : x) }),
          )}
          onCheckIn={() => act(
            { action: snap.checkedInAt ? 'undo_check_in' : 'check_in' },
            (s) => ({ ...s, checkedInAt: s.checkedInAt ? null : new Date().toISOString() }),
          )}
          onPosition={(p) => act({ action: 'position', position: p }, (s) => ({ ...s, lastPosition: p }))}
          onHelp={() => setScreen('help')}
          onWrap={() => setScreen('wrap')} />
      ) : (
        /* ── Screen 2: Pre-Tournament Hub ───────────────────────────────── */
        <PreTournamentHub snap={snap} doneCount={doneCount} now={now}
          onOpenTask={(id) => { setOpenTask(id); setScreen('task'); }}
          onToggle={(t) => act(
            { action: t.completedAt ? 'uncomplete_task' : 'complete_task', taskId: t.id },
            (s) => ({ ...s, tasks: s.tasks.map((x) => x.id === t.id ? { ...x, completedAt: x.completedAt ? null : new Date().toISOString() } : x) }),
          )}
          onHelp={() => setScreen('help')} />
      )}
    </Shell>
  );
}

// ── Screens ─────────────────────────────────────────────────────────────────

function Welcome({ snap, onAnswer }: { snap: Snapshot; onAnswer: (a: 'confirm' | 'decline') => void }) {
  return (
    <>
      <p style={S.kick}>{snap.phase === 'planning' ? 'Planning team' : 'Day of the tournament'}</p>
      <h1 style={S.h1}>Can you take &ldquo;{snap.roleName}&rdquo;?</h1>
      <p style={S.p}>Hi {snap.volunteerName} — you&rsquo;ve been asked to help with <strong>{snap.tournamentName}</strong>.</p>
      {snap.roleDescription && <p style={S.p}>{snap.roleDescription}</p>}
      {snap.tasks.length > 0 && (
        <div style={S.panel}>
          <p style={S.kick}>What it involves</p>
          {snap.tasks.map((t) => <p key={t.id} style={S.li}>{t.title}</p>)}
        </div>
      )}
      <button onClick={() => onAnswer('confirm')} style={S.bigBtn}>Yes, I can help</button>
      <button onClick={() => onAnswer('decline')} style={S.bigGhost}>I can&rsquo;t this time</button>
      <p style={S.fine}>No account needed. This link is yours — save it to your home screen.</p>
    </>
  );
}

function Countdown({ eventDate, shotgunTime, now }: { eventDate: string | null; shotgunTime: string | null; now: number }) {
  if (!eventDate || !now) return null;
  const days = Math.ceil((Date.parse(`${eventDate.slice(0, 10)}T12:00:00Z`) - now) / 86_400_000);
  const when = new Date(`${eventDate.slice(0, 10)}T12:00:00Z`)
    .toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  return (
    <div style={S.hero}>
      <div style={{ fontSize: 34, fontWeight: 700, fontFamily: "'Fraunces', serif", lineHeight: 1 }}>
        {days > 0 ? days : 0}
      </div>
      <div style={{ fontSize: 13, opacity: 0.85 }}>
        {days > 1 ? 'days to go' : days === 1 ? 'day to go' : 'today'} · {when}{shotgunTime ? ` · ${shotgunTime}` : ''}
      </div>
    </div>
  );
}

function TaskRow({ t, onToggle, onOpen }: { t: Task; onToggle: () => void; onOpen: () => void }) {
  return (
    <div style={S.taskRow}>
      <button onClick={onToggle} aria-label={t.completedAt ? 'Mark not done' : 'Mark done'} style={S.check}>
        {t.completedAt ? '✓' : ''}
      </button>
      <button onClick={onOpen} style={S.taskBody}>
        <strong style={{ fontSize: 15.5, display: 'block', color: t.completedAt ? '#8A9089' : 'var(--ink)', textDecoration: t.completedAt ? 'line-through' : 'none' }}>
          {t.title}
        </strong>
        {!t.completedAt && <span style={{ fontSize: 13.5, color: '#5C6B62', lineHeight: 1.5 }}>{t.lines[0]}</span>}
      </button>
    </div>
  );
}

function PreTournamentHub({ snap, doneCount, now, onOpenTask, onToggle, onHelp }: {
  snap: Snapshot; doneCount: number; now: number;
  onOpenTask: (id: string) => void; onToggle: (t: Task) => void; onHelp: () => void;
}) {
  return (
    <>
      <p style={S.kick}>{snap.tournamentName}</p>
      <h1 style={S.h1}>{snap.roleName}</h1>
      <Countdown eventDate={snap.eventDate} shotgunTime={snap.shotgunTime} now={now} />
      <p style={S.progress}>{doneCount} of {snap.tasks.length} done</p>
      {snap.tasks.map((t) => (
        <TaskRow key={t.id} t={t} onToggle={() => onToggle(t)} onOpen={() => onOpenTask(t.id)} />
      ))}
      {snap.inbox.length > 0 && (
        <div style={S.panel}>
          <p style={S.kick}>Updates</p>
          {snap.inbox.slice(0, 5).map((m) => (
            <p key={m.id} style={S.li}><strong>{m.subject}</strong>{m.body ? ` — ${m.body}` : ''}</p>
          ))}
        </div>
      )}
      <button onClick={onHelp} style={S.bigGhost}>Ask a question</button>
    </>
  );
}

function DayOfHub({ snap, nextTask, doneCount, onOpenTask, onToggle, onCheckIn, onPosition, onHelp, onWrap }: {
  snap: Snapshot; nextTask: Task | null; doneCount: number;
  onOpenTask: (id: string) => void; onToggle: (t: Task) => void;
  onCheckIn: () => void; onPosition: (p: string) => void; onHelp: () => void; onWrap: () => void;
}) {
  const [pos, setPos] = useState(snap.lastPosition ?? '');
  const latest = snap.firedTriggers[snap.firedTriggers.length - 1];
  return (
    <>
      <p style={S.kick}>Today · {snap.tournamentName}</p>
      <h1 style={S.h1}>{snap.roleName}</h1>

      {/* The single most useful thing on the day: what is happening RIGHT NOW. */}
      {latest && (
        <div style={{ ...S.hero, background: 'var(--primary)' }}>
          <div style={{ fontSize: 12, opacity: 0.85, letterSpacing: 0.6, textTransform: 'uppercase' }}>Now</div>
          <div style={{ fontSize: 20, fontWeight: 700, fontFamily: "'Fraunces', serif" }}>
            {TRIGGER_LABEL[latest.kind] ?? latest.kind}
          </div>
          <div style={{ fontSize: 12.5, opacity: 0.85 }}>{time(latest.firedAt)}</div>
        </div>
      )}

      <button onClick={onCheckIn} style={snap.checkedInAt ? S.bigGhost : S.bigBtn}>
        {snap.checkedInAt ? `Checked in at ${time(snap.checkedInAt)} — tap to undo` : 'I’m here — check me in'}
      </button>

      {nextTask && (
        <div style={{ ...S.panel, borderColor: 'var(--primary)' }}>
          <p style={S.kick}>Your next task</p>
          <strong style={{ fontSize: 16, display: 'block', marginBottom: 6 }}>{nextTask.title}</strong>
          {nextTask.lines.map((l, i) => <p key={i} style={S.li}>{l}</p>)}
          <button onClick={() => onToggle(nextTask)} style={S.bigBtn}>Mark this done</button>
        </div>
      )}

      <p style={S.progress}>{doneCount} of {snap.tasks.length} done</p>
      {snap.tasks.map((t) => (
        <TaskRow key={t.id} t={t} onToggle={() => onToggle(t)} onOpen={() => onOpenTask(t.id)} />
      ))}

      <div style={S.panel}>
        <p style={S.kick}>Where are you?</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={pos} onChange={(e) => setPos(e.target.value)} placeholder="e.g. hole 7, clubhouse"
            style={{ ...S.input, flex: 1 }} />
          <button onClick={() => onPosition(pos)} disabled={!pos.trim()} style={S.smallBtn}>Update</button>
        </div>
        <p style={S.fine}>Helps the organizer find you without ringing round.</p>
      </div>

      <button onClick={onHelp} style={S.bigGhost}>I need help</button>
      <button onClick={onWrap} style={S.textBtn}>Wrapping up →</button>
    </>
  );
}

function TaskDetail({ task, depth, onBack, onToggle }: {
  task: Task; depth: string; onBack: () => void; onToggle: () => void;
}) {
  const [full, setFull] = useState(depth === 'detailed');
  const lines = full ? task.allDepths.detailed : task.lines;
  return (
    <>
      <button onClick={onBack} style={S.back}>← Back</button>
      <h1 style={S.h1}>{task.title}</h1>
      {task.dueAt && <p style={S.kick}>Due {new Date(task.dueAt).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })}</p>}
      <div style={S.panel}>
        {lines.map((l, i) => (
          <p key={i} style={{ ...S.li, fontSize: 15, lineHeight: 1.65 }}>
            {full && lines.length > 1 ? <strong style={{ color: 'var(--primary)' }}>{i + 1}. </strong> : null}{l}
          </p>
        ))}
      </div>
      {!full && (
        <button onClick={() => setFull(true)} style={S.textBtn}>Show me the full steps</button>
      )}
      <button onClick={onToggle} style={task.completedAt ? S.bigGhost : S.bigBtn}>
        {task.completedAt ? 'Mark not done' : 'Mark this done'}
      </button>
    </>
  );
}

function Help({ snap, onBack, onSend }: {
  snap: Snapshot; onBack: () => void;
  onSend: (body: string, audience: 'organizer' | 'lead' | 'platform') => void;
}) {
  const [text, setText] = useState('');
  const [audience, setAudience] = useState<'organizer' | 'lead' | 'platform'>('organizer');
  return (
    <>
      <button onClick={onBack} style={S.back}>← Back</button>
      <h1 style={S.h1}>Need a hand?</h1>

      {snap.contacts.map((c) => (
        <div key={c.label} style={S.panel}>
          <p style={S.kick}>{c.label}</p>
          <strong style={{ fontSize: 16 }}>{c.name ?? 'Your organizer'}</strong>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            {c.phone && <a href={`tel:${c.phone}`} style={S.callBtn}>Call</a>}
            {c.phone && <a href={`sms:${c.phone}`} style={S.callBtn}>Text</a>}
            {c.email && <a href={`mailto:${c.email}`} style={S.callBtn}>Email</a>}
          </div>
        </div>
      ))}

      <div style={S.panel}>
        <p style={S.kick}>Or message in the app</p>
        {snap.messages.map((m) => (
          <div key={m.id} style={{
            margin: '6px 0', padding: '9px 12px', borderRadius: 12, fontSize: 14, lineHeight: 1.55,
            background: m.direction === 'from_volunteer' ? '#E7F1EA' : '#FAF8F3',
          }}>
            {m.body}
            <span style={{ display: 'block', fontSize: 10.5, color: '#8A9089', marginTop: 3 }}>
              {m.direction === 'from_volunteer' ? `You → ${m.audience}` : (m.senderName ?? 'Organizer')}
            </span>
          </div>
        ))}
        <select value={audience} onChange={(e) => setAudience(e.target.value as typeof audience)} style={S.input}>
          <option value="organizer">The organizer</option>
          <option value="lead">My team lead</option>
          <option value="platform">TourneyCoach support</option>
        </select>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3}
          placeholder="What do you need?" style={{ ...S.input, resize: 'vertical' }} />
        <button disabled={!text.trim()} onClick={() => { onSend(text, audience); setText(''); }} style={S.bigBtn}>
          Send
        </button>
        {audience === 'platform' && (
          <p style={S.fine}>Escalating reaches TourneyCoach directly, not just your organizer.</p>
        )}
      </div>
    </>
  );
}

function PostTournament({ snap, doneCount, onFeedback, onBack }: {
  snap: Snapshot; doneCount: number;
  onFeedback: (fb: Record<string, unknown>) => void; onBack: () => void;
}) {
  const [done, setDone] = useState(false);
  return (
    <>
      <h1 style={S.h1}>That&rsquo;s a wrap — thank you.</h1>
      <p style={S.p}>
        You finished <strong>{doneCount} of {snap.tasks.length}</strong> tasks as {snap.roleName} at {snap.tournamentName}.
        Tournaments like this only happen because people turn up.
      </p>

      {done ? (
        <div style={{ ...S.panel, background: '#E7F1EA', borderColor: '#B7E0C6' }}>
          <p style={{ ...S.p, margin: 0 }}>Thank you — that shapes how we brief you next time.</p>
        </div>
      ) : (
        <div style={S.panel}>
          <p style={S.kick}>Two quick questions</p>
          <p style={S.li}>How were the instructions?</p>
          <button onClick={() => { onFeedback({ wantsMoreDetail: true }); setDone(true); }} style={S.bigGhost}>
            I&rsquo;d have liked more detail
          </button>
          <button onClick={() => { onFeedback({ rating: 5 }); setDone(true); }} style={S.bigGhost}>
            About right
          </button>
          <button onClick={() => { onFeedback({ wantsLessDetail: true }); setDone(true); }} style={S.bigGhost}>
            Too much — keep it short
          </button>
          <p style={S.fine}>This tunes what you get next year. It is the only thing that overrides everything we infer.</p>
        </div>
      )}
      <button onClick={onBack} style={S.textBtn}>← Back to my tasks</button>
    </>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--cream)', padding: '18px 16px 60px' }}>
      <div style={{ maxWidth: 520, margin: '0 auto' }}>{children}</div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  h1: { fontFamily: "'Fraunces', serif", fontSize: 26, lineHeight: 1.2, color: 'var(--ink)', margin: '2px 0 12px' },
  kick: { fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: '#8A9089', margin: '0 0 6px' },
  p: { margin: '0 0 14px', fontSize: 15, lineHeight: 1.6, color: '#4A524C' },
  li: { margin: '0 0 8px', fontSize: 14, lineHeight: 1.6, color: '#4A524C' },
  fine: { margin: '10px 0 0', fontSize: 12, color: '#8A9089', lineHeight: 1.55 },
  dim: { color: '#8A9089', fontSize: 14 },
  panel: { background: '#fff', border: '1px solid var(--line)', borderRadius: 14, padding: 16, margin: '12px 0' },
  hero: { background: 'var(--deep-green, #14532d)', color: '#fff', borderRadius: 16, padding: '18px 20px', margin: '12px 0', textAlign: 'center' },
  progress: { fontSize: 12.5, fontWeight: 700, color: '#8A9089', letterSpacing: 0.4, textTransform: 'uppercase', margin: '16px 0 8px' },
  taskRow: { display: 'flex', gap: 12, alignItems: 'flex-start', background: '#fff', border: '1px solid var(--line)', borderRadius: 12, padding: 12, marginBottom: 8 },
  check: { width: 30, height: 30, minWidth: 30, borderRadius: 8, border: '2px solid var(--primary)', background: '#fff', color: 'var(--primary)', fontSize: 17, fontWeight: 800, cursor: 'pointer', lineHeight: 1 },
  taskBody: { flex: 1, textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit' },
  bigBtn: { width: '100%', background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 12, padding: '15px 18px', fontSize: 16, fontWeight: 700, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", marginTop: 10 },
  bigGhost: { width: '100%', background: '#fff', color: 'var(--ink)', border: '1px solid var(--line)', borderRadius: 12, padding: '14px 18px', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", marginTop: 8 },
  smallBtn: { background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 10, padding: '11px 15px', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  textBtn: { width: '100%', background: 'none', border: 'none', color: 'var(--primary)', fontSize: 14, fontWeight: 600, cursor: 'pointer', padding: '14px 0', fontFamily: "'DM Sans', sans-serif" },
  back: { background: 'none', border: 'none', color: 'var(--primary)', fontWeight: 600, fontSize: 14, cursor: 'pointer', padding: '4px 0 10px' },
  callBtn: { flex: 1, textAlign: 'center', background: 'var(--primary)', color: '#fff', borderRadius: 10, padding: '12px 14px', fontSize: 14.5, fontWeight: 700, textDecoration: 'none', minWidth: 84 },
  input: { width: '100%', border: '1px solid var(--line)', borderRadius: 10, padding: '12px 13px', fontSize: 16, fontFamily: 'inherit', boxSizing: 'border-box', marginBottom: 8, background: '#fff' },
  offline: { background: '#FBF0DC', color: '#7A5F16', borderRadius: 10, padding: '10px 13px', fontSize: 13, marginBottom: 12, lineHeight: 1.5 },
  note: { background: '#E7F1EA', color: '#1B6B3A', borderRadius: 10, padding: '10px 13px', fontSize: 13, marginBottom: 12 },
  err: { background: '#FBE9E7', color: '#B8442C', borderRadius: 10, padding: '10px 13px', fontSize: 13, marginBottom: 12 },
};
