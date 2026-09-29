import React, { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../services/api';

// Team fundraising pages under a parent campaign (#952). Renders the
// aggregated team surface on the parent's page: ordered member cards with
// per-member progress, the parent rollup, and — for the campaign owner — a
// picker to attach/detach their own campaigns as team members.

function formatAmount(value, assetType) {
  const number = Number(value || 0);
  return `${number.toLocaleString()} ${assetType || ''}`.trim();
}

function TeamMemberCard({ member, onRemove, canManage }) {
  return (
    <div
      style={{
        border: '1px solid var(--color-border-light)',
        borderRadius: '8px',
        padding: '0.9rem',
      }}
      data-testid="team-member-card"
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: '0.5rem',
          alignItems: 'baseline',
        }}
      >
        <strong>{member.title}</strong>
        {member.role === 'owner' && (
          <span
            style={{ fontSize: '0.7rem', color: 'var(--color-text-hint)' }}
            data-testid="team-member-role"
          >
            lead
          </span>
        )}
      </div>
      <div style={{ fontSize: '0.8rem', color: 'var(--color-text-hint)', margin: '0.25rem 0 0.5rem' }}>
        {formatAmount(member.raised_amount, member.asset_type)} raised of{' '}
        {formatAmount(member.target_amount, member.asset_type)} goal
      </div>
      <div
        role="progressbar"
        aria-valuenow={Math.round(member.progress_percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${member.title} funding progress`}
        style={{
          height: '6px',
          background: 'var(--color-border-lighter)',
          borderRadius: '4px',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${Math.min(100, member.progress_percent || 0)}%`,
            background: 'var(--color-accent)',
          }}
        />
      </div>
      {canManage && (
        <button
          type="button"
          onClick={() => onRemove(member)}
          style={{
            marginTop: '0.6rem',
            fontSize: '0.75rem',
            color: 'var(--color-danger, #b00)',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
          }}
          data-testid="team-member-remove"
        >
          Remove from team
        </button>
      )}
    </div>
  );
}

/**
 * Aggregated team section for a parent campaign page (#952).
 *
 * Fetches `GET /api/campaigns/:id/team` for the member cards + rollup. When
 * `canManage` is set (the viewer owns the parent), it also offers a picker
 * backed by `GET /api/campaigns/mine` to attach other campaigns of theirs as
 * team members, and per-member remove buttons wired to the DELETE endpoint.
 */
