import { advance, createTimer, duration, minute, pause, resume } from './timer.js';

const apiUrl = 'https://study-interval-timer.niwatorikounotori.workers.dev';
const byId = (id) => document.getElementById(id);
const form = byId('settings');
const focusInput = byId('focus');
const breakInput = byId('break');
const toggle = byId('toggle');
const reset = byId('reset');
const notify = byId('notify');
const testNotify = byId('test-notify');
const note = byId('notify-note');
const message = byId('message');
const clock = document.querySelector('.clock');
const progress = byId('progress');
const labels = { focus: '集中', break: '休憩' };
const storageKey = 'study-interval-timer.v1';

let saved = {};
try { saved = JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch {}
focusInput.value = saved.focus ?? 50;
breakInput.value = saved.rest ?? 10;
let timer = saved.timer ?? null;
let token = saved.token ?? null;
let registration;
let publicKey;
let busy = false;
let revision = 0;
let audio;

function store() {
  localStorage.setItem(storageKey, JSON.stringify({
    timer, token, focus: focusInput.valueAsNumber, rest: breakInput.valueAsNumber,
  }));
}

function say(text = '', error = false) {
  message.hidden = !text;
  message.textContent = text;
  message.dataset.error = error;
}

function render(now = Date.now()) {
  const current = advance(timer, now);
  const phase = current?.phase ?? 'focus';
  const total = current ? duration(current) : (focusInput.valueAsNumber || 0) * minute;
  const left = current ? current.left ?? current.due - now : total;
  const seconds = Math.max(0, Math.ceil(left / 1000));
  const next = phase === 'focus' ? 'break' : 'focus';
  const nextMinutes = next === 'break' ? current?.rest ?? breakInput.valueAsNumber : current.focus;

  clock.dataset.phase = phase;
  byId('focus-tab').toggleAttribute('aria-current', phase === 'focus');
  byId('break-tab').toggleAttribute('aria-current', phase === 'break');
  byId(phase + '-tab').setAttribute('aria-current', 'step');
  const phaseText = labels[phase] + (current?.due === null ? ' · 一時停止' : '');
  if (byId('phase').textContent !== phaseText) byId('phase').textContent = phaseText;
  byId('remaining').textContent = String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
  byId('next').textContent = `次は${labels[next]} · ${nextMinutes || '—'}分`;
  progress.style.strokeDasharray = `${total ? Math.max(0, Math.min(100, 100 * left / total)) : 0} 100`;
  toggle.textContent = !timer ? 'スタート' : timer.due === null ? '再開' : '一時停止';
  toggle.disabled = busy;
  reset.disabled = busy || !timer;
  focusInput.disabled = breakInput.disabled = busy || !!timer;
  notify.disabled = busy || !!timer || (!token && !publicKey);
  notify.textContent = token ? '通知をオフ' : '通知をオン';
  testNotify.hidden = !token;
  testNotify.disabled = busy;
}

async function api(path, data, auth = token) {
  const headers = {};
  if (auth) headers.Authorization = 'Bearer ' + auth;
  if (data) headers['Content-Type'] = 'application/json';
  const response = await fetch(apiUrl + '/' + path, {
    method: data ? 'POST' : 'GET', headers,
    body: data ? JSON.stringify(data) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '通知サーバーと通信できませんでした。');
  return result;
}

function refreshNote() {
  if (token) note.textContent = 'ロック画面への通知がオンです。';
  else if (!('PushManager' in window) || !('serviceWorker' in navigator)) {
    note.textContent = 'iPhone・iPadでは、Safariの共有メニューから「ホーム画面に追加」し、追加したアイコンから開いてください。';
  } else if (Notification.permission === 'denied') {
    note.textContent = '端末の通知設定で、このアプリの通知を許可してください。';
  } else if (publicKey) note.textContent = '切り替えをロック画面に通知できます。';
}

function unlockAudio() {
  try {
    audio ??= new AudioContext();
    void audio.resume().catch(() => {});
  } catch {}
}

function chime() {
  if (audio?.state !== 'running') return;
  [640, 850].forEach((frequency, index) => {
    const start = audio.currentTime + index * 0.17;
    const tone = audio.createOscillator();
    const gain = audio.createGain();
    tone.type = 'sine';
    tone.frequency.value = frequency;
    gain.gain.setValueAtTime(0.15, start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.23);
    tone.connect(gain).connect(audio.destination);
    tone.start(start);
    tone.stop(start + 0.24);
  });
}

async function run(action) {
  if (busy) return;
  revision += 1;
  busy = true;
  say();
  render();
  try { await action(); }
  catch (error) {
    say(error instanceof TypeError || error.name === 'TimeoutError' ? '通信できませんでした。接続を確認して、もう一度お試しください。' : error.message, true);
  } finally {
    busy = false;
    refreshNote();
    render();
  }
}

function tick() {
  if (!token && !busy && timer) {
    const current = advance(timer, Date.now());
    if (current !== timer) {
      timer = current;
      store();
      if (!document.hidden) chime();
    }
  }
  render();
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const focus = focusInput.valueAsNumber;
  const rest = breakInput.valueAsNumber;
  unlockAudio();
  void run(async () => {
    const action = !timer ? 'start' : timer.due === null ? 'resume' : 'pause';
    if (token) timer = (await api(action, action === 'start' ? { focus, rest } : {})).timer;
    else if (action === 'start') timer = createTimer(focus, rest, Date.now());
    else if (action === 'resume') timer = resume(timer, Date.now());
    else timer = pause(timer, Date.now());
    store();
  });
});

reset.addEventListener('click', () => void run(async () => {
  if (token) await api('reset', {});
  timer = null;
  store();
}));

form.addEventListener('input', () => {
  store();
  render();
});

notify.addEventListener('click', () => void run(async () => {
  if (token) {
    await api('disable', {});
    token = null;
    store();
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) await subscription.unsubscribe();
    return;
  }
  if (Notification.permission === 'denied') {
    throw new Error('端末の通知設定で許可してから、もう一度お試しください。');
  }
  const newSubscription = registration.pushManager.subscribe({
    userVisibleOnly: true, applicationServerKey: publicKey,
  });
  const subscription = await newSubscription;
  const newToken = crypto.randomUUID();
  await api('enable', { subscription: subscription.toJSON() }, newToken);
  token = newToken;
  store();
}));

