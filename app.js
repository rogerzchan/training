'use strict';
/* Training log. Program definition comes from program.json (git).
   All athlete data lives in localStorage (never git). */

const KEY = 'tr.v2';   // v2: sessions keyed by week+slot, not by date
const DOW = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const $ = s => document.querySelector(s);
const iso = d => new Date(d.getTime() - d.getTimezoneOffset()*6e4).toISOString().slice(0,10);
const today = () => iso(new Date());
const days = (a,b) => Math.round((new Date(b+'T00:00') - new Date(a+'T00:00'))/864e5);
const esc = s => String(s??'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };

let P = null;                 // program
let S = load();               // state
let view = 'today';
let openSession = null;       // session id being logged, e.g. "w1-d0"
let curWeek = null;           // week the user is browsing

/* A session's identity is its slot in the program (week + position),
   NOT a calendar date. The date is recorded when you finish it, so you can
   do Monday's lift on Wednesday and it still counts as Monday's lift. */
const sid = (week, slot) => `w${week}-d${slot}`;
function parseSid(id){
  const m = /^w(\d+)-d(\d+)$/.exec(id||'');
  return m ? {week:+m[1], slot:+m[2]} : null;
}
function weekByN(n){ return P.weeks.find(w => w.n === n) || null; }
function slotDate(week, slot){
  const w = weekByN(week); if(!w) return null;
  return iso(new Date(new Date(w.start+'T00:00').getTime() + slot*864e5));
}
function currentWeekN(){
  const w = weekFor(today());
  if(w) return w.n;
  return days(today(), P.meta.start) > 0 ? 1 : P.weeks[P.weeks.length-1].n;
}

function blank(){ return { sessions:{}, daily:{}, tests:[], settings:{} }; }

/* ---------- durability ---------- */
let PERSISTED = null;          // true = browser promised not to evict
function isStandalone(){
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}
function isIOS(){ return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
async function requestPersist(){
  try {
    if(!navigator.storage || !navigator.storage.persist) return null;
    PERSISTED = await navigator.storage.persisted();
    if(!PERSISTED) PERSISTED = await navigator.storage.persist();
    return PERSISTED;
  } catch(e){ return null; }
}
function doneCount(){ return Object.values(S.sessions).filter(s=>s.done).length; }
function backupState(){
  const last = S.settings.lastExport;
  const sinceCount = doneCount() - (S.settings.lastExportCount || 0);
  const sinceDays = last ? days(last, today()) : null;
  const stale = !last ? doneCount() >= 3 : (sinceCount >= 10 || sinceDays >= 14);
  return {last, sinceCount, sinceDays, stale};
}
function load(){ try { return Object.assign(blank(), JSON.parse(localStorage.getItem(KEY)||'{}')); }
                 catch(e){ return blank(); } }
function save(){ localStorage.setItem(KEY, JSON.stringify(S)); }

/* ---------- program lookup ---------- */
function weekFor(date){
  const n = Math.floor(days(P.meta.start, date)/7) + 1;
  return P.weeks.find(w => w.n === n) || null;
}
function todaySlot(){
  const w = weekFor(today()); if(!w) return null;
  let dow = new Date(today()+'T00:00').getDay();
  return {week:w.n, slot:(dow+6)%7};   // Mon=0
}
function dayDef(id){ return id ? P.days[id] : null; }

/* ---------- computed rules (Tier 2) ---------- */
function weekBounds(date){
  const w = weekFor(date); if(!w) return null;
  const s = w.start, e = iso(new Date(new Date(s+'T00:00').getTime()+6*864e5));
  return {w, start:s, end:e};
}
/* Which week's jump budget does a session count against? The week that
   contains the date it was actually DONE, because that is when the tissue
   absorbed it — not the week it was scheduled in. Work logged before the
   program officially starts still counts against week 1 rather than
   vanishing into no week at all. */
function budgetWeekOf(s){
  if(!s.date) return null;
  const first = P.weeks[0], last = P.weeks[P.weeks.length-1];
  if(s.date < first.start) return first.n;
  const n = Math.floor(days(P.meta.start, s.date)/7) + 1;
  if(n > last.n) return last.n;
  return n;
}
function contactsOf(sess){
  let c = 0;
  for(const en of sess.entries||[]){
    const ex = P.exercises[en.ex]; if(!ex || ex.cat !== 'plyo') continue;
    for(const st of en.sets||[]) if(st.done) c += (num(st.reps) || 0);
  }
  return c;
}
function jumpBudget(date){
  const b = weekBounds(date); if(!b) return null;
  const inSeason = b.w.block === 'in-season';
  const ceiling = inSeason ? P.budget.inSeasonCeiling : P.budget.offSeasonCeiling;
  let vbHours = 0, contacts = 0;
  for(const s of Object.values(S.sessions)){
    if(!s.done || !s.date) continue;
    if(budgetWeekOf(s) !== b.w.n) continue;
    if(s.play) vbHours += num(s.playHours) || 2;
    contacts += contactsOf(s);
  }
  const vbJumps = Math.round(vbHours * P.budget.vbJumpsPerHour);
  const total = vbJumps + contacts;
  return {ceiling, vbHours, vbJumps, contacts, total,
          pct: Math.min(100, Math.round(total/ceiling*100)),
          level: total > ceiling ? 'b' : total > ceiling*0.85 ? 'w' : 'g'};
}
// 24h tendon rule (Cook/Purdam): compare the morning AFTER a session to the
// pre-session baseline. Same or better = the tendon tolerated the load.
function tendonRule(site){
  const dates = Object.keys(S.daily).filter(d => S.daily[d][site] != null).sort();
  const done  = Object.values(S.sessions).filter(s=>s.done&&s.date).map(s=>s.date).sort();
  if(dates.length < 2) return {status:'need-data', msg:'Log a morning score for 2+ days'};
  if(!done.length)     return {status:'need-data', msg:'No completed sessions yet'};

  // baseline = last score on or before the session; response = first score after it
  const pair = sd => {
    const before = dates.filter(d => d <= sd).pop();
    const after  = dates.find(d => d > sd);
    if(before == null || after == null) return null;
    return {before:S.daily[before][site], after:S.daily[after][site]};
  };
  const recent = done.slice(-4).reverse();          // newest first
  const p = pair(recent[0]);
  if(!p) return {status:'wait', msg:'Log tomorrow morning to close the loop'};

  let streak = 0;
  for(const sd of recent){ const q = pair(sd); if(q && q.after > q.before) streak++; else break; }
  if(streak >= 3) return {status:'bad',
    msg:`Worse at 24h ${streak} sessions running. Cap range and escalate.`};
  if(p.after > p.before) return {status:'warn',
    msg:`Was ${p.before}, now ${p.after} at 24h. Hold load, repeat the week.`};
  return {status:'good', msg:`${p.before} → ${p.after} at 24h. Progress as written.`};
}
function e1rm(load, reps){ return (load && reps) ? load*(1+reps/30) : null; }
function bodyweight(){ return num(S.settings.bw); }   // local only, never in the repo

/* ---------- prescribed load ----------
   Always resolves to ONE number, never a range. Block 1 climbs from loads
   derived from Roger's TrainHeroic history; later blocks derive from his own
   logged e1RM so the number comes from real data, not a year-old guess. */
function roundTo(v, inc){ return Math.round(v/inc)*inc; }
/* "8/arm" -> 8, "3/side, max effort" -> 3, "30s" -> 30, "full series" -> '' */
function repsPrefill(reps){
  const m = /\d+/.exec(String(reps ?? ''));
  return m ? m[0] : '';
}
function isDeload(week){ return (P.deloadWeeks||[]).includes(week); }
function prescribedLoad(it, week, exId){
  if(it.bw) return null;
  if(it.fixed != null) return {v:it.fixed, kind:'implement'};
  if(it.pct != null){
    const ref = bestE1(it.pctOf || exId);
    if(!ref) return {kind:'needs-max', pct:it.pct, of:it.pctOf || exId};
    return {v:roundTo(ref.v*it.pct, 5), kind:'pct', pct:it.pct};
  }
  if(it.start == null) return null;
  let v = it.start + it.step*Math.floor((week-1)/it.every);
  if(it.cap != null) v = Math.min(v, it.cap);
  // only round if the load actually moves, and never coarser than the step itself,
  // otherwise a 2 lb wrist weight rounds to zero
  const inc = !it.step ? null : (it.step < 5 ? it.step : 5);
  if(isDeload(week) && it.step) v = v*(P.deloadFactor||0.85);
  if(inc) v = roundTo(v, inc);
  return {v, kind:'progression', capped: it.cap != null && v >= it.cap};
}
function loadLabel(L, unit){
  if(!L) return null;
  if(L.kind === 'needs-max') return `${Math.round(L.pct*100)}% of your logged max`;
  return `${L.v} ${unit==='oz'?'oz':'lb'}`;
}
function videoUrl(exId){
  const ex = P.exercises[exId]; if(!ex) return null;
  if(ex.video) return ex.video;
  return 'https://www.youtube.com/results?search_query=' + encodeURIComponent(ex.q || ex.name);
}
function bestE1(exId){
  let best = null;
  for(const s of Object.values(S.sessions)){
    if(!s.done) continue;
    for(const en of s.entries||[]) if(en.ex === exId)
      for(const st of en.sets||[]){
        if(!st.done) continue;
        const v = e1rm(num(st.load), num(st.reps));
        if(v && (!best || v > best.v)) best = {v, load:num(st.load), reps:num(st.reps)};
      }
  }
  return best;
}
function completedSessions(){
  return Object.values(S.sessions).filter(s => s.done && s.date)
    .sort((a,b) => a.date < b.date ? 1 : a.date > b.date ? -1 : 0);   // newest first
}
function lastPerf(exId, excludeId){
  for(const s of completedSessions()){
    if(s.id === excludeId) continue;
    const en = (s.entries||[]).find(e => e.ex === exId && (e.sets||[]).some(x=>x.done));
    if(en) return {date:s.date, sets:en.sets.filter(x=>x.done)};
  }
  return null;
}
function progressionHint(exId, excludeId){
  const lp = lastPerf(exId, excludeId); if(!lp) return null;
  const ex = P.exercises[exId];
  if(!ex || (ex.cat !== 'upper' && ex.cat !== 'lower')) return null;
  const allDone = lp.sets.length >= 3;
  const rpes = lp.sets.map(s=>num(s.rpe)).filter(v=>v!=null);
  const easy = rpes.length && Math.max(...rpes) <= 7;
  const ld = num(lp.sets[0].load);
  if(allDone && easy && ld) return `Last was RPE ≤7 → try ${ld+5}`;
  if(allDone && !rpes.length && ld) return `All sets clean → try ${ld+5} if it felt ≤7`;
  return null;
}
function layoff(){
  const cs = completedSessions();
  if(!cs.length) return null;
  const n = days(cs[0].date, today());
  return n >= 10 ? n : null;
}

/* ---------- session draft ---------- */
function getSession(id){
  if(S.sessions[id]) return S.sessions[id];
  const k = parseSid(id); if(!k) return null;
  const w = weekByN(k.week); if(!w) return null;
  const dayId = w.days[k.slot], def = dayDef(dayId);
  const s = {id, week:k.week, slot:k.slot, dayId, date:null, done:false,
             entries:[], play:!!(def && def.isPlay)};
  if(def) for(const blk of def.blocks) for(const it of blk.items){
    const n = parseInt(it.sets)||1;
    const L = prescribedLoad(it, k.week, it.ex);
    const pre = (L && L.v != null) ? String(L.v) : '';
    const rp = repsPrefill(it.reps);
    const rpe = it.rpe != null ? String(it.rpe) : '';
    s.entries.push({ex:it.ex, block:blk.name, rx:it,
      sets:Array.from({length:n},()=>({reps:rp,load:pre,rpe,done:false}))});
  }
  S.sessions[id] = s; save(); return s;
}
function started(s){ return !!s && (s.done || !!s.startedAt || s.entries.some(e=>e.sets.some(x=>x.done))); }

/* ---------- rest timer ----------
   Timestamp-based on purpose: iOS suspends JS when the app is backgrounded or
   the screen locks, so a tick-counting timer would drift or freeze. Storing the
   end time means the display is always right when you come back, and an alarm
   that came due while suspended fires the moment you return. */
let rest = null;         // {exId, label, endsAt, dur, fired}
let restTick = null;
let audioCtx = null;

function restSecs(r){
  const s = String(r ?? '').trim().toLowerCase();
  if(!s || s === '-' || s === '0') return 0;
  if(s.includes('full')) return 150;
  const m = /([\d.]+)\s*(min|m|s)?/.exec(s);
  if(!m) return 60;
  const v = parseFloat(m[1]);
  return Math.round(m[2] === 'min' || m[2] === 'm' ? v*60 : v);
}
function beep(){
  try{
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if(audioCtx.state === 'suspended') audioCtx.resume();
    const t0 = audioCtx.currentTime;
    [0, 0.18, 0.36].forEach((off,i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = i === 2 ? 1180 : 880;
      g.gain.setValueAtTime(0.0001, t0+off);
      g.gain.exponentialRampToValueAtTime(0.35, t0+off+0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0+off+0.15);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t0+off); o.stop(t0+off+0.16);
    });
  }catch(e){}
}
function notify(title, body){
  try{
    if('Notification' in window && Notification.permission === 'granted')
      new Notification(title, {body, tag:'rest', icon:'icon.svg', silent:false});
  }catch(e){}
}
function restLeft(){ return rest ? Math.ceil((rest.endsAt - Date.now())/1000) : 0; }
function startRest(exId, restStr){
  const d = restSecs(restStr);
  if(!d){ rest = null; return renderRest(); }
  const ex = P.exercises[exId];
  rest = {exId, label: ex ? ex.name : '', endsAt: Date.now() + d*1000, dur: d, fired:false};
  // unlock audio inside the tap that started the rest, or iOS will stay silent
  try{ audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); }catch(e){}
  renderRest(); runRest();
}
function clearRest(){ rest = null; if(restTick){ clearInterval(restTick); restTick = null; } renderRest(); }
function runRest(){
  if(restTick) clearInterval(restTick);
  restTick = setInterval(() => {
    if(!rest){ clearInterval(restTick); restTick = null; return; }
    if(restLeft() <= 0 && !rest.fired){
      rest.fired = true;
      beep(); notify('Rest over', `${rest.label} — back to work`);
      setTimeout(() => { if(rest && rest.fired) clearRest(); }, 4000);
    }
    renderRest();
  }, 250);
}
function renderRest(){
  const el = document.getElementById('restbar');
  if(!el) return;
  if(!rest){ el.className = 'restbar'; el.innerHTML = ''; return; }
  const left = restLeft(), over = left <= 0;
  const pct = Math.max(0, Math.min(100, (1 - left/rest.dur)*100));
  el.className = 'restbar on' + (over ? ' over' : '');
  el.innerHTML = `
    <i style="width:${pct}%"></i>
    <div class="rb-in">
      <span class="rb-t">${over ? 'GO' : hms(left)}</span>
      <span class="rb-l">${over ? 'rest over' : 'rest · ' + esc(rest.label)}</span>
      <button class="rb-x" data-act="rest-skip">${over ? 'Dismiss' : 'Skip'}</button>
    </div>`;
}
// an alarm that came due while iOS had the page suspended should fire on return
document.addEventListener('visibilitychange', () => {
  if(document.visibilityState !== 'visible' || !rest) return;
  if(restLeft() <= 0 && !rest.fired){
    rest.fired = true; beep(); notify('Rest over', `${rest.label} — back to work`);
    setTimeout(() => { if(rest && rest.fired) clearRest(); }, 4000);
  }
  renderRest(); runRest();
});

