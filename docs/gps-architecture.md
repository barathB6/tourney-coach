# TourneyCoach GPS Architecture — Implementation Reference

**Audience:** patent counsel + future engineering reference.
**Purpose:** map each mechanism described in the provisional filing to its
concrete implementation, state exactly what has been verified and how, and
record the tunable parameters and their rationale.

Last updated: 2026-07-22 (Day 20, Phase D integration). All file paths are
relative to the repository root; line-level details may drift, function and
table names are stable.

---

## 1. The inventive mechanism: score submission as GPS labeling

**Claim (plain terms):** when a participant submits a score for hole N, the
system captures the participant's contemporaneous GPS coordinates and labels
them as the approximate green location for hole N — deriving surveyed-quality
course data from ordinary tournament behavior, with zero manual survey work.

**Implementation:**

| Step | Where |
|---|---|
| Score entry UI (web) | `app/live/[id]/page.tsx` — flushes the buffered GPS queue **before** posting the score, so the freshest points are server-side when labeling runs |
| Score entry UI (native iOS/Android) | `mobile/app/(app)/live.tsx` + `mobile/lib/liveRound.ts` (same API contract) |
| Score API (the trigger) | `app/api/gps/score/route.ts` — identifies the device by its registered token (issued during the consent flow), calls the labeler, persists the score to `score_submissions`. Consent is enforced at GPS *ingestion*, not at score submission — a device that revoked consent may still score, but labeling can only ever match points collected under active consent |
| The labeler | `lib/gps/labelGreen.ts` → `labelGreenOnScoreSubmission()` |

**Labeling algorithm** (`labelGreen.ts`): take the submitting foursome's
unlabeled `gps_tracks` points for that hole within ±3 minutes
(`MATCH_WINDOW_MS`) of the submission timestamp; keep the closest-in-time
point per device; average across devices (a 4-phone centroid is steadier than
any single phone). The matched raw points are tagged
(`feature_type='green'`, `feature_source='score_submission'`), a per-event
`green` row is written to `course_gps_features` with
`confidence = devices/4`, and the hole's `course_holes.gps_status.green` is
updated for immediate UI feedback.

**Rationale for the window:** scoring happens after holing out, not before —
so the group's most recent pings are, with high confidence, at or near the
green. The ±3-minute window tolerates walking off the green before typing.

## 2. Tee box cluster detection

**Claim:** when multiple team members' coordinates converge at a common
starting location prior to play on a hole, the centroid is designated the tee
box.

**Implementation:** `lib/gps/clustering.ts` → `detectTeeClusters()`, run by
the daily cron. For each hole, each device's **first** untagged ping (the
moment before the group fans out) is grouped by foursome; a foursome whose
first-pings converge within 30 m (`MAX_SPREAD_M`) yields a tee event at the
centroid, `confidence = devices/4`.

**Cross-tournament accrual (important):** detection dedupes per
`(course, hole, tournament)` — every tournament that fields a converging
group contributes its **own** independent tee event. This is what lets the
confidence model (§4) climb with tournament count. Winning pings are tagged
(`feature_type='tee_box'`, `feature_source='cluster_detection'`) so re-runs
never double-count.

## 3. Collection pipeline & consent

**Consent (explicit, affirmative, auditable):**
- UI consent card with plain-language terms (what is collected, why, opt-out)
  on both web and native; the native flow additionally triggers the OS
  location-permission dialog whose usage string carries the same language
  (`mobile/app.json`, expo-location plugin config).
- `app/api/gps/consent/route.ts` registers the device
  (`gps_devices`, client-generated random token — players have no accounts)
  and appends a `granted` event to `gps_consent_events` (append-only audit
  log; revocation appends `revoked`). Ingestion checks active consent on
  every batch (`lib/gps/consent.ts`).

**Collection cadence:** a fix is logged every 15 s while the round screen is
active (`LOG_EVERY_MS`), throttled client-side. Day 20 added quality/battery
gates on both clients: fixes with accuracy worse than 50 m are dropped,
near-stationary duplicates (<4 m movement) are suppressed, and both gates
yield to a 60 s keep-alive so degraded signal produces sparse points rather
than silence. These gates are deliberately JS-level only — an OS distance
filter was considered and rejected because it suppresses delivery entirely
while stationary, and standing at a tee or green is precisely when the two
patent mechanisms need points. The battery saving comes from logging and
uploading ~4× fewer points while stationary, not from idling the location
hardware. *Note: the filing describes 5–15 s intervals; the shipped cadence
is a fixed 15 s (the conservative end), not adaptive.*

**Offline resilience:** points queue in memory + durable storage
(localStorage / AsyncStorage) and flush in batches on hole change, on
backgrounding, at a 40-point threshold, and on a 2-minute fallback timer.
Failed flushes are re-queued — connectivity gaps lose nothing.

