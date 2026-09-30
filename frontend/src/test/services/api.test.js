import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, retryQueuedRequests, apiClient } from '../../services/api';

const { responseRejectedHandlers } = vi.hoisted(() => ({ responseRejectedHandlers: [] }));

// Mock axios
vi.mock('axios', () => {
  const mockAxios = {
    create: vi.fn(() => mockAxios),
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn((_success, failure) => responseRejectedHandlers.push(failure)) },
    },
    request: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
  return { default: mockAxios };
});

import axios from 'axios';

describe('API Service - CSRF Interceptor', () => {
  let mockDocumentCookie;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock document.cookie
    mockDocumentCookie = '';
    Object.defineProperty(document, 'cookie', {
      get: () => mockDocumentCookie,
      set: (val) => {
        mockDocumentCookie = val;
      },
      configurable: true,
    });
  });

  it('attaches CSRF token to mutating requests when cookie exists', async () => {
    mockDocumentCookie = 'cp_csrf=test-csrf-token';

    axios.post.mockResolvedValue({ data: { success: true } });

    await api.createCampaign({ title: 'Test' });

    // Check that the request interceptor was called with the CSRF header
    const postCall = axios.post.mock.calls[0];
    const config = postCall[2];
    expect(config.headers['x-csrf-token']).toBe('test-csrf-token');
  });

  it('does not attach CSRF token when cookie is missing', async () => {
    mockDocumentCookie = '';

    axios.post.mockResolvedValue({ data: { success: true } });

    await api.createCampaign({ title: 'Test' });

    const postCall = axios.post.mock.calls[0];
    const config = postCall[2];
    expect(config.headers['x-csrf-token']).toBeUndefined();
  });

  it('does not attach CSRF token to GET requests', async () => {
    mockDocumentCookie = 'cp_csrf=test-csrf-token';

    axios.get.mockResolvedValue({ data: { campaigns: [] } });

    await api.getCampaigns({});

    const getCall = axios.get.mock.calls[0];
    const config = getCall[1];
    expect(config.headers['x-csrf-token']).toBeUndefined();
  });

  it('attaches CSRF token to PUT requests', async () => {
    mockDocumentCookie = 'cp_csrf=test-csrf-token';

    axios.put.mockResolvedValue({ data: { success: true } });

    await api.updateCampaign('campaign-id', { title: 'Updated' });

    const putCall = axios.put.mock.calls[0];
    const config = putCall[2];
    expect(config.headers['x-csrf-token']).toBe('test-csrf-token');
  });

  it('attaches CSRF token to PATCH requests', async () => {
    mockDocumentCookie = 'cp_csrf=test-csrf-token';

    axios.patch.mockResolvedValue({ data: { success: true } });

    await api.updateCampaign('campaign-id', { title: 'Updated' });

    const patchCall = axios.patch.mock.calls[0];
    const config = patchCall[2];
    expect(config.headers['x-csrf-token']).toBe('test-csrf-token');
  });

  it('attaches CSRF token to DELETE requests', async () => {
    mockDocumentCookie = 'cp_csrf=test-csrf-token';

    axios.delete.mockResolvedValue({ data: { success: true } });

    await api.deleteApiKey('key-id');

    const deleteCall = axios.delete.mock.calls[0];
    const config = deleteCall[2];
    expect(config.headers['x-csrf-token']).toBe('test-csrf-token');
  });
});

describe('API Service - Offline Retry Queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function rejectNetworkRequest(config = {}) {
    const error = new Error('Network Error');
    error.config = { method: 'get', url: '/campaigns', ...config };
    return responseRejectedHandlers[0](error);
  }

  it('delivers the replay response to the original GET caller', async () => {
    const originalRequest = rejectNetworkRequest();
    const response = { data: { campaigns: [] } };
    axios.request.mockResolvedValue(response);

    await retryQueuedRequests();

    await expect(originalRequest).resolves.toBe(response);
    expect(axios.request).toHaveBeenCalledTimes(1);
    expect(axios.request.mock.calls[0][0]._retried).toBe(true);
  });

  it('shares one replay for duplicate GETs and resolves each original caller', async () => {
    const firstRequest = rejectNetworkRequest();
    const secondRequest = rejectNetworkRequest();
    const response = { data: { campaigns: [] } };
    axios.request.mockResolvedValue(response);

    await retryQueuedRequests();

    await expect(Promise.all([firstRequest, secondRequest])).resolves.toEqual([response, response]);
    expect(axios.request).toHaveBeenCalledTimes(1);
  });

  it('propagates replay failures to the original caller and drains the queue', async () => {
    const originalRequest = rejectNetworkRequest();
    axios.request.mockRejectedValue({
      response: { status: 503, data: { error: { message: 'Unavailable', code: 'DOWN' } } },
    });

    const outcomes = await retryQueuedRequests();

    await expect(originalRequest).rejects.toMatchObject({ status: 503, code: 'DOWN' });
    expect(outcomes[0].status).toBe('rejected');
    expect(await retryQueuedRequests()).toEqual([]);
  });

  it('does not queue non-GET requests', async () => {
    const error = new Error('Network Error');
    error.config = { method: 'post', url: '/campaigns' };

    await expect(responseRejectedHandlers[0](error)).rejects.toMatchObject({ status: 0 });
    await retryQueuedRequests();
    expect(axios.request).not.toHaveBeenCalled();
  });

  it('caps the queue at 100 requests and rejects an evicted caller', async () => {
    const pending = [];
    for (let index = 0; index < 101; index += 1) {
      const queued = rejectNetworkRequest({ url: `/campaigns/${index}` });
      pending.push(index === 0 ? queued.catch((error) => error) : queued);
    }
    axios.request.mockResolvedValue({ data: {} });

    await retryQueuedRequests();
    const results = await Promise.all(pending);

    expect(axios.request).toHaveBeenCalledTimes(100);
    expect(results[0]).toMatchObject({ status: 0, message: 'Network Error' });
  });
});

describe('API Service - API Key requests bypass CSRF', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(document, 'cookie', {
      get: () => 'cp_csrf=test-csrf-token',
      configurable: true,
    });
  });

  it('does not attach CSRF token to API key list request', async () => {
    axios.get.mockResolvedValue({ data: [] });

    await api.listApiKeys();

    const getCall = axios.get.mock.calls[0];
    const config = getCall[1];
    // API key requests use the shared client but don't mutate state
    // They should not have CSRF token since they use Bearer auth
    expect(config.headers['x-csrf-token']).toBeUndefined();
  });

  it('does not attach CSRF token to API key create request (uses Bearer auth)', async () => {
    axios.post.mockResolvedValue({ data: { id: 'key-1', secret: 'cp_live_test' } });

    await api.createApiKey({ label: 'Test', scopes: ['read'] });

    const postCall = axios.post.mock.calls[0];
    const config = postCall[2];
    // API key requests should not use CSRF since they use API key auth
    expect(config.headers['x-csrf-token']).toBeUndefined();
  });
});
