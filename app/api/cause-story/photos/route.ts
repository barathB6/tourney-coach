import { NextRequest, NextResponse } from "next/server";
import { askClaude } from "../../../../lib/ai/anthropic";

export async function POST(req: NextRequest) {
  const { fullStory } = await req.json();
  if (!fullStory || typeof fullStory !== "string" || !fullStory.trim()) {
    return NextResponse.json({ error: "Missing full story text" }, { status: 400 });
  }

  const system = `You recommend photo types for a charity golf tournament's microsite based on its cause story. Respond with ONLY valid JSON, no markdown fences, matching this exact shape: {"recommendations": [{"type": string, "reason": string}]}. Return exactly 4-6 recommendations. "type" is a short photo category label (e.g. "Founder with beneficiaries", "Past tournament action shots", "Beneficiary/recipient portraits", "Community event moments"). "reason" is one short sentence tying it back to a specific detail in the story.`;

  const prompt = `Cause story:\n\n"""\n${fullStory}\n"""\n\nRecommend photo types as JSON.`;

  try {
    const raw = await askClaude(system, prompt, 700);
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = JSON.parse(cleaned);
    const recommendations = Array.isArray(parsed.recommendations) ? parsed.recommendations : [];
    return NextResponse.json({ recommendations });
  } catch (e) {
    const message = e instanceof Error ? e.message : "AI photo recommendations failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
