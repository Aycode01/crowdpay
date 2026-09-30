const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function buildService(queryImpl) {
  return proxyquire('./sponsorMatchingService', {
    '../config/database': {
      query: queryImpl,
    },
    '../config/logger': {
      info: () => {},
      error: () => {},
      warn: () => {},
    },
  });
}

test('createMatchingPledge validates matchRatio positive', async () => {
  const { createMatchingPledge } = buildService(async () => ({ rows: [] }));
  await assert.rejects(
    createMatchingPledge({
      campaignId: 'campaign-uuid-1',
      sponsorUserId: 'sponsor-uuid-1',
      matchRatio: -1,
      pledgeAmount: '1000',
    }),
    /matchRatio must be positive/
  );
});

test('createMatchingPledge validates pledgeAmount positive', async () => {
  const { createMatchingPledge } = buildService(async () => ({ rows: [] }));
  await assert.rejects(
    createMatchingPledge({
      campaignId: 'campaign-uuid-1',
      sponsorUserId: 'sponsor-uuid-1',
      matchRatio: 1.0,
      pledgeAmount: '0',
    }),
    /pledgeAmount must be positive/
  );
});

test('createMatchingPledge creates a pledge', async () => {
  const calls = [];
  const mockResult = {
    id: 'match-uuid-1',
    campaign_id: 'campaign-uuid-1',
    sponsor_user_id: 'sponsor-uuid-1',
    match_ratio: 1.0,
    pledge_amount: '1000',
    matched_amount: '0',
    status: 'active',
    created_at: new Date(),
  };

  const { createMatchingPledge } = buildService(async text => {
    calls.push(text);
    if (text.includes('SELECT id FROM campaign_matches')) {
      return { rows: [] };
    }
    return { rows: [mockResult] };
  });

  const result = await createMatchingPledge({
    campaignId: 'campaign-uuid-1',
    sponsorUserId: 'sponsor-uuid-1',
    matchRatio: 1.0,
    pledgeAmount: '1000',
  });

  assert.deepEqual(result, mockResult);
  assert.equal(calls.length, 2);
});

test('processContributionMatch calculates correct match amount', async () => {
  const { processContributionMatch } = buildService(async text => {
    if (text.includes('FROM campaign_matches')) {
      return {
        rows: [{ id: 'match-uuid-1', match_ratio: 1.0, pledge_amount: 1000, matched_amount: 0 }],
      };
    }
    return { rows: [] };
  });

  const matchedAmount = await processContributionMatch({
    campaignId: 'campaign-uuid-1',
    contributionId: 'contrib-uuid-1',
    contributionAmount: '100',
  });

  assert.equal(matchedAmount, 100);
});

test('processContributionMatch applies 2:1 ratio', async () => {
  const { processContributionMatch } = buildService(async text => {
    if (text.includes('FROM campaign_matches')) {
      return {
        rows: [{ id: 'match-uuid-1', match_ratio: 2.0, pledge_amount: 2000, matched_amount: 0 }],
      };
    }
    return { rows: [] };
  });

  const matchedAmount = await processContributionMatch({
    campaignId: 'campaign-uuid-1',
    contributionId: 'contrib-uuid-1',
    contributionAmount: '100',
  });

  assert.equal(matchedAmount, 200);
});

test('processContributionMatch caps at pledge amount and marks exhausted', async () => {
  const updateCalls = [];
  const { processContributionMatch } = buildService(async (text, params) => {
    if (text.includes('FROM campaign_matches')) {
      return {
        rows: [{ id: 'match-uuid-1', match_ratio: 1.0, pledge_amount: 500, matched_amount: 0 }],
      };
    }
    if (text.includes('UPDATE campaign_matches')) {
      updateCalls.push(params);
    }
    return { rows: [] };
  });

  const matchedAmount = await processContributionMatch({
    campaignId: 'campaign-uuid-1',
    contributionId: 'contrib-uuid-1',
    contributionAmount: '600',
  });

  assert.equal(matchedAmount, 500);
  assert.ok(updateCalls.some(p => p.includes('exhausted')));
});

