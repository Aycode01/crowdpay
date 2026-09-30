const db = require('../config/database');
const { stripHtml } = require('../lib/sanitize');

const MAX_TIERS_PER_CAMPAIGN = 10;

/**
 * Validate and normalize a reward_tiers array supplied by a campaign creator.
 *
 * Tiers are optional (0-10 per campaign). Each tier's asset_type must match the
 * campaign asset. Throws an Error with a user-friendly message on bad input.
 *
 * @param {Array|undefined} tiers   raw reward_tiers from the request body
 * @param {string} campaignAssetType  'XLM' | 'USDC'
 * @returns {Array} normalized tier objects ready for insertTiers()
 */
function validateTiersInput(tiers, campaignAssetType) {
  if (tiers === undefined || tiers === null) return [];
  if (!Array.isArray(tiers)) {
    throw new Error('reward_tiers must be an array');
  }
  if (tiers.length > MAX_TIERS_PER_CAMPAIGN) {
    throw new Error(`A campaign can have at most ${MAX_TIERS_PER_CAMPAIGN} reward tiers`);
  }

  return tiers.map((tier, index) => {
    const label = `reward_tiers[${index}]`;

    const title = stripHtml(tier.title || '');
    if (!title) throw new Error(`${label}: title is required`);

    const minAmount = Number(tier.min_amount);
    if (!Number.isFinite(minAmount) || minAmount <= 0) {
      throw new Error(`${label}: min_amount must be a positive number`);
    }

    // asset_type is optional in the request; if given it must match the campaign.
    const assetType = tier.asset_type ? String(tier.asset_type) : campaignAssetType;
    if (assetType !== campaignAssetType) {
      throw new Error(`${label}: asset_type must match the campaign asset (${campaignAssetType})`);
    }

    let tierLimit = null;
    if (tier.limit !== undefined && tier.limit !== null && tier.limit !== '') {
      tierLimit = Number(tier.limit);
      if (!Number.isInteger(tierLimit) || tierLimit <= 0) {
        throw new Error(`${label}: limit must be a positive whole number`);
      }
    }

    let estimatedDelivery = null;
    if (tier.estimated_delivery) {
      const date = new Date(tier.estimated_delivery);
      if (Number.isNaN(date.getTime())) {
        throw new Error(`${label}: estimated_delivery must be a valid date`);
      }
      estimatedDelivery = tier.estimated_delivery;
    }

    const nftEnabled =
      tier.nft_enabled === true || tier.nft_enabled === 'true' || tier.nft_enabled === 1;
    const nftMetadataUrl =
      typeof tier.nft_metadata_url === 'string' && tier.nft_metadata_url.trim()
        ? stripHtml(tier.nft_metadata_url.trim()) || null
        : null;
    const nftArtworkUrl =
      typeof tier.nft_artwork_url === 'string' && tier.nft_artwork_url.trim()
        ? stripHtml(tier.nft_artwork_url.trim()) || null
        : null;

    return {
      title,
      description:
        typeof tier.description === 'string' ? stripHtml(tier.description) || null : null,
      min_amount: minAmount,
      asset_type: assetType,
      tier_limit: tierLimit,
      estimated_delivery: estimatedDelivery,
      nft_enabled: nftEnabled,
      nft_metadata_url: nftMetadataUrl,
      nft_artwork_url: nftArtworkUrl,
    };
  });
}

/**
 * Insert reward tiers for a campaign. Runs on a provided client so it can join
 * an existing transaction (e.g. campaign creation).
 */
