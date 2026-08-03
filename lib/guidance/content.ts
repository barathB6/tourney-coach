// Instruction content at three depths, for every task template.
//
// The authored library lives in lib/guidance/contentLibrary.ts, keyed by
// role + task title. This file is the lookup — and the guarantee: every task
// yields usable content at every depth even when nothing was authored,
// because a task an organizer adds next week must not render blank for a
// first-timer who needs the most help.
//
// Depth contract:
//   detailed — numbered steps a person who has never done this can follow,
//              including when to start, what to bring, and who to find.
//   standard — the 2–3 bullets someone who has done it once needs.
//   minimal  — one imperative line. A veteran wants the reminder, not a manual.

import { CONTENT_LIBRARY } from '@/lib/guidance/contentLibrary';
import type { Depth } from '@/lib/guidance/engine';

export interface TaskContent {
  detailed: string[];
  standard: string[];
  minimal: string;
  /** False when this came from the derivation fallback, not authored copy. */
  authored: boolean;
}

export const contentKey = (roleName: string, taskTitle: string): string =>
  `${roleName.trim().toLowerCase()}|${taskTitle.trim().toLowerCase()}`;

/** Derive passable content from the template's own description. */
export function deriveContent(taskTitle: string, description: string | null): TaskContent {
  const desc = (description ?? '').trim();
  const sentences = desc.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
  return {
    detailed: [
      taskTitle,
      ...(sentences.length ? sentences : ['Check with your organizer for the specifics of this task.']),
      'When it is done, tick it off in your volunteer portal so the team can see it.',
    ],
    standard: sentences.length ? sentences.slice(0, 2) : [taskTitle],
    minimal: taskTitle.length <= 90 ? taskTitle : `${taskTitle.slice(0, 87)}…`,
    authored: false,
  };
}

export function contentFor(roleName: string, taskTitle: string, description: string | null): TaskContent {
  const authored = CONTENT_LIBRARY[contentKey(roleName, taskTitle)];
  if (authored) return { ...authored, authored: true };
  return deriveContent(taskTitle, description);
}

/** The lines to actually show, at one depth. */
export function linesAtDepth(content: TaskContent, depth: Depth): string[] {
  if (depth === 'detailed') return content.detailed;
  if (depth === 'standard') return content.standard;
  return [content.minimal];
}
