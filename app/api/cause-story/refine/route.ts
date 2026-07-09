import { NextRequest, NextResponse } from "next/server";
import { askClaude } from "../../../../lib/ai/anthropic";

export async function POST(req: NextRequest) {
  const { draft, instruction } = await req.json();
  if (!draft || typeof draft !== "string" || !draft.trim()) {
    return NextResponse.json({ error: "Missing draft text" }, { status: 400 });
  }

  const system = `You are an editor helping charity golf tournament organizers refine their "cause story" — the narrative that explains why their tournament exists. You improve clarity, flow, and emotional resonance WITHOUT replacing the organizer's own voice, word choices, or specific details. Never invent facts, names, numbers, or details that aren't in the draft. Return only the revised story text, no preamble, no explanation, no quotation marks around it.`;

  const prompt = `Here is the organizer's draft cause story:\n\n"""\n${draft}\n"""\n\n${
    instruction && typeof instruction === "string" && instruction.trim()
      ? `Specific direction from the organizer: ${instruction.trim()}\n\n`
      : ""
  }Revise it to be clearer and more compelling while keeping it recognizably in the organizer's own voice. Keep roughly the same length.`;

  try {
    const suggestion = await askClaude(system, prompt, 900);
    return NextResponse.json({ suggestion });
  } catch (e) {
    const message = e instanceof Error ? e.message : "AI refinement failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
