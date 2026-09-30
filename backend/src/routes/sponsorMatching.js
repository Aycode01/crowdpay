const router = require('express').Router();
const db = require('../config/database');
const logger = require('../config/logger');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { body, param, validationResult } = require('express-validator');
const {
  createMatchingPledge,
  getCampaignMatchProgress,
  completeMatchingPledge,
  getSponsorMatchingPledges,
} = require('../services/sponsorMatchingService');
const { emitWebhookEventForCampaign, WEBHOOK_EVENTS } = require('../services/webhookDispatcher');

/**
 * @openapi
 * tags:
 *   - name: Sponsor Matching
 *     description: Sponsor matching pools and pledge management
 */

/**
 * POST /api/campaigns/:id/matches
 * Create a new sponsor matching pledge for a campaign.
 *
 * @openapi
 * /api/campaigns/{id}/matches:
 *   post:
 *     summary: Create sponsor matching pledge
 *     tags:
 *       - Sponsor Matching
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               match_ratio:
 *                 type: number
 *                 example: 1.0
 *               pledge_amount:
 *                 type: string
 *                 example: "1000"
 *     responses:
 *       201:
 *         description: Matching pledge created
 *       400:
 *         description: Invalid input
 *       404:
 *         description: Campaign not found
 */
router.post(
  '/:id/matches',
  requireAuth,
  param('id').isUUID(),
  body('match_ratio').isFloat({ gt: 0 }).toFloat(),
  body('pledge_amount').isString().isInt({ min: 1 }),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const campaignId = req.params.id;
    const { match_ratio: matchRatio, pledge_amount: pledgeAmount } = req.body;

    // Verify campaign exists
    const { rows: campaigns } = await db.query(
      `SELECT id FROM campaigns WHERE id = $1 AND deleted_at IS NULL`,
      [campaignId]
    );
    if (!campaigns.length) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    try {
      const pledge = await createMatchingPledge({
        campaignId,
        sponsorUserId: req.user.userId,
        matchRatio,
        pledgeAmount,
      });

      // Emit webhook
      emitWebhookEventForCampaign(campaignId, WEBHOOK_EVENTS.SPONSOR_MATCH_CREATED, {
        match_id: pledge.id,
        sponsor_user_id: pledge.sponsor_user_id,
        match_ratio: pledge.match_ratio,
        pledge_amount: pledge.pledge_amount,
      }).catch(err => logger.error('Webhook emit failed', { err }));

      res.status(201).json(pledge);
    } catch (err) {
      logger.error('Failed to create matching pledge', { error: err.message, campaignId });
      res.status(400).json({ error: err.message });
    }
  })
);

/**
 * GET /api/campaigns/:id/matches
 * Get sponsor matching progress for a campaign.
 *
 * @openapi
 * /api/campaigns/{id}/matches:
 *   get:
 *     summary: Get campaign matching progress
 *     tags:
 *       - Sponsor Matching
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Matching progress data
 *       404:
 *         description: Campaign not found
 */
router.get(
  '/:id/matches',
  param('id').isUUID(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const campaignId = req.params.id;

    // Verify campaign exists
    const { rows: campaigns } = await db.query(
      `SELECT id FROM campaigns WHERE id = $1 AND deleted_at IS NULL`,
      [campaignId]
    );
    if (!campaigns.length) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    try {
      const progress = await getCampaignMatchProgress(campaignId);
      res.json(progress);
    } catch (err) {
      logger.error('Failed to get matching progress', { error: err.message, campaignId });
      res.status(500).json({ error: 'Failed to retrieve matching progress' });
    }
  })
);

/**
 * GET /api/user/sponsor-matches
 * Get sponsor's matching pledges across all campaigns.
 *
 * @openapi
 * /api/user/sponsor-matches:
 *   get:
 *     summary: Get user's sponsor matching pledges
 *     tags:
 *       - Sponsor Matching
 *     responses:
 *       200:
 *         description: Array of matching pledges
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/user/sponsor-matches',
  requireAuth,
  asyncHandler(async (req, res) => {
    try {
      const pledges = await getSponsorMatchingPledges(req.user.userId);
      res.json({ pledges });
    } catch (err) {
      logger.error('Failed to get sponsor pledges', {
        error: err.message,
        userId: req.user.userId,
      });
      res.status(500).json({ error: 'Failed to retrieve pledges' });
    }
  })
);

/**
 * PATCH /api/campaigns/:id/matches/:matchId/complete
 * Mark a matching pledge as completed (campaign ended).
 *
 * @openapi
 * /api/campaigns/{id}/matches/{matchId}/complete:
 *   patch:
 *     summary: Complete a matching pledge
 *     tags:
 *       - Sponsor Matching
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: matchId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Matching pledge completed
 *       404:
 *         description: Match not found
 */
router.patch(
  '/:id/matches/:matchId/complete',
  requireAuth,
  param('id').isUUID(),
  param('matchId').isUUID(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { id: campaignId, matchId } = req.params;

    // Verify user is the sponsor or campaign owner
    const { rows: matches } = await db.query(
      `SELECT cm.*, c.creator_id 
       FROM campaign_matches cm
       JOIN campaigns c ON cm.campaign_id = c.id
       WHERE cm.id = $1 AND cm.campaign_id = $2`,
      [matchId, campaignId]
    );

    if (!matches.length) {
      return res.status(404).json({ error: 'Match not found' });
    }

    const match = matches[0];
    const isSponsor = match.sponsor_user_id === req.user.userId;
    const isCreator = match.creator_id === req.user.userId;

    if (!isSponsor && !isCreator) {
      return res.status(403).json({ error: 'You do not have permission to complete this pledge' });
    }

    try {
      const completed = await completeMatchingPledge(matchId);

      // Emit webhook
      emitWebhookEventForCampaign(campaignId, WEBHOOK_EVENTS.SPONSOR_MATCH_COMPLETED, {
        match_id: completed.id,
        sponsor_user_id: completed.sponsor_user_id,
        unclaimed_amount:
          parseFloat(completed.pledge_amount) - parseFloat(completed.matched_amount),
      }).catch(err => logger.error('Webhook emit failed', { err }));

      res.json(completed);
    } catch (err) {
      logger.error('Failed to complete matching pledge', { error: err.message, matchId });
      res.status(400).json({ error: err.message });
    }
  })
);

module.exports = router;
