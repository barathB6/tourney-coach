// Shared coaching content: Demo Mode scripts, phrasing aliases, and the
// proactive-nudge engine. Single source of truth for both the full coach
// page (app/coach/page.tsx) and the floating CoachWidget so the two never
// drift out of sync.
//
// All "answer" fields are short bullet points ("- " lines) — quick to
// scan, and toPlainText() renders them as "•" for display while stripping
// them entirely for speech. "spoken" fields are separate, already-short
// flowing sentences meant for text-to-speech, not bulleted.

export const SCRIPTS: Record<string, { answer: string; spoken?: string; followups: string[] }> = {
  "how do i fill my field": {
    answer: "- Map your network first: board, staff, donors, volunteers, past attendees\n- A 72-player field is only 18 foursomes — most orgs find 40-50 players before outreach even starts\n- For the rest, send a TourneyCircle notification to charitable golfers within 25 miles\n- $29 per send, typically delivers 3-5 foursomes who've already proven they show up",
    spoken: "Your personal network gets you most of the way there, and TourneyCircle fills the rest. For 29 dollars, TourneyCoach notifies hundreds of local charitable golfers on your behalf — one organizer recently filled 4 foursomes and brought in 2,400 dollars from a single send.",
    followups: ["How does TourneyCircle work?", "What should I charge?", "How do I get sponsors?"],
  },
  "what should i charge": {
    answer: "- First-year scramble sweet spot: $100-$125/player ($400-$500/foursome)\n- Premium course: $150-$175 is expected\n- 72 players at $125 = $9,000 in entry fees alone\n- Add $8,000-$10,000 in sponsorships → $17,000-$19,000 gross\n- After costs: $9,200-$13,400 net to your cause in Year 1",
    spoken: "For a local scramble, charge 100 to 125 dollars per player. At 72 players that's 9,000 dollars in entry fees before a single sponsor dollar. Add solid sponsorships and your cause nets up to 13,000 dollars in Year 1.",
    followups: ["How much will we raise?", "What expenses should I plan for?", "How do I get sponsors?"],
  },
  "how does tourneycircle work": {
    answer: "- A network of charitable golfers who played a prior event and opted in\n- $29 sends a notification on your behalf to every matched player nearby\n- Includes your tournament name, date, course, cause story, and a registration link\n- You never see names/emails — just results: notified, clicked, registered, revenue\n- Top 5 groups on the Circle of Excellence leaderboard earn a free foursome each season",
    spoken: "TourneyCircle is a network of charitable golfers who've already played in a TourneyCoach event and asked to hear about more. For 29 dollars, we notify everyone in your area on your behalf. You keep the registrations — we protect their privacy.",
    followups: ["How do I fill my field?", "What is TourneyCircle of Excellence?", "How much will we raise?"],
  },
  "how much will we raise": {
    answer: "- Well-run first year, 72 players, solid sponsors: $10,000-$18,000 net\n- Industry average is $29,500 (NGF) — but that's skewed by large established events\n- Realistic Year 1 target: $12,000-$15,000 net\n- Path: $9,000 entry fees + $8,000-$10,000 sponsorships + $2,000-$4,000 mulligans/contests\n- Year 3, with returning sponsors and TourneyCircle: typically $20,000-$35,000",
    spoken: "A well-run first-year event should net 10 to 18 thousand dollars. By Year 3, with returning sponsors and TourneyCircle, you're typically looking at 20 to 35 thousand. TourneyCoach is built to close that gap faster.",
    followups: ["What should I charge?", "How do I get sponsors?", "What expenses should I plan for?"],
  },
  "how do i get sponsors": {
    answer: "- Entry fees cover your costs — sponsors fund your cause, so this is where real money is\n- Hole sponsorships: $250-$500 each × 18 holes = $4,500-$9,000 from signs alone\n- Add Presenting ($3,000-$5,000), Gold ($1,500-$2,500), Silver ($750-$1,000)\n- A solid menu adds $10,000-$15,000 to your gross\n- Best first targets: medical practices, law firms, financial advisors, local restaurants",
    spoken: "Sponsorships fund your cause — entry fees just cover costs. Start with hole sponsorships at 250 to 500 dollars each, that's up to 9,000 dollars right there. Add a presenting sponsor and you're looking at 10 to 15 thousand in total sponsorship revenue.",
    followups: ["What packages should I offer?", "Who should I ask to sponsor?", "How do sponsors pay?"],
  },
  "what packages should i offer": {
    answer: "- A tight menu of 4-5 tiers converts better than a long list\n- Title Sponsor $5,000 — name on the event, logo everywhere, a foursome included, 1 available\n- Eagle $2,500, Birdie $1,000, Hole $250 (18 available)\n- Add 1-2 specialty tiers (Beverage Cart, Putting Contest, Dinner) at $500-$1,500\n- Build these in the package builder — set price, benefits, quantity — each tier shows a live Sold count",
    spoken: "Keep it to four or five tiers. A Title sponsor at 5,000 dollars anchors the menu, then Eagle at 2,500, Birdie at 1,000, and Hole sponsors at 250 with 18 available. Add a specialty tier like beverage cart or putting contest to give smaller businesses a moment to own.",
    followups: ["Who should I ask to sponsor?", "How do sponsors pay?", "How do I write a sponsor email?"],
  },
  "who should i ask to sponsor": {
    answer: "- First ring: businesses already connected to your cause — board members' companies, vendors, families the cause has helped. These convert fastest\n- Second ring: local businesses that run on community goodwill — medical/dental, law firms, financial advisors, dealerships, restaurants, real estate\n- Add each to your prospect pipeline in TourneyCoach\n- It tracks who you've contacted, who replied, and who's gone quiet",
    spoken: "Start with businesses already connected to your cause — board members' companies, vendors you pay, families you've helped. Then local businesses that run on community goodwill: dentists, law firms, financial advisors, restaurants. Add each to your prospect pipeline and TourneyCoach tracks who you've contacted and who's gone quiet.",
    followups: ["How do I write a sponsor email?", "A sponsor hasn't replied", "What packages should I offer?"],
  },
  "how do i write a sponsor email": {
    answer: "- Keep it short, specific, personal — it should ask for a reply, not a signature\n- Open with a genuine local hook tying the business to your cause\n- Name one specific package, its price, and its two best benefits\n- Close with a low-friction ask: a 10-minute call or a simple yes\n- TourneyCoach's AI drafts this for you, pulling a real detail from your cause story",
    spoken: "Keep it short, specific, and personal. Open with a local hook tied to your cause, name one package with its price and two best benefits, and close by asking for a 10-minute call. TourneyCoach's AI drafts the whole thing for you using a real detail from your cause story — you just review and send.",
    followups: ["A sponsor hasn't replied", "Who should I ask to sponsor?", "How do sponsors pay?"],
  },
  "a sponsor hasn't replied": {
    answer: "- Silence usually means busy, not no — most sponsorships close on the 2nd or 3rd touch\n- Wait about a week, send one short warm follow-up with one new reason to say yes\n- Don't apologize for following up — you're offering them something good\n- TourneyCoach auto-follows-up on a 7-day cadence, capped at two attempts\n- Anyone still quiet gets flagged so you can decide on a personal call",
    spoken: "Silence usually means busy, not no — most sponsorships close on the second or third touch. Wait about a week and send one short follow-up with a new reason to say yes. TourneyCoach does this automatically on a 7-day cadence, capped at two attempts so you're never a pest.",
    followups: ["How do I write a sponsor email?", "How do I recognize sponsors?", "Who should I ask to sponsor?"],
  },
  "how do sponsors pay": {
    answer: "- Sponsors can buy their own package online — no chasing checks\n- Your microsite has a public sponsorship page with every tier and how many are left\n- They pick a level, enter details, pay by card — availability updates automatically\n- Paid by check or transfer instead? Mark them paid manually — they still get a confirmation and logo prompt",
    spoken: "Sponsors buy online themselves. Your microsite has a public sponsorship page with every tier — a business picks a level, enters their details, and pays by card right there. Availability updates automatically so you never oversell. And if someone pays by check, you mark them paid manually and they still get a confirmation and logo prompt.",
    followups: ["How do I recognize sponsors?", "What packages should I offer?", "How do I write a sponsor email?"],
  },
  "how do i recognize sponsors": {
    answer: "- Recognition turns a one-time sponsor into a returning one\n- Once paid, sponsors are prompted to upload their logo — it flows to your microsite automatically\n- TourneyCoach builds a recognition list grouped by tier (Title, Eagle, Birdie, ...)\n- Print it for the program or hand it to your emcee for the awards script\n- Every paid sponsor appears automatically, always current up to tee-off",
    spoken: "Recognition is what turns a one-time sponsor into a returning one. The moment a sponsor pays, they upload their logo and it flows straight onto your microsite. For event day, TourneyCoach builds a recognition list grouped by tier, ready to print for the program or hand to your emcee.",
    followups: ["How do sponsors pay?", "What packages should I offer?", "How much will we raise?"],
  },
  "what expenses should i plan for": {
    answer: "- Well-managed first year runs $8,600-$12,800 all in\n- Golf course: $5,400-$7,200 for 72 players at charity rate — always ask for it\n- Food and beverage: $1,200-$2,500\n- Trophies: $400-$800; event shirts: $864-$1,080\n- Hole signs $350-$600, hole-in-one insurance $350-$600 (worth it — get a sponsor to cover it), TourneyCircle $29\n- Goal: get sponsors covering as many line items as possible",
    spoken: "Total expenses for a first-year event run 8,600 to 12,800 dollars. The golf course is your biggest cost. Always ask for the charity rate. Your goal is to get sponsors covering as many line items as possible — that is where the real profit margin gets built.",
    followups: ["How much will we raise?", "How do I get sponsors?", "What should I charge?"],
  },
  "what is tourneycircle of excellence": {
    answer: "- TourneyCoach's prestige rewards tier — players ranked by tournaments played and dollars donated across all events\n- Leaderboard updates in real time, filterable by region or all-time\n- Top 5 groups each season earn a complimentary foursome at any TourneyCoach event\n- Also a sponsorship asset — businesses pay $2,500-$5,000 for their name on the leaderboard and foursome certificates",
    spoken: "The Circle of Excellence ranks charitable golfers by tournaments played and dollars donated. Top 5 groups each season earn a free foursome. It keeps your most loyal players competing and giving all year — and it's a valuable sponsorship asset.",
    followups: ["How does TourneyCircle work?", "How do I fill my field?", "How much will we raise?"],
  },
  "how do i register": {
    answer: "- Registration runs entirely through TourneyCoach — no spreadsheets, no manual check collection\n- Your tournament gets a white-label microsite at YourEventName.TourneyCoach.com automatically\n- Players click the link, enter team details, pay directly — straight to your cause minus a small fee\n- Every registration tracks live in your dashboard: who's in, foursomes, spots remaining\n- Registration closes automatically at field capacity",
    spoken: "Registration runs through your TourneyCoach microsite — players click your link, enter their team info, and pay online. You see every registration in real time on your dashboard. No spreadsheets, no chasing checks.",
    followups: ["What should I charge?", "How do I fill my field?", "How does TourneyCircle work?"],
  },
  "how does scoring work": {
    answer: "- Scramble format, one key rule: par is your friend — teams pick up at par on any hole\n- Saves 30-45 minutes across the round, keeps pace smooth, prevents frustration\n- Scores entered hole-by-hole through the TourneyCoach mobile app\n- Live leaderboard updates instantly on a clubhouse TV — creates real excitement on the back nine\n- Pace-of-play tracker shows every group's position on the course in real time",
    spoken: "TourneyCoach uses scramble format with one key rule — par is your friend, teams pick up at par. It saves 30 to 45 minutes and keeps the energy high all day. Scores update live on a leaderboard that players can follow on their phones or a TV in the clubhouse.",
    followups: ["How does the leaderboard work?", "What should I charge?", "How do I fill my field?"],
  },
  "how does day-of scoring work": {
    answer: "- Scramble format, one key rule: par is your friend — teams pick up at par on any hole\n- Saves 30-45 minutes across the round, keeps pace smooth, prevents frustration\n- Scores entered hole-by-hole through the TourneyCoach mobile app\n- Live leaderboard updates instantly on a clubhouse TV — creates real excitement on the back nine\n- Pace-of-play tracker shows every group's position on the course in real time",
    spoken: "TourneyCoach uses scramble format with one key rule — par is your friend, teams pick up at par. It saves 30 to 45 minutes and keeps the energy high all day. Scores update live on a leaderboard that players can follow on their phones or a TV in the clubhouse.",
    followups: ["How does the leaderboard work?", "What should I charge?", "How do I fill my field?"],
  },
  "how does the leaderboard work": {
    answer: "- Updates in real time as teams submit scores hole-by-hole through the app\n- Display on any TV via a simple browser URL — no app needed on the screen\n- Players check it constantly on the back nine — creates genuine competitive energy\n- Pace-of-play tracker runs alongside, showing every group's course position\n- Kitchen notification fires automatically 45 minutes before the last group finishes",
    spoken: "The live leaderboard updates in real time as teams score each hole. Display it on any TV with a browser URL — no setup required. Players follow it on their phones through the back nine. And the pace tracker automatically notifies the kitchen 45 minutes before the last group finishes.",
    followups: ["How does scoring work?", "How does TourneyCircle work?", "How much will we raise?"],
  },
  "how much does it cost to register on tourneycoach": {
    answer: "- Free for charity organizers to get started — setup, AI coaching, registration, scoring, leaderboard all included\n- Platform fee: ~2.5% on entry fee payments processed (e.g. $225 on a $9,000 gross)\n- Optional to pass through to players or absorb — most add $5/player to cover it\n- TourneyCircle notification: $29/send\n- Corporate TourneyCircle memberships: $199-$299/year",
    spoken: "TourneyCoach is free to get started for charity organizers. The platform earns a small fee on entry payments processed — about 2.5%. The TourneyCircle notification is 29 dollars per send. Everything else including AI coaching, live scoring, and the leaderboard is included.",
    followups: ["How does TourneyCircle work?", "How much will we raise?", "How do I get sponsors?"],
  },
  "what is the kitchen notification": {
    answer: "- Solves the classic problem: lunch either sits cold or isn't ready when groups finish\n- Pace-of-play tracker monitors every group's course position in real time\n- When the last group is ~45 minutes out, it auto-fires a notification to the kitchen\n- No organizer action required — lunch is ready exactly when the last team walks off 18\n- One of the best conversation openers when pitching a course partnership",
    spoken: "The kitchen notification fires automatically 45 minutes before the last group finishes — based on real-time pace tracking, no manual action needed. The kitchen is always ready when players walk off 18. Golf pros love this feature more than anything else TourneyCoach does.",
    followups: ["How does the leaderboard work?", "How does scoring work?", "How do I get sponsors?"],
  },

  // ── Day 13 topic-specific coaching modules ──────────────────────────────
  "how do i price registration": {
    answer: "- Price for a full field first, profit second — an empty course raises nothing\n- First-year scramble sweet spot: $100-$125/player ($400-$500/foursome); premium course $150-$175\n- Pricing low to \"be accessible\" usually backfires — it signals a smaller event\n- Decide in 3 steps: start from course cost → add your margin → sanity-check nearby events\n- Set it once during setup — it flows to your registration page and every projection",
    spoken: "Price for a full field first. For a first-year scramble, 100 to 125 dollars per player is the sweet spot — 150 to 175 at a premium course. Pricing low to be accessible usually backfires; charity golfers expect to pay real money for a real cause. Start from your course cost, add your margin, and sanity-check against nearby events.",
    followups: ["How much will we raise?", "What should sponsorship packages look like?", "What does a successful Year 1 look like?"],
  },
  "what should sponsorship packages look like": {
    answer: "- A tight ladder of 4-5 tiers converts far better than a long menu\n- Title Sponsor $5,000 — name on the event, logo everywhere, a foursome, 1 available\n- Eagle $2,500, Birdie $1,000, Hole $250 (18 available)\n- Add one specialty tier (Beverage Cart, Putting Contest, Dinner) at $500-$1,500\n- Name concrete, visible benefits — signage, program listing, players — not vague \"recognition\"",
    spoken: "Keep it to four or five tiers. Anchor with a Title sponsor at 5,000 dollars, then Eagle at 2,500, Birdie at 1,000, and Hole sponsors at 250 with 18 available. Add a specialty tier like beverage cart or putting contest for smaller businesses. Name concrete visible benefits, not vague recognition.",
    followups: ["Who should I ask to sponsor?", "How do I write a sponsor email?", "How much will we raise?"],
  },
  "how do i find volunteers": {
    answer: "- Need fewer than you think: ~10-15 for a 72-player event\n- Start with the cause itself — people it serves and their families\n- Then board, staff, and their spouses\n- Then local groups needing service hours — honor societies, scouts, church groups\n- Give each one a clearly-named role (registration, scoring, marshal, setup)\n- Microsite sign-up form collects name/contact/role automatically — no spreadsheet",
    spoken: "You need about 10 to 15 volunteers for a 72-player event. Start with the people your cause serves and their families, then your board and staff, then local groups needing service hours — honor societies, scouts, church groups. Give each one a clearly named role. TourneyCoach's microsite collects sign-ups automatically.",
    followups: ["What does a successful Year 1 look like?", "How do I get vendor donations?", "How do I fill my field?"],
  },
  "how do i get vendor donations": {
    answer: "- In-kind donations stretch every dollar — margin you keep for the cause\n- Ask businesses you already spend money with first: caddie shop, beverage distributor, printer\n- Then local restaurants (gift cards), breweries (kegs), sporting-goods stores (raffle items)\n- Make a specific ask tied to recognition: name the exact item, offer a program listing or sign\n- Track these as in-kind sponsors — they show up on your recognition list alongside cash sponsors",
    spoken: "In-kind donations are margin you keep for the cause. Ask the businesses you already spend money with first — your beverage distributor, your printer. Then local restaurants for gift cards, breweries for kegs, sporting-goods stores for raffle items. Make a specific ask tied to recognition: name the exact item and offer a program listing or sign.",
    followups: ["Who should I ask to sponsor?", "How do I find volunteers?", "What does a successful Year 1 look like?"],
  },
  "what does a successful year 1 look like": {
    answer: "- Not measured only in dollars — a full field, a smooth day, sponsors who want to come back\n- Well-run first year, 72 players, solid sponsors: $10,000-$18,000 net\n- Real win: 5-10 sponsors who had a great experience — they renew and upgrade in Year 2\n- Year 2 jumps to $20,000-$35,000 with returning sponsors\n- Protect three things: don't overprice into an empty field, don't skimp on the day, thank everyone personally",
    spoken: "A successful first year isn't just dollars — it's a full field, a smooth day, and sponsors who want to come back. The numbers: 10 to 18 thousand net for a well-run first event. But the real win is the foundation — sponsors who renew and upgrade in Year 2, when events jump to 20 to 35 thousand. Don't overprice into an empty field, don't skimp on the day, and thank everyone personally.",
    followups: ["What should I charge?", "What should sponsorship packages look like?", "How do I find volunteers?"],
  },
  "how do i write a cause story": {
    answer: "- Be specific, not sweeping — one real person or moment beats broad statistics\n- Lead with a concrete detail: a name, a number, a single scene\n- \"14 kids stayed in school last year\" beats \"we support education\"\n- Explain in a sentence or two exactly what the money does\n- Close with the ask: what this year's event will make possible\n- Keep it to 3 short paragraphs — sponsors and players skim, they don't read essays",
    spoken: "The best cause stories are specific — one real person or moment beats broad statistics. Lead with a concrete detail, explain in a sentence what the money does, and close with what this year's event will make possible. Keep it to three short paragraphs. TourneyCoach's cause story builder walks you through it step by step.",
    followups: ["What does a successful Year 1 look like?", "How do I get sponsors?", "How do I fill my field?"],
  },

  // ── Escalate to human ───────────────────────────────────────────────────
  // The static answer below is the no-phone-on-file fallback. Both
  // CoachWidget and the full /coach page call escalationAnswer() instead,
  // which personalizes with the organizer's own phone number when they've
  // added one to their profile — see resolveScriptKey()/ESCALATION_KEY.
  "i need to talk to a human": {
    answer: "- You should never feel stuck\n- Email admin@tourneycoach.com — a real person replies within about one business day\n- Time-sensitive? Put your tournament name and date in the subject line",
    spoken: "You should never feel stuck. For anything I can't answer, or when you'd rather talk to a person, email the TourneyCoach team at admin at tourneycoach dot com and a real human will get back to you, usually within one business day.",
    followups: ["What does a successful Year 1 look like?", "How do I fill my field?", "How do I get sponsors?"],
  },
};

