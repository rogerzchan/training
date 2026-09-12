# Training

A 12-month training log for Roger. Baseball throwing velocity primary, vertical jump
secondary, peaking into NACIVT Labor Day weekend 2027.

Program design and reasoning live in `~/Desktop/Personal /athletic-training/`.
This repo is just the app.

## How it works

| Thing | Where it lives | Changes how |
|---|---|---|
| **Program** (weeks, days, exercises, prescriptions) | `program.json` in this repo | edit + `git push` |
| **Session identity** | week + slot (`w1-d0`), never a calendar date | — |
| **Your logs** (sets, reps, loads, pain scores, tests) | `localStorage` in your browser | logging, never git |

Those are deliberately decoupled. **You never push to log a workout.** The service worker
fetches `program.json` network-first, so a pushed program change appears on next refresh,
while everything else is cache-first and works offline in the gym.

## Deploy to GitHub Pages

```sh
git init && git add -A && git commit -m "Training app"
gh repo create rogerzchan/training --public --source=. --push
```
Then: repo **Settings → Pages → Source: Deploy from a branch → main / (root)**.

Live at `https://rogerzchan.github.io/training/`. Open on your phone, Share → Add to Home
Screen, and it runs standalone and offline.

> `gh auth status` currently shows `rogerchan-commits` (work). Switch first:
> `gh auth switch --user rogerzchan`

## Run locally

```sh
python3 -m http.server 8000
```
Then open `http://localhost:8000`.

## Is my data safe?

**Yes, it survives refreshes.** `localStorage` persists across page refreshes, closing the
tab, restarting the browser, restarting the phone, and being offline. Every keystroke is
saved immediately, so a mid-workout interruption loses nothing.

It is lost only if you: clear site data, uninstall, or switch device/browser. Export covers
all three.

**It works fine in a Safari tab.** One caveat worth knowing: since iOS 13.4, Safari clears a
site's script-writable storage after **7 days of not opening the site at all**. That will
never happen during a training week; it is a risk over a holiday or an injury layoff. Web
apps **added to the Home Screen are exempt**, so installing it removes the risk entirely.
The app shows a gentle reminder if you are running it in a Safari tab on iOS.

The app also calls `navigator.storage.persist()` on load, which asks the browser not to evict
the data under storage pressure. Status is shown in the Data tab.

Refs: [Apple's 7-day cap on script-writable storage](https://support.didomi.io/apple-adds-a-7-day-cap-on-all-script-writable-storage),
[StorageManager.persist() (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist)

## Sessions belong to the week, not to a date

A session's identity is its slot in the program (`w1-d0` = week 1, first session), and the
date is just **when you actually did it**. So Monday's lift done on Wednesday is still
Monday's lift: it stays in the right week, keeps the right prescription, and the week counter
reads `3/6 done` instead of marking anything missed.

The calendar day is shown as a suggestion and nothing more. Every session in the week is
tappable in any order, and there is a date field on each one if you are logging it late.

## What the app computes for you

Rules are implemented so week-to-week adjustment needs no conversation:

- **Jump budget** — volleyball hours × 64 + logged plyo contacts vs the weekly ceiling
- **24-hour tendon rule** — compares the morning-after score to the pre-session baseline.
  Same/better = progress, worse = hold load, worse 3 sessions running = escalate
- **Backup nagging** — flags when you are 10 sessions or 14 days past your last export
- **Progression hints** — all sets clean at RPE ≤ 7 suggests +5 lb
- **e1RM and ×bodyweight** per key lift (Epley)
- **Layoff detection** — 10+ days without a session offers a reduced ramp
- **Week flags** — deloads, taper, weighted-ball phases, maintenance blocks, test weeks
- **Velocity conversion** — enter frame count, it applies `mph = 9816 ÷ frames`

## Escalate to a conversation instead

Pain lasting 3+ days, velo or jump trending down across 3 tests, two missed weeks, a
schedule change lasting 2+ weeks, a tournament appearing. See
`athletic-training/HOW-TO-UPDATE.md`.