**Ingestion:** `app/api/gps/track/route.ts` validates points, resolves the
device→registration (the foursome unit) server-side (never trusting the
client for identity), and bulk-inserts into `gps_tracks` with timestamp,
accuracy, and labeling state (`feature_type` null until a mechanism tags it).

## 4. Aggregation & confidence (the course profile)

**Claim:** across multiple tournaments at the same course, derived features
average into canonical positions; each feature carries a confidence score
based on the number of **independent** GPS sample sequences contributing;
"after 3–5 tournaments → accurate positions."

**Implementation:** `lib/gps/aggregateCore.ts` (pure math) +
`lib/gps/aggregate.ts` (DB glue), run daily after cluster detection
(`app/api/cron/gps-clusters/route.ts`, Vercel cron 06:00 UTC).

- **Outlier rejection:** component-wise median reference; events >40 m out
  (`OUTLIER_RADIUS_M`) are excluded (wrong-hole tags, parking-lot fixes).
- **Position:** weighted centroid of surviving events (weight = ping count,
  capped at 4).
- **Independence:** samples from the same tournament corroborate weakly
  (shared weather/pins/crowd), so confidence is driven by **distinct
  tournament count** T:

  `confidence = T/(T + 1.8) × agreement`, `agreement = 1 − 0.5·min(1, spread/40 m)`

  Curve at tight agreement: 1→0.34, 2→0.51, 3→0.60, **5→0.71**, 10→0.82.
  `VERIFIED_THRESHOLD = 0.70` — the "verified" badge crosses at ~5
  tournaments, matching the filing's 3–5 tournament milestone. *(K=1.8 and
  the 0.70 line are FOUNDER-review parameters.)*