async function insertTiers(client, campaignId, normalizedTiers) {
  const createdTiers = [];
  for (const tier of normalizedTiers) {
    const { rows } = await client.query(
      `INSERT INTO reward_tiers
         (campaign_id, title, description, min_amount, asset_type, tier_limit, estimated_delivery)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, title`,
      [
        campaignId,
        tier.title,
        tier.description,
        tier.min_amount,
        tier.asset_type,
        tier.tier_limit,
        tier.estimated_delivery,
      ]
    );
    const insertedTier = rows[0];
    if (tier.nft_enabled) {
      await client.query(
        `INSERT INTO nft_rewards
           (reward_tier_id, campaign_id, status, metadata_url, artwork_url)
         VALUES ($1, $2, 'configured', $3, $4)`,
        [insertedTier.id, campaignId, tier.nft_metadata_url, tier.nft_artwork_url]
      );
    }
    createdTiers.push({
      id: insertedTier.id,
      title: insertedTier.title,
      nft_enabled: tier.nft_enabled,
    });
  }
  return createdTiers;
}

/**
 * List a campaign's tiers with remaining availability.
 * remaining = null for unlimited tiers, otherwise tier_limit - claimed_count.
 */
async function listTiersWithAvailability(campaignId) {
  const { rows } = await db.query(
    `SELECT rt.id, rt.campaign_id, rt.title, rt.description, rt.min_amount, rt.asset_type,
            rt.tier_limit, rt.claimed_count, rt.estimated_delivery, rt.created_at,
            CASE WHEN rt.tier_limit IS NULL THEN NULL
                 ELSE GREATEST(rt.tier_limit - rt.claimed_count, 0) END AS remaining,
            (rt.tier_limit IS NOT NULL AND rt.claimed_count >= rt.tier_limit) AS sold_out,
            EXISTS (
              SELECT 1
              FROM nft_rewards nr
              WHERE nr.reward_tier_id = rt.id
                AND nr.contribution_id IS NULL
            ) AS nft_enabled,
            (
              SELECT nr.metadata_url
              FROM nft_rewards nr
              WHERE nr.reward_tier_id = rt.id
                AND nr.contribution_id IS NULL
              ORDER BY nr.created_at ASC
              LIMIT 1
            ) AS nft_metadata_url,
            (
              SELECT nr.artwork_url
              FROM nft_rewards nr
              WHERE nr.reward_tier_id = rt.id
                AND nr.contribution_id IS NULL
              ORDER BY nr.created_at ASC
              LIMIT 1
            ) AS nft_artwork_url
       FROM reward_tiers rt
      WHERE rt.campaign_id = $1
      ORDER BY rt.min_amount ASC`,
    [campaignId]
  );
  return rows;
}

/**
 * Reserve a slot in a specific reward tier by incrementing its claimed_count.
 *
 * Called from the contribution route INSIDE its transaction so the tier slot
 * is atomically reserved alongside the Stellar transaction submission. If the
 * tier is already sold out (claimed_count >= tier_limit with a finite limit)
 * the UPDATE returns zero rows and the caller should reject the contribution
 * with HTTP 409.
 *
 * @param {object} client   Database client inside an open transaction
 * @param {{tierId: string, campaignId: string}} params
 * @returns {{id: string, title: string}|null} the reserved tier, or null if sold out
 */
async function reserveTierSlot(client, { tierId, campaignId }) {
  const { rows } = await client.query(
    `UPDATE reward_tiers
        SET claimed_count = claimed_count + 1
      WHERE id = $1
        AND campaign_id = $2
        AND (tier_limit IS NULL OR claimed_count < tier_limit)
      RETURNING id, title`,
    [tierId, campaignId]
  );
  return rows[0] || null;
}

/**
 * Match a contribution to the highest reward tier it qualifies for that still
 * has capacity, record it, and increment that tier's claimed_count.
 *
 * When an explicit tierId is provided (pre-reserved via reserveTierSlot) the
 * function only creates the contribution_rewards join row without bumping
 * claimed_count (the slot was already reserved in the route transaction).
 *
 * Runs on a provided client inside the contribution-indexing transaction so the
 * assignment is atomic with the contribution insert. The whole operation is a
 * single statement:
 *   - FOR UPDATE locks the chosen tier row against concurrent indexing.
 *   - ON CONFLICT (contribution_id) makes re-indexing the same contribution a
 *     no-op (idempotent), and claimed_count is only bumped on a real insert.
 *   - Full tiers are filtered out, so a contributor that can't get the top tier
 *     automatically falls back to the next qualifying one.
 *
 * @param {object}   client  Database client inside an open transaction
 * @param {{campaignId: string, amount: number, contributionId: string, tierId?: string}} params
 * @returns {{id: string, title: string}|null} the assigned tier, or null if none matched
 */
