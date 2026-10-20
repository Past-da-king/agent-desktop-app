/**
 * Icons for generated cards, by word. The model names Lucide icons ("calendar", "map-pin") and writes plain labels
 * ("Bedrooms", "Deposit"); both are mapped to an icon by word, so a card gets its icons whether or not the model
 * asked for any. The same keyword table as the phone app's ui/openui/OpenUiIcons.kt.
 */
export type UiIcon =
  | 'payments' | 'flight' | 'ticket' | 'seat' | 'bank' | 'savings' | 'card' | 'bed' | 'ruler' | 'home' | 'event'
  | 'schedule' | 'luggage' | 'hotel' | 'car' | 'train' | 'place' | 'wifi' | 'call' | 'mail' | 'attach' | 'send'
  | 'person' | 'groups' | 'cart' | 'cafe' | 'star' | 'lock' | 'warning' | 'error' | 'checkCircle' | 'info' | 'doc'
  | 'search' | 'link' | 'work' | 'trendUp' | 'trendDown' | 'checklist' | 'sun' | 'cloud' | 'bolt' | 'sell' | 'image'
  | 'music' | 'heart' | 'book' | 'insights' | 'openInNew' | 'close' | 'check' | 'addCart' | 'alarm' | 'arrowForward'
  | 'bag' | 'callMade' | 'callReceived'

const WORDS: Array<[string[], UiIcon]> = [
  [['rent', 'price', 'cost', 'amount', 'fee', 'total', 'pay', 'paid', 'salary', 'income', 'money', 'dollar', 'banknote', 'wallet', 'bill', 'invoice', 'receipt', 'fare'], 'payments'],
  [['flight', 'airline', 'plane', 'gate', 'boarding', 'airport', 'takeoff'], 'flight'],
  [['ref', 'reference', 'confirmation', 'ticket', 'pnr', 'code', 'pass'], 'ticket'],
  [['seat'], 'seat'],
  [['balance', 'bank', 'account', 'transfer', 'statement'], 'bank'],
  [['deposit', 'saving', 'budget'], 'savings'],
  [['card', 'credit', 'debit'], 'card'],
  [['bedroom', 'bed', 'sleep', 'room'], 'bed'],
  [['size', 'area', 'm2', 'sqm', 'floor', 'ruler'], 'ruler'],
  [['home', 'house', 'flat', 'apartment', 'property', 'listing', 'building'], 'home'],
  [['available', 'date', 'when', 'day', 'event', 'calendar', 'meeting', 'appointment', 'booking', 'viewing', 'due', 'deadline', 'schedule'], 'event'],
  [['time', 'depart', 'arrive', 'duration', 'hour', 'clock', 'late', 'wait', 'pending', 'timer'], 'schedule'],
  [['luggage', 'bag', 'baggage', 'suitcase', 'trip', 'travel'], 'luggage'],
  [['hotel', 'stay', 'night', 'lodging'], 'hotel'],
  [['car', 'drive', 'ride', 'taxi', 'uber', 'bolt ride', 'parking', 'fuel', 'petrol'], 'car'],
  [['train', 'bus', 'transit', 'commute'], 'train'],
  [['location', 'address', 'where', 'map', 'pin', 'place', 'suburb', 'city', 'street', 'near', 'distance', 'gps'], 'place'],
  [['wifi', 'internet', 'network', 'fibre', 'fiber'], 'wifi'],
  [['phone', 'call', 'mobile', 'tel', 'number'], 'call'],
  [['mail', 'email', 'inbox', 'message', 'reply', 'to', 'from', 'subject', 'cc', 'recipient', 'body'], 'mail'],
  [['attachment', 'attached', 'attach'], 'attach'],
  [['send', 'share', 'forward'], 'send'],
  [['person', 'user', 'name', 'contact', 'agent', 'landlord', 'owner', 'host', 'guest', 'who', 'people'], 'person'],
  [['team', 'group', 'family', 'friends', 'attendee', 'helper', 'helpers'], 'groups'],
  [['food', 'restaurant', 'dinner', 'lunch', 'eat', 'menu', 'meal', 'grocer', 'spar', 'shop', 'store', 'cart', 'buy', 'order'], 'cart'],
  [['coffee', 'cafe', 'café', 'tea', 'drink'], 'cafe'],
  [['star', 'rating', 'review', 'score', 'favourite', 'favorite'], 'star'],
  [['lock', 'secure', 'security', 'password', 'private', 'safe'], 'lock'],
  [['alert', 'warning', 'risk', 'caution', 'overdue', 'expir'], 'warning'],
  [['error', 'fail', 'declin', 'reject', 'cancel', 'danger', 'problem'], 'error'],
  [['check', 'done', 'success', 'approve', 'confirm', 'ok', 'complete', 'yes'], 'checkCircle'],
  [['info', 'note', 'about', 'detail', 'status'], 'info'],
  [['doc', 'document', 'file', 'pdf', 'report', 'contract', 'lease', 'text', 'page'], 'doc'],
  [['search', 'find', 'look'], 'search'],
  [['link', 'url', 'website', 'web', 'open'], 'link'],
  [['work', 'job', 'career', 'briefcase', 'office', 'company'], 'work'],
  [['trend', 'growth', 'increase', 'up', 'profit'], 'trendUp'],
  [['decrease', 'down', 'loss', 'drop'], 'trendDown'],
  [['task', 'todo', 'to-do', 'list', 'step', 'checklist'], 'checklist'],
  [['sun', 'weather', 'forecast', 'temperature', 'clear'], 'sun'],
  [['cloud', 'rain', 'storm'], 'cloud'],
  [['bolt', 'fast', 'power', 'electric', 'energy', 'load'], 'bolt'],
  [['tag', 'label', 'category', 'sale', 'deal', 'discount'], 'sell'],
  [['photo', 'image', 'picture', 'camera'], 'image'],
  [['music', 'song', 'play', 'audio', 'track'], 'music'],
  [['health', 'doctor', 'heart', 'medical'], 'heart'],
  [['book', 'read', 'study', 'learn', 'school', 'course'], 'book'],
]

