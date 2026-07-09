import { NextRequest, NextResponse } from "next/server";
import { askClaude } from "../../../../lib/ai/anthropic";

export async function POST(req: NextRequest) {
  const { fullStory } = await req.json();
  if (!fullStory || typeof fullStory !== "string" || !fullStory.trim()) {
    return NextResponse.json({ error: "Missing full story text" }, { status: 400 });
  }

  const system = `You condense a charity golf tournament's cause story into shorter versions for different uses, while preserving the organizer's voice and the core facts. Never invent details not present in the source. Respond with ONLY valid JSON, no markdown fences, matching this exact shape: {"medium": string, "short": string, "oneLiner": string}.
- "medium" (2-3 sentences, ~40-60 words): for sponsor package materials — should convey impact and credibility to a business audience.
- "short" (1-2 sentences, ~20-30 words): for social media captions.
- "oneLiner" (under 15 words): a single punchy sentence for a registration form header.`;

  const prompt = `Full cause story:\n\n"""\n${fullStory}\n"""\n\nGenerate the three condensed versions as JSON.`;

  try {
    const raw = await askClaude(system, prompt, 700);
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = JSON.parse(cleaned);
    return NextResponse.json({
      medium: String(parsed.medium || ""),
      short: String(parsed.short || ""),
      oneLiner: String(parsed.oneLiner || ""),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "AI length generation failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
