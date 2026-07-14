// Shared coaching content: Demo Mode scripts, phrasing aliases, and the
// proactive-nudge engine. Single source of truth for both the full coach
// page (app/coach/page.tsx) and the floating CoachWidget so the two never
// drift out of sync.

export const SCRIPTS: Record<string, { answer: string; spoken?: string; followups: string[] }> = {
  "how do i fill my field": {
    answer: "Your personal network gets you most of the way there — and TourneyCircle fills the rest.\n\nMap everyone your charity knows: board members, staff, donors, volunteers, past attendees. A 72-player field is only 18 foursomes. Most organizations can identify 40 to 50 players before they even start outreach.\n\nFor the remaining spots, send a TourneyCircle notification to registered charitable golfers within 25 miles. $29, and it typically delivers 3 to 5 foursomes of people who have already proven they will show up and play for a cause.",
    spoken: "Your personal network gets you most of the way there, and TourneyCircle fills the rest. For 29 dollars, TourneyCoach notifies hundreds of local charitable golfers on your behalf — one organizer recently filled 4 foursomes and brought in 2,400 dollars from a single send.",
    followups: ["How does TourneyCircle work?", "What should I charge?", "How do I get sponsors?"],
  },
  "what should i charge": {
    answer: "For a first-year scramble, $100 to $125 per player is the sweet spot — $400 to $500 per foursome. At a premium course, $150 to $175 is expected. Price it right and fill the field with TourneyCircle.\n\nThe math on 72 players at $125: $9,000 in entry fees. Add $8,000 to $10,000 in sponsorships and you're at $17,000 to $19,000 gross. After costs, your cause nets $9,200 to $13,400 in Year 1.",
    spoken: "For a local scramble, charge 100 to 125 dollars per player. At 72 players that's 9,000 dollars in entry fees before a single sponsor dollar. Add solid sponsorships and your cause nets up to 13,000 dollars in Year 1.",
    followups: ["How much will we raise?", "What expenses should I plan for?", "How do I get sponsors?"],
  },
  "how does tourneycircle work": {
    answer: "TourneyCircle is TourneyCoach's network of charitable golfers who played a previous event and opted in to hear about more tournaments near them.\n\nFor $29, TourneyCoach sends a notification on your behalf to every matched player in your radius — your tournament name, date, course, cause story, and a direct registration link. You never see their names or emails. You see results: notified, clicked, registered, and revenue.\n\nThe TourneyCircle of Excellence leaderboard rewards top players by tournaments and giving. Top 5 groups earn a complimentary foursome each season.",
    spoken: "TourneyCircle is a network of charitable golfers who've already played in a TourneyCoach event and asked to hear about more. For 29 dollars, we notify everyone in your area on your behalf. You keep the registrations — we protect their privacy.",
    followups: ["How do I fill my field?", "What is TourneyCircle of Excellence?", "How much will we raise?"],
  },
  "how much will we raise": {
    answer: "A well-run first-year event with 72 players and solid sponsorships should net $10,000 to $18,000 for your charity. The industry average is $29,500 per the National Golf Foundation — but that is skewed by large established events. A realistic Year 1 target is $12,000 to $15,000 net.\n\nThe path: $9,000 in entry fees, plus $8,000 to $10,000 in sponsorships, plus $2,000 to $4,000 from mulligans and contests. After costs, $9,200 to $14,400 net to your cause.\n\nThe Year 3 version — with returning sponsors and a TourneyCircle audience who already know you — typically raises $20,000 to $35,000.",
    spoken: "A well-run first-year event should net 10 to 18 thousand dollars. By Year 3, with returning sponsors and TourneyCircle, you're typically looking at 20 to 35 thousand. TourneyCoach is built to close that gap faster.",
    followups: ["What should I charge?", "How do I get sponsors?", "What expenses should I plan for?"],
  },
  "how do i get sponsors": {
    answer: "Sponsorships are where the real money is — entry fees pay your costs, sponsors fund your cause.\n\nStart with hole sponsorships at $250 to $500 each. 18 holes is $4,500 to $9,000 from signs alone. Add a Presenting Sponsor at $3,000 to $5,000, Gold at $1,500 to $2,500, Silver at $750 to $1,000. A solid menu adds $10,000 to $15,000 to your gross.\n\nBest first targets: medical practices, law firms, financial advisors, local restaurants — businesses that already support your cause. TourneyCoach includes outreach scripts and a sponsorship package builder.",
    spoken: "Sponsorships fund your cause — entry fees just cover costs. Start with hole sponsorships at 250 to 500 dollars each, that's up to 9,000 dollars right there. Add a presenting sponsor and you're looking at 10 to 15 thousand in total sponsorship revenue.",
    followups: ["What packages should I offer?", "Who should I ask to sponsor?", "How do sponsors pay?"],
  },
  "what packages should i offer": {
    answer: "A tight menu of 4 to 5 tiers converts better than a long list. Here's a proven ladder:\n\nTitle Sponsor at $5,000 — event named for them, logo on everything, a foursome included. One available, and it's your anchor. Then Eagle at $2,500, Birdie at $1,000, and Hole at $250 with 18 available.\n\nAdd one or two specialty tiers that let a smaller business own a moment: Beverage Cart, Putting Contest, or Dinner sponsor at $500 to $1,500. In TourneyCoach you build these in the package builder — set the price, benefits, and how many are available, and each one gets a Sold count as they fill.",
    spoken: "Keep it to four or five tiers. A Title sponsor at 5,000 dollars anchors the menu, then Eagle at 2,500, Birdie at 1,000, and Hole sponsors at 250 with 18 available. Add a specialty tier like beverage cart or putting contest to give smaller businesses a moment to own.",
    followups: ["Who should I ask to sponsor?", "How do sponsors pay?", "How do I write a sponsor email?"],
  },
  "who should i ask to sponsor": {
    answer: "Start with businesses that already have a reason to say yes — then work outward.\n\nFirst ring: anyone connected to your cause. Board members' companies, vendors your charity already pays, families the cause has helped. These convert fastest.\n\nSecond ring: local businesses that live on community goodwill — medical and dental practices, law firms, financial advisors, car dealerships, restaurants, real estate brokers. Add each one to your prospect pipeline in TourneyCoach, and it tracks who you've contacted, who replied, and who's gone quiet so nothing slips.",
    spoken: "Start with businesses already connected to your cause — board members' companies, vendors you pay, families you've helped. Then local businesses that run on community goodwill: dentists, law firms, financial advisors, restaurants. Add each to your prospect pipeline and TourneyCoach tracks who you've contacted and who's gone quiet.",
    followups: ["How do I write a sponsor email?", "A sponsor hasn't replied", "What packages should I offer?"],
  },
  "how do i write a sponsor email": {
    answer: "The best outreach email is short, specific, and personal — it asks for a reply, not a signature.\n\nOpen with a genuine local hook that ties the business to your cause. Name one specific package, its price, and its two best benefits. Close with a low-friction ask: a 10-minute call or a simple yes.\n\nTourneyCoach drafts this for you. Add the prospect, pick a package, and the AI writes a personalized email that pulls a real detail from your cause story — so it reads like you wrote it, not a template. You review, tweak, and send. Then it tracks opens and clicks so you know who's actually interested.",
    spoken: "Keep it short, specific, and personal. Open with a local hook tied to your cause, name one package with its price and two best benefits, and close by asking for a 10-minute call. TourneyCoach's AI drafts the whole thing for you using a real detail from your cause story — you just review and send.",
    followups: ["A sponsor hasn't replied", "Who should I ask to sponsor?", "How do sponsors pay?"],
  },
  "a sponsor hasn't replied": {
    answer: "Silence usually means busy, not no. Most sponsorships close on the second or third touch.\n\nWait about a week, then send one short, warm follow-up — reference your first note, add one new reason to say yes, and keep the ask small. Don't apologize for following up; you're offering them something good.\n\nTourneyCoach handles this automatically. A prospect who hasn't responded gets a follow-up on a 7-day cadence, capped at two attempts so you're never a pest. Anyone who's gone quiet is flagged in your pipeline so you can decide whether to make one personal call to close it.",
    spoken: "Silence usually means busy, not no — most sponsorships close on the second or third touch. Wait about a week and send one short follow-up with a new reason to say yes. TourneyCoach does this automatically on a 7-day cadence, capped at two attempts so you're never a pest.",
    followups: ["How do I write a sponsor email?", "How do I recognize sponsors?", "Who should I ask to sponsor?"],
  },
  "how do sponsors pay": {
    answer: "Sponsors can buy their package themselves, online, without you chasing a check.\n\nYour microsite has a public sponsorship page listing every tier with its benefits and how many are left. A business picks a level, enters their details, and pays by card right there — the money flows to your cause the same way entry fees do. The tier's availability updates automatically so you never oversell.\n\nYou can also mark a sponsor paid manually if they hand you a check or pay by transfer — either way, they get a confirmation email and a prompt to upload their logo.",
    spoken: "Sponsors buy online themselves. Your microsite has a public sponsorship page with every tier — a business picks a level, enters their details, and pays by card right there. Availability updates automatically so you never oversell. And if someone pays by check, you mark them paid manually and they still get a confirmation and logo prompt.",
    followups: ["How do I recognize sponsors?", "What packages should I offer?", "How do I write a sponsor email?"],
  },
  "how do i recognize sponsors": {
    answer: "Recognition is what turns a one-time sponsor into a returning one — and TourneyCoach automates most of it.\n\nThe moment a sponsor pays, they're prompted to upload their logo, and it flows straight onto your event microsite under Our Sponsors. No back-and-forth over email attachments.\n\nFor event day, TourneyCoach builds a recognition list grouped by tier — Title at the top, then Eagle, Birdie, and so on — ready to print for the program or hand to your emcee for the awards ceremony script. Every paid sponsor shows up automatically, so the list is always current right up to tee-off.",
    spoken: "Recognition is what turns a one-time sponsor into a returning one. The moment a sponsor pays, they upload their logo and it flows straight onto your microsite. For event day, TourneyCoach builds a recognition list grouped by tier, ready to print for the program or hand to your emcee.",
    followups: ["How do sponsors pay?", "What packages should I offer?", "How much will we raise?"],
  },
  "what expenses should i plan for": {
    answer: "A well-managed first-year event runs $8,600 to $12,800 all in.\n\nGolf course: $5,400 to $7,200 for 72 players at charity rate — always ask for it. Food and beverage: $1,200 to $2,500. Trophies: $400 to $800. Event shirts: $864 to $1,080.\n\nSmaller items: hole signs $350 to $600, hole-in-one insurance $350 to $600 — always worth it and get a sponsor to cover it — and the TourneyCircle notification at just $29.\n\nGoal: get sponsors covering as many line items as possible.",
    spoken: "Total expenses for a first-year event run 8,600 to 12,800 dollars. The golf course is your biggest cost. Always ask for the charity rate. Your goal is to get sponsors covering as many line items as possible — that is where the real profit margin gets built.",
    followups: ["How much will we raise?", "How do I get sponsors?", "What should I charge?"],
  },
  "what is tourneycircle of excellence": {
    answer: "TourneyCircle of Excellence is TourneyCoach's prestige rewards tier — players ranked by tournaments played and dollars donated across all TourneyCoach events.\n\nThe leaderboard updates in real time, filterable by region or all-time. The top 5 groups each season earn a complimentary foursome at any TourneyCoach event.\n\nIt is also a sponsorship asset — a law firm or medical group will pay $2,500 to $5,000 to have their name on the Circle of Excellence leaderboard and the foursome certificates.",
    spoken: "The Circle of Excellence ranks charitable golfers by tournaments played and dollars donated. Top 5 groups each season earn a free foursome. It keeps your most loyal players competing and giving all year — and it's a valuable sponsorship asset.",
    followups: ["How does TourneyCircle work?", "How do I fill my field?", "How much will we raise?"],
  },
  "how do i register": {
    answer: "Registering players for your tournament is handled entirely through TourneyCoach — no spreadsheets, no manual collection of checks.\n\nWhen you set up your tournament, TourneyCoach generates a white-label microsite at YourEventName.TourneyCoach.com automatically. Share that link with players, post it on social media, or embed it in your email campaign. Players click through, enter their team details, and pay their entry fee directly — it goes straight to your cause minus a small processing fee.\n\nEvery registration is tracked in your organizer dashboard in real time. You see who has registered, who is in each foursome, and how many spots remain. When you hit your field capacity, registration closes automatically.",
    spoken: "Registration runs through your TourneyCoach microsite — players click your link, enter their team info, and pay online. You see every registration in real time on your dashboard. No spreadsheets, no chasing checks.",
    followups: ["What should I charge?", "How do I fill my field?", "How does TourneyCircle work?"],
  },
  "how does scoring work": {
    answer: "TourneyCoach uses a scramble format with one important rule: par is your friend. Teams pick up at par on any hole.\n\nIn a 4-man scramble, reaching par is a genuine achievement — especially for higher handicappers. The pick-up-at-par rule saves 30 to 45 minutes across the round, keeps pace of play smooth, and prevents the frustration that kills the energy at charity events. Players leave happy instead of exhausted.\n\nScores are entered through the TourneyCoach mobile app hole by hole. The live leaderboard updates instantly on a TV screen in the clubhouse — players check it at every turn and it creates genuine excitement through the back nine. The pace-of-play tracker shows every group's position on the course in real time.",
    spoken: "TourneyCoach uses scramble format with one key rule — par is your friend, teams pick up at par. It saves 30 to 45 minutes and keeps the energy high all day. Scores update live on a leaderboard that players can follow on their phones or a TV in the clubhouse.",
    followups: ["How does the leaderboard work?", "What should I charge?", "How do I fill my field?"],
  },
  "how does day-of scoring work": {
    answer: "TourneyCoach uses a scramble format with one important rule: par is your friend. Teams pick up at par on any hole.\n\nIn a 4-man scramble, reaching par is a genuine achievement — especially for higher handicappers. The pick-up-at-par rule saves 30 to 45 minutes across the round, keeps pace of play smooth, and prevents the frustration that kills the energy at charity events. Players leave happy instead of exhausted.\n\nScores are entered through the TourneyCoach mobile app hole by hole. The live leaderboard updates instantly on a TV screen in the clubhouse — players check it at every turn and it creates genuine excitement through the back nine. The pace-of-play tracker shows every group's position on the course in real time.",
    spoken: "TourneyCoach uses scramble format with one key rule — par is your friend, teams pick up at par. It saves 30 to 45 minutes and keeps the energy high all day. Scores update live on a leaderboard that players can follow on their phones or a TV in the clubhouse.",
    followups: ["How does the leaderboard work?", "What should I charge?", "How do I fill my field?"],
  },
  "how does the leaderboard work": {
    answer: "The live leaderboard is one of TourneyCoach's most visible features on event day — and one of the things players talk about most afterward.\n\nAs teams submit scores hole by hole through the TourneyCoach app, the leaderboard updates in real time. You display it on a TV screen in the clubhouse or the turn station using a simple browser URL — no app required on the display screen. Players check it constantly on the back nine, which creates genuine competitive energy at a charity event.\n\nThe pace-of-play tracker runs alongside it, showing every group's position on the course. When the last group is 45 minutes from finishing, TourneyCoach automatically sends the kitchen notification to the course — so lunch is ready exactly when the last team walks off 18.",
    spoken: "The live leaderboard updates in real time as teams score each hole. Display it on any TV with a browser URL — no setup required. Players follow it on their phones through the back nine. And the pace tracker automatically notifies the kitchen 45 minutes before the last group finishes.",
    followups: ["How does scoring work?", "How does TourneyCircle work?", "How much will we raise?"],
  },
  "how much does it cost to register on tourneycoach": {
    answer: "TourneyCoach is free for charity organizers to get started. The core platform — tournament setup, AI coaching, registration, live scoring, and leaderboard — is available at no upfront cost so first-time organizers can run their first event without any financial risk.\n\nTourneyCoach earns a small platform fee on entry fee payments processed through the system — typically 2.5% on top of standard payment processing. On a $9,000 entry fee gross, that is $225. The platform fee is optional to pass through to players or absorb — most organizers add $5 per player to cover it.\n\nThe TourneyCircle notification is $29 per send. Corporate player memberships for TourneyCircle are $199 to $299 per year. Everything else — AI coaching, live scoring, leaderboard, pace tracker, kitchen notification — is included.",
    spoken: "TourneyCoach is free to get started for charity organizers. The platform earns a small fee on entry payments processed — about 2.5%. The TourneyCircle notification is 29 dollars per send. Everything else including AI coaching, live scoring, and the leaderboard is included.",
    followups: ["How does TourneyCircle work?", "How much will we raise?", "How do I get sponsors?"],
  },
  "what is the kitchen notification": {
    answer: "The kitchen notification is the single most valuable feature TourneyCoach offers to golf course professionals — and it is the best conversation opener when you are pitching a course partnership.\n\nHere is the problem it solves: every charity tournament ends with either lunch sitting cold for two hours because the kitchen prepared it too early, or groups arriving at the clubhouse to find nothing ready. Both kill the energy at the end of a great day.\n\nTourneyCoach's pace-of-play tracker monitors every group's position on the course in real time. When the data shows the last group is approximately 45 minutes from finishing, the system automatically fires a notification to the kitchen — no organizer action required. Lunch is ready when the last team walks off 18. Every time. The golf pro never has to manage it.",
    spoken: "The kitchen notification fires automatically 45 minutes before the last group finishes — based on real-time pace tracking, no manual action needed. The kitchen is always ready when players walk off 18. Golf pros love this feature more than anything else TourneyCoach does.",
    followups: ["How does the leaderboard work?", "How does scoring work?", "How do I get sponsors?"],
  },

  // ── Day 13 topic-specific coaching modules ──────────────────────────────
  "how do i price registration": {
    answer: "Price for a full field first, profit second — an empty course raises nothing.\n\nFor a first-year scramble, $100 to $125 per player ($400 to $500 per foursome) is the sweet spot. At a premium course, $150 to $175 is expected. The instinct to price low to \"be accessible\" usually backfires: it signals a smaller event and leaves money on the table, since the people who sponsor and play charity golf expect to pay real money for a real cause.\n\nDecide it in three steps: (1) start from your course's per-player cost, (2) add your target margin for the cause, (3) sanity-check against nearby charity events. In TourneyCoach you set the fee once during setup and it flows to your registration page and every projection.",
    spoken: "Price for a full field first. For a first-year scramble, 100 to 125 dollars per player is the sweet spot — 150 to 175 at a premium course. Pricing low to be accessible usually backfires; charity golfers expect to pay real money for a real cause. Start from your course cost, add your margin, and sanity-check against nearby events.",
    followups: ["How much will we raise?", "What should sponsorship packages look like?", "What does a successful Year 1 look like?"],
  },
  "what should sponsorship packages look like": {
    answer: "A tight ladder of 4 to 5 tiers converts far better than a long menu.\n\nAnchor with a Title Sponsor at $5,000 — event named for them, logo on everything, a foursome included, just one available. Then Eagle at $2,500, Birdie at $1,000, and Hole at $250 with 18 available. Add one specialty tier that lets a smaller business own a moment: Beverage Cart, Putting Contest, or Dinner sponsor at $500 to $1,500.\n\nEach tier should name concrete, visible benefits — signage, program listing, players included — not vague \"recognition.\" In TourneyCoach you build these in the package builder, set how many of each are available, and every tier shows a live Sold count as they fill.",
    spoken: "Keep it to four or five tiers. Anchor with a Title sponsor at 5,000 dollars, then Eagle at 2,500, Birdie at 1,000, and Hole sponsors at 250 with 18 available. Add a specialty tier like beverage cart or putting contest for smaller businesses. Name concrete visible benefits, not vague recognition.",
    followups: ["Who should I ask to sponsor?", "How do I write a sponsor email?", "How much will we raise?"],
  },
  "how do i find volunteers": {
    answer: "You need fewer volunteers than you think — about 10 to 15 for a 72-player event — and most come from three warm sources.\n\nStart with the cause itself: the people your charity serves and their families are usually eager to give back for a day. Then your board, staff, and their spouses. Then local groups that need service hours — high school honor societies, college clubs, scout troops, and church groups.\n\nGive each volunteer one clearly-named role (registration, scoring, hole marshal, setup) so they know exactly what they're signing up for. TourneyCoach's microsite has a volunteer sign-up form that collects name, contact, and role automatically, and you manage the whole list from your dashboard — no spreadsheet.",
    spoken: "You need about 10 to 15 volunteers for a 72-player event. Start with the people your cause serves and their families, then your board and staff, then local groups needing service hours — honor societies, scouts, church groups. Give each one a clearly named role. TourneyCoach's microsite collects sign-ups automatically.",
    followups: ["What does a successful Year 1 look like?", "How do I get vendor donations?", "How do I fill my field?"],
  },
  "how do i get vendor donations": {
    answer: "In-kind donations stretch every dollar — a donated case of water or a raffle prize is margin you keep for the cause.\n\nAsk the businesses you already spend money with first: your caddie shop, the beverage distributor, the printer doing your signs. \"We're running a charity tournament for [cause] — would you donate [item] in exchange for recognition in our program?\" is a warm, easy yes. Then local restaurants (gift cards for prizes), breweries (kegs), and sporting-goods stores (raffle items).\n\nThe magic phrase is a specific ask tied to recognition: name the exact item, and offer program listing or a sign. In TourneyCoach you can track these as in-kind sponsors so they show up on your recognition list alongside cash sponsors.",
    spoken: "In-kind donations are margin you keep for the cause. Ask the businesses you already spend money with first — your beverage distributor, your printer. Then local restaurants for gift cards, breweries for kegs, sporting-goods stores for raffle items. Make a specific ask tied to recognition: name the exact item and offer a program listing or sign.",
    followups: ["Who should I ask to sponsor?", "How do I find volunteers?", "What does a successful Year 1 look like?"],
  },
  "what does a successful year 1 look like": {
    answer: "A successful first year is not measured only in dollars — it's a full field, a smooth day, and sponsors who want to come back.\n\nThe numbers: a well-run first-year event with 72 players and solid sponsorships nets $10,000 to $18,000 for the cause. But the real win is the foundation — a field that filled, a day that ran on time, and 5 to 10 sponsors who had a great experience. Those are the sponsors who renew (and upgrade) in Year 2, which is where events jump to $20,000 to $35,000.\n\nSo protect three things above the fundraising total: don't overprice yourself into an empty field, don't skimp on the day-of experience, and thank every sponsor and volunteer personally. Year 1 is where you plant; Year 3 is where you harvest.",
    spoken: "A successful first year isn't just dollars — it's a full field, a smooth day, and sponsors who want to come back. The numbers: 10 to 18 thousand net for a well-run first event. But the real win is the foundation — sponsors who renew and upgrade in Year 2, when events jump to 20 to 35 thousand. Don't overprice into an empty field, don't skimp on the day, and thank everyone personally.",
    followups: ["What should I charge?", "What should sponsorship packages look like?", "How do I find volunteers?"],
  },

  // ── Escalate to human ───────────────────────────────────────────────────
  "i need to talk to a human": {
    answer: "Absolutely — you should never feel stuck.\n\nFor anything I can't answer, or when you'd just rather talk to a person, email the TourneyCoach team at support@tourneycoach.com and a real human will get back to you, usually within one business day. If it's about your specific event and time-sensitive, put your tournament name and date in the subject line so they can jump straight in.\n\nAnd for questions that need a licensed professional — legal structure, tax treatment of donations, insurance specifics — that's exactly the kind of thing to take to your accountant or attorney rather than any AI, including me.",
    spoken: "You should never feel stuck. For anything I can't answer, or when you'd rather talk to a person, email the TourneyCoach team at support at tourneycoach dot com and a real human will get back to you, usually within one business day. And for legal, tax, or insurance specifics, take those to your accountant or attorney.",
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

export function lookupScript(text: string) {
  const key = text.toLowerCase().trim().replace(/[?!.]+$/, '');
  const resolved = SCRIPT_ALIASES[key] ?? key;
  for (const [k, v] of Object.entries(SCRIPTS)) {
    if (resolved === k) return v;
  }
  return null;
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
      question: 'What does a successful Year 1 look like?',
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