- **Fairway routing:** each round's track is projected onto the tee→green
  axis (longitude scaled by cos(latitude) — metric-true), bucketed into 10
  bins, averaged per-round first (a lingering round can't outvote others),
  then across rounds → a typical-play polyline.

Aggregates are written to `course_holes.gps_status` in a single per-hole
write: the tee and green slots each carry lat/lng, confidence, sample_count,
tournaments, spread_m, source, aggregated_at; the fairway slot carries
waypoints[] (ordered lat/lng), confidence, rounds, tournaments, source,
aggregated_at.

## 5. Hazard inference from avoidance

**Claim:** regions that player tracks conspicuously avoid across rounds are
probable hazards; boundaries emerge "after 10–20 tournaments."

**Implementation:** `lib/gps/hazardCore.ts` → `inferHazards()`, gated behind
≥8 rounds per hole (`HAZARD_MIN_ROUNDS`). A 15 m grid over the play corridor
(±60 m around the tee→green axis) counts distinct-round visits per cell. A
hazard candidate must satisfy all three: (a) an unvisited in-corridor cell,
(b) **bracketed** by traffic on opposite sides (including diagonals) — that
discriminates an interior avoided pocket (hazard) from the corridor's outer
edge (rough) — and (c) at least 3 distinct rounds across its 8 neighboring
cells (`MIN_NEIGHBOR_VISITS`), so sparse coverage can't fake avoidance. Adjacent candidates flood-fill into regions;
regions under 4 cells are discarded as noise; the region is represented by
its fairway-facing edge. Confidence reuses the §4 tournament-count model.
Hazard rows live in `course_gps_features` (`feature_type='hazard'`) and are
recomputed (delete-then-derive) each run, so stale hazards self-heal.

## 6. The hybrid model

**Claim:** pro-entered structured data fuses with GPS-derived spatial data.

**Implementation:** the Course Builder (`app/course/[id]`) captures the
pro-entered half (par, handicap, per-tee yardages, descriptions →
`courses` + `course_holes`); the pipeline above derives the spatial half.
`GET /api/course/[id]/profile` serves the fused profile per hole:
`proEntered {par, handicap, teeYardages, description}` +
`gpsDerived {tee, green, fairway, hazards}` with per-feature confidence.
Player-facing rendering: the Live Round hole map
(`components/gps/HoleSchematic.tsx`) draws a to-scale projected map with
confidence badges once GPS data exists, and falls back to a
yardage-schematic labeled "GPS data not yet collected" when it doesn't.

## 7. Data flow (end to end)

```
 player phone (web /live/[id] or native app)
   │  explicit consent  ──────────────►  gps_devices + gps_consent_events (audit)
   │  15s fixes, offline-buffered
   ▼
 POST /api/gps/track  ── consent check ──►  gps_tracks (timestamp, accuracy,
   │                                         labeling state, foursome, tournament)
   │  score submitted for hole N
   ▼
 POST /api/gps/score ──┬─► labelGreenOnScoreSubmission()
   │                   │     ├─► gps_tracks rows tagged feature_type='green'
   │                   │     ├─► course_gps_features (green event, per tournament)
   │                   │     └─► course_holes.gps_status.green (immediate UI feedback)
   │                   └─► score_submissions (the score itself, after labeling)
   ▼
 daily cron /api/cron/gps-clusters
   ├─► detectTeeClusters()        ──► course_gps_features (tee event PER tournament)
   └─► aggregateCourseProfiles()  ──► course_holes.gps_status (tee/green/fairway
                                       + cross-tournament confidence)
                                  ──► course_gps_features hazards (≥8 rounds)
   ▼
 GET /api/course/[id]/profile  ──► hybrid profile (pro-entered + GPS-derived)
   ▼
 player hole map (HoleSchematic) — confidence badges, "verified" at ≥0.70
```

## 8. Storage & access control

| Table | Contents | Access |
|---|---|---|
| `gps_devices` | device token ↔ registration | service-role only |
| `gps_consent_events` | append-only consent audit (granted/revoked) | service-role only |
| `gps_tracks` | raw fixes + labeling state | service-role only |
| `course_gps_features` | per-event derived features (tee/green/hazard) with `tournament_id` attribution | service-role only |
| `score_submissions` | scores + labeled-point counts | service-role only |
| `course_holes.gps_status` | aggregated per-hole profile | readable via app views/APIs |

All GPS tables have RLS enabled with anon/authenticated grants revoked
(migrations 024–027); every client interaction goes through the API routes
above, which enforce consent and derive identity server-side.

## 9. Verification status (honest ledger)

**Verified — offline synthetic harness** (`scripts/verify-gps-aggregation.ts`,
seeded/deterministic, rerunnable):
aggregation converges to ground truth (0.2 m at 10 tournaments); outlier
rejected; confidence curve monotone, crosses 0.70 at T=5, disagreement
penalized; fairway hugs the true axis (0.8 m max deviation); hazard localized
to 7.0 m with zero false positives on the negative control.

**Verified — live end-to-end against production**
(`scripts/e2e-phase-d.ts`, 2026-07-22): full pipeline with 2 simulated
tournaments × 4 consented devices × 3 holes through the real deployed APIs —
every consent recorded, every batch ingested, **all 6 score submissions
labeled a green from 4 contemporaneous devices**, tee events accrued one per
tournament, aggregated tee/green/fairway written with confidence and
tournaments=2, zero false hazards, hybrid profile endpoint fused both halves,
and the player map rendered the pipeline's own output. All test data purged
afterward.

**Adversarially reviewed:** the Day 19 aggregation diff went through a
multi-agent review (12 confirmed findings); all correctness-relevant defects
fixed and re-verified (notably: per-tournament tee accrual, jsonb
confidence-clobbering, newest-first track windowing, hazard staleness,
grid OOM guard).

**NOT yet verified (requires a physical course):**
- real-world collection while walking with varying signal strength;
- battery impact over a multi-hour round (the Day 20 gates are
  designed-for-battery but unmeasured in the field);
- GPS accuracy of a real labeled green vs. ground truth.

**Known deviations from the filing language:**
- collection is a fixed 15 s cadence (filing says 5–15 s adaptive);
- consent is recorded permission language, not a formal ToS-acceptance
  document (counsel should review the exact wording in
  `app/live/[id]/page.tsx` and `mobile/app.json`);
- web collection runs only while the page is foregrounded (browser
  limitation); background collection requires the native app;
- consent gates GPS *ingestion*, not score submission: a device that
  revoked consent may still submit scores (scores and location consent are
  separate concerns); labeling then finds no fresh points because ingestion
  stopped, so no location data ever flows from a non-consenting device.

## 10. Tunable parameters (single reference)

| Parameter | Value | Where | Rationale |
|---|---|---|---|
| Logging interval | 15 s | both clients | filing's conservative end; battery |
| Accuracy gate | 50 m | both clients | drop cold-start/indoor garbage |
| Stationary filter | 4 m | both clients (JS-level only) | battery; dedup — deliberately NOT an OS distance filter (see §3) |
| Keep-alive | 60 s | both clients | bad signal degrades, never silences |
| Green match window | ±3 min | labelGreen | score follows holing out |
| Tee cluster spread | ≤30 m | clustering | one tee pad |
| Cluster lookback | 30 h | clustering | daily cron must span a full day of play |
| Outlier radius | 40 m | aggregateCore | feature scale vs. gross error |
| Confidence K | 1.8 | aggregateCore | verified line at ~5 tournaments |
| Verified threshold | 0.70 | aggregateCore | FOUNDER-review parameter |
| Hazard grid | 15 m | hazardCore | bunker-scale resolution |
| Corridor half-width | 60 m | hazardCore | playable corridor |
| Neighbor-round floor | 3 | hazardCore | candidate needs ≥3 distinct rounds among its 8 neighbors |
| Hazard min rounds | 8 | aggregate | noise floor before inference |
| Max hole length guard | 1200 m | hazardCore | OOM guard vs. garbage coords |