/* ---------- session clock ---------- */
let tick = null;
/* clock = { accMs, since }. since is null while paused. */
function clockOf(s){
  if(!s) return {accMs:0, since:null};
  if(!s.clock){
    // migrate the old startedAt/finishedAt shape
    const acc = (s.startedAt && s.finishedAt) ? (s.finishedAt - s.startedAt) : 0;
    s.clock = {accMs:acc, since: (s.startedAt && !s.finishedAt && !s.done) ? s.startedAt : null};
  }
  return s.clock;
}
function elapsedOf(s){
  const c = clockOf(s);
  return Math.max(0, Math.floor((c.accMs + (c.since ? Date.now() - c.since : 0))/1000));
}
function isRunning(s){ return !!clockOf(s).since; }
function clockStart(s){ const c = clockOf(s); if(!c.since) c.since = Date.now(); }
function clockPause(s){ const c = clockOf(s);
  if(c.since){ c.accMs += Date.now() - c.since; c.since = null; } }
function clockReset(s){ s.clock = {accMs:0, since:null}; }
function hms(sec){
  const m = Math.floor(sec/60), ss = sec%60;
  return `${m}:${String(ss).padStart(2,'0')}`;
}
function startClock(){
  stopClock();
  tick = setInterval(() => {
    const el = document.getElementById('clock');
    if(!el){ stopClock(); return; }
    const s = S.sessions[openSession];
    if(!s || s.done || !isRunning(s)){ stopClock(); return; }
    el.textContent = hms(elapsedOf(s));
    const cap = dayDef(s.dayId);
    if(cap && cap.mins && elapsedOf(s) > cap.mins*60) el.classList.add('over');
  }, 1000);
}
function stopClock(){ if(tick){ clearInterval(tick); tick = null; } }
/* Weeks advance with the real calendar, so a missed session would otherwise
   just vanish off the Today screen. Surface anything still unfinished. */