testNotify.addEventListener('click', () => void run(async () => {
  await api('test', {});
  say('テスト通知を送信しました。');
}));

function sync() {
  if (!token || busy || document.hidden) return;
  const currentToken = token;
  const currentRevision = revision;
  void api('state').then((result) => {
    if (busy || currentToken !== token || currentRevision !== revision) return;
    timer = result.timer;
    if (timer) {
      focusInput.value = timer.focus;
      breakInput.value = timer.rest;
    }
    if (!result.enabled) {
      token = null;
      say('通知が無効になりました。通知をオンにし直してください。', true);
    }
    store();
    refreshNote();
    render();
  }).catch(() => {});
}

document.addEventListener('visibilitychange', () => { tick(); sync(); });
window.addEventListener('online', sync);
setInterval(tick, 250);
setInterval(sync, 20_000);
tick();
refreshNote();
sync();
if ('PushManager' in window && 'serviceWorker' in navigator) {
  Promise.all([
    navigator.serviceWorker.register('./sw.js').then(() => navigator.serviceWorker.ready),
    api('config', undefined, null),
  ]).then(([worker, config]) => {
    registration = worker;
    publicKey = Uint8Array.from(atob(config.publicKey.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
    refreshNote();
    render();
  }).catch(() => {
    note.textContent = '通知の設定を読み込めませんでした。再読み込みしてお試しください。';
  });
}
