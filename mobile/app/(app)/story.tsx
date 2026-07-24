import { useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import ScreenHeader from '../../components/ScreenHeader';
import { useAuth } from '../../lib/auth';
import { useTournament } from '../../lib/useTournament';
import { supabase } from '../../lib/supabase';
import { config } from '../../lib/config';
import { colors, font } from '../../lib/theme';

// Native Cause Story builder — the same guided flow as the web /story: two
// prompt steps, a full-story editor with AI refinement + a photo shot-list,
// and three length variants. Hits the same public AI endpoints
// (/api/cause-story/{refine,lengths,photos}) and saves with the same authed
// PUT /api/tournaments/[id] contract. A live donor-preview card mirrors the
// web's right-hand panel, adapted to a single phone column.

type PhotoRec = { type: string; reason: string; selected?: boolean };
type Field = { key: string; label: string; placeholder: string; hint: string; input?: 'number' | 'line' };

const STEPS: { title: string; subtitle: string; fields: Field[] }[] = [
  {
    title: 'The origin & impact',
    subtitle: "Who's behind this, who is helped, and what is the need?",
    fields: [
      { key: 'founder_connection', label: "Who is the founder/organizer, and what's the connection?", placeholder: "e.g., Our school opened with 36 students and our son was one of them. Six years later, the school is full — and there's a waiting list of families who want in but can't cover tuition.", hint: 'Your personal tie to this cause — why you started or run this event.' },
      { key: 'who_helped', label: 'Who is helped?', placeholder: "e.g., Students at St. Michael's Catholic School", hint: 'The students, families, or community this tournament supports.' },
      { key: 'need', label: 'What is the need?', placeholder: 'e.g., Without this funding, roughly 40% of enrolled families would need to leave within two years.', hint: 'What gap or problem does this funding actually close?' },
    ],
  },
  {
    title: 'The ask',
    subtitle: 'What does success look like, and why now?',
    fields: [
      { key: 'success_looks_like', label: 'What does success look like?', placeholder: 'e.g., This year we want to fund tuition for 20 students, up from 14 last year.', hint: 'A concrete outcome donors can rally behind.' },
      { key: 'why_now', label: 'Why now?', placeholder: 'e.g., The waiting list doubled this year, and tuition costs rose 8% — the gap is wider than it has ever been.', hint: "What makes this year's ask urgent." },
      { key: 'stat_amount', label: 'A number that brings it home', placeholder: 'e.g., 340', hint: 'A specific stat beats "many" or "a lot" every time.', input: 'number' },
      { key: 'stat_description', label: 'What does that number mean?', placeholder: 'e.g., Average tuition gap covered per foursome registration', hint: 'One short line — appears under the number.', input: 'line' },
    ],
  },
];

const STORY_STEP = STEPS.length;
const LENGTHS_STEP = STEPS.length + 1;
const TOTAL_STEPS = STEPS.length + 2;

// markdown-lite inline renderer (**bold**, *italic*) mirroring lib/richtext.
function Rich({ text, style }: { text: string; style?: object }) {
  const tokens = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).filter(Boolean);
  return (
    <Text style={style}>
      {tokens.map((tok, i) => {
        if (tok.startsWith('**') && tok.endsWith('**')) return <Text key={i} style={{ fontFamily: font.sansBold }}>{tok.slice(2, -2)}</Text>;
        if (tok.startsWith('*') && tok.endsWith('*')) return <Text key={i} style={{ fontStyle: 'italic' }}>{tok.slice(1, -1)}</Text>;
        return <Text key={i}>{tok}</Text>;
      })}
    </Text>
  );
}

function DonorPreview({ headline, body, statAmount, statDescription, empty }: { headline?: string; body: string[]; statAmount?: string; statDescription?: string; empty: string }) {
  const hasAny = headline || body.length > 0 || statAmount || statDescription;
  return (
    <View style={s.donor}>
      <View style={s.donorBadge}><Text style={s.donorBadgeText}>LIVE DONOR VIEW</Text></View>
      {!hasAny ? (
        <Text style={s.donorEmpty}>{empty}</Text>
      ) : (
        <View style={{ gap: 14 }}>
          {!!headline && <Rich text={headline} style={s.donorHead} />}
          {body.map((p, i) => <Rich key={i} text={p} style={s.donorBody} />)}
          {(!!statAmount || !!statDescription) && (
            <View style={s.statCard}>
              {!!statAmount && <Text style={s.statNum}>${statAmount}</Text>}
              {!!statDescription && <Text style={s.statDesc}>{statDescription}</Text>}
            </View>
          )}
        </View>
      )}
    </View>
  );
}

