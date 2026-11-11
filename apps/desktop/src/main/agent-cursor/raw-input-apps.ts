/**
 * Programs and windows that read the mouse and keyboard BELOW window messages (remote viewers, virtual machines, game
 * streams, game and 3D engines). Input posted to their window, or sent through UI Automation, never reaches what they
 * show. screen_act answers "needs the agent desktop" for them at once. ONE list: the helper (tools/agent-screen) is
 * sent this list on every action, so there is no second copy to keep in step.
 */
export const RAW_INPUT_PROCESSES: readonly string[] = [
  'anydesk', 'teamviewer', 'mstsc', 'msrdc', 'vncviewer', 'tvnviewer', 'rustdesk', 'parsecd', 'parsec', 'moonlight', 'vmconnect', 'vmware', 'vmware-vmx',
  'vmware-remotemks', 'virtualboxvm', 'scrcpy', 'splashtop', 'srclient', 'remoting_desktop', 'nomachine', 'nxplayer', 'dwrcc', 'ultraviewer_desktop', 'sunshine',
]

/** Window classes of programs drawn by a game or 3D engine. */
export const RAW_INPUT_CLASSES: readonly string[] = ['TscShellContainerClass', 'UnityWndClass', 'UnrealWindow', 'SDL_app', 'SDL_Window', 'GLFW30', 'LWJGL', 'CryENGINE', 'Valve001']

/** Windows drawn by Chromium (browsers, Electron apps): the CDP rung can reach their pages. */
export const CHROMIUM_CLASSES: readonly string[] = ['Chrome_WidgetWin_1', 'Chrome_WidgetWin_0']

export function needsAgentDesktopReason(process: string, className: string): string | null {
  const proc = process.toLowerCase()
  if (RAW_INPUT_PROCESSES.includes(proc)) return process + ' reads the mouse and keyboard below window messages (a remote viewer, virtual machine or stream), so input sent to its window never reaches what it shows'
  if (RAW_INPUT_CLASSES.includes(className)) return 'This window (' + className + ') is drawn by a game or 3D engine that reads raw input, so input sent to its window is ignored'
  return null
}
