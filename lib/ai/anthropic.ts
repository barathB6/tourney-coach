import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

export function getAnthropicClient() {
  if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY === "your_anthropic_api_key") {
    return null;
  }
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

export const CAUSE_STORY_MODEL = "claude-haiku-4-5";

export async function askClaude(system: string, prompt: string, maxTokens = 1024): Promise<string> {
  const anthropic = getAnthropicClient();
  if (!anthropic) {
    throw new Error("AI is not configured yet — add a real ANTHROPIC_API_KEY to enable this feature.");
  }
  const message = await anthropic.messages.create({
    model: CAUSE_STORY_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: prompt }],
  });
  const block = message.content[0];
  return block.type === "text" ? block.text.trim() : "";
}
