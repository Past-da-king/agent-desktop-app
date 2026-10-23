/**
 * When the agent asks the person first (the person's rule, 23 Oct 2026: "stop asking me all them permissions").
 *
 * Ordinary work runs without a card: sending a message or a file, posting, replying, editing, creating. Only these
 * still ask:
 *  - what deletes or cannot be undone (delete, remove, trash, purge, wipe, revoke, cancel, unsubscribe...);
 *  - what costs money (pay, purchase, buy, checkout, refund, transfer, withdraw, place an order...);
 *  - the person's three yes-items: going live or DNS (deploy, promote to production, DNS, nameservers, domain records),
 *    secrets and env vars (secrets, API keys, passwords, credentials, env vars, connection strings), and changing
 *    a resource someone else owns (the person flags those per app or per account: "ask first" in Connections).
 * A per-app or per-account "ask first" in Connections is the person's opt-in to be asked for every change.
 */

const RISKY_WORDS = [
  // Deletes or cannot be undone.
  'delete',
  'deletes',
  'deleting',
  'deletion',
  'remove',
  'removes',
  'removing',
  'trash',
  'purge',
  'wipe',
  'erase',
  'destroy',
  'revoke',
  'cancel',
  'unsubscribe',
  'deactivate',
  'terminate',
  'empty trash',
  'permanently',
  // Costs money.
  'pay',
  'pays',
  'payment',
  'payments',
  'payout',
  'purchase',
  'buy',
  'checkout',
  'refund',
  'transfer money',
  'transfer funds',
  'withdraw',
  'withdrawal',
  'place order',
  'place an order',
  'charge',
  'top up',
  // Going live, DNS.
  'deploy',
  'deployment',
  'promote to production',
  'go live',
  'dns',
  'nameserver',
  'nameservers',
  'domain record',
  'domain records',
  // Secrets and env vars.
  'secret',
  'secrets',
  'api key',
  'api keys',
  'password',
  'passwords',
  'credential',
  'credentials',
  'env var',
  'env vars',
  'environment variable',
  'environment variables',
  'connection string',
  // Other people's resources: access to someone else's account, files or site, and paid seats.
  'grant',
  'grants',
  'granting',
  'site admin',
  'license',
  'licenses',
  'licence',
  'licences',
]

const RISKY = new RegExp(`(^|[^a-z0-9])(${RISKY_WORDS.map((w) => w.replace(/ /g, '[ _-]+')).join('|')})($|[^a-z0-9])`, 'i')

/**
 * Does this action need the person's yes under the rule above? `text` is what names it: a learned tool's name and
 * description, or a connected app's action slug (GMAIL_MOVE_TO_TRASH). Underscores count as spaces.
 */
export function needsYes(text: string): boolean {
  return RISKY.test(text.replace(/_/g, ' '))
}
