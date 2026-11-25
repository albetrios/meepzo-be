export function buildTagDefinitions(
  tagSet: Set<string>,
  tagStrings?: Record<string, string>,
): Array<{ name: string; description: string }> {
  const builtInTagDescriptions: Record<string, string> = {
    Health: 'Server health and readiness probes',
    MCP: 'Model Context Protocol — tools and resources for agents (requires admin JWT when ENABLE_MCP_SERVER=true)',
    Auth: 'Authentication — logout, refresh, active organization (no passwords)',
    'Email Login': 'Passwordless sign-in with an emailed verification code',
    OAuth: 'OAuth 2.0 social login flows',
    Password:
      'Password sign-in and management (login, forgot, reset, change) — PASSWORD-ROUTES-DISABLED: registered only when PASSWORD_ROUTES_ENABLED=true',
    'Email Verification': 'Email address verification',
    MFA: 'Multi-factor authentication enrollment and verification',
    Token: 'Token refresh and management',
    Session: 'Session management — list and revoke active sessions',
    'Auth Method': 'Manage linked authentication methods (email code, OAuth, MFA)',
    User: 'Current user profile management',
    'User Settings': 'User personal settings (dark mode, language, etc.)',
    'Notification Preferences': 'Per-user notification type and channel preferences',
    Admin: 'Platform administration endpoints (requires admin role)',
    'User Management': 'Admin user management — list, update, suspend, delete users',
    Organization: 'Organization CRUD and management',
    'Organization Settings': 'Organization-level settings and policies',
    'API Key': 'Organization API key management',
    'Notification Policy': 'Organization notification delivery policies',
    'Audit Log': 'Audit trail of actions performed in the organization',
    Membership: 'Organization membership management',
    Invitation: 'Membership invitations — create, accept, decline, resend',
    Role: 'Custom role management within organizations',
    Permission: 'Available permissions that can be assigned to roles',
    Billing: 'Billing and subscription management',
    Plan: 'Subscription plans and pricing',
    Subscription: 'Subscription lifecycle — create, upgrade, cancel, resume',
    'Stripe Webhook': 'Stripe billing webhook receiver (raw body, signature verified)',
    Notification: 'User notification feed',
    Webhook: 'Webhook endpoint management and delivery history',
    Upload: 'Pre-signed URL generation for file uploads',
    'Channel connection':
      "The organization's provider logins — Meta's Unified Login for a business portfolio: start, finish, reconnect, pick its Instagram accounts under the plan's limit, list, read and disconnect the business, and Meta's deauthorize and data-deletion callbacks",
    'Channel account':
      "The organization's connected accounts, whatever their channel (Instagram now): list, read, disconnect one, pause and resume its sending, and choose which accounts are active within the plan",
    'Instagram account':
      "The organization's connected Instagram professional accounts — change their settings, and browse their posts and stories",
    'Instagram sending':
      "How an organization's Instagram accounts are sending: an account's sending status (waiting messages, stops, today's results) and the organization's monthly DM meter",
    Contact:
      "The people who interacted with the organization's Instagram accounts — list and erase",
    'Instagram Webhook':
      'Instagram events Meta delivers for the connected account, and the list of what happened to each',
    Automation:
      "What answers comments, DMs and story replies on the organization's Instagram accounts — list, create, read, edit and delete",
    Broadcasts:
      'Messages sent to the people of one channel account who match an audience — list, draft, read, edit, send, cancel and delete them',
    Segments:
      'Saved audiences of one channel account that broadcasts reuse — list, save, read, change and delete them, and count an audience',
    'Automation backfill':
      "An automation's past-comments reads — answer the comments of the last 1 to 7 days, and follow a read",
  };
  const tagDescriptions = tagStrings ?? builtInTagDescriptions;

  const tagOrder = [
    'Health',
    'MCP',
    'Auth',
    'Email Login',
    'OAuth',
    'Password',
    'Email Verification',
    'MFA',
    'Token',
    'Session',
    'Auth Method',
    'User',
    'User Settings',
    'Notification Preferences',
    'Admin',
    'User Management',
    'Organization',
    'Organization Settings',
    'API Key',
    'Notification Policy',
    'Audit Log',
    'Membership',
    'Invitation',
    'Role',
    'Permission',
    'Billing',
    'Plan',
    'Subscription',
    'Stripe Webhook',
    'Notification',
    'Webhook',
    'Upload',
    'Channel connection',
    'Channel account',
    'Instagram account',
    'Instagram sending',
    'Contact',
    'Automation',
    'Broadcasts',
    'Segments',
    'Automation backfill',
    'Instagram Webhook',
  ];

  const sortedTags = [...tagSet].sort((left, right) => {
    const indexLeft = tagOrder.indexOf(left);
    const indexRight = tagOrder.indexOf(right);
    if (indexLeft === -1 && indexRight === -1) return left.localeCompare(right);
    if (indexLeft === -1) return 1;
    if (indexRight === -1) return -1;
    return indexLeft - indexRight;
  });

  return sortedTags.map((tag) => ({
    name: tag,
    description: tagDescriptions[tag] ?? builtInTagDescriptions[tag] ?? tag,
  }));
}