export default function TeamCampaignsSection({ campaignId, canManage }) {
  const [team, setTeam] = useState(null);
  const [teamError, setTeamError] = useState('');
  const [myCampaigns, setMyCampaigns] = useState(null);
  const [addBusyId, setAddBusyId] = useState(null);
  const [actionError, setActionError] = useState('');

  const loadTeam = useCallback(async () => {
    setTeamError('');
    try {
      const { data } = await apiClient.get(`/campaigns/${campaignId}/team`);
      setTeam(data);
    } catch (error) {
      setTeamError(
        error?.response?.data?.error || 'Could not load the team page.'
      );
    }
  }, [campaignId]);

  useEffect(() => {
    if (!campaignId) return;
    loadTeam();
  }, [campaignId, loadTeam]);

  useEffect(() => {
    if (!canManage || !campaignId) return;
    let cancelled = false;
    apiClient
      .get('/campaigns/mine', { params: { limit: 50 } })
      .then(({ data }) => {
        if (cancelled) return;
        const items = Array.isArray(data?.campaigns)
          ? data.campaigns
          : Array.isArray(data)
            ? data
            : [];
        setMyCampaigns(items);
      })
      .catch(() => setMyCampaigns([]));
    return () => {
      cancelled = true;
    };
  }, [canManage, campaignId]);

  const handleAdd = async (memberCampaignId) => {
    setActionError('');
    setAddBusyId(memberCampaignId);
    try {
      await apiClient.post(`/campaigns/${campaignId}/team/members`, {
        member_campaign_id: memberCampaignId,
      });
      await loadTeam();
    } catch (error) {
      setActionError(
        error?.response?.data?.error || 'Could not add the team member.'
      );
    } finally {
      setAddBusyId(null);
    }
  };

  const handleRemove = async (member) => {
    setActionError('');
    try {
      await apiClient.delete(
        `/campaigns/${campaignId}/team/members/${member.id}`
      );
      await loadTeam();
    } catch (error) {
      setActionError(
        error?.response?.data?.error || 'Could not remove the team member.'
      );
    }
  };

  if (teamError && !team) {
    return (
      <div
        role="alert"
        style={{
          border: '1px solid var(--color-border-light)',
          borderRadius: '8px',
          padding: '1rem',
          fontSize: '0.85rem',
        }}
        data-testid="team-section-error"
      >
        {teamError}
      </div>
    );
  }

  if (!team) {
    return (
      <div style={{ fontSize: '0.85rem', color: 'var(--color-text-hint)' }} data-testid="team-section-loading">
        Loading team…
      </div>
      );
  }

  if (!team.members?.length) {
    return (
      <div style={{ fontSize: '0.85rem', color: 'var(--color-text-hint)' }} data-testid="team-section-empty">
        This campaign has no team members yet.{' '}
        {canManage
          ? 'Add one of your other campaigns below to group them under this page.'
          : ''}
      </div>
    );
  }

  return (
    <div data-testid="team-campaigns-section">
      {/* Parent rollup */}
      <div
        style={{
          border: '1px solid var(--color-border-light)',
          borderRadius: '8px',
          padding: '0.9rem',
          marginBottom: '1rem',
        }}
        data-testid="team-totals"
      >
        <strong style={{ display: 'block', marginBottom: '0.4rem' }}>
          Team total
        </strong>
        <div style={{ fontSize: '0.85rem', color: 'var(--color-text-hint)' }}>
          {formatAmount(team.totals.raised_amount, team.members[0]?.asset_type)} raised
          across {team.totals.member_count} member
          {team.totals.member_count === 1 ? '' : 's'} —{' '}
          {team.totals.progress_percent.toFixed(1)}% of{' '}
          {formatAmount(team.totals.target_amount, team.members[0]?.asset_type)}
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
          gap: '0.9rem',
        }}
      >
        {team.members.map((member) => (
          <TeamMemberCard
            key={member.id}
            member={member}
            canManage={canManage}
            onRemove={handleRemove}
          />
        ))}
      </div>

      {canManage && (
        <div
          style={{
            marginTop: '1.25rem',
            borderTop: '1px dashed var(--color-border-light)',
            paddingTop: '1rem',
          }}
          data-testid="team-add-picker"
        >
          <strong style={{ display: 'block', marginBottom: '0.5rem' }}>
            Add a campaign to this team
          </strong>
          {actionError && (
            <div role="alert" style={{ color: 'var(--color-danger, #b00)', fontSize: '0.8rem' }} data-testid="team-action-error">
              {actionError}
            </div>
          )}
          {!myCampaigns ? (
            <div style={{ fontSize: '0.8rem', color: 'var(--color-text-hint)' }}>
              Loading your campaigns…
            </div>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {myCampaigns
                .filter(
                  (candidate) =>
                    candidate.id !== campaignId &&
                    !team.members.some((member) => member.id === candidate.id)
                )
                .slice(0, 8)
                .map((candidate) => (
                  <li
                    key={candidate.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: '0.75rem',
                      padding: '0.4rem 0',
                    }}
                  >
                    <span style={{ fontSize: '0.85rem' }}>{candidate.title}</span>
                    <button
                      type="button"
                      onClick={() => handleAdd(candidate.id)}
                      disabled={addBusyId === candidate.id}
                      style={{
                        fontSize: '0.75rem',
                        padding: '0.25rem 0.6rem',
                        cursor: 'pointer',
                      }}
                      data-testid="team-add-button"
                    >
                      {addBusyId === candidate.id ? 'Adding…' : 'Add'}
                    </button>
                  </li>
                ))}
              {myCampaigns.filter(
                (candidate) =>
                  candidate.id !== campaignId &&
                  !team.members.some((member) => member.id === candidate.id)
              ).length === 0 && (
                <li style={{ fontSize: '0.8rem', color: 'var(--color-text-hint)' }}>
                  None of your other campaigns are available to add.
                </li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
