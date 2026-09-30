const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isValidRole,
  canPostUpdates,
  canEditCampaignContent,
  canViewAnalytics,
  canAssignRole,
} = require('../lib/campaignPermissions');

test('role helpers enforce manager vs editor capabilities', () => {
  assert.equal(canPostUpdates('manager'), true);
  assert.equal(canPostUpdates('editor'), false);
  assert.equal(canEditCampaignContent('editor'), true);
  assert.equal(canViewAnalytics('editor'), false);
  assert.equal(canViewAnalytics('viewer'), true);
});

test('isValidRole accepts all team roles', () => {
  for (const role of ['owner', 'manager', 'editor', 'viewer']) {
    assert.equal(isValidRole(role), true);
  }
  assert.equal(isValidRole('admin'), false);
});

test('canAssignRole prevents non-owners from granting the owner role', () => {
  // Only owners may grant owner.
  assert.equal(canAssignRole('owner', 'owner'), true);
  assert.equal(canAssignRole('manager', 'owner'), false);
  assert.equal(canAssignRole('editor', 'owner'), false);
  assert.equal(canAssignRole('viewer', 'owner'), false);

  // Managers may still invite managers, editors, and viewers.
  assert.equal(canAssignRole('manager', 'manager'), true);
  assert.equal(canAssignRole('manager', 'editor'), true);
  assert.equal(canAssignRole('manager', 'viewer'), true);

  // Editors/viewers cannot invite at all.
  assert.equal(canAssignRole('editor', 'viewer'), false);
  assert.equal(canAssignRole('viewer', 'viewer'), false);

  // Invalid target roles are rejected.
  assert.equal(canAssignRole('owner', 'admin'), false);
});
