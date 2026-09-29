import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TeamCampaignsSection from './TeamCampaignsSection';
import { apiClient } from '../services/api';

vi.mock('../services/api', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
}));

const TEAM_PAYLOAD = {
  members: [
    {
      id: 'member-1',
      title: 'Team A',
      target_amount: 100,
      raised_amount: 40,
      asset_type: 'XLM',
      status: 'active',
      role: 'owner',
      progress_percent: 40,
    },
    {
      id: 'member-2',
      title: 'Team B',
      target_amount: 200,
      raised_amount: 200,
      asset_type: 'XLM',
      status: 'funded',
      role: 'member',
      progress_percent: 100,
    },
  ],
  totals: {
    target_amount: 300,
    raised_amount: 240,
    progress_percent: 80,
    member_count: 2,
  },
};

describe('TeamCampaignsSection (#952)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.get.mockImplementation((url) => {
      if (url.endsWith('/team')) {
        return Promise.resolve({ data: TEAM_PAYLOAD });
      }
      if (url === '/campaigns/mine') {
        return Promise.resolve({ data: { campaigns: [{ id: 'c9', title: 'My Other Campaign' }] } });
      }
      return Promise.resolve({ data: {} });
    });
  });

  it('renders the rollup and one card per member', async () => {
    render(<TeamCampaignsSection campaignId="parent-1" canManage={false} />);

    await waitFor(() => {
      expect(screen.getByTestId('team-totals')).toBeInTheDocument();
    });
    expect(screen.getByText(/240.*raised/i)).toBeInTheDocument();
    expect(screen.getAllByTestId('team-member-card')).toHaveLength(2);
    // Non-managers get no remove buttons and no picker.
    expect(screen.queryAllByTestId('team-member-remove')).toHaveLength(0);
    expect(screen.queryByTestId('team-add-picker')).toBeNull();
  });

  it('shows the empty state when there are no members', async () => {
    apiClient.get.mockImplementation((url) =>
      url.endsWith('/team')
        ? Promise.resolve({ data: { members: [], totals: { member_count: 0 } } })
        : Promise.resolve({ data: {} })
    );

    render(<TeamCampaignsSection campaignId="parent-1" canManage={false} />);

    await waitFor(() => {
      expect(screen.getByTestId('team-section-empty')).toBeInTheDocument();
    });
  });

  it('propagates load failures as an alert', async () => {
    apiClient.get.mockImplementation((url) =>
      url.endsWith('/team')
        ? Promise.reject({ response: { data: { error: 'Database down' } } })
        : Promise.resolve({ data: {} })
    );

    render(<TeamCampaignsSection campaignId="parent-1" canManage={false} />);

    await waitFor(() => {
      expect(screen.getByTestId('team-section-error')).toHaveTextContent(
        'Database down'
      );
    });
  });

  it('adds a member from the picker and refreshes the team', async () => {
    const user = userEvent.setup();
    apiClient.post.mockResolvedValue({ data: {} });

    render(<TeamCampaignsSection campaignId="parent-1" canManage />);

    await waitFor(() => {
      expect(screen.getByTestId('team-add-picker')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('team-add-button'));

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith(
        '/campaigns/parent-1/team/members',
        { member_campaign_id: 'c9' }
      );
    });
    // Team reloaded after the add.
    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });

  it('removes a member and refreshes the team', async () => {
    const user = userEvent.setup();
    apiClient.delete.mockResolvedValue({ data: {} });

    render(<TeamCampaignsSection campaignId="parent-1" canManage />);

    await waitFor(() => {
      expect(screen.getAllByTestId('team-member-remove')).toHaveLength(2);
    });
    await user.click(screen.getAllByTestId('team-member-remove')[0]);

    await waitFor(() => {
      expect(apiClient.delete).toHaveBeenCalledWith(
        '/campaigns/parent-1/team/members/member-1'
      );
    });
  });

  it('surfaces service rejections when adding fails', async () => {
    const user = userEvent.setup();
    apiClient.post.mockRejectedValue({
      response: { data: { error: 'A campaign cannot be a member of itself' } },
    });

    render(<TeamCampaignsSection campaignId="parent-1" canManage />);

    await waitFor(() => {
      expect(screen.getByTestId('team-add-picker')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('team-add-button'));

    await waitFor(() => {
      expect(screen.getByTestId('team-action-error')).toHaveTextContent(
        'A campaign cannot be a member of itself'
      );
    });
  });
});