export const FAQ_CHIPS = ["How do I fill my field?", "How do I price registration?", "What should sponsorship packages look like?", "How do I find volunteers?", "How do I get vendor donations?", "What does a successful Year 1 look like?"];

// Common phrasings that should resolve to a canonical scripted topic —
// especially the human-escalation intent, which people phrase many ways.
export const SCRIPT_ALIASES: Record<string, string> = {
  'talk to a human': 'i need to talk to a human',
  'talk to a person': 'i need to talk to a human',
  'speak to someone': 'i need to talk to a human',
  'speak to a human': 'i need to talk to a human',
  'can i talk to a person': 'i need to talk to a human',
  'this isn\'t helping': 'i need to talk to a human',
  'you\'re not helping': 'i need to talk to a human',
  'i need real help': 'i need to talk to a human',
  'contact support': 'i need to talk to a human',
  'how do i price my registration': 'how do i price registration',
  'how should i price registration': 'how do i price registration',
  'what should my sponsorship packages look like': 'what should sponsorship packages look like',
  'how do i get volunteers': 'how do i find volunteers',
  'where do i find volunteers': 'how do i find volunteers',
  'how do i get in-kind donations': 'how do i get vendor donations',
  'what does a good first year look like': 'what does a successful year 1 look like',
  'what does a successful first year look like': 'what does a successful year 1 look like',
};