async function assignTierToContribution(client, { campaignId, amount, contributionId, tierId }) {
  if (tierId) {
    // Explicit tier — slot was already reserved by the contribution route.
    // Only create the contribution_rewards join row; do NOT bump claimed_count
    // again because reserveTierSlot already did that atomically.
    const { rows } = await client.query(
      `WITH ins AS (
         INSERT INTO contribution_rewards (contribution_id, reward_tier_id)
         VALUES ($1, $2)
         ON CONFLICT (contribution_id) DO NOTHING
         RETURNING reward_tier_id
       )
       SELECT r.id, r.title,
              EXISTS (
                SELECT 1
                FROM nft_rewards nr
                WHERE nr.reward_tier_id = r.id
                  AND nr.contribution_id IS NULL
              ) AS nft_enabled,
              (
                SELECT nr.metadata_url
                FROM nft_rewards nr
                WHERE nr.reward_tier_id = r.id
                  AND nr.contribution_id IS NULL
                ORDER BY nr.created_at ASC
                LIMIT 1
              ) AS nft_metadata_url,
              (
                SELECT nr.artwork_url
                FROM nft_rewards nr
                WHERE nr.reward_tier_id = r.id
                  AND nr.contribution_id IS NULL
                ORDER BY nr.created_at ASC
                LIMIT 1
              ) AS nft_artwork_url
         FROM reward_tiers r
         JOIN ins ON ins.reward_tier_id = r.id`,
      [contributionId, tierId]
    );
    return rows[0] || null;
  }

  // Auto-match to the highest qualifying tier (legacy behaviour)
  const { rows } = await client.query(
    `WITH chosen AS (
       SELECT id
         FROM reward_tiers
        WHERE campaign_id = $1
          AND min_amount <= $2
          AND (tier_limit IS NULL OR claimed_count < tier_limit)
        ORDER BY min_amount DESC
        LIMIT 1
        FOR UPDATE
     ),
     ins AS (
       INSERT INTO contribution_rewards (contribution_id, reward_tier_id)
       SELECT $3, id FROM chosen
       ON CONFLICT (contribution_id) DO NOTHING
       RETURNING reward_tier_id
     )
     UPDATE reward_tiers t
        SET claimed_count = claimed_count + 1
       FROM ins
      WHERE t.id = ins.reward_tier_id
      RETURNING t.id, t.title,
                EXISTS (
                  SELECT 1
                  FROM nft_rewards nr
                  WHERE nr.reward_tier_id = t.id
                    AND nr.contribution_id IS NULL
                ) AS nft_enabled,
                (
                  SELECT nr.metadata_url
                  FROM nft_rewards nr
                  WHERE nr.reward_tier_id = t.id
                    AND nr.contribution_id IS NULL
                  ORDER BY nr.created_at ASC
                  LIMIT 1
                ) AS nft_metadata_url,
                (
                  SELECT nr.artwork_url
                  FROM nft_rewards nr
                  WHERE nr.reward_tier_id = t.id
                    AND nr.contribution_id IS NULL
                  ORDER BY nr.created_at ASC
                  LIMIT 1
                ) AS nft_artwork_url`,
    [campaignId, amount, contributionId]
  );
  return rows[0] || null;
}

module.exports = {
  MAX_TIERS_PER_CAMPAIGN,
  validateTiersInput,
  insertTiers,
  listTiersWithAvailability,
  assignTierToContribution,
  reserveTierSlot,
};
