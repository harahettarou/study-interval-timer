export const minute = 60_000;

export function validMinutes(value) {
  return Number.isInteger(value) && value >= 1 && value <= 180;
}

export function createTimer(focus, rest, now) {
  return { focus, rest, phase: 'focus', due: now + focus * minute, left: null };
}

export function duration(timer, phase = timer.phase) {
  return (phase === 'focus' ? timer.focus : timer.rest) * minute;
}

export function advance(timer, now) {
  if (!timer || timer.due === null || now < timer.due) return timer;
  const cycle = (timer.focus + timer.rest) * minute;
  const boundary = timer.due + Math.floor((now - timer.due) / cycle) * cycle;
  const other = timer.phase === 'focus' ? 'break' : 'focus';
  const nextBoundary = boundary + duration(timer, other);
  if (now < nextBoundary) return { ...timer, phase: other, due: nextBoundary };
  return { ...timer, due: boundary + cycle };
}

export function pause(timer, now) {
  const current = advance(timer, now);
  return { ...current, due: null, left: current.due - now };
}

export function resume(timer, now) {
  return { ...timer, due: now + timer.left, left: null };
}

export function transitionNotice(timer) {
  const focus = timer.phase === 'focus';
  return {
    title: focus ? '休憩終了' : '集中終了',
    body: focus ? `集中を開始しました（${timer.focus}分）` : `休憩を開始しました（${timer.rest}分）`,
    tag: `phase-${timer.due}`,
  };
}
