import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startPolling } from '../../src/lib/realtime';

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    value: state,
    configurable: true,
  });
}

function becomeVisible() {
  setVisibility('visible');
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('startPolling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility('visible');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('polls fn repeatedly on the interval, starting one interval after it is started', async () => {
    const fn = vi.fn().mockResolvedValue('data');
    const onData = vi.fn();
    const stop = startPolling(fn, 1000, onData);

    await vi.advanceTimersByTimeAsync(999);
    expect(fn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onData).toHaveBeenNthCalledWith(1, 'data');

    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(3);

    stop();
  });

  it('never overlaps: the next run is scheduled only after the previous one finishes', async () => {
    let resolveFn: (value: string) => void = () => {};
    const fn = vi.fn().mockImplementation(
      () => new Promise<string>((resolve) => { resolveFn = resolve; }),
    );
    const onData = vi.fn();
    const stop = startPolling(fn, 1000, onData);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);

    // Well past another interval while the first call is still in flight: no second call.
    await vi.advanceTimersByTimeAsync(5000);
    expect(fn).toHaveBeenCalledTimes(1);

    resolveFn('first-result');
    await vi.advanceTimersByTimeAsync(0);
    expect(onData).toHaveBeenCalledWith('first-result');

    // The next run is a full interval after the first one resolved -- no catch-up burst.
    await vi.advanceTimersByTimeAsync(999);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);

    stop();
  });

  it('the returned stop function halts further polling and detaches the wake listeners', async () => {
    const fn = vi.fn().mockResolvedValue('data');
    const onData = vi.fn();
    const stop = startPolling(fn, 1000, onData);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);

    stop();

    await vi.advanceTimersByTimeAsync(10000);
    window.dispatchEvent(new Event('focus'));
    becomeVisible();
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not call onData after stop, even if an in-flight request resolves later', async () => {
    let resolveFn: (value: string) => void = () => {};
    const fn = vi.fn().mockImplementation(
      () => new Promise<string>((resolve) => { resolveFn = resolve; }),
    );
    const onData = vi.fn();
    const stop = startPolling(fn, 1000, onData);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);

    stop();

    resolveFn('too-late');
    await vi.advanceTimersByTimeAsync(0);

    expect(onData).not.toHaveBeenCalled();
  });

  it('makes no requests at all while the tab is hidden, and fires immediately when it becomes visible again', async () => {
    setVisibility('hidden');

    const fn = vi.fn().mockResolvedValue('data');
    const onData = vi.fn();
    const stop = startPolling(fn, 1000, onData);

    await vi.advanceTimersByTimeAsync(10000);
    expect(fn).not.toHaveBeenCalled();

    becomeVisible();
    await vi.advanceTimersByTimeAsync(0);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(onData).toHaveBeenCalledWith('data');

    // And the regular interval resumes from there.
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);

    stop();
  });

  it('refreshes on window focus once minGapMs has passed since the last run', async () => {
    const fn = vi.fn().mockResolvedValue('data');
    const onData = vi.fn();
    const stop = startPolling(fn, 60_000, onData, { minGapMs: 30_000 });

    await vi.advanceTimersByTimeAsync(30_000);
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);

    expect(fn).toHaveBeenCalledTimes(1);

    stop();
  });

  it('throttles wake events: focus + visibilitychange together, or a quick alt-tab, cost nothing extra', async () => {
    const fn = vi.fn().mockResolvedValue('data');
    const onData = vi.fn();
    const stop = startPolling(fn, 60_000, onData, { minGapMs: 30_000 });

    // Too soon after start (which counts as the caller's own initial fetch).
    await vi.advanceTimersByTimeAsync(10_000);
    window.dispatchEvent(new Event('focus'));
    becomeVisible();
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).not.toHaveBeenCalled();

    // Past the gap: the pair of events fires exactly one request.
    await vi.advanceTimersByTimeAsync(25_000);
    window.dispatchEvent(new Event('focus'));
    becomeVisible();
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);

    stop();
  });

  it('stays within one request per interval while left open and visible', async () => {
    const fn = vi.fn().mockResolvedValue('data');
    const stop = startPolling(fn, 60_000, vi.fn());

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fn).toHaveBeenCalledTimes(10);

    stop();
  });

  it('a rejected fn does not kill the loop; subsequent runs still happen', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('ok');
    const onData = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const stop = startPolling(fn, 1000, onData);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onData).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onData).toHaveBeenCalledWith('ok');

    stop();
  });
});