function carryOver(){
  const now = weekFor(today());
  if(!now) return [];
  const out = [];
  for(let n = Math.max(1, now.n - 4); n < now.n; n++){
    const pr = weekProgress(n);
    if(pr.total && pr.done < pr.total) out.push({n, ...pr});
  }
  return out;
}
function weekProgress(n){
  const w = weekByN(n); if(!w) return {done:0,total:0};
  let done=0,total=0;
  w.days.forEach((dayId,i)=>{
    const def = dayDef(dayId); if(!def || def.isOff) return;
    total++;
    if(S.sessions[sid(n,i)]?.done) done++;
  });
  return {done,total};
}

/* ---------- render ---------- */
function syncHash(){
  const h = openSession ? `#/s/${openSession}` : `#/${view}`;
  if(location.hash !== h) history.replaceState(null,'',h);
}
function readHash(){
  const m = /^#\/s\/(w\d+-d\d+)$/.exec(location.hash||'');
  if(m){ openSession = m[1]; return; }
  const v = (location.hash||'').replace('#/','');
  if(['today','week','log','tests','data'].includes(v)){ view = v; openSession = null; }
}
let lastScreen = null;
function render(){
  const v = {today:vToday, week:vWeek, log:vHistory, tests:vTests, data:vData}[view] || vToday;
  const screen = openSession ? 's:'+openSession : view;
  const keep = screen === lastScreen ? window.scrollY : 0;   // stay put within a screen
  $('#app').innerHTML = openSession ? vSession() : v();
  renderTabs(); syncHash();
  window.scrollTo(0, keep);
  lastScreen = screen;
  if(openSession){ const s = S.sessions[openSession]; if(s && !s.done && isRunning(s)) startClock(); }
  renderRest();
}
function renderTabs(){
  const tabs = [['today','Today'],['week','Week'],['log','Log'],['tests','Tests'],['data','Data']];
  $('#tabs').innerHTML = tabs.map(([k,l]) =>
    `<button data-tab="${k}" class="${view===k&&!openSession?'on':''}" aria-label="${l}">
       <svg><use href="#i-${k}"/></svg>${l}</button>`).join('');
}


/* A week's sessions, in program order. Order is a suggestion, not a rule:
   tap any one and log it whenever you actually did it. */
