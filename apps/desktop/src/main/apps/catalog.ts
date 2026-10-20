/**
 * The apps people connect most, so Connections has something to pick from, and display names for
 * slugs. Ported from reference phone tools/AppCatalog.kt (slugs checked against Composio there).
 */
import type { AppChoice } from '@agent/core'

function t(slug: string, name: string, line: string): AppChoice {
  return { slug, name, line }
}

export const POPULAR_APPS: AppChoice[] = [
  t('gmail', 'Gmail', 'Read, search, draft and send email'),
  t('googlecalendar', 'Google Calendar', 'See your day, find time, add events'),
  t('googledrive', 'Google Drive', 'Find, read and share your files'),
  t('googledocs', 'Google Docs', 'Read and write documents'),
  t('googlesheets', 'Google Sheets', 'Read and update spreadsheets'),
  t('googletasks', 'Google Tasks', 'Your to-do lists'),
  t('googlemeet', 'Google Meet', 'Create and find meetings'),
  t('outlook', 'Outlook', 'Microsoft email and calendar'),
  t('microsoft_teams', 'Microsoft Teams', 'Chats, channels and meetings'),
  t('one_drive', 'OneDrive', 'Microsoft files'),
  t('slack', 'Slack', 'Read channels and send messages'),
  t('whatsapp', 'WhatsApp', 'WhatsApp Business messages'),
  t('telegram', 'Telegram', 'Bots and messages'),
  t('discord', 'Discord', 'Servers, channels and messages'),
  t('notion', 'Notion', 'Notes, docs and databases'),
  t('todoist', 'Todoist', 'Tasks and projects'),
  t('trello', 'Trello', 'Boards and cards'),
  t('asana', 'Asana', 'Team tasks and projects'),
  t('clickup', 'ClickUp', 'Tasks, docs and goals'),
  t('linear', 'Linear', 'Issues and projects'),
  t('jira', 'Jira', 'Issues and sprints'),
  t('confluence', 'Confluence', 'Team wiki pages'),
  t('airtable', 'Airtable', 'Bases and records'),
  t('github', 'GitHub', 'Repos, issues and pull requests'),
  t('gitlab', 'GitLab', 'Repos, issues and merge requests'),
  t('dropbox', 'Dropbox', 'Files and folders'),
  t('zoom', 'Zoom', 'Meetings and recordings'),
  t('calendly', 'Calendly', 'Bookings and availability'),
  t('hubspot', 'HubSpot', 'Contacts, deals and CRM'),
  t('salesforce', 'Salesforce', 'Leads, accounts and opportunities'),
  t('mailchimp', 'Mailchimp', 'Audiences and campaigns'),
  t('shopify', 'Shopify', 'Orders, products and customers'),
  t('stripe', 'Stripe', 'Payments, invoices and customers'),
  t('quickbooks', 'QuickBooks', 'Invoices and accounting'),
  t('xero', 'Xero', 'Invoices and accounting'),
  t('docusign', 'DocuSign', 'Send and track signatures'),
  t('typeform', 'Typeform', 'Forms and responses'),
  t('figma', 'Figma', 'Design files and comments'),
  t('canva', 'Canva', 'Designs and brand assets'),
  t('miro', 'Miro', 'Whiteboards'),
  t('linkedin', 'LinkedIn', 'Posts and profile'),
  t('twitter', 'X (Twitter)', 'Posts and timeline'),
  t('instagram', 'Instagram', 'Posts and insights'),
  t('facebook', 'Facebook', 'Pages and posts'),
  t('youtube', 'YouTube', 'Videos, playlists and channels'),
  t('reddit', 'Reddit', 'Posts and comments'),
  t('spotify', 'Spotify', 'Playback and playlists'),
  t('wordpress_com', 'WordPress.com', 'Posts and pages'),
  t('webflow', 'Webflow', 'Sites and CMS items'),
  t('zendesk', 'Zendesk', 'Support tickets'),
  t('intercom', 'Intercom', 'Conversations and contacts'),
  t('supabase', 'Supabase', 'Databases and projects'),
]

const NAMES = new Map<string, string>([
  ...POPULAR_APPS.map((app) => [app.slug, app.name] as [string, string]),
  ['wordpress', 'WordPress'],
  ['metaads', 'Meta Ads'],
])

/** An app's display name. An app made for the account (custom_recipes) goes by its own name (Recipes). */
export function appName(slug: string): string {
  const lower = slug.toLowerCase()
  const known = NAMES.get(lower)
  if (known !== undefined) return known
  return lower
    .replace(/^custom_/, '')
    .split('_')
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * Apps where one person has several workspaces (Slack, Notion, Teams...). When Composio does not
 * say which workspace an account is, each gets a label of its own so a second one can be told apart.
 */
const WORKSPACE_APPS = new Set([
  'slack', 'notion', 'discord', 'microsoft_teams', 'microsoftteams', 'teams', 'asana', 'clickup',
  'linear', 'jira', 'trello', 'airtable', 'hubspot', 'shopify', 'figma',
])

export function workspaceLabel(slug: string, id: string): string {
  if (!WORKSPACE_APPS.has(slug) || id === '') return ''
  return `${appName(slug)} workspace ${id.slice(-4)}`
}