// The canonical key for the escalation script — exported so callers can
// special-case it (to build a phone-personalized answer) before falling
// back to lookupScript()'s static text.
export const ESCALATION_KEY = 'i need to talk to a human';

export function resolveScriptKey(text: string): string {
  const key = text.toLowerCase().trim().replace(/[?!.]+$/, '');
  return SCRIPT_ALIASES[key] ?? key;
}

export function lookupScript(text: string) {
  const resolved = resolveScriptKey(text);
  for (const [k, v] of Object.entries(SCRIPTS)) {
    if (resolved === k) return v;
  }
  return null;
}

// Builds the escalate-to-human answer, personalized with the organizer's
// own phone number when they've provided one in their profile — so the
// coach can offer "reply here and we'll call you" instead of email-only.
export function escalationAnswer(phone?: string | null): { answer: string; spoken: string; followups: string[] } {
  const trimmedPhone = phone?.trim();
  const answer = trimmedPhone
    ? `- You should never feel stuck\n- Email admin@tourneycoach.com — a real person replies within about one business day\n- Prefer a call? We have ${trimmedPhone} on file — reply here and we'll ring you\n- Time-sensitive? Put your tournament name and date in the subject line`
    : SCRIPTS[ESCALATION_KEY].answer;
  const spoken = trimmedPhone
    ? `You should never feel stuck. Email admin at tourneycoach dot com and a real human will get back to you, usually within one business day. We also have your phone number on file, so just reply here and we'll call you instead.`
    : SCRIPTS[ESCALATION_KEY].spoken!;
  return { answer, spoken, followups: SCRIPTS[ESCALATION_KEY].followups };
}

