const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();
const request = require('supertest');
const express = require('express');

const CAMPAIGN_UUID = '11111111-1111-4111-8111-111111111111';
const OTHER_UUID = '22222222-2222-4222-8222-222222222222';
const MATCH_UUID = '33333333-3333-4333-8333-333333333333';

function buildApp({ queryImpl, serviceImpl }) {
  const dbStub = { query: queryImpl };

  const serviceStub = {
    createMatchingPledge: async () => {
      throw new Error('unmocked');
    },
    getCampaignMatchProgress: async () => ({}),
    completeMatchingPledge: async () => ({}),
    getSponsorMatchingPledges: async () => [],
    ...serviceImpl,
  };

  const router = proxyquire('./sponsorMatching', {
    '../config/database': dbStub,
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId: 'user-uuid-1' };
        next();
      },
    },
    '../config/logger': {
      info: () => {},
      error: () => {},
      warn: () => {},
    },
    '../services/sponsorMatchingService': serviceStub,
    '../services/webhookDispatcher': {
      emitWebhookEventForCampaign: async () => {},
      WEBHOOK_EVENTS: {
        SPONSOR_MATCH_CREATED: 'sponsor_match.created',
        SPONSOR_MATCH_COMPLETED: 'sponsor_match.completed',
      },
    },
  });

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { userId: 'user-uuid-1' };
    next();
  });
  app.use('/', router);
  return app;
}

test('POST /campaigns/:id/matches creates a matching pledge', async () => {
  const mockPledge = {
    id: MATCH_UUID,
    campaign_id: CAMPAIGN_UUID,
    sponsor_user_id: 'user-uuid-1',
    match_ratio: 1.0,
    pledge_amount: '1000',
    matched_amount: '0',
    status: 'active',
    created_at: '2026-08-01T00:00:00.000Z',
  };

  const app = buildApp({
    queryImpl: async text => {
      if (text.includes('FROM campaigns')) {
        return { rows: [{ id: CAMPAIGN_UUID }] };
      }
      return { rows: [] };
    },
    serviceImpl: {
      createMatchingPledge: async () => mockPledge,
    },
  });

  const res = await request(app)
    .post(`/${CAMPAIGN_UUID}/matches`)
    .send({ match_ratio: 1.0, pledge_amount: '1000' });

  assert.equal(res.status, 201);
  assert.deepEqual(res.body, mockPledge);
});

test('POST /campaigns/:id/matches returns 404 when campaign not found', async () => {
  const app = buildApp({
    queryImpl: async () => ({ rows: [] }),
  });

  const res = await request(app)
    .post(`/${CAMPAIGN_UUID}/matches`)
    .send({ match_ratio: 1.0, pledge_amount: '1000' });

  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'Campaign not found' });
});

test('POST /campaigns/:id/matches validates positive match ratio', async () => {
  const app = buildApp({ queryImpl: async () => ({ rows: [] }) });

  const res = await request(app)
    .post(`/${CAMPAIGN_UUID}/matches`)
    .send({ match_ratio: -1, pledge_amount: '1000' });

  assert.equal(res.status, 400);
  assert.ok(res.body.errors);
});

test('POST /campaigns/:id/matches validates positive pledge amount', async () => {
  const app = buildApp({ queryImpl: async () => ({ rows: [] }) });

  const res = await request(app)
    .post(`/${CAMPAIGN_UUID}/matches`)
    .send({ match_ratio: 1.0, pledge_amount: '0' });

  assert.equal(res.status, 400);
});

test('GET /campaigns/:id/matches returns campaign matching progress', async () => {
  const app = buildApp({
    queryImpl: async text => {
      if (text.includes('FROM campaigns')) {
        return { rows: [{ id: CAMPAIGN_UUID }] };
      }
      return { rows: [] };
    },
    serviceImpl: {
      getCampaignMatchProgress: async () => ({
        campaignId: CAMPAIGN_UUID,
        matches: [],
        totalPledged: 1000,
        totalMatched: 300,
        remainingPoolAmount: 700,
        activePoolCount: 1,
        exhaustedPoolCount: 0,
        percentageUsed: 30,
      }),
    },
  });

  const res = await request(app).get(`/${CAMPAIGN_UUID}/matches`);

  assert.equal(res.status, 200);
  assert.equal(res.body.totalPledged, 1000);
  assert.equal(res.body.totalMatched, 300);
  assert.ok(res.body.matches);
});

test('GET /campaigns/:id/matches returns 404 when campaign not found', async () => {
  const app = buildApp({ queryImpl: async () => ({ rows: [] }) });

  const res = await request(app).get(`/${CAMPAIGN_UUID}/matches`);

  assert.equal(res.status, 404);
});

test('GET /user/sponsor-matches returns sponsor pledges', async () => {
  const app = buildApp({
    queryImpl: async () => ({ rows: [] }),
    serviceImpl: {
      getSponsorMatchingPledges: async () => [
        {
          id: MATCH_UUID,
          campaignId: 'campaign-1',
          campaignTitle: 'Campaign A',
          campaignStatus: 'active',
          sponsorUserId: 'user-uuid-1',
          sponsorName: 'Sponsor',
          matchRatio: 1.0,
          pledgeAmount: 1000,
          matchedAmount: 300,
          remainingAmount: 700,
          status: 'active',
          contractId: null,
          createdAt: new Date(),
        },
      ],
    },
  });

  const res = await request(app).get('/user/sponsor-matches');

  assert.equal(res.status, 200);
  assert.equal(res.body.pledges.length, 1);
  assert.equal(res.body.pledges[0].pledgeAmount, 1000);
});

test('PATCH /campaigns/:id/matches/:matchId/complete completes a matching pledge', async () => {
  const app = buildApp({
    queryImpl: async text => {
      if (text.includes('FROM campaign_matches cm')) {
        return {
          rows: [
            {
              id: MATCH_UUID,
              campaign_id: CAMPAIGN_UUID,
              sponsor_user_id: 'user-uuid-1',
              creator_id: 'creator-uuid',
              pledge_amount: 1000,
              matched_amount: 600,
              status: 'completed',
            },
          ],
        };
      }
      return { rows: [] };
    },
    serviceImpl: {
      completeMatchingPledge: async () => ({
        id: MATCH_UUID,
        campaign_id: CAMPAIGN_UUID,
        sponsor_user_id: 'user-uuid-1',
        pledge_amount: 1000,
        matched_amount: 600,
        status: 'completed',
      }),
    },
  });

  const res = await request(app).patch(`/${CAMPAIGN_UUID}/matches/${MATCH_UUID}/complete`);

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'completed');
});

test('PATCH /campaigns/:id/matches/:matchId/complete returns 403 when user not authorized', async () => {
  const app = buildApp({
    queryImpl: async text => {
      if (text.includes('FROM campaign_matches cm')) {
        return {
          rows: [
            {
              id: MATCH_UUID,
              campaign_id: CAMPAIGN_UUID,
              sponsor_user_id: 'different-sponsor-uuid',
              creator_id: 'different-creator-uuid',
            },
          ],
        };
      }
      return { rows: [] };
    },
  });

  const res = await request(app).patch(`/${CAMPAIGN_UUID}/matches/${MATCH_UUID}/complete`);

  assert.equal(res.status, 403);
  assert.ok(res.body.error);
});

test('PATCH /campaigns/:id/matches/:matchId/complete returns 404 when match not found', async () => {
  const app = buildApp({ queryImpl: async () => ({ rows: [] }) });

  const res = await request(app).patch(`/${CAMPAIGN_UUID}/matches/${MATCH_UUID}/complete`);

  assert.equal(res.status, 404);
});
