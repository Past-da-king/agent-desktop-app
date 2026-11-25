/** Same order in Settings, the wire catalogue, turn failover and the phone. Never sort ties by display name. */
export interface OrderedDevice { id: string; priority: number; pairedAt?: number }
export function compareDeviceOrder(a: OrderedDevice, b: OrderedDevice): number {
  return a.priority - b.priority || (a.pairedAt ?? 0) - (b.pairedAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}
export function hasTiedPriorities(rows: OrderedDevice[]): boolean { return new Set(rows.map(row => row.priority)).size !== rows.length }
