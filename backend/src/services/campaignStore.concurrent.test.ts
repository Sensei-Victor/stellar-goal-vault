import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, resetDbForTests, getDb } from './db';
import {
  initCampaignStore,
  createCampaign,
  addPledge,
  getCampaign,
  claimCampaign,
} from './campaignStore';

const CREATOR = 'GDOGOQQQWCIPOHLIYHQIVI5HKYHYI6IDBGRW245JZC623TVFFKFQZCKQ';
const CONTRIBUTOR_1 = 'GBBXILIJHRPV2GWBGPQLWSGR57FO6OODNMBZB5EUKBFX3MRINA7NMKUI';
const CONTRIBUTOR_2 = 'GBJI32M2VAAYQU3S6LOXCWNIOCXG7I2I3J3JO3XPT5PEYXL72W3QNOMU';
const CONTRIBUTOR_3 = 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI';

describe('Concurrent Pledge Race Condition Tests', () => {
  beforeEach(() => {
    initDb();
    initCampaignStore();
  });

  afterEach(() => {
    resetDbForTests();
  });

  it('should handle concurrent pledges without race conditions', async () => {
    // Create a campaign with a target of 1000
    const { id: campaignId } = createCampaign({
      creator: CREATOR,
      title: 'Concurrent Test Campaign',
      description: 'Testing concurrent pledge handling with race conditions',
      acceptedTokens: ['USDC'],
      targetAmount: 1000,
      deadline: Math.floor(Date.now() / 1000) + 86400, // 24 hours from now
    });

    // Simulate concurrent pledges from multiple contributors
    // Each pledge is 250, so 4 concurrent pledges should reach the target
    const pledgeAmount = 250;
    const concurrentPledges = 4;

    // Create promises for concurrent pledge operations
    const pledgePromises = [
      Promise.resolve().then(() =>
        addPledge(campaignId, {
          contributor: CONTRIBUTOR_1,
          amount: pledgeAmount,
          assetCode: 'USDC',
        }),
      ),
      Promise.resolve().then(() =>
        addPledge(campaignId, {
          contributor: CONTRIBUTOR_2,
          amount: pledgeAmount,
          assetCode: 'USDC',
        }),
      ),
      Promise.resolve().then(() =>
        addPledge(campaignId, {
          contributor: CONTRIBUTOR_3,
          amount: pledgeAmount,
          assetCode: 'USDC',
        }),
      ),
      Promise.resolve().then(() =>
        addPledge(campaignId, {
          contributor: CREATOR,
          amount: pledgeAmount,
          assetCode: 'USDC',
        }),
      ),
    ];

    // Execute all pledges concurrently
    const results = await Promise.all(pledgePromises);

    // Verify all pledges were recorded
    expect(results).toHaveLength(concurrentPledges);
    results.forEach((result) => {
      expect(result).toBeDefined();
      expect(result.id).toBeDefined();
    });

    // Verify campaign state is consistent
    const campaign = getCampaign(campaignId);
    expect(campaign).toBeDefined();
    expect(campaign?.pledgedAmount).toBe(pledgeAmount * concurrentPledges);
    expect(campaign?.pledgedAmount).toBe(campaign?.targetAmount);
  });

  it('should prevent over-pledging when concurrent pledges exceed target', async () => {
    // Create a campaign with a target of 500
    const { id: campaignId } = createCampaign({
      creator: CREATOR,
      title: 'Over-pledge Test Campaign',
      description: 'Testing over-pledge prevention with concurrent requests',
      acceptedTokens: ['USDC'],
      targetAmount: 500,
      deadline: Math.floor(Date.now() / 1000) + 86400,
    });

    // Try to pledge 300 from 3 different contributors concurrently
    // Total would be 900, exceeding the 500 target
    const pledgePromises = [
      Promise.resolve().then(() =>
        addPledge(campaignId, {
          contributor: CONTRIBUTOR_1,
          amount: 300,
          assetCode: 'USDC',
        }),
      ),
      Promise.resolve().then(() =>
        addPledge(campaignId, {
          contributor: CONTRIBUTOR_2,
          amount: 300,
          assetCode: 'USDC',
        }),
      ),
      Promise.resolve().then(() =>
        addPledge(campaignId, {
          contributor: CONTRIBUTOR_3,
          amount: 300,
          assetCode: 'USDC',
        }),
      ),
    ];

    const results = await Promise.allSettled(pledgePromises);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Only one pledge of 300 should succeed, next one will exceed 500 cap
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    expect((rejected[0] as PromiseRejectedResult).reason.code).toBe('CAMPAIGN_FUNDING_CAP_EXCEEDED');

    const campaign = getCampaign(campaignId);
    expect(campaign).toBeDefined();
    expect(campaign?.pledgedAmount).toBe(300);
  });

  it('should enforce per-contributor limits with concurrent pledges', async () => {
    // Create a campaign with max 200 per contributor
    const { id: campaignId } = createCampaign({
      creator: CREATOR,
      title: 'Per-Contributor Limit Test',
      description: 'Testing per-contributor limits with concurrent pledges',
      acceptedTokens: ['USDC'],
      targetAmount: 1000,
      deadline: Math.floor(Date.now() / 1000) + 86400,
      maxPerContributor: 200,
    });

    // Try to pledge 150 twice concurrently from the same contributor
    const pledgePromises = [
      Promise.resolve().then(() =>
        addPledge(campaignId, {
          contributor: CONTRIBUTOR_1,
          amount: 150,
          assetCode: 'USDC',
        }),
      ),
      Promise.resolve().then(() =>
        addPledge(campaignId, {
          contributor: CONTRIBUTOR_1,
          amount: 150,
          assetCode: 'USDC',
        }),
      ),
    ];

    const results = await Promise.allSettled(pledgePromises);

    // The per-contributor limit is enforced within a transaction, so the
    // second pledge should be rejected when the limit is exceeded
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.code).toBe('MAX_PER_CONTRIBUTOR_EXCEEDED');

    const campaign = getCampaign(campaignId);
    expect(campaign).toBeDefined();
    expect(campaign?.pledgedAmount).toBe(150);
  });

  it('should maintain data consistency under high concurrent load', async () => {
    // Create a campaign
    const { id: campaignId } = createCampaign({
      creator: CREATOR,
      title: 'High Load Test Campaign',
      description: 'Testing data consistency under high concurrent load',
      acceptedTokens: ['USDC'],
      targetAmount: 10000,
      deadline: Math.floor(Date.now() / 1000) + 86400,
    });

    // Simulate 20 concurrent pledges of 50 each
    const pledgePromises = Array.from({ length: 20 }, (_, i) => {
      const contributorIndex = i % 5; // Reuse 5 contributors
      const contributors = [
        CONTRIBUTOR_1,
        CONTRIBUTOR_2,
        CONTRIBUTOR_3,
        CREATOR,
        CONTRIBUTOR_3,
      ];

      return addPledge(campaignId, {
        contributor: contributors[contributorIndex],
        amount: 50,
        assetCode: 'USDC',
      });
    });

    const results = await Promise.all(pledgePromises);

    // All pledges should succeed
    expect(results).toHaveLength(20);
    results.forEach((result) => {
      expect(result).toBeDefined();
      expect(result.id).toBeDefined();
    });

    // Verify final state
    const campaign = getCampaign(campaignId);
    expect(campaign).toBeDefined();
    expect(campaign?.pledgedAmount).toBe(1000); // 20 * 50
  });

  it('should handle concurrent claim and pledge operations safely', async () => {
    // Create a campaign with target 500 and a deadline in the future
    const { id: campaignId } = createCampaign({
      creator: CREATOR,
      title: 'Concurrent Claim Test',
      description: 'Testing concurrent claim and pledge operations',
      acceptedTokens: ['USDC'],
      targetAmount: 500,
      deadline: Math.floor(Date.now() / 1000) + 86400,
    });

    // Add initial pledges to reach target
    addPledge(campaignId, {
      contributor: CONTRIBUTOR_1,
      amount: 250,
      assetCode: 'USDC',
    });
    addPledge(campaignId, {
      contributor: CONTRIBUTOR_2,
      amount: 250,
      assetCode: 'USDC',
    });

    // Move deadline to the past so the campaign can be claimed
    const pastDeadline = Math.floor(Date.now() / 1000) - 3600;
    getDb().prepare(`UPDATE campaigns SET deadline = ? WHERE id = ?`).run(pastDeadline, campaignId);

    // Try to claim and pledge concurrently
    const operations = [
      Promise.resolve().then(() =>
        claimCampaign(campaignId, { creator: CREATOR, transactionHash: 'test-tx-hash' }),
      ),
      Promise.resolve().then(() =>
        addPledge(campaignId, {
          contributor: CONTRIBUTOR_3,
          amount: 100,
          assetCode: 'USDC',
        }),
      ),
    ];

    const results = await Promise.allSettled(operations);

    // Claim should succeed; pledge should fail because the deadline has passed
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.code).toBe('INVALID_CAMPAIGN_STATE');

    // Verify final state
    const campaign = getCampaign(campaignId);
    expect(campaign).toBeDefined();
    expect(campaign?.claimedAt).toBeDefined();
    expect(campaign?.pledgedAmount).toBe(500);
  });

  it('should detect and handle duplicate concurrent pledges from same contributor', async () => {
    const { id: campaignId } = createCampaign({
      creator: CREATOR,
      title: 'Duplicate Pledge Test',
      description: 'Testing duplicate pledge detection',
      acceptedTokens: ['USDC'],
      targetAmount: 1000,
      deadline: Math.floor(Date.now() / 1000) + 86400,
    });

    // Attempt to pledge the same amount from same contributor concurrently
    // This simulates a user clicking submit multiple times
    const pledgePromises = Array.from({ length: 3 }, () =>
      addPledge(campaignId, {
        contributor: CONTRIBUTOR_1,
        amount: 100,
        assetCode: 'USDC',
      }),
    );

    const results = await Promise.all(pledgePromises);

    // All pledges should be recorded (no deduplication at this level)
    expect(results).toHaveLength(3);

    const campaign = getCampaign(campaignId);
    expect(campaign).toBeDefined();
    // All pledges should be recorded
    expect(campaign?.pledgedAmount).toBe(300);
  });
});