function sessionList(n, {suggest=null}={}){
  const w = weekByN(n); if(!w) return '';
  let h = '<div class="card">';
  const nextSlot = w.days.findIndex((d,i)=>{
    const def = dayDef(d); return def && !def.isOff && !S.sessions[sid(n,i)]?.done; });
  w.days.forEach((dayId,i)=>{
    const def = dayDef(dayId); if(!def) return;
    const s = S.sessions[sid(n,i)];
    const isSuggest = suggest != null && suggest === i;
    const isNext = i === nextSlot;
    let pill = '';
    if(s?.done) pill = '<span class="pill g">Done</span>';
    else if(started(s)) pill = '<span class="pill w">Part done</span>';
    // isNext is already signalled by the volt Start button; no pill needed
    h += `<div class="dayitem ${isSuggest?'today':''}">
      <span class="slot">${i+1}</span>
      <div class="grow">
        <div class="dayname" style="${s?.done?'color:var(--dim)':''}">${esc(def.name)}</div>
        <div class="tiny">${def.mins?`${def.mins} min · `:''}${isSuggest?'today · ':''}${
          s?.done&&s.date?`logged ${s.date}`:`planned ${slotDate(n,i)}`}</div></div>
      <div class="row" style="gap:7px;flex:0 0 auto">${pill}
      ${def.isOff?'':`<button class="btn ${isNext&&!s?.done?'':'sec'} sm" data-act="open" data-sid="${sid(n,i)}">${
        s?.done?'View':started(s)?'Resume':'Start'}</button>`}</div></div>`;
  });
  return h + '</div>';
}

function vToday(){
  const d = today(), w = weekFor(d);
  if(!w) return vPreStart(d);
  const ts = todaySlot(), prog = weekProgress(w.n);
  const bud = jumpBudget(d), lay = layoff();
  const dl = S.daily[d] || {};
  const need = dl.quad == null || dl.shoulder == null;

  let h = storageWarning();
  h += `<h1>Week ${w.n} of ${P.meta.totalWeeks}</h1>
    <p class="sub">Block ${esc(w.block)} · ${esc(w.sub)} · ${esc(w.priority)} priority
      · ${P.meta.totalWeeks - w.n} wks to NACIVT</p>`;

  h += backupBanner();
  if(lay) h += `<div class="flag b">No session logged in ${lay} days. Drop to 2 sets per lift and rebuild load.</div>`;
  const co = carryOver();
  if(co.length) h += `<div class="flag">Still unfinished: ${
    co.map(c=>`<button class="link" style="display:inline;padding:0" data-act="wk" data-n="${c.n}"
      >week ${c.n} (${c.total-c.done} left)</button>`).join(', ')}.
    Nothing is lost, they stay loggable. Skip them if the week has moved on.</div>`;
  for(const f of w.flags) h += `<div class="flag">${esc(f)}</div>`;
  if(w.weightedBalls) h += `<div class="flag g">Weighted balls — ${esc(w.weightedBalls)}</div>`;

  // morning check-in
  h += `<h2>Morning check-in</h2><div class="card">`;
  if(need){
    h += `<div class="muted">Quad tendon pain (0–10)</div>${scale('quad', dl.quad)}
          <div class="muted" style="margin-top:14px">Shoulder pain (0–10)</div>${scale('shoulder', dl.shoulder)}`;
  } else {
    h += `<div class="row sb"><div>Quad <b class="mono">${dl.quad}</b> · Shoulder <b class="mono">${dl.shoulder}</b></div>
      <button class="btn sec sm" data-act="reset-checkin">Edit</button></div>`;
    for(const site of ['quad','shoulder']){
      const r = tendonRule(site);
      const cls = {good:'g',warn:'w',bad:'b'}[r.status] || 'n';
      h += `<div class="row" style="margin-top:9px;gap:8px"><span class="pill ${cls}">${site}</span>
        <span class="muted grow">${esc(r.msg)}</span></div>`;
    }
  }
  h += `</div>`;

  // this week's sessions
  h += `<div class="row sb" style="margin:24px 0 8px">
      <h2 style="margin:0">This week's sessions</h2>
      <span class="muted mono">${prog.done}/${prog.total} done</span></div>
    <div class="tiny" style="margin-bottom:9px">Do them in any order, on any day. They log
      against the workout, not the date.</div>`;
  h += sessionList(w.n, {suggest: ts ? ts.slot : null});

  if(bud) h += `<h2>Jump budget this week</h2><div class="card">
    <div class="row sb" style="align-items:baseline">
      <span class="big" style="color:var(--${bud.level==='b'?'bad':bud.level==='w'?'warn':'good'})">${bud.total}</span>
      <span class="muted mono">of ${bud.ceiling} ceiling</span></div>
    <div class="bar"><i class="${bud.level}" style="width:${bud.pct}%"></i></div>
    <div class="tiny" style="margin-top:8px">Volleyball ${bud.vbHours}h ≈ ${bud.vbJumps} jumps · training ${bud.contacts} contacts</div>
    ${bud.level==='b'?'<div class="flag b" style="margin:10px 0 0">Over budget. Cut training jumps, never the volleyball.</div>':''}
    ${bud.level==='w'?'<div class="flag" style="margin:10px 0 0">Approaching ceiling. Skip the microdose if you add a session.</div>':''}
  </div>`;

  const keys = ['bench','squatacc','hangclean'];
  const bw = bodyweight();
  const rows = keys.map(k=>{const b=bestE1(k); return b?`<tr><td>${esc(P.exercises[k].name)}</td>
      <td class="r mono">${b.load}×${b.reps}</td><td class="r mono">${Math.round(b.v)}</td>
      ${bw?`<td class="r mono">${(b.v/bw).toFixed(2)}x</td>`:'<td class="r tiny">—</td>'}</tr>`:''})
    .filter(Boolean).join('');
  if(rows) h += `<h2>Key lifts</h2><div class="card tight"><table>
    <tr><th>Lift</th><th class="r">Best</th><th class="r">e1RM</th><th class="r">×BW</th></tr>${rows}</table>
    ${bw?'':'<div class="tiny" style="margin-top:9px">Set your bodyweight in the Data tab to see ×BW.</div>'}</div>`;
  return h;
}