/** The icon for a Lucide-style name or a free label; null when nothing fits. */
export function iconForText(text: string | null | undefined): UiIcon | null {
  const t = (text ?? '').toLowerCase().trim()
  if (t === '') return null
  const parts = t.split(/[^a-z0-9é+]+/).filter((p) => p !== '')
  // Whole-word hits win over fragments ("bed" in "bedrooms" is still right, "up" in "upload" is not).
  const whole = WORDS.find(([keys]) => keys.some((k) => parts.some((p) => p === k || (k.length >= 4 && p.startsWith(k)))))
  if (whole !== undefined) return whole[1]
  const fragment = WORDS.find(([keys]) => keys.some((k) => k.length >= 5 && t.includes(k)))
  return fragment === undefined ? null : fragment[1]
}

/** The leading icon for an action button, from its label. */
export function iconForAction(label: string | null | undefined): UiIcon | null {
  const t = (label ?? '').toLowerCase()
  if (/approve|confirm|accept|yes|done|ok\b|allow/.test(t)) return 'check'
  if (/decline|reject|cancel|no\b|deny|dismiss|skip/.test(t)) return 'close'
  if (/book|schedule|viewing|reserve|appointment/.test(t)) return 'event'
  if (/open|view|see|visit|read|details|listing|link/.test(t)) return 'openInNew'
  if (/call|phone|ring/.test(t)) return 'call'
  if (/boarding|ticket|pass\b/.test(t)) return 'ticket'
  if (/cart|basket|bag/.test(t)) return 'addCart'
  if (/pay|buy|order|checkout|tip/.test(t)) return 'payments'
  if (/send|reply|message|email|forward|share/.test(t)) return 'send'
  if (/remind|snooze|later/.test(t)) return 'alarm'
  if (/search|find|compare|check/.test(t)) return 'search'
  return null
}

/** A button that only opens or shows something ("Details", "Open listing"), as opposed to one that decides or sends. */
export function navigates(label: string | null | undefined): boolean {
  return iconForAction(label) === 'openInNew'
}
