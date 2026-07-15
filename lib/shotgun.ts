// Shotgun start capacity math and auto-assignment.
//
// Locked rule (Day 16): in a double shotgun, par 3s take exactly ONE foursome;
// par 4s and par 5s take TWO (an A group that tees off first and a B group
// that follows). That's what makes a standard par-72 (4 par-3s) support
// 4×1 + 14×2 = 32 foursomes = 128 players. Single shotgun is one foursome per
// hole regardless of par. A tee-time wave goes off hole 1 only, so hole
// capacity doesn't bound the field — waves do.

export type ShotgunFormat = 'single' | 'double' | 'wave' | 'tee_times';

export const STANDARD_PAR_72: number[] = [4, 3, 5, 4, 3, 4, 5, 4, 4, 4, 5, 3, 4, 4, 5, 3, 4, 4];

export interface Team {
  id: string;
  name: string;
  startingHole: number | null; // 1-based
  startSlot: 'A' | 'B' | null;
}

export function slotsForHole(par: number, format: ShotgunFormat): ('A' | 'B')[] {
  if (format === 'wave' || format === 'tee_times') return [];
  if (format === 'single') return ['A'];
  return par === 3 ? ['A'] : ['A', 'B'];
}

export function courseCapacityTeams(pars: number[], format: ShotgunFormat): number | null {
  if (format === 'wave' || format === 'tee_times') return null; // not hole-bound
  return pars.reduce((sum, par) => sum + slotsForHole(par, format).length, 0);
}

export interface Conflict {
  hole: number; // 1-based
  message: string;
  teamIds: string[];
}

// Everything that can be wrong with a set of assignments against a course
// layout: a B group on a par 3 (the over-stack the rule forbids), two teams
// in the same slot, or a slot letter the format doesn't have.
export function findConflicts(teams: Team[], pars: number[], format: ShotgunFormat): Conflict[] {
  const conflicts: Conflict[] = [];
  const bySlot = new Map<string, Team[]>();

  for (const t of teams) {
    if (t.startingHole == null) continue;
    if (t.startingHole < 1 || t.startingHole > pars.length) {
      conflicts.push({ hole: t.startingHole, message: `${t.name} is assigned to hole ${t.startingHole}, which doesn't exist on this course`, teamIds: [t.id] });
      continue;
    }
    const par = pars[t.startingHole - 1];
    const allowed = slotsForHole(par, format);
    const slot = t.startSlot ?? 'A';
    if (!allowed.includes(slot)) {
      conflicts.push({
        hole: t.startingHole,
        message: par === 3
          ? `Hole ${t.startingHole} is a par 3 — only one foursome allowed, but ${t.name} is stacked in the B slot`
          : `${t.name} is in slot ${slot} on hole ${t.startingHole}, which this format doesn't allow`,
        teamIds: [t.id],
      });
      continue;
    }
    const key = `${t.startingHole}-${slot}`;
    bySlot.set(key, [...(bySlot.get(key) ?? []), t]);
  }

  for (const [key, slotTeams] of bySlot) {
    if (slotTeams.length > 1) {
      const [hole, slot] = key.split('-');
      conflicts.push({
        hole: Number(hole),
        message: `${slotTeams.map(t => t.name).join(' and ')} are both in slot ${slot} on hole ${Number(hole)}`,
        teamIds: slotTeams.map(t => t.id),
      });
    }
  }
  return conflicts;
}

// Fill A slots across the course in hole order first (so every hole has a
// lead group and the course clears evenly), then B slots on par 4/5s.
// Already-assigned teams keep their spots; only unassigned teams are placed.
export function autoAssign(teams: Team[], pars: number[], format: ShotgunFormat): Team[] {
  if (format === 'wave' || format === 'tee_times') return teams;

  const result = teams.map(t => ({ ...t }));
  const taken = new Set(
    result
      .filter(t => t.startingHole != null && findConflicts([t], pars, format).length === 0)
      .map(t => `${t.startingHole}-${t.startSlot ?? 'A'}`),
  );
  const unassigned = result.filter(t => t.startingHole == null || findConflicts([t], pars, format).length > 0);

  const openSlots: { hole: number; slot: 'A' | 'B' }[] = [];
  for (const slot of ['A', 'B'] as const) {
    for (let h = 1; h <= pars.length; h++) {
      if (slotsForHole(pars[h - 1], format).includes(slot) && !taken.has(`${h}-${slot}`)) {
        openSlots.push({ hole: h, slot });
      }
    }
  }

  for (const team of unassigned) {
    const next = openSlots.shift();
    if (!next) { team.startingHole = null; team.startSlot = null; continue; }
    team.startingHole = next.hole;
    team.startSlot = next.slot;
  }
  return result;
}