export function daysOut(dateStr: string) {
  return Math.max(0, Math.round((new Date(dateStr).getTime() - Date.now()) / 86400000));
}

// ── Proactive coaching triggers ──────────────────────────────────────────
// Surfaces at most two gentle, dismissible nudges based on where the
// tournament actually is. Tone: supportive and optional — never pushy.
export interface Nudge { id: string; text: string; question: string; }
export function computeNudges(state: {
  daysOut: number | null;
  regCount: number;
  maxPlayers: number;
  sponsorSold: number;
  sponsorTotal: number;
  causeStoryDone: boolean;
}): Nudge[] {
  const nudges: Nudge[] = [];
  const { daysOut: d, regCount, maxPlayers, sponsorSold, sponsorTotal, causeStoryDone } = state;
  const fieldPct = maxPlayers > 0 ? regCount / maxPlayers : 0;
  const sponsorPct = sponsorTotal > 0 ? sponsorSold / sponsorTotal : 0;
  const soon = d != null && d <= 45;
  const dLabel = d != null ? `${d} day${d === 1 ? '' : 's'}` : 'some time';

  if (!causeStoryDone) {
    nudges.push({
      id: 'cause-story',
      text: "Your cause story isn't written yet — it's the single thing that makes sponsors say yes and players show up. Want to talk through what makes a great one?",
      question: 'How do I write a cause story?',
    });
  }
  if (sponsorTotal === 0) {
    nudges.push({
      id: 'no-sponsors',
      text: "You haven't set up sponsorship packages yet — sponsorships are 50 to 70% of tournament revenue. Want to see what a good package menu looks like?",
      question: 'What should sponsorship packages look like?',
    });
  } else if (soon && sponsorPct < 0.5) {
    nudges.push({
      id: 'sponsor-outreach',
      text: `You're ${dLabel} out and only ${sponsorSold} of ${sponsorTotal} sponsorships are sold. Want to walk through outreach strategy?`,
      question: 'How do I write a sponsor email?',
    });
  }
  if (soon && maxPlayers > 0 && fieldPct < 0.5) {
    nudges.push({
      id: 'fill-field',
      text: `You're ${dLabel} out with ${regCount} of ${maxPlayers} spots filled. Want to talk through how to fill the rest?`,
      question: 'How do I fill my field?',
    });
  }
  if (nudges.length === 0 && fieldPct >= 0.75) {
    nudges.push({
      id: 'day-of',
      text: `Nice work — you're ${Math.round(fieldPct * 100)}% full. Want to start thinking about day-of logistics so the event runs smoothly?`,
      question: 'How does day-of scoring work?',
    });
  }
  return nudges.slice(0, 2);
}