test('processContributionMatch returns zero when pool exhausted', async () => {
  const { processContributionMatch } = buildService(async text => {
    if (text.includes('FROM campaign_matches')) {
      return {
        rows: [{ id: 'match-uuid-1', match_ratio: 1.0, pledge_amount: 100, matched_amount: 100 }],
      };
    }
    return { rows: [] };
  });

  const matchedAmount = await processContributionMatch({
    campaignId: 'campaign-uuid-1',
    contributionId: 'contrib-uuid-1',
    contributionAmount: '50',
  });

  assert.equal(matchedAmount, 0);
});

test('processContributionMatch returns zero when no pool', async () => {
  const { processContributionMatch } = buildService(async () => ({ rows: [] }));

  const matchedAmount = await processContributionMatch({
    campaignId: 'campaign-uuid-1',
    contributionId: 'contrib-uuid-1',
    contributionAmount: '100',
  });

  assert.equal(matchedAmount, 0);
});

test('getCampaignMatchProgress aggregates multiple sponsors', async () => {
  const { getCampaignMatchProgress } = buildService(async () => ({
    rows: [
      {
        id: 'match-uuid-1',
        sponsor_user_id: 'sponsor-1',
        sponsor_name: 'Sponsor One',
        match_ratio: 1.0,
        pledge_amount: 1000,
        matched_amount: 300,
        status: 'active',
        created_at: new Date(),
        contribution_count: 3,
        total_contributed: 300,
      },
      {
        id: 'match-uuid-2',
        sponsor_user_id: 'sponsor-2',
        sponsor_name: 'Sponsor Two',
        match_ratio: 1.0,
        pledge_amount: 500,
        matched_amount: 100,
        status: 'active',
        created_at: new Date(),
        contribution_count: 1,
        total_contributed: 100,
      },
    ],
  }));

  const progress = await getCampaignMatchProgress('campaign-uuid-1');

  assert.equal(progress.totalPledged, 1500);
  assert.equal(progress.totalMatched, 400);
  assert.equal(progress.remainingPoolAmount, 1100);
  assert.equal(progress.activePoolCount, 2);
  assert.equal(progress.percentageUsed, 26.67);
});

test('getCampaignMatchProgress calculates zero percentage when no pledges', async () => {
  const { getCampaignMatchProgress } = buildService(async () => ({ rows: [] }));

  const progress = await getCampaignMatchProgress('campaign-uuid-1');

  assert.equal(progress.totalPledged, 0);
  assert.equal(progress.percentageUsed, 0);
});

test('completeMatchingPledge marks completed', async () => {
  const mockMatch = {
    id: 'match-uuid-1',
    campaign_id: 'campaign-uuid-1',
    sponsor_user_id: 'sponsor-uuid-1',
    pledge_amount: 1000,
    matched_amount: 600,
    status: 'completed',
  };

  const { completeMatchingPledge } = buildService(async () => ({ rows: [mockMatch] }));

  const result = await completeMatchingPledge('match-uuid-1');

  assert.deepEqual(result, mockMatch);
  assert.equal(result.status, 'completed');
});

test('completeMatchingPledge throws when not found', async () => {
  const { completeMatchingPledge } = buildService(async () => ({ rows: [] }));

  await assert.rejects(
    completeMatchingPledge('invalid-uuid'),
    /Match not found or already completed/
  );
});

test('getSponsorMatchingPledges returns sponsor pledges', async () => {
  const { getSponsorMatchingPledges } = buildService(async () => ({
    rows: [
      {
        id: 'match-uuid-1',
        campaign_id: 'campaign-1',
        campaign_title: 'Campaign A',
        campaign_status: 'active',
        sponsor_user_id: 'sponsor-uuid-1',
        sponsor_name: 'Sponsor',
        match_ratio: 1.0,
        pledge_amount: 1000,
        matched_amount: 300,
        status: 'active',
        contract_id: null,
        created_at: new Date(),
      },
    ],
  }));

  const pledges = await getSponsorMatchingPledges('sponsor-uuid-1');

  assert.equal(pledges.length, 1);
  assert.equal(pledges[0].pledgeAmount, 1000);
  assert.equal(pledges[0].remainingAmount, 700);
});
