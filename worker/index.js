import { DurableObject } from 'cloudflare:workers';
import { advance, createTimer, pause, resume, transitionNotice, validMinutes } from '../docs/timer.js';
import { fromBase64, sendPush } from './push.js';

const error = (message, status = 400) => ({ status, body: { error: message } });
const ok = (body) => ({ status: 200, body });
const activeHosts = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com']);

async function readBody(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing body');
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) throw new Error('Large body');
      text += decoder.decode(value, { stream: true });
    }
    const data = JSON.parse(text + decoder.decode());
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid body');
    return data;
  } catch (problem) {
    void reader.cancel().catch(() => {});
    throw problem;
  }
}

async function normalizeSubscription(value) {
  const endpoint = new URL(value.endpoint);
  const isApple = endpoint.hostname === 'web.push.apple.com' || endpoint.hostname.endsWith('.push.apple.com');
  const isGoogle = endpoint.hostname === 'fcm.googleapis.com';
  if (endpoint.protocol !== 'https:' || endpoint.port || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || (!isApple && !activeHosts.has(endpoint.hostname)) ||
      (isGoogle && !endpoint.pathname.startsWith('/fcm/send/'))) throw new Error('Unsupported endpoint');
  const { p256dh, auth } = value.keys;
  if (typeof p256dh !== 'string' || typeof auth !== 'string' ||
      fromBase64(p256dh).length !== 65 || fromBase64(auth).length !== 16) throw new Error('Invalid keys');
  await crypto.subtle.importKey('raw', fromBase64(p256dh), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  return { endpoint: endpoint.href, keys: { p256dh, auth } };
}

export default {
  async fetch(request, env) {
    const origin = new URL(env.SITE_URL).origin;
    if (request.headers.get('Origin') !== origin) return new Response('Forbidden', { status: 403 });
    const headers = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '600',
      'Cache-Control': 'no-store',
      Vary: 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const action = new URL(request.url).pathname.slice(1);
    const get = ['state', 'config'].includes(action);
    const post = ['enable', 'disable', 'start', 'pause', 'resume', 'reset', 'test'].includes(action);
    if (!(get && request.method === 'GET' || post && request.method === 'POST')) {
      return Response.json({ error: 'ページが見つかりません。' }, { status: 404, headers });
    }
    if (action === 'config') return Response.json({ publicKey: env.VAPID_PUBLIC_KEY }, { headers });
    const token = request.headers.get('Authorization')?.match(/^Bearer ([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/)?.[1];
    if (!token) return Response.json({ error: '通知をオンにし直してください。' }, { status: 401, headers });
    let data;
    if (post) {
      try {
        data = await readBody(request);
        if (action === 'enable') data = await normalizeSubscription(data.subscription);
      } catch {
        return Response.json({ error: 'この通知設定は登録できません。' }, { status: 400, headers });
      }
    }
    try {
      const { status, body } = await env.TIMERS.getByName(token).command(action, data ?? null);
      return Response.json(body, { status, headers });
    } catch {
      return Response.json({ error: '通知サーバーでエラーが起きました。もう一度お試しください。' }, { status: 500, headers });
    }
  },
};

export class TimerSession extends DurableObject {
  async command(action, data) {
    const storage = this.ctx.storage;
    if (action === 'state') {
      const state = await storage.get('state');
      return ok({ enabled: !!state?.subscription, timer: advance(state?.timer ?? null, Date.now()) });
    }
    if (action === 'test') return this.testNotification();
    return storage.transaction(async (transaction) => {
      const state = await transaction.get('state');
      const now = Date.now();
      if (action === 'enable') {
        if (state?.subscription) return ok({ enabled: true });
        await transaction.put('state', { subscription: data, timer: null, lastTest: 0 });
        return ok({ enabled: true });
      }
      if (action === 'disable') {
        await transaction.delete('state');
        await transaction.deleteAlarm();
        return ok({ enabled: false });
      }
      if (!state?.subscription) return error('通知をオンにし直してください。', 410);
      let timer = state.timer;
      if (action === 'start') {
        if (!validMinutes(data.focus) || !validMinutes(data.rest)) return error('時間は1～180分で設定してください。');
        timer ??= createTimer(data.focus, data.rest, now);
      } else if (action === 'pause' && timer?.due != null) timer = pause(timer, now);
      else if (action === 'resume' && timer?.due === null) timer = resume(timer, now);
      else if (action === 'reset') timer = null;

      await transaction.put('state', { ...state, timer });
      if (timer?.due != null) await transaction.setAlarm(timer.due);
      else await transaction.deleteAlarm();
      return ok({ timer: advance(timer, now) });
    });
  }

  async testNotification() {
    const entry = await this.ctx.storage.transaction(async (transaction) => {
      const state = await transaction.get('state');
      if (!state?.subscription) return error('通知をオンにし直してください。', 410);
      const now = Date.now();
      if (now - state.lastTest < 15_000) return error('15秒ほど待ってからお試しください。', 429);
      await transaction.put('state', { ...state, lastTest: now });
      return { subscription: state.subscription };
    });
    if (!entry.subscription) return entry;
    const status = await this.deliver(entry.subscription, {
      title: '集中タイマー',
      body: 'テスト通知が届きました。',
      tag: 'test',
    });
    return status >= 200 && status < 300 ? ok({ sent: true }) : error('通知を送信できませんでした。通知設定を確認してください。', 502);
  }

  async alarm() {
    const event = await this.ctx.storage.transaction(async (transaction) => {
      const state = await transaction.get('state');
      if (!state?.subscription || state.timer?.due == null) return null;
      const timer = advance(state.timer, Date.now());
      await transaction.setAlarm(timer.due);
      if (timer === state.timer) return null;
      await transaction.put('state', { ...state, timer });
      return { subscription: state.subscription, notice: transitionNotice(timer) };
    });
    if (event) await this.deliver(event.subscription, event.notice);
  }

  async deliver(subscription, notice) {
    let status;
    try { status = await sendPush(subscription, notice, this.env); }
    catch { status = 503; }
    if (status === 404 || status === 410) {
      await this.ctx.storage.transaction(async (transaction) => {
        const state = await transaction.get('state');
        if (state?.subscription?.endpoint !== subscription.endpoint) return;
        await transaction.put('state', { ...state, subscription: null });
        await transaction.deleteAlarm();
      });
    }
    if (status >= 400) console.warn('push_delivery_rejected', { status });
    return status;
  }
}
