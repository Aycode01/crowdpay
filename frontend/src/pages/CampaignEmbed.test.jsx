import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import CampaignEmbed from './CampaignEmbed';

const CAMPAIGN_DATA = {
  id: '123',
  title: 'Test Campaign',
  description: 'A test campaign',
  raised_amount: '5000',
  target_amount: '10000',
  asset_type: 'USDC',
  progress_percentage: 50,
  backer_count: 25,
  days_remaining: 10,
  contribution_url: 'https://example.com/contribute',
  milestones: [],
  milestone_summary: null,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CampaignEmbed', () => {
  let resizeObserverMock;
  let postMessageSpy;

  beforeEach(() => {
    let resizeCb = null;
    resizeObserverMock = {
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
      trigger: () => {
        if (resizeCb) resizeCb();
      },
    };
    globalThis.ResizeObserver = class {
      constructor(cb) {
        resizeCb = () => cb();
      }
      observe(el) {
        resizeObserverMock.observe(el);
      }
      unobserve() {
        resizeObserverMock.unobserve();
      }
      disconnect() {
        resizeObserverMock.disconnect();
      }
    };

    postMessageSpy = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 500,
      configurable: true,
      writable: true,
    });
  });

  function renderEmbed(url) {
    window.history.pushState({}, '', url || '/embed/campaigns/123?origin=http://localhost');
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(CAMPAIGN_DATA),
    });
    return render(<CampaignEmbed />);
  }

  it('sends initial height notification using the configured origin', async () => {
    renderEmbed();
    await waitFor(() => {
      expect(postMessageSpy).toHaveBeenCalledWith(
        { type: 'resize', height: 500 },
        'http://localhost'
      );
    });
  });

  it('observes document.documentElement with ResizeObserver', () => {
    renderEmbed();
    expect(resizeObserverMock.observe).toHaveBeenCalledWith(document.documentElement);
  });

  it('does not send duplicate height notifications when size is unchanged', async () => {
    renderEmbed();
    await waitFor(() => {
      expect(postMessageSpy).toHaveBeenCalledTimes(2);
    });
    act(() => {
      resizeObserverMock.trigger();
    });
    expect(postMessageSpy).toHaveBeenCalledTimes(2);
  });

  it('sends a new notification when height actually changes', async () => {
    renderEmbed();
    await waitFor(() => {
      expect(postMessageSpy).toHaveBeenCalledTimes(2);
    });
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 999,
      configurable: true,
      writable: true,
    });
    act(() => {
      resizeObserverMock.trigger();
    });
    expect(postMessageSpy).toHaveBeenCalledWith(
      { type: 'resize', height: 999 },
      'http://localhost'
    );
  });

  it('disconnects ResizeObserver on unmount', () => {
    const { unmount } = renderEmbed();
    unmount();
    expect(resizeObserverMock.disconnect).toHaveBeenCalled();
  });

  it('falls back to document.referrer origin when origin param is absent', async () => {
    Object.defineProperty(document, 'referrer', {
      value: 'https://example.com/some-page',
      configurable: true,
    });
    renderEmbed('/embed/campaigns/123');
    await waitFor(() => {
      expect(postMessageSpy).toHaveBeenCalledWith(
        { type: 'resize', height: expect.any(Number) },
        'https://example.com'
      );
    });
  });

  it('uses wildcard when no origin is available', async () => {
    Object.defineProperty(document, 'referrer', {
      value: '',
      configurable: true,
    });
    renderEmbed('/embed/campaigns/123');
    await waitFor(() => {
      expect(postMessageSpy).toHaveBeenCalledWith(
        { type: 'resize', height: expect.any(Number) },
        '*'
      );
    });
  });
});