function vPreStart(d){
  const till = days(d, P.meta.start);
  const dl = S.daily[d] || {};
  const need = dl.quad == null || dl.shoulder == null;
  if(till <= 0) return `<h1>Program complete</h1>
    <p class="sub">Ran ${P.meta.start} to ${P.meta.peakDate}. Time to write the next one.</p>`;
  const w1 = P.weeks[0];
  let h = storageWarning();
  h += `<h1>Starts in ${till} day${till===1?'':'s'}</h1>
    <p class="sub">Week 1 begins Monday ${P.meta.start} · ${P.meta.totalWeeks} weeks to ${esc(P.meta.peakEvent)}</p>
    <div class="flag g">Nothing to do today. Start logging your morning pain scores now so the
     24-hour rule has a baseline before week 1.</div>`;
  h += `<h2>Morning check-in</h2><div class="card">`;
  if(need){
    h += `<div class="muted">Quad tendon pain (0–10)</div>${scale('quad', dl.quad)}
          <div class="muted" style="margin-top:14px">Shoulder pain (0–10)</div>${scale('shoulder', dl.shoulder)}`;
  } else {
    h += `<div class="row sb"><div>Quad <b class="mono">${dl.quad}</b> · Shoulder <b class="mono">${dl.shoulder}</b></div>
      <button class="btn sec sm" data-act="reset-checkin">Edit</button></div>
      <div class="tiny" style="margin-top:8px">Logged for ${Object.keys(S.daily).length} day(s).</div>`;
  }
  h += `</div>`;
  h += `<h2>Week 1 · ${esc(w1.sub)}</h2>`;
  for(const f of w1.flags) h += `<div class="flag">${esc(f)}</div>`;
  h += sessionList(w1.n);
  h += `<h2>Before Monday</h2><div class="card tight"><table>
    <tr><td>Buy a 5 oz baseball</td><td class="r muted">~$10</td></tr>
    <tr><td>Calibrate phone frame rate</td><td class="r muted">film a stopwatch 10s</td></tr>
    <tr><td>Mark out 60 ft</td><td class="r muted">for the velo test</td></tr>
    <tr><td>Measure standing reach</td><td class="r muted">Tests tab</td></tr>
  </table></div>`;
  return h;
}

function storageWarning(){
  if(!isIOS() || isStandalone()) return '';
  return `<div class="flag"><b>Add to Home Screen (recommended).</b> This works fine in a Safari
   tab and your logs save normally. But iOS clears a site's saved data after 7 days of
   <i>not opening it at all</i> — irrelevant while you're training, a real risk over a holiday
   or layoff. Home Screen apps are exempt. Share → Add to Home Screen.</div>`;
}
function backupBanner(){
  const b = backupState(); if(!b.stale) return '';
  const why = !b.last ? `${doneCount()} sessions logged and never backed up`
    : `${b.sinceCount} sessions and ${b.sinceDays} days since your last backup`;
  return `<div class="flag"><b>Back up.</b> ${why}.
    <button class="link" style="display:inline;padding:0;margin-left:4px" data-act="export">Export now</button></div>`;
}

function scale(site, val){
  return `<div class="scale">${Array.from({length:11},(_,i)=>
    `<button data-act="score" data-site="${site}" data-v="${i}" class="${val===i?'on':''}">${i}</button>`)
    .slice(0,11).join('')}</div>`;
}

