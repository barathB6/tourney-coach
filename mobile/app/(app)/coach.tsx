import { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import ScreenHeader from '../../components/ScreenHeader';
import { useTournament } from '../../lib/useTournament';
import { supabase } from '../../lib/supabase';
import { config } from '../../lib/config';
import { colors, font } from '../../lib/theme';

type Msg = { role: 'user' | 'assistant'; content: string };
const STARTERS = ['How many volunteers do I need?', 'Boost registration to 75', 'How much should I charge per player?', 'Add a $2,500 sponsor'];

// Native AI Coach — same conversational coach as the web widget/page, talking
// to the same /api/gps... coach endpoint (which now also DOES things: change
// the event, add sponsors, open registration). React Native's fetch can't
// stream a body incrementally, so we read the whole SSE response and parse it
// (the reply lands when the model finishes rather than typing out).
export default function CoachScreen() {
  const { tournament } = useTournament();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [convId, setConvId] = useState<string | undefined>();
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => { scrollRef.current?.scrollToEnd({ animated: true }); }, [messages, busy]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setInput('');
    setMessages((m) => [...m, { role: 'user', content: message }]);
    setBusy(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`${config.apiBaseUrl}/api/coach/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ message, conversationId: convId, tournamentId: tournament?.id }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || `Coach unavailable (${res.status})`);
      }
      // Parse the whole SSE payload at once (no incremental streaming on RN).
      const body = await res.text();
      let reply = '';
      let actions: string[] = [];
      for (const line of body.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          const d = JSON.parse(line.slice(6));
          if (d.type === 'delta') { reply += d.text; if (d.conversationId) setConvId(d.conversationId); }
          if ((d.type === 'done' || d.type === 'error') && Array.isArray(d.actions)) actions = d.actions;
          if (d.type === 'error' && !reply) reply = 'Something went wrong — try again.';
        } catch { /* skip */ }
      }
      setMessages((m) => [...m, { role: 'assistant', content: reply.trim() || 'Sorry, I could not work that out — try rephrasing?' }]);
      // Actions changed the event — the dashboard re-reads on its next focus.
      void actions;
    } catch (e) {
      setMessages((m) => [...m, { role: 'assistant', content: e instanceof Error ? e.message : 'Connection lost — please try again.' }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <ScreenHeader title="AI Coach" subtitle={tournament?.name ?? 'Your tournament'} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={8}>
        <ScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={s.list} keyboardShouldPersistTaps="handled">
          {messages.length === 0 && (
            <View style={s.intro}>
              <Text style={s.introTitle}>Hey — I&rsquo;m your coach.</Text>
              <Text style={s.introBody}>Ask me anything about running your tournament, or just tell me what to change and I&rsquo;ll do it — like &ldquo;boost registration to 75&rdquo; or &ldquo;add ACME as a $2,500 sponsor.&rdquo;</Text>
            </View>
          )}
          {messages.map((m, i) => (
            <View key={i} style={[s.bubbleRow, { justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }]}>
              <View style={[s.bubble, m.role === 'user' ? s.user : s.assistant]}>
                <Text style={[s.bubbleText, m.role === 'user' && { color: '#fff' }]}>{m.content}</Text>
              </View>
            </View>
          ))}
          {busy && (
            <View style={[s.bubbleRow, { justifyContent: 'flex-start' }]}>
              <View style={[s.bubble, s.assistant, { flexDirection: 'row', alignItems: 'center', gap: 8 }]}>
                <ActivityIndicator size="small" color={colors.green} />
                <Text style={[s.bubbleText, { color: colors.muted }]}>Thinking…</Text>
              </View>
            </View>
          )}
        </ScrollView>

        {messages.length === 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips} keyboardShouldPersistTaps="handled">
            {STARTERS.map((q) => (
              <Pressable key={q} onPress={() => send(q)} style={s.chip}><Text style={s.chipText}>{q}</Text></Pressable>
            ))}
          </ScrollView>
        )}

        <View style={s.inputRow}>
          <TextInput
            style={s.input}
            value={input}
            onChangeText={setInput}
            placeholder="Ask your coach, or tell me what to change…"
            placeholderTextColor={colors.faint}
            multiline
            onSubmitEditing={() => send(input)}
            returnKeyType="send"
          />
          <Pressable onPress={() => send(input)} disabled={busy || !input.trim()} style={[s.sendBtn, (busy || !input.trim()) && { opacity: 0.5 }]}>
            <Text style={s.sendText}>Send</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.cream },
  list: { padding: 14, gap: 10 },
  intro: { backgroundColor: colors.greenSoft, borderColor: colors.greenBorder, borderWidth: 1, borderRadius: 14, padding: 16, marginBottom: 6 },
  introTitle: { fontFamily: font.serif, fontSize: 18, color: colors.ink, marginBottom: 6 },
  introBody: { fontFamily: font.sans, fontSize: 13.5, lineHeight: 20, color: colors.muted },
  bubbleRow: { flexDirection: 'row' },
  bubble: { maxWidth: '84%', borderRadius: 14, paddingHorizontal: 13, paddingVertical: 10 },
  user: { backgroundColor: colors.primary, borderBottomRightRadius: 4 },
  assistant: { backgroundColor: '#fff', borderColor: colors.line, borderWidth: 1, borderBottomLeftRadius: 4 },
  bubbleText: { fontFamily: font.sans, fontSize: 14, lineHeight: 20, color: colors.ink },
  chips: { paddingHorizontal: 12, paddingBottom: 8, gap: 8 },
  chip: { backgroundColor: '#fff', borderColor: colors.line, borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 7 },
  chipText: { fontFamily: font.sansMedium, fontSize: 12.5, color: colors.green },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 12, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.cream },
  input: { flex: 1, minHeight: 44, maxHeight: 120, borderColor: colors.line, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontFamily: font.sans, fontSize: 14, color: colors.ink, backgroundColor: '#fff' },
  sendBtn: { backgroundColor: colors.primary, borderRadius: 12, paddingHorizontal: 18, height: 44, alignItems: 'center', justifyContent: 'center' },
  sendText: { fontFamily: font.sansBold, fontSize: 14, color: '#fff' },
});
