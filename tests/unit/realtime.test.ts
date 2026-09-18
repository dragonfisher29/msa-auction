import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startPolling, checkHealth } from '../../src/lib/realtime';

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    value: state,
    configurable: true,
  });
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

  it('polls fn repeatedly on the interval', async () => {
    const fn = vi.fn().mockResolvedValue('data');
    const onData = vi.fn();
    const stop = startPolling(fn, 1000, onData);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onData).toHaveBeenNthCalledWith(1, 'data');

    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(3);

    stop();
  });

  it('does not overlap: skips a tick while the previous fn call is still pending', async () => {
    let resolveFn: (value: string) => void = () => {};
    const fn = vi.fn().mockImplementation(
      () => new Promise<string>((resolve) => { resolveFn = resolve; }),
    );
    const onData = vi.fn();
    const stop = startPolling(fn, 1000, onData);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);

    // A second interval tick fires while the first call is still in flight.
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);

    resolveFn('first-result');
    await vi.advanceTimersByTimeAsync(0);
    expect(onData).toHaveBeenCalledWith('first-result');

    // Now that the in-flight call resolved, the next tick runs fn again.
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);

    stop();
  });

  it('the returned stop function halts further polling', async () => {
    const fn = vi.fn().mockResolvedValue('data');
    const onData = vi.fn();
    const stop = startPolling(fn, 1000, onData);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);

    stop();

    await vi.advanceTimersByTimeAsync(10000);
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

  it('skips ticks while the tab is hidden and fires immediately when it becomes visible again', async () => {
    setVisibility('hidden');

    const fn = vi.fn().mockResolvedValue('data');
    const onData = vi.fn();
    const stop = startPolling(fn, 1000, onData);

    await vi.advanceTimersByTimeAsync(3000);
    expect(fn).not.toHaveBeenCalled();

    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(onData).toHaveBeenCalledWith('data');

    stop();
  });

  it('a rejected fn does not kill the interval; subsequent ticks still run', async () => {
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

describe('checkHealth', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns true only when the response is ok and the body status is "ok"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok' }),
    }));

    await expect(checkHealth()).resolves.toBe(true);
  });

  it('returns false for a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ status: 'ok' }),
    }));

    await expect(checkHealth()).resolves.toBe(false);
  });

  it('returns false for a wrong status string', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'degraded' }),
    }));

    await expect(checkHealth()).resolves.toBe(false);
  });

  it('returns false when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    await expect(checkHealth()).resolves.toBe(false);
  });
});
