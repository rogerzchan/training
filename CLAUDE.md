# Training app — operating manual

Roger's training log. **The program lives in `program.json` in this repo; his training data
lives in his phone's localStorage.** He exports a JSON, sends it here, and you update the
program from what he actually did.

Coaching knowledge, injury history and the reasoning behind every prescription live in
`~/Desktop/Personal /athletic-training/`. **Read that folder's `CLAUDE.md` first** — do not
re-derive the sports science, it is already written down with sources.

## The loop

1. Roger trains, ticks sets, writes per-exercise notes in the app
2. He exports JSON (Data → Export) and pastes or attaches it here
3. You read it: prescribed vs actual, notes, session RPE, duration, morning pain scores
4. You update `program.json`, push, and he refreshes
5. You log what changed in `../athletic-training/CHANGELOG.md`

He never edits the program. You never touch his logs.

## Reading an export

It is self-describing. Per session: name, date, `durationMin` vs `targetMin`, `sessionRPE`,
and per exercise the `prescribed` string next to the `sets` actually done, plus `note`.
Also `morningPain` (quad + shoulder, 0-10), `tests`, `bodyweightLb`. Raw state is under
`_state` for lossless re-import.

**What to act on:**

| Signal in the export | What to do |
|---|---|
| Note says he swapped an exercise | Make it permanent if the reason holds, or record why not |
| Actual load consistently above prescribed | Raise `start` for that item |
| Actual load consistently below, or RPE 9-10 | Lower `start`, or check the progression is too steep |
| `durationMin` well over `targetMin` | The duration model is wrong. Re-estimate and trim |
| Morning quad or shoulder score rising | See `joint-health.md`. Quad above 3/10 moves the isometric back to the warm-up |
| Sets marked done at fewer reps than prescribed | Hold the load rather than progressing |

## Hard rules

- **Session length is Roger's call, not a cap** (revised 2026-09-22). It was a hard 90 min
  ceiling; he dropped it after Upper A ran 90.3 and he judged it fine. Still re-estimate
  `mins` after every edit so the label is honest, but **do not cut work to hit a number**.
  He will say in the session notes if a workout is too long. `meta.maxSessionMins` is now
  advisory and is not read by the app.
- **Every exercise needs a rest period.** The only exemption is a follow-along video.
- **Read the session notes field**, not just per-exercise notes. It is the bottom of the
  session view and is where length complaints and anything session-wide will land.
- **Weekly jump contacts under 400** (volleyball hours x 64 + logged plyo contacts).
- Loads are always **one concrete number**, never a range.
- A load is the **total**, not per hand. A 70 lb dumbbell lift means 35 in each hand. His
  notes are written the same way, but not always, so read them with this in mind.
- No circuits. He wants a rest timer on every single exercise.

## Data model in `program.json`

- `exercises{id}`: name, cue, cat, unit, q (YouTube search), video (direct link), equip, loc, alt
  - `cat` drives the jump budget: only `plyo` counts as landing load. `agility` does not.
  - `mins` on an exercise means it is a follow-along video of that runtime
- `days{id}`: name, mins (computed, do not hand-write), blocks[] of items
  - item: ex, sets, reps, rest, rpe, plus a load rule
  - load rules: `start`/`step`/`every`/`cap` (progression), `fixed` (implement weight),
    `pct`+`pctOf` (% of logged e1RM), or `bw`
  - `note` of "A1"/"A2" etc. marks a superset pair: they share one rest
- `weeks[]`: n, start, block, sub, priority, days[7] of day ids, flags, weightedBalls
- `meta.build`: a **timestamp**, bump it on every change. Not a sha; that was confusing.

## Duration model

`sets x (work + rest)`, then **x1.35** for transitions and setup, plus **5 min per barbell
lift** needing a warm-up ramp (capped at 10). Work time is ~3.5 s/rep, doubled for `/arm`,
`/leg` and `/side`; timed reps and video runtimes count at face value.

**Supersets do NOT share a rest.** An earlier version of this model assumed they did. The
app runs a rest timer on every exercise, so he takes both rests, and the three sessions
logged on 2026-09-19 confirmed it. The 1.35 factor is fitted on those same three sessions,
whose overhead over raw set time was 21%, 30% and 53%. `[?]` It still under-predicts
barbell days by roughly 10 min. Re-fit it as sessions accumulate.

The estimator is not in the repo. `mins` is recomputed by running the model in a scratch
script whenever items change, and every day must land under `meta.maxSessionMins`.

A dev harness lives in `.dev/harness.js` (gitignored) that loads `app.js` in node so you can
call `prescribedLoad`, `vSession`, `jumpBudget` etc. without a browser.

## Deploying

```sh
git add -A && git commit && git push origin main
```
Pages rebuilds in ~30-60 s. Verify with:
```sh
curl -sL "https://rogerzchan.github.io/training/program.json?cb=$(date +%s)" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['meta']['build'])"
```
The remote is `rogerzchan/training` but git is authed as the **work** account
(`rogerchan-commits`), which is a collaborator. Commits are attributed to
`rogerzchan <100112948+rogerzchan@users.noreply.github.com>` via local git config — leave
that alone, it keeps his work email out of a public repo.

## Current constraints (verify against `../athletic-training/athlete-profile.md`)

- 5'10", 170 lb, 24. Squat peaked 325x2, clean 225x2, bench is new and light.
- **Quad tendinopathy** history, currently asymptomatic. **Bilateral anterior shoulder
  pinching** under volleyball load. Both have tripwires in `joint-health.md`.
- GoodLife: full gym, sled, curved treadmill, med balls, padded wall at 1-2 m. Home: bedroom.
- **No outdoor throwing until ~April.** Velocity is unmeasurable indoors; the tracked proxy
  is rotational med ball throw distance.
- 3 lower + 2 upper + 2 arm-speed days, volleyball 1x/week.
