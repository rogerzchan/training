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
    if(!s.done || !s.date || s.date < b.start || s.date > b.end) continue;
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
    s.entries.push({ex:it.ex, block:blk.name, rx:it,
      sets:Array.from({length:n},()=>({reps:'',load:it.load??'',rpe:'',done:false}))});
  }
  S.sessions[id] = s; save(); return s;
}
function started(s){ return !!s && (s.done || s.entries.some(e=>e.sets.some(x=>x.done))); }
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
function render(){
  const v = {today:vToday, week:vWeek, log:vHistory, tests:vTests, data:vData}[view] || vToday;
  $('#app').innerHTML = openSession ? vSession() : v();
  renderTabs(); syncHash(); window.scrollTo(0,0);
}
function renderTabs(){
  const t = [['today','◉','Today'],['week','▦','Week'],['log','≡','Log'],['tests','◎','Tests'],['data','⚙','Data']];
  $('#tabs').innerHTML = t.map(([k,i,l]) =>
    `<button data-tab="${k}" class="${view===k&&!openSession?'on':''}"><span class="ic">${i}</span>${l}</button>`).join('');
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
    else if(isNext) pill = '<span class="pill n">Next up</span>';
    h += `<div class="dayitem ${isSuggest?'today':''}"><div class="grow">
      <div style="font-weight:${isNext||isSuggest?650:500}">${i+1}. ${esc(def.name)}</div>
      <div class="tiny">${def.mins?`${def.mins} min · `:''}${isSuggest?'suggested today · ':''}${
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
    <div class="row sb"><b class="mono">${bud.total}</b><span class="muted mono">/ ${bud.ceiling}</span></div>
    <div class="bar"><i class="${bud.level}" style="width:${bud.pct}%"></i></div>
    <div class="tiny" style="margin-top:8px">Volleyball ${bud.vbHours}h ≈ ${bud.vbJumps} jumps · training ${bud.contacts} contacts</div>
    ${bud.level==='b'?'<div class="flag b" style="margin:10px 0 0">Over budget. Cut training jumps, never the volleyball.</div>':''}
    ${bud.level==='w'?'<div class="flag" style="margin:10px 0 0">Approaching ceiling. Skip the microdose if you add a session.</div>':''}
  </div>`;

  const keys = ['bench','squatacc','hangclean'];
  const rows = keys.map(k=>{const b=bestE1(k); return b?`<tr><td>${esc(P.exercises[k].name)}</td>
      <td class="r mono">${b.load}×${b.reps}</td><td class="r mono">${Math.round(b.v)}</td>
      <td class="r mono">${(b.v/P.athlete.bw).toFixed(2)}x</td></tr>`:''}).filter(Boolean).join('');
  if(rows) h += `<h2>Key lifts</h2><div class="card tight"><table>
    <tr><th>Lift</th><th class="r">Best</th><th class="r">e1RM</th><th class="r">×BW</th></tr>${rows}</table></div>`;
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
    <button class="addset" style="display:inline;padding:0;margin-left:4px" data-act="export">Export now →</button></div>`;
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
    ${s.done?'<span class="pill g">Done</span>':started(s)?'<span class="pill w">Part done</span>':''}</div>
    <h1 style="margin-top:14px">${esc(def.name)}</h1>
    <p class="sub">Week ${s.week} · session ${s.slot+1} of 7 · ${def.mins} min target${
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
    s.entries.forEach((en,ei)=>{
      if(en.block !== cur){ cur = en.block; h += `<h2>${esc(cur)}</h2>`; }
      const ex = P.exercises[en.ex] || {name:en.ex, cue:''};
      const rx = en.rx, lp = lastPerf(en.ex, id), hint = progressionHint(en.ex, id);
      h += `<div class="card"><div class="exname">${esc(ex.name)}</div>
        ${ex.cue?`<div class="cue">${esc(ex.cue)}</div>`:''}
        <div class="rx">${esc(rx.sets)} × ${esc(rx.reps)} · rest ${esc(rx.rest)}${rx.load?` · ${rx.load}`:''}${rx.note?` · ${esc(rx.note)}`:''}</div>
        ${lp?`<div class="last">Last ${lp.date}: ${lp.sets.map(x=>`${x.reps||'?'}×${x.load||'bw'}`).join(', ')}</div>`:'<div class="last">No history</div>'}
        ${hint?`<div class="last" style="color:var(--acc)">${esc(hint)}</div>`:''}
        <div class="sets">
          ${en.sets.map((st,si)=>`<div class="set">
            <span class="n">${si+1}</span>
            <input inputmode="numeric" placeholder="reps" value="${esc(st.reps)}" data-f="reps" data-e="${ei}" data-s="${si}">
            <input inputmode="decimal" placeholder="${ex.unit==='none'?'bw':ex.unit}" value="${esc(st.load)}" data-f="load" data-e="${ei}" data-s="${si}">
            <input inputmode="numeric" placeholder="rpe" value="${esc(st.rpe)}" data-f="rpe" data-e="${ei}" data-s="${si}">
            <button class="chk ${st.done?'on':''}" data-act="tog" data-e="${ei}" data-s="${si}">${st.done?'✓':''}</button>
          </div>`).join('')}
        </div>
        <div class="row sb"><button class="addset" data-act="addset" data-e="${ei}">+ Add set</button>
        ${en.sets.length>1?`<button class="addset" style="color:var(--dim2)" data-act="delset" data-e="${ei}">− Remove</button>`:''}</div>
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
      <div style="text-align:center"><div style="font-weight:700">Week ${w.n}</div>
        <div class="tiny">${esc(w.sub)}${isNow?' · current':''}</div></div>
      <button class="btn sec sm" data-act="wk" data-n="${w.n+1}" ${w.n>=P.meta.totalWeeks?'disabled':''}>Next ›</button>
    </div>
    <p class="sub" style="margin-top:14px">Block ${esc(w.block)} · ${esc(w.priority)} priority
      · starts ${w.start} · <span class="mono">${prog.done}/${prog.total}</span> done</p>`;
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
      <div class="tiny">${s.date} · wk ${s.week}${s.rpe!=null?` · RPE ${s.rpe}`:''}${
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
  <h2>Program</h2><div class="card tight"><table>
    <tr><td>Start</td><td class="r mono">${P.meta.start}</td></tr>
    <tr><td>Peak event</td><td class="r">${esc(P.meta.peakEvent)}</td></tr>
    <tr><td>Peak date</td><td class="r mono">${P.meta.peakDate}</td></tr>
    <tr><td>Total weeks</td><td class="r mono">${P.meta.totalWeeks}</td></tr>
    <tr><td>Bodyweight</td><td class="r mono">${P.athlete.bw} lb</td></tr>
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
  if(a === 'open'){ openSession = t.dataset.sid; return render(); }
  if(a === 'wk'){ const n = +t.dataset.n;
    if(n >= 1 && n <= P.meta.totalWeeks){ curWeek = n; view = 'week'; openSession = null; }
    return render(); }
  if(a === 'close'){ openSession = null; return render(); }
  if(a === 'score'){ const d = today(); (S.daily[d] ||= {})[t.dataset.site] = +t.dataset.v; save(); return render(); }
  if(a === 'reset-checkin'){ delete S.daily[today()]; save(); return render(); }
  if(a === 'srpe'){ getSession(openSession).rpe = +t.dataset.v; save(); return render(); }
  if(a === 'tog'){ const s = getSession(openSession), st = s.entries[+t.dataset.e].sets[+t.dataset.s];
    st.done = !st.done; save(); return render(); }
  if(a === 'addset'){ const s = getSession(openSession), en = s.entries[+t.dataset.e];
    const l = en.sets[en.sets.length-1]; en.sets.push({reps:l?.reps||'', load:l?.load||'', rpe:'', done:false});
    save(); return render(); }
  if(a === 'delset'){ const s = getSession(openSession), en = s.entries[+t.dataset.e];
    if(en.sets.length > 1) en.sets.pop(); save(); return render(); }
  if(a === 'finish'){ const s = getSession(openSession);
    const def = dayDef(s.dayId);
    if(def && def.isPlay){ s.play = true; s.playHours = num($('#pHours')?.value) || 2; }
    if(!s.date) s.date = today();
    s.done = true; save();
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
  .then(p => { P = p; readHash(); render();
    requestPersist().then(ok => { if(ok !== null) render(); });
    if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{}); })
  .catch(() => { $('#app').innerHTML =
    '<h1>Could not load program</h1><p class="sub">program.json is missing or unreachable.</p>'; });