function vSession(){
  const id = openSession, s = getSession(id);
  if(!s) return `<button class="btn sec sm" data-act="close">‹ Back</button>
    <h1 style="margin-top:14px">Not found</h1>`;
  const def = dayDef(s.dayId), w = weekByN(s.week);
  if(!def || def.isOff) return `<button class="btn sec sm" data-act="close">‹ Back</button>
    <h1 style="margin-top:14px">Rest day</h1><p class="sub">Nothing scheduled.</p>`;

  let h = `<div class="row sb"><button class="btn sec sm" data-act="close">‹ Back</button>
    <div class="row" style="gap:6px;flex:0 0 auto">
      <span id="clock" class="clock${s.done?' done':''}${
        def.mins && elapsedOf(s) > def.mins*60 ? ' over':''}">${hms(elapsedOf(s))}</span>
      ${s.done?'' :`<button class="tbtn" data-act="clk-toggle" aria-label="${isRunning(s)?'pause':'resume'}">${
        isRunning(s) ? '&#10073;&#10073;' : '&#9654;'}</button>
      <button class="tbtn" data-act="clk-reset" aria-label="reset timer">&#8635;</button>`}
    </div></div>
    ${s.done?'':`<div class="row sb" style="margin:10px 0 2px">
      <span class="tiny">${isRunning(s)?'Timer running':'Timer paused'}</span>
      ${s.done?'':started(s)?'<span class="pill w">Part done</span>':''}</div>`}
    <h1 style="margin-top:14px">${esc(def.name)}</h1>
    <p class="sub">Week ${s.week} · session ${s.slot+1} of 7 · ~${def.mins} min incl. rest${
      s.date?` · logged ${s.date}`:''}</p>`;
  if(w) for(const f of w.flags) h += `<div class="flag">${esc(f)}</div>`;
  if(w && w.weightedBalls && def.name.includes('Throwing'))
    h += `<div class="flag g">Weighted balls — ${esc(w.weightedBalls)}</div>`;

  if(def.isPlay){
    h += `<div class="card"><div class="cue">Quad isometrics before you play — 5×45s @70%.
      ~45 min analgesic window.</div>
      <div class="row" style="margin-top:12px;gap:8px">
        <input id="pHours" type="number" step="0.5" placeholder="hours" value="${s.playHours??2}" style="max-width:100px">
        <span class="muted">hours played</span></div></div>`;
  } else {
    let cur = null;
    const blockMeta = {};
    for(const blk of def.blocks) blockMeta[blk.name] = blk;
    s.entries.forEach((en,ei)=>{
      if(en.block !== cur){
        cur = en.block;
        const bm = blockMeta[cur] || {};
        h += `<h2>${esc(cur)}</h2>`;
        if(bm.circuit) h += `<div class="tiny" style="margin:-4px 0 10px">Circuit — ${
          bm.rounds||2} rounds, move straight through. ${esc(bm.roundRest||'45s')} between rounds.</div>`;
      }
      const ex = P.exercises[en.ex] || {name:en.ex, cue:''};
      const rx = en.rx, lp = lastPerf(en.ex, id), hint = progressionHint(en.ex, id);
      const L = prescribedLoad(rx, s.week, en.ex);
      const unitCol = L ? (ex.unit==='oz'?'OZ':'LB') : (ex.unit==='mph'?'MPH':'BW');
      h += `<div class="card">
        <div class="row sb" style="align-items:flex-start;gap:9px">
          <div class="exname grow">${esc(ex.name)}</div>
          <a class="vid" href="${videoUrl(en.ex)}" target="_blank" rel="noopener noreferrer">
            <svg viewBox="0 0 24 24"><path d="M4 5.8v12.4a1 1 0 0 0 1.52.85l10.3-6.2a1 1 0 0 0 0-1.7L5.52 4.95A1 1 0 0 0 4 5.8z"/></svg>
            How&nbsp;to</a></div>
        ${ex.cue?`<div class="cue">${esc(ex.cue)}</div>`:''}
        <div class="rx">${esc(rx.sets)} × ${esc(rx.reps)}${
          L?` @ <b>${loadLabel(L, ex.unit)}</b>`:''}${
          String(rx.rest).trim()&&String(rx.rest).trim()!=='-'?` · rest ${esc(rx.rest)}`:''}${
          rx.note?` · ${esc(rx.note)}`:''}</div>
        ${L&&L.kind==='implement'?'<div class="tiny">Implement weight — fixed. Progress intent, not load.</div>':''}
        ${L&&L.capped?'<div class="tiny">Holding here. Retest before adding more.</div>':''}
        ${lp?`<div class="last">Last ${lp.date}: ${lp.sets.map(x=>`${x.reps||'?'}×${x.load||'bw'}`).join(', ')}</div>`:'<div class="last">No history</div>'}
        ${hint?`<div class="last" style="color:var(--accent)">${esc(hint)}</div>`:''}
        <div class="set head"><span class="n">SET</span><span>REPS</span><span>${unitCol}</span><span>RPE</span><span></span></div>
        <div class="sets">
          ${en.sets.map((st,si)=>`<div class="set">
            <span class="n">${si+1}</span>
            <input inputmode="numeric" placeholder="reps" value="${esc(st.reps)}" data-f="reps" data-e="${ei}" data-s="${si}">
            <input inputmode="decimal" placeholder="${ex.unit==='none'?'bw':ex.unit}" value="${esc(st.load)}" data-f="load" data-e="${ei}" data-s="${si}">
            <input inputmode="numeric" placeholder="rpe" value="${esc(st.rpe)}" data-f="rpe" data-e="${ei}" data-s="${si}">
            <button class="chk ${st.done?'on':''}" data-act="tog" data-e="${ei}" data-s="${si}"
              aria-label="set ${si+1} done"></button>
          </div>`).join('')}
        </div>
        <div class="row sb"><button class="link" data-act="addset" data-e="${ei}">+ Add set</button>
        ${en.sets.length>1?`<button class="link" style="color:var(--dim2)" data-act="delset" data-e="${ei}">− Remove</button>`:''}</div>
      </div>`;
    });
    h += `<h2>Session</h2><div class="card">
      <div class="muted">Session RPE (0–10)</div>${scaleS(s.rpe)}
      <input style="margin-top:12px;text-align:left" placeholder="Notes" value="${esc(s.notes||'')}" data-f="notes">`;
  }
  if(def.isPlay) h += `<div class="card">`;
  h += `<div class="row" style="margin-top:12px;gap:8px">
      <input type="date" value="${s.date||today()}" data-f="date" style="max-width:170px">
      <span class="muted tiny grow">date you actually did it</span></div>
    <button class="btn" style="margin-top:12px" data-act="finish">${s.done?'Saved — update':'Finish session'}</button>
    ${s.done?`<button class="btn sec" style="margin-top:8px" data-act="unfinish">Mark not done</button>`:''}
    </div>`;
  return h;
}

function scaleS(val){
  return `<div class="scale">${Array.from({length:11},(_,i)=>
    `<button data-act="srpe" data-v="${i}" class="${val===i?'on':''}">${i}</button>`).join('')}</div>`;
}

function vWeek(){
  if(curWeek == null) curWeek = currentWeekN();
  const w = weekByN(curWeek); if(!w) return '<h1>Week</h1>';
  const prog = weekProgress(w.n), isNow = weekFor(today())?.n === w.n;
  let h = `<div class="row sb">
      <button class="btn sec sm" data-act="wk" data-n="${w.n-1}" ${w.n<=1?'disabled':''}>‹ Prev</button>
      <div style="text-align:center"><div style="font-family:var(--display);font-weight:700;
        text-transform:uppercase;letter-spacing:1px;font-size:18px;line-height:1">Week ${w.n}</div>
        <div class="tiny">${esc(w.sub)}${isNow?' · current':''}</div></div>
      <button class="btn sec sm" data-act="wk" data-n="${w.n+1}" ${w.n>=P.meta.totalWeeks?'disabled':''}>Next ›</button>
    </div>
    <p class="sub" style="margin-top:14px">Block ${esc(w.block)} · ${esc(w.priority)} priority
      · starts ${w.start} · <span class="mono">${prog.done}/${prog.total}</span> done${
      !isNow && weekFor(today()) && w.n < weekFor(today()).n && prog.done < prog.total
        ? ' · <span style="color:var(--warn)">past week, unfinished</span>' : ''}</p>`;
  for(const f of w.flags) h += `<div class="flag">${esc(f)}</div>`;
  if(w.weightedBalls) h += `<div class="flag g">Weighted balls — ${esc(w.weightedBalls)}</div>`;
  h += sessionList(w.n, {suggest: isNow && todaySlot() ? todaySlot().slot : null});
  h += `<h2>Whole program</h2><div class="card tight"><table>
    <tr><th>Wk</th><th>Phase</th><th class="r">Starts</th><th class="r">Done</th></tr>
    ${P.weeks.filter(x=>x.n%4===1||x.n===w.n).map(x=>{const pr=weekProgress(x.n);
      return `<tr style="${x.n===w.n?'color:var(--acc)':''}">
      <td class="mono"><button data-act="wk" data-n="${x.n}" style="color:inherit">${x.n}</button></td>
      <td>${esc(x.sub)}</td><td class="r mono tiny">${x.start}</td>
      <td class="r mono tiny">${pr.done}/${pr.total}</td></tr>`;}).join('')}</table></div>`;
  return h;
}

function vHistory(){
  const cs = completedSessions();
  let h = `<h1>Log</h1><p class="sub">${cs.length} completed sessions</p>`;
  if(!cs.length) return h + '<div class="card"><div class="muted">Nothing logged yet.</div></div>';
  for(const s of cs.slice(0,80)){
    const def = dayDef(s.dayId);
    const vol = (s.entries||[]).reduce((a,en)=>a+(en.sets||[]).reduce((b,st)=>
      b + (st.done ? (num(st.load)||0)*(num(st.reps)||0) : 0),0),0);
    h += `<div class="card tight"><div class="row sb"><div class="grow">
      <div style="font-weight:600">${esc(def?def.name:s.dayId||'Session')}</div>
      <div class="tiny">${s.date} · wk ${s.week}${
        elapsedOf(s)?` · ${hms(elapsedOf(s))}`:''}${s.rpe!=null?` · RPE ${s.rpe}`:''}${
        vol?` · ${Math.round(vol).toLocaleString()} lb`:''}${s.play?` · ${s.playHours||2}h play`:''}</div>
      ${s.notes?`<div class="tiny" style="color:var(--dim)">${esc(s.notes)}</div>`:''}</div>
      <button class="btn sec sm" data-act="open" data-sid="${s.id}">View</button></div></div>`;
  }
  return h;
}

const TESTS = [['velo','Velocity (video flight time)','mph'],['frames','…or frame count @240fps/60ft','frames'],
  ['reach','Standing reach','in'],['cmj','CMJ (hands on hips)','in'],['cmjArm','CMJ with arm swing','in'],
  ['approach','Approach jump height','in'],['spike','Spike reach','in'],['rsi','Drop jump RSI','ratio'],
  ['broad','Broad jump','in'],['mbrot','Rotational MB throw','ft'],['mbscoop','MB scoop throw','ft'],
  ['longtoss','Long toss max','ft'],['visa','VISA-P score','/100']];
function vTests(){
  let h = `<h1>Tests</h1><p class="sub">Week 1 is your baseline battery. Then every 3 weeks.</p>
  <div class="flag g">Velocity: 240fps, 60 ft, 5 throws. <b>mph = 9816 ÷ frames</b>. Enter frames and it converts.</div>
  <div class="card">`;
  for(const [k,label,unit] of TESTS){
    const prev = S.tests.filter(t=>t.k===k).sort((a,b)=>a.d<b.d?1:-1)[0];
    h += `<div class="exg"><div class="row sb"><div class="grow">
      <div style="font-weight:600;font-size:15px">${esc(label)}</div>
      <div class="tiny">${prev?`Last ${prev.d}: <b class="mono">${prev.v}</b> ${esc(unit)}`:'No record'}</div></div></div>
      <div class="row" style="margin-top:8px;gap:8px">
        <input inputmode="decimal" placeholder="${esc(unit)}" data-test="${k}" style="max-width:120px">
        <button class="btn sec sm" data-act="savetest" data-k="${k}">Save</button></div></div>`;
  }
  h += `</div>`;
  const hist = S.tests.slice().sort((a,b)=>a.d<b.d?1:-1).slice(0,40);
  if(hist.length) h += `<h2>History</h2><div class="card tight"><table>
    <tr><th>Date</th><th>Test</th><th class="r">Value</th></tr>
    ${hist.map(t=>`<tr><td class="mono tiny">${t.d}</td><td>${esc((TESTS.find(x=>x[0]===t.k)||[,t.k])[1])}</td>
      <td class="r mono">${t.v}</td></tr>`).join('')}</table></div>`;
  return h;
}

function vData(){
  const n = Object.keys(S.sessions).length, b = backupState();
  const pill = PERSISTED === true ? '<span class="pill g">Protected</span>'
    : PERSISTED === false ? '<span class="pill w">Best effort</span>' : '<span class="pill n">Unknown</span>';
  return `<h1>Data</h1><p class="sub">Your log lives in this browser and survives refreshes,
    restarts and going offline. It does not sync to other devices.</p>
  ${storageWarning()}
  <h2>Durability</h2><div class="card tight"><table>
    <tr><td>Saved on every keystroke</td><td class="r"><span class="pill g">Yes</span></td></tr>
    <tr><td>Survives refresh / restart</td><td class="r"><span class="pill g">Yes</span></td></tr>
    <tr><td>Eviction protection</td><td class="r">${pill}</td></tr>
    <tr><td>Installed to Home Screen</td><td class="r">${isStandalone()
      ? '<span class="pill g">Yes</span>' : '<span class="pill w">No</span>'}</td></tr>
    <tr><td>Last backup</td><td class="r mono">${b.last || 'never'}</td></tr>
  </table>
  <div class="tiny" style="margin-top:10px">Lost only if you clear site data, uninstall, or
   switch device or browser. Export covers all three.</div></div>
  <h2>Backup</h2>
  <div class="card"><div class="row sb"><div><div style="font-weight:600">${n} sessions · ${S.tests.length} tests</div>
    <div class="tiny">${(JSON.stringify(S).length/1024).toFixed(1)} KB stored locally</div></div></div>
    <button class="btn" style="margin-top:12px" data-act="export">Export JSON backup</button>
    <div class="tiny" style="margin-top:8px">On your phone the share sheet lets you save it
     straight into iCloud Drive or Google Drive. That is your off-device copy.</div>
    <button class="btn sec" style="margin-top:8px" data-act="import">Import JSON</button>
    <input type="file" id="fin" accept="application/json" style="display:none">
  </div>
  <h2>You</h2><div class="card">
    <div class="row" style="gap:8px"><input inputmode="decimal" placeholder="bodyweight (lb)"
      value="${S.settings.bw ?? ''}" data-set="bw" style="max-width:150px">
      <span class="muted tiny grow">stays on this device, never in the repo</span></div>
    <div class="tiny" style="margin-top:8px">Used for the ×bodyweight column on key lifts.</div></div>
  <h2>Rest alarm</h2><div class="card tight"><table>
    <tr><td>Sound at end of rest</td><td class="r"><span class="pill g">On</span></td></tr>
    <tr><td>Phone notification</td><td class="r">${
      !('Notification' in window) ? '<span class="pill n">Unsupported</span>'
      : Notification.permission === 'granted' ? '<span class="pill g">Allowed</span>'
      : Notification.permission === 'denied' ? '<span class="pill b">Blocked</span>'
      : '<button class="btn sec sm" data-act="notif">Enable</button>'}</td></tr>
    <tr><td>Installed to Home Screen</td><td class="r">${isStandalone()
      ? '<span class="pill g">Yes</span>' : '<span class="pill w">Required for iOS</span>'}</td></tr>
  </table><div class="tiny" style="margin-top:10px">iOS only allows web notifications for
   Home Screen apps, and it suspends the page when the screen locks — so an alarm that comes
   due with the screen off fires the moment you pick the phone back up, not before. The
   countdown itself is always accurate because it runs off an end time, not a tick count.</div></div>
  <h2>Program</h2><div class="card tight"><table>
    <tr><td>Build</td><td class="r mono">${esc(P.meta.build || 'unknown')}</td></tr>
    <tr><td>Start</td><td class="r mono">${P.meta.start}</td></tr>
    <tr><td>Peak event</td><td class="r">${esc(P.meta.peakEvent)}</td></tr>
    <tr><td>Peak date</td><td class="r mono">${P.meta.peakDate}</td></tr>
    <tr><td>Total weeks</td><td class="r mono">${P.meta.totalWeeks}</td></tr>
  </table><div class="tiny" style="margin-top:10px">To change the program, edit program.json and push.
    Never needed for logging.</div></div>
  <h2>Danger</h2><div class="card"><button class="btn sec" data-act="wipe"
    style="color:var(--bad)">Erase all local data</button></div>`;
}

/* ---------- events ---------- */
document.addEventListener('click', e => {
  const t = e.target.closest('[data-act],[data-tab]'); if(!t) return;
  const a = t.dataset.act;
  if(t.dataset.tab){ view = t.dataset.tab; openSession = null; return render(); }
  if(a === 'open'){ openSession = t.dataset.sid;
    const s = getSession(openSession);
    if(s && !s.done && !clockOf(s).since && elapsedOf(s) === 0){ clockStart(s); save(); }
    render(); if(s && !s.done && isRunning(s)) startClock(); return; }
  if(a === 'wk'){ const n = +t.dataset.n;
    if(n >= 1 && n <= P.meta.totalWeeks){ curWeek = n; view = 'week'; openSession = null; }
    return render(); }
  if(a === 'close'){ stopClock(); clearRest(); openSession = null; return render(); }
  if(a === 'score'){ const d = today(); (S.daily[d] ||= {})[t.dataset.site] = +t.dataset.v; save(); return render(); }
  if(a === 'reset-checkin'){ delete S.daily[today()]; save(); return render(); }
  if(a === 'srpe'){ getSession(openSession).rpe = +t.dataset.v; save(); return render(); }
  if(a === 'clk-toggle'){ const s = getSession(openSession);
    isRunning(s) ? clockPause(s) : clockStart(s); save(); render();
    if(isRunning(s)) startClock(); else stopClock(); return; }
  if(a === 'rest-skip'){ clearRest(); return; }
  if(a === 'notif'){
    if('Notification' in window) Notification.requestPermission().then(()=>render());
    return; }
  if(a === 'clk-reset'){ const s = getSession(openSession);
    clockReset(s); save(); stopClock(); return render(); }
  if(a === 'tog'){ const s = getSession(openSession), en = s.entries[+t.dataset.e];
    const st = en.sets[+t.dataset.s];
    st.done = !st.done; save();
    if(st.done){
      // circuits have no rest between drills; the rest belongs between rounds,
      // so it fires when the last drill in the circuit is ticked
      const def = dayDef(s.dayId);
      const blk = def && def.blocks.find(b => b.name === en.block);
      if(blk && blk.circuit){
        const lastEx = blk.items[blk.items.length-1].ex;
        if(en.ex === lastEx) startRest(en.ex, blk.roundRest || '45s');
        else clearRest();
      } else {
        startRest(en.ex, en.rx.rest);
      }
    } else clearRest();
    return render(); }
  if(a === 'addset'){ const s = getSession(openSession), en = s.entries[+t.dataset.e];
    const l = en.sets[en.sets.length-1];
    en.sets.push({reps:l?.reps||'', load:l?.load||'', rpe:l?.rpe||'', done:false});
    save(); return render(); }
  if(a === 'delset'){ const s = getSession(openSession), en = s.entries[+t.dataset.e];
    if(en.sets.length > 1) en.sets.pop(); save(); return render(); }
  if(a === 'finish'){ const s = getSession(openSession);
    // if you typed reps, you did the set — no need to also tick it
    for(const en of s.entries) for(const st of en.sets)
      if(!st.done && num(st.reps) != null) st.done = true;
    const def = dayDef(s.dayId);
    if(def && def.isPlay){ s.play = true; s.playHours = num($('#pHours')?.value) || 2; }
    if(!s.date) s.date = today();
    clockPause(s);
    s.done = true; save(); stopClock(); clearRest();
    openSession = null; view = 'today'; return render(); }
  if(a === 'unfinish'){ const s = getSession(openSession); s.done = false; save(); return render(); }
  if(a === 'savetest'){ const k = t.dataset.k, inp = document.querySelector(`[data-test="${k}"]`);
    let v = num(inp?.value); if(v == null) return;
    if(k === 'frames'){ S.tests.push({d:today(), k:'velo', v:+(9816/v).toFixed(1)}); }
    else S.tests.push({d:today(), k, v});
    save(); return render(); }
  if(a === 'export'){
    S.settings.lastExport = today(); S.settings.lastExportCount = doneCount(); save();
    const b = new Blob([JSON.stringify(S,null,1)], {type:'application/json'});
    const u = URL.createObjectURL(b), l = document.createElement('a');
    l.href = u; l.download = `training-${today()}.json`; l.click(); URL.revokeObjectURL(u);
    render(); return; }
  if(a === 'import'){ $('#fin').click(); return; }
  if(a === 'wipe'){ if(confirm('Erase all logged sessions and tests? This cannot be undone.')){
    localStorage.removeItem(KEY); S = blank(); render(); } return; }
});
document.addEventListener('input', e => {
  if(e.target.dataset.set){ S.settings[e.target.dataset.set] = e.target.value; return save(); }
  const el = e.target; if(!el.dataset.f || !openSession) return;
  const s = getSession(openSession); if(!s) return;
  if(el.dataset.f === 'notes'){ s.notes = el.value; return save(); }
  if(el.dataset.f === 'date'){ s.date = el.value || null; return save(); }
  if(el.dataset.e == null) return;
  s.entries[+el.dataset.e].sets[+el.dataset.s][el.dataset.f] = el.value;
  save();   // no re-render: keeps focus
});
document.addEventListener('change', e => {
  if(e.target.id !== 'fin') return;
  const f = e.target.files[0]; if(!f) return;
  const r = new FileReader();
  r.onload = () => { try { S = Object.assign(blank(), JSON.parse(r.result)); save(); render(); }
                     catch(err){ alert('Could not read that file.'); } };
  r.readAsText(f);
});

/* ---------- boot ---------- */
window.addEventListener('hashchange', () => { if(!P) return; readHash(); render(); });

fetch('program.json?v=' + Date.now())
  .then(r => r.json())
  .then(p => { P = p; readHash();
    if(openSession){
      const s = getSession(openSession);
      if(s && !s.done && !clockOf(s).since && elapsedOf(s) === 0){ clockStart(s); save(); }
    }
    render();
    if(openSession){ const s = S.sessions[openSession]; if(s && !s.done && isRunning(s)) startClock(); }
  renderRest();
    requestPersist().then(ok => { if(ok !== null) render(); });
    if('serviceWorker' in navigator){
      // when a new service worker takes over, reload once so you are running the new code
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if(reloaded) return; reloaded = true; location.reload();
      });
      navigator.serviceWorker.register('sw.js').then(reg => reg.update()).catch(()=>{});
    } })
  .catch(() => { $('#app').innerHTML =
    '<h1>Could not load program</h1><p class="sub">program.json is missing or unreachable.</p>'; });