export default function CauseStoryScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const { tournament, loading: tLoading } = useTournament();
  const uid = session?.user.id;
  const tid = tournament?.id;

  const [step, setStep] = useState(0);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [hydrated, setHydrated] = useState(false);

  const [fullStory, setFullStory] = useState('');
  const [prevFullStory, setPrevFullStory] = useState<string | null>(null);
  const [refining, setRefining] = useState(false);
  const [medium, setMedium] = useState('');
  const [short, setShort] = useState('');
  const [oneLiner, setOneLiner] = useState('');
  const [generatingLengths, setGeneratingLengths] = useState(false);
  const [photoRecs, setPhotoRecs] = useState<PhotoRec[]>([]);
  const [generatingPhotos, setGeneratingPhotos] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Load any saved story off the tournament record; fall back to a local draft
  // (same precedence as the web builder).
  useEffect(() => {
    if (tLoading || hydrated) return;
    let cancelled = false;
    (async () => {
      let answers: Record<string, string> | null = null;
      if (tid) {
        const { data } = await supabase
          .from('tournaments')
          .select('cause_story_answers, cause_story_full, cause_story_medium, cause_story_short, cause_story_one_liner, cause_story_photo_recs')
          .eq('id', tid)
          .maybeSingle();
        if (cancelled) return;
        if (data) {
          if (data.cause_story_full) setFullStory(data.cause_story_full);
          if (data.cause_story_medium) setMedium(data.cause_story_medium);
          if (data.cause_story_short) setShort(data.cause_story_short);
          if (data.cause_story_one_liner) setOneLiner(data.cause_story_one_liner);
          if (Array.isArray(data.cause_story_photo_recs)) setPhotoRecs(data.cause_story_photo_recs);
          if (data.cause_story_answers) answers = data.cause_story_answers;
        }
      }
      if (!answers && uid) {
        try {
          const saved = await AsyncStorage.getItem(`tourney_story_${uid}`);
          if (saved) answers = JSON.parse(saved);
        } catch { /* corrupt or missing draft — start blank */ }
      }
      if (!cancelled) {
        if (answers) setFields((prev) => ({ ...prev, ...answers }));
        setHydrated(true);
      }
    })();
    return () => { cancelled = true; };
  }, [tLoading, tid, uid, hydrated]);

  const update = (key: string, value: string) => setFields((prev) => ({ ...prev, [key]: value }));

  const preview = useMemo(() => {
    const paragraph1 = [fields.who_helped && `This tournament exists for ${fields.who_helped}.`, fields.need].filter(Boolean).join(' ');
    const paragraph2 = [fields.success_looks_like, fields.why_now].filter(Boolean).join(' ');
    const body = [paragraph1, paragraph2].filter(Boolean) as string[];
    return { headline: fields.founder_connection, body, statAmount: fields.stat_amount?.trim(), statDescription: fields.stat_description?.trim() };
  }, [fields]);

  const persistDraft = async () => {
    if (uid) { try { await AsyncStorage.setItem(`tourney_story_${uid}`, JSON.stringify(fields)); } catch { /* non-fatal */ } };
  };

  const advanceToStory = async () => {
    await persistDraft();
    if (!fullStory) setFullStory([preview.headline, ...preview.body].filter(Boolean).join('\n\n'));
    setStep(STORY_STEP);
  };

  async function callAI(path: string, payload: object): Promise<Record<string, unknown>> {
    const res = await fetch(`${config.apiBaseUrl}/api/cause-story/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || 'AI request failed');
    return data as Record<string, unknown>;
  }

  const handleRefine = async () => {
    if (!fullStory.trim()) { setError('Write your story first.'); return; }
    setRefining(true); setError('');
    try {
      const data = await callAI('refine', { draft: fullStory });
      setPrevFullStory(fullStory);
      setFullStory(String(data.suggestion || ''));
    } catch (e) { setError(e instanceof Error ? e.message : 'AI refinement failed'); }
    finally { setRefining(false); }
  };

  const undoRefine = () => { if (prevFullStory !== null) { setFullStory(prevFullStory); setPrevFullStory(null); } };

  const handleGenerateLengths = async () => {
    if (!fullStory.trim()) { setError('Write your story first.'); return; }
    setGeneratingLengths(true); setError('');
    try {
      const data = await callAI('lengths', { fullStory });
      setMedium(String(data.medium || '')); setShort(String(data.short || '')); setOneLiner(String(data.oneLiner || ''));
    } catch (e) { setError(e instanceof Error ? e.message : 'AI length generation failed'); }
    finally { setGeneratingLengths(false); }
  };

  const handleGeneratePhotos = async () => {
    if (!fullStory.trim()) { setError('Write your story first.'); return; }
    setGeneratingPhotos(true); setError('');
    try {
      const data = await callAI('photos', { fullStory });
      const recs = (Array.isArray(data.recommendations) ? data.recommendations : []) as PhotoRec[];
      const prevSelected = new Set(photoRecs.filter((r) => r.selected).map((r) => r.type));
      setPhotoRecs(recs.map((r) => ({ ...r, selected: prevSelected.has(r.type) })));
    } catch (e) { setError(e instanceof Error ? e.message : 'AI photo recommendations failed'); }
    finally { setGeneratingPhotos(false); }
  };

  const togglePhotoRec = (i: number) => setPhotoRecs((prev) => prev.map((r, idx) => (idx === i ? { ...r, selected: !r.selected } : r)));

  const handleFinish = async () => {
    await persistDraft();
    if (!tid) { router.back(); return; }
    setSaving(true); setError('');
    try {
      const { data: { session: sess } } = await supabase.auth.getSession();
      const res = await fetch(`${config.apiBaseUrl}/api/tournaments/${tid}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sess?.access_token}` },
        body: JSON.stringify({
          cause_story_answers: fields,
          cause_story_full: fullStory || null,
          cause_story_medium: medium || null,
          cause_story_short: short || null,
          cause_story_one_liner: oneLiner || null,
          cause_story_photo_recs: photoRecs,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError((data as { error?: string; errors?: { message: string }[] }).error || (data as { errors?: { message: string }[] }).errors?.[0]?.message || 'Failed to save your story');
        setSaving(false);
        return;
      }
    } catch {
      setError('Could not save — check your connection and try again.');
      setSaving(false);
      return;
    }
    setSaving(false);
    router.back();
  };

  const Progress = () => (
    <View style={s.progress}>
      {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
        <View key={i} style={[s.seg, { backgroundColor: i <= step ? colors.primary : colors.line }]} />
      ))}
    </View>
  );

  const selectedCount = photoRecs.filter((r) => r.selected).length;

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <ScreenHeader title="Cause story" subtitle={tournament?.name ?? 'Your tournament'} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={8}>
        <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
          <Progress />

          {/* ── PROMPT STEPS ── */}
          {step < STEPS.length && (
            <>
              <Text style={s.eyebrow}>Step {step + 1} of {TOTAL_STEPS} · {STEPS[step].title}</Text>
              <Text style={s.h1}>{STEPS[step].subtitle}</Text>
              <View style={{ gap: 18, marginTop: 6 }}>
                {STEPS[step].fields.map((f) => (
                  <View key={f.key}>
                    <Text style={s.label}>{f.label}</Text>
                    {f.input === 'number' ? (
                      <View style={s.numRow}>
                        <Text style={s.dollar}>$</Text>
                        <TextInput
                          style={[s.input, { flex: 1 }]}
                          value={fields[f.key] || ''}
                          onChangeText={(v) => update(f.key, v.replace(/[^0-9,]/g, ''))}
                          placeholder={f.placeholder} placeholderTextColor={colors.faint}
                          keyboardType="number-pad"
                        />
                      </View>
                    ) : f.input === 'line' ? (
                      <TextInput style={s.input} value={fields[f.key] || ''} onChangeText={(v) => update(f.key, v)} placeholder={f.placeholder} placeholderTextColor={colors.faint} />
                    ) : (
                      <TextInput style={[s.input, s.multiline]} value={fields[f.key] || ''} onChangeText={(v) => update(f.key, v)} placeholder={f.placeholder} placeholderTextColor={colors.faint} multiline />
                    )}
                    <Text style={s.hint}>{f.hint}</Text>
                  </View>
                ))}
              </View>

              <DonorPreview {...preview} empty="Start writing above — your donor story appears here as you go." />

              <View style={s.navRow}>
                {step > 0 ? <Pressable style={s.btnGhost} onPress={() => setStep(step - 1)}><Text style={s.btnGhostText}>← Back</Text></Pressable> : <View />}
                <Pressable style={s.btnPrimary} onPress={() => (step < STEPS.length - 1 ? setStep(step + 1) : advanceToStory())}>
                  <Text style={s.btnPrimaryText}>Continue →</Text>
                </Pressable>
              </View>
            </>
          )}

          {/* ── FULL STORY ── */}
          {step === STORY_STEP && (
            <>
              <Text style={s.eyebrow}>Step {step + 1} of {TOTAL_STEPS}</Text>
              <Text style={s.h1}>Your full cause story</Text>
              <Text style={s.sub}>This is what appears on your microsite. Edit it directly, or let AI refine it.</Text>

              <TextInput style={[s.input, s.story]} value={fullStory} onChangeText={setFullStory} placeholder="Your composed story appears here — edit freely." placeholderTextColor={colors.faint} multiline />
              <View style={s.storyActions}>
                <Pressable style={[s.btnFill, refining && { opacity: 0.6 }]} onPress={handleRefine} disabled={refining}>
                  {refining ? <ActivityIndicator size="small" color="#fff" /> : <Text style={s.btnFillText}>✨ Refine with AI</Text>}
                </Pressable>
                {prevFullStory !== null && <Pressable onPress={undoRefine}><Text style={s.undo}>Undo AI refinement</Text></Pressable>}
              </View>

              <DonorPreview
                headline={fullStory.split(/\n\n+/).map((p) => p.trim()).filter(Boolean)[0]}
                body={fullStory.split(/\n\n+/).map((p) => p.trim()).filter(Boolean).slice(1)}
                statAmount={preview.statAmount} statDescription={preview.statDescription}
                empty="Edit your story above — the donor view appears here."
              />

              <Text style={[s.h2, { marginTop: 26 }]}>Photo recommendations</Text>
              <Text style={s.sub}>What kinds of photos would make your microsite land.{photoRecs.length > 0 ? ' Tap the shots you plan to get.' : ''}</Text>
              <Pressable style={[s.btnOutline, generatingPhotos && { opacity: 0.6 }]} onPress={handleGeneratePhotos} disabled={generatingPhotos}>
                {generatingPhotos ? <ActivityIndicator size="small" color={colors.primary} /> : <Text style={s.btnOutlineText}>{photoRecs.length > 0 ? 'Regenerate suggestions' : 'Get photo suggestions'}</Text>}
              </Pressable>
              {photoRecs.map((rec, i) => (
                <Pressable key={i} onPress={() => togglePhotoRec(i)} style={[s.recCard, rec.selected && s.recCardOn]}>
                  <View style={[s.recBox, rec.selected && s.recBoxOn]}><Text style={s.recCheck}>{rec.selected ? '✓' : ''}</Text></View>
                  <View style={{ flex: 1 }}>
                    <Text style={s.recType}>{rec.type}</Text>
                    <Text style={s.recReason}>{rec.reason}</Text>
                  </View>
                </Pressable>
              ))}
              {selectedCount > 0 && <Text style={s.recCount}>{selectedCount} shot{selectedCount === 1 ? '' : 's'} on your list — saved with your story.</Text>}

              {!!error && <Text style={s.error}>{error}</Text>}
              <View style={s.navRow}>
                <Pressable style={s.btnGhost} onPress={() => setStep(STEPS.length - 1)}><Text style={s.btnGhostText}>← Back</Text></Pressable>
                <Pressable style={s.btnPrimary} onPress={() => setStep(LENGTHS_STEP)}><Text style={s.btnPrimaryText}>Continue →</Text></Pressable>
              </View>
            </>
          )}

          {/* ── LENGTH VARIANTS ── */}
          {step === LENGTHS_STEP && (
            <>
              <Text style={s.eyebrow}>Step {step + 1} of {TOTAL_STEPS} · Length variants</Text>
              <Text style={s.h1}>One story, three lengths</Text>
              <Text style={s.sub}>Used across sponsor packages, social captions, and the registration form.</Text>

              <Pressable style={[s.btnOutline, generatingLengths && { opacity: 0.6 }]} onPress={handleGenerateLengths} disabled={generatingLengths}>
                {generatingLengths ? <ActivityIndicator size="small" color={colors.primary} /> : <Text style={s.btnOutlineText}>Generate from full cause story</Text>}
              </Pressable>

              <View style={{ gap: 18, marginTop: 4 }}>
                <View>
                  <Text style={s.label}>Medium — sponsor packages</Text>
                  <TextInput style={[s.input, s.multiline]} value={medium} onChangeText={setMedium} multiline placeholder="2–3 sentences for sponsor materials." placeholderTextColor={colors.faint} />
                </View>
                <View>
                  <Text style={s.label}>Short — social captions</Text>
                  <TextInput style={[s.input, s.multiline]} value={short} onChangeText={setShort} multiline placeholder="1–2 sentences for social." placeholderTextColor={colors.faint} />
                </View>
                <View>
                  <Text style={s.label}>One-liner — registration form</Text>
                  <TextInput style={s.input} value={oneLiner} onChangeText={setOneLiner} placeholder="A single punchy line." placeholderTextColor={colors.faint} />
                </View>
              </View>

              {(!!medium.trim() || !!short.trim() || !!oneLiner.trim()) && (
                <View style={s.donor}>
                  <View style={s.donorBadge}><Text style={s.donorBadgeText}>LIVE PREVIEW</Text></View>
                  <View style={{ gap: 12 }}>
                    <View style={s.varCard}><Text style={s.varLab}>SPONSOR PACKAGE</Text><Text style={[s.varText, medium.trim() ? { fontStyle: 'italic' } : null]}>{medium.trim() ? `“${medium}”` : 'Generate or write a medium version.'}</Text></View>
                    <View style={s.varCard}><Text style={s.varLab}>SOCIAL CAPTION</Text><Text style={s.varText}>{short.trim() || 'Generate or write a short version.'}</Text></View>
                    <View style={s.varCard}><Text style={s.varLab}>REGISTRATION HERO</Text><Text style={[s.varText, oneLiner.trim() ? { fontStyle: 'italic' } : null]}>{oneLiner.trim() || 'Write a one-liner.'}</Text></View>
                  </View>
                </View>
              )}

              {!!error && <Text style={s.error}>{error}</Text>}
              <View style={s.navRow}>
                <Pressable style={s.btnGhost} onPress={() => setStep(STORY_STEP)}><Text style={s.btnGhostText}>← Back</Text></Pressable>
                <Pressable style={[s.btnPrimary, saving && { opacity: 0.6 }]} onPress={handleFinish} disabled={saving}>
                  {saving ? <ActivityIndicator size="small" color="#fff" /> : <Text style={s.btnPrimaryText}>Save →</Text>}
                </Pressable>
              </View>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.cream },
  scroll: { padding: 18, paddingBottom: 40 },
  progress: { flexDirection: 'row', gap: 6, marginBottom: 20 },
  seg: { flex: 1, height: 4, borderRadius: 999 },

  eyebrow: { fontFamily: font.sansBold, fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase', color: colors.primary, marginBottom: 4 },
  h1: { fontFamily: font.serif, fontSize: 23, lineHeight: 29, color: colors.deepGreen, marginBottom: 6 },
  h2: { fontFamily: font.serif, fontSize: 18, color: colors.deepGreen, marginBottom: 4 },
  sub: { fontFamily: font.sans, fontSize: 13.5, lineHeight: 20, color: colors.muted, marginBottom: 12 },

  label: { fontFamily: font.sansBold, fontSize: 13.5, color: colors.ink, marginBottom: 6 },
  hint: { fontFamily: font.sans, fontSize: 12, color: colors.muted, marginTop: 5 },
  input: { borderWidth: 1, borderColor: colors.line, borderRadius: 10, backgroundColor: '#fff', paddingHorizontal: 12, paddingVertical: 11, fontFamily: font.sans, fontSize: 14.5, lineHeight: 21, color: colors.ink },
  multiline: { minHeight: 66, textAlignVertical: 'top' },
  story: { minHeight: 190, textAlignVertical: 'top', marginTop: 2 },
  numRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dollar: { fontFamily: font.sansBold, fontSize: 15, color: colors.ink },

  storyActions: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 10 },
  btnFill: { backgroundColor: colors.primary, borderRadius: 999, paddingVertical: 9, paddingHorizontal: 16, minWidth: 150, alignItems: 'center' },
  btnFillText: { fontFamily: font.sansBold, fontSize: 13, color: '#fff' },
  undo: { fontFamily: font.sansMedium, fontSize: 13, color: colors.primary },

  btnOutline: { borderWidth: 1, borderColor: colors.primary, borderRadius: 10, backgroundColor: '#fff', paddingVertical: 11, alignItems: 'center', marginBottom: 14, marginTop: 2 },
  btnOutlineText: { fontFamily: font.sansMedium, fontSize: 14, color: colors.primary },

  recCard: { flexDirection: 'row', gap: 11, alignItems: 'flex-start', backgroundColor: '#F0F4F2', borderWidth: 1.5, borderColor: 'transparent', borderRadius: 12, padding: 13, marginBottom: 9 },
  recCardOn: { backgroundColor: colors.greenSoft, borderColor: colors.primary },
  recBox: { width: 20, height: 20, borderRadius: 6, borderWidth: 1.5, borderColor: '#B9C4BC', alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  recBoxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  recCheck: { color: '#fff', fontSize: 12, fontFamily: font.sansBold },
  recType: { fontFamily: font.sansBold, fontSize: 14, color: colors.primary },
  recReason: { fontFamily: font.sans, fontSize: 13, lineHeight: 19, color: colors.muted, marginTop: 2 },
  recCount: { fontFamily: font.sansMedium, fontSize: 12.5, color: colors.primary, marginTop: 2, marginBottom: 4 },

  donor: { backgroundColor: colors.deepGreen, borderRadius: 16, padding: 20, marginTop: 22 },
  donorBadge: { alignSelf: 'flex-start', backgroundColor: colors.gold, borderRadius: 5, paddingVertical: 4, paddingHorizontal: 9, marginBottom: 16 },
  donorBadgeText: { fontFamily: font.sansBold, fontSize: 9.5, letterSpacing: 1.2, color: colors.deepGreen },
  donorEmpty: { fontFamily: font.sans, fontSize: 13.5, lineHeight: 20, color: 'rgba(234,242,237,0.6)' },
  donorHead: { fontFamily: font.serif, fontSize: 22, lineHeight: 28, color: '#fff' },
  donorBody: { fontFamily: font.sans, fontSize: 14, lineHeight: 21, color: 'rgba(250,248,243,0.85)' },
  statCard: { backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', borderRadius: 16, padding: 18, marginTop: 4 },
  statNum: { fontFamily: font.serif, fontSize: 40, color: colors.gold },
  statDesc: { fontFamily: font.sans, fontSize: 14.5, lineHeight: 20, color: 'rgba(250,248,243,0.85)', marginTop: 6 },

  varCard: { backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', borderRadius: 12, padding: 13 },
  varLab: { fontFamily: font.sansBold, fontSize: 9.5, letterSpacing: 0.9, color: 'rgba(255,255,255,0.55)', marginBottom: 6 },
  varText: { fontFamily: font.sans, fontSize: 13.5, lineHeight: 20, color: 'rgba(250,248,243,0.9)' },

  error: { fontFamily: font.sans, fontSize: 13.5, color: colors.alert, marginTop: 16 },
  navRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 26 },
  btnGhost: { borderWidth: 1, borderColor: colors.line, borderRadius: 10, backgroundColor: '#fff', paddingVertical: 11, paddingHorizontal: 18 },
  btnGhostText: { fontFamily: font.sansMedium, fontSize: 14, color: colors.ink },
  btnPrimary: { backgroundColor: colors.primary, borderRadius: 10, paddingVertical: 11, paddingHorizontal: 22, minWidth: 108, alignItems: 'center' },
  btnPrimaryText: { fontFamily: font.sansBold, fontSize: 14, color: '#fff' },
});
