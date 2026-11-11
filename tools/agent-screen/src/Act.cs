// agent-screen, acting (11 Nov 2026): the agent's own input. See docs/agent-cursor.md.
//
// The rule this file exists for: the agent NEVER takes the person's mouse, keyboard or window focus. Every action
// here reaches ONE window, named by its handle (and checked against its process id), without moving the pointer and
// without bringing that window to the front:
//
//   rung "uia:*"   UI Automation patterns on the element (Invoke, Toggle, SelectionItem, ExpandCollapse, Value,
//                  RangeValue, Scroll, LegacyIAccessible default action, ShowContextMenu). Never SetFocus.
//   rung "msg:*"   a text message to a classic edit control (WM_SETTEXT, EM_REPLACESEL).
//   rung "post:*"  mouse, wheel, key and character messages posted to the child window under the point.
//
// (The Chromium debugger rung, "cdp:*", lives in the app: apps/desktop/src/main/agent-cursor/cdp-rung.ts.)
//
// After every action the effect is LOOKED FOR: the element's own state, the program's windows, the control tree,
// then the window's picture. A rung that changed nothing is said to have changed nothing and the next one is tried;
// when none did, the answer is ok:false with reason "ignored" and nothing is claimed.
//
// The person's pointer and foreground window are read before and after and reported. If the target program brought
// itself to the front because of the action, the window he was in gets the keyboard back at once, and that is said.
//
// "inject" is the only real input in this program (SendInput). It is the last resort, asked for only by the app's
// input lock (apps/desktop/src/main/agent-cursor/input-lock.ts), and it guards itself too: it refuses unless he has
// been idle for the time asked, stops the moment a mouse or key event that is not its own arrives, and puts his
// pointer and his window back.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UIA;

namespace AgentScreen
{
    internal static class Native2
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct GUITHREADINFO
        {
            public int cbSize; public uint flags; public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret; public Native.RECT rcCaret;
        }
        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT { public uint type; public INPUTUNION u; }
        [StructLayout(LayoutKind.Explicit)]
        public struct INPUTUNION
        {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
        }
        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }

        public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr data);

        [DllImport("user32.dll")] public static extern bool GetCursorPos(out Native.POINT point);
        [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr hwnd, ref Native.POINT point);
        [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref Native.POINT point);
        [DllImport("user32.dll")] public static extern IntPtr ChildWindowFromPointEx(IntPtr parent, Native.POINT point, uint flags);
        [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Native.POINT point);
        [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageTimeoutW")] public static extern IntPtr SendMessageTimeoutText(IntPtr hwnd, uint msg, IntPtr wParam, string lParam, uint flags, uint timeout, out IntPtr result);
        [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info);
        [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc proc, IntPtr data);
        [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out Native.RECT rect);
        [DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
        [DllImport("user32.dll")] public static extern short VkKeyScan(char ch);
        [DllImport("user32.dll")] public static extern bool GetKeyboardState(byte[] state);
        [DllImport("user32.dll")] public static extern bool SetKeyboardState(byte[] state);

        public const uint WM_SETTEXT = 0x000C, WM_GETTEXTLENGTH = 0x000E, WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, WM_CHAR = 0x0102, WM_SYSKEYDOWN = 0x0104, WM_SYSKEYUP = 0x0105,
            WM_MOUSEMOVE = 0x0200, WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202, WM_LBUTTONDBLCLK = 0x0203, WM_RBUTTONDOWN = 0x0204, WM_RBUTTONUP = 0x0205,
            WM_MOUSEWHEEL = 0x020A, WM_CONTEXTMENU = 0x007B, EM_SETSEL = 0x00B1, EM_REPLACESEL = 0x00C2;
        public const uint CWP_SKIPINVISIBLE = 1, CWP_SKIPDISABLED = 2, CWP_SKIPTRANSPARENT = 4;
    }

    internal sealed class Snap
    {
        public string State, Windows, Tree;
        public long Pixels;
        public bool HasTree, HasPixels;
    }

    internal sealed class Tried
    {
        public string Rung, Result;
        public Tried(string rung, string result) { Rung = rung; Result = result; }
    }

    internal static partial class Program
    {
        private const int PatInvoke = 10000, PatValue = 10002, PatRangeValue = 10003, PatScroll = 10004, PatExpand = 10005, PatSelectionItem = 10010,
            PatText = 10014, PatToggle = 10015, PatLegacy = 10018;

        // ---- which windows posted input cannot reach ----

        /** Programs that read the mouse and keyboard below the window messages (remote viewers, virtual machines, game streams): posted input never reaches what they show. */
        private static readonly string[] RawInputProcesses = new string[]
        {
            "anydesk", "teamviewer", "mstsc", "msrdc", "vncviewer", "tvnviewer", "rustdesk", "parsecd", "parsec", "moonlight", "vmconnect", "vmware", "vmware-vmx",
            "vmware-remotemks", "virtualboxvm", "scrcpy", "splashtop", "srclient", "remoting_desktop", "nomachine", "nxplayer", "dwrcc", "ultraviewer_desktop", "sunshine",
        };

        /** Window classes of programs that draw with a game or 3D engine and read raw input. */
        private static readonly string[] RawInputClasses = new string[]
        {
            "TscShellContainerClass", "UnityWndClass", "UnrealWindow", "SDL_app", "SDL_Window", "GLFW30", "LWJGL", "CryENGINE", "Valve001",
        };

        /** Why posted input cannot work on this window, or null when nothing says it cannot. code: elevated | raw_input. */
        private static string NeedsOwnDesktop(IntPtr hwnd, Dictionary<string, object> req, out string code)
        {
            code = null;
            uint pid;
            Native.GetWindowThreadProcessId(hwnd, out pid);
            if (!selfElevated && IsElevated(pid) == 1)
            {
                code = "elevated";
                return "That window runs as administrator and this app does not, so Windows blocks every message and every read from here.";
            }
            string process = ProcessName(pid).ToLowerInvariant();
            foreach (string name in ListFrom(req, "rawProcesses", RawInputProcesses))
            {
                if (process == name) { code = "raw_input"; return "That program (" + process + ") reads the mouse and keyboard below window messages (a remote viewer, virtual machine or stream), so input sent to its window never reaches what it shows."; }
            }
            string cls = ClassOf(hwnd);
            foreach (string name in ListFrom(req, "rawClasses", RawInputClasses))
            {
                if (cls == name) { code = "raw_input"; return "That window (" + cls + ") is drawn by a game or 3D engine that reads raw input, so input sent to its window is ignored."; }
            }
            return null;
        }

        /** The caller's list (the app keeps ONE list of such programs in a data file and sends it); the built-in one when none came. */
        private static IEnumerable<string> ListFrom(Dictionary<string, object> req, string key, string[] fallback)
        {
            object raw;
            if (req != null && req.TryGetValue(key, out raw) && raw is object[])
            {
                List<string> list = new List<string>();
                foreach (object item in (object[])raw) if (item is string) list.Add(((string)item).ToLowerInvariant() == (string)item ? (string)item : (string)item);
                return list;
            }
            return fallback;
        }

        private static string CommandLineOf(uint pid)
        {
            try
            {
                using (System.Management.ManagementObjectSearcher searcher = new System.Management.ManagementObjectSearcher("SELECT CommandLine FROM Win32_Process WHERE ProcessId = " + pid))
                {
                    foreach (System.Management.ManagementBaseObject item in searcher.Get())
                    {
                        object value = item["CommandLine"];
                        return value == null ? "" : value.ToString();
                    }
                }
            }
            catch (Exception) { }
            return "";
        }

        private static string ArgOf(string commandLine, string flag)
        {
            int at = commandLine.IndexOf(flag + "=", StringComparison.OrdinalIgnoreCase);
            if (at < 0) return null;
            int from = at + flag.Length + 1;
            if (from >= commandLine.Length) return "";
            // The whole argument may be quoted ("--flag=value with spaces"), or only the value (--flag="value").
            bool quotedArg = at > 0 && commandLine[at - 1] == '"';
            bool quotedValue = commandLine[from] == '"';
            if (quotedValue) from++;
            int end = quotedArg || quotedValue ? commandLine.IndexOf('"', from) : commandLine.IndexOf(' ', from);
            if (end < 0) end = commandLine.Length;
            return commandLine.Substring(from, end - from);
        }

        /** Is this point of the screen showing this window (nothing of another program on top of it there)? */
        private static bool ShowsAt(IntPtr hwnd, int x, int y)
        {
            // Top to bottom: the first window at that point that eyes and clicks do not pass through.
            int guard = 0;
            IntPtr top = Native.GetTopWindow(IntPtr.Zero);
            while (top != IntPtr.Zero && guard++ < 4000)
            {
                if (Native.IsWindowVisible(top) && !Native.IsIconic(top) && !Cloaked(top))
                {
                    Native.RECT r;
                    Native.GetWindowRect(top, out r);
                    if (x >= r.Left && x < r.Right && y >= r.Top && y < r.Bottom)
                    {
                        if (top == hwnd) return true;
                        long ex = Native.GetWindowLongPtr(top, Native.GWL_EXSTYLE).ToInt64();
                        bool passes = (ex & 0x20) != 0 && (ex & 0x80000) != 0; // WS_EX_TRANSPARENT and WS_EX_LAYERED: a click-through overlay
                        if (!passes) return false;
                    }
                }
                top = Native.GetWindow(top, Native.GW_HWNDNEXT);
            }
            return false;
        }

        /** Where a window is and whether it can be seen: what the agent's cursor follows. */
        private static string PlaceOf(Dictionary<string, object> req)
        {
            IntPtr hwnd = ParseHwnd(J.Get(req, "hwnd"));
            if (hwnd == IntPtr.Zero || !Native.IsWindow(hwnd)) return "{\"exists\":false}";
            Native.RECT r = FrameOf(hwnd);
            bool minimized = Native.IsIconic(hwnd);
            bool hidden = !Native.IsWindowVisible(hwnd) || Cloaked(hwnd);
            StringBuilder sb = new StringBuilder(160);
            sb.Append("{\"exists\":true,\"minimized\":").Append(minimized ? "true" : "false").Append(",\"hidden\":").Append(hidden ? "true" : "false").Append(",\"bounds\":");
            J.Rect(sb, r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top);
            if (req.ContainsKey("x") && req.ContainsKey("y"))
            {
                bool shows = !minimized && !hidden && ShowsAt(hwnd, J.Int(req, "x", 0), J.Int(req, "y", 0));
                sb.Append(",\"shows\":").Append(shows ? "true" : "false");
            }
            IntPtr fg = Native.GetForegroundWindow();
            sb.Append(",\"foreground\":").Append(fg != IntPtr.Zero && Native.GetAncestor(fg, Native.GA_ROOT) == hwnd ? "true" : "false").Append('}');
            return sb.ToString();
        }

        /** What kind of window this is for acting: can posted input reach it, is there a debugger door. */
        private static string Probe(Dictionary<string, object> req)
        {
            IntPtr hwnd = Hwnd(req);
            uint pid;
            Native.GetWindowThreadProcessId(hwnd, out pid);
            string code;
            string why = NeedsOwnDesktop(hwnd, req, out code);
            string cls = ClassOf(hwnd);
            StringBuilder sb = new StringBuilder(256);
            sb.Append("{\"hwnd\":\"").Append(HwndText(hwnd)).Append("\",\"pid\":").Append(pid).Append(",\"process\":");
            J.Str(sb, ProcessName(pid));
            sb.Append(",\"className\":");
            J.Str(sb, cls);
            sb.Append(",\"title\":");
            J.Str(sb, TitleOf(hwnd));
            sb.Append(",\"minimized\":").Append(Native.IsIconic(hwnd) ? "true" : "false");
            sb.Append(",\"own\":").Append(IsExcluded(hwnd) ? "true" : "false");
            sb.Append(",\"needsOwnDesktop\":").Append(why == null ? "false" : "true");
            if (why != null) { sb.Append(",\"code\":\"").Append(code).Append("\",\"why\":"); J.Str(sb, why); }
            if (BrowserClass(cls) && J.Bool(req, "debugPort", true))
            {
                string commandLine = CommandLineOf(pid);
                string port = ArgOf(commandLine, "--remote-debugging-port");
                string dir = ArgOf(commandLine, "--user-data-dir");
                int number;
                if (port != null && int.TryParse(port, NumberStyles.Integer, CultureInfo.InvariantCulture, out number)) sb.Append(",\"debugPort\":").Append(number);
                if (dir != null) { sb.Append(",\"userDataDir\":"); J.Str(sb, dir); }
                // The page's own window: where page coordinates start.
                IntPtr page = Native.FindWindowEx(hwnd, IntPtr.Zero, "Chrome_RenderWidgetHostHWND", null);
                Native.RECT pr;
                if (page != IntPtr.Zero && Native.GetWindowRect(page, out pr)) { sb.Append(",\"page\":"); J.Rect(sb, pr.Left, pr.Top, pr.Right - pr.Left, pr.Bottom - pr.Top); }
            }
            sb.Append('}');
            return sb.ToString();
        }

        // ---- what changed ----

        private static object Pattern(IUIAutomationElement el, int id)
        {
            try { return el.GetCurrentPattern(id); } catch (Exception) { return null; }
        }

        private static bool IsPassword(IUIAutomationElement el)
        {
            try { return el.CurrentIsPassword != 0; } catch (Exception) { return false; }
        }

        /** The element's own state as text: what a successful action changes. A password's value is never read (its length is). */
        private static string StateOf(IUIAutomationElement el)
        {
            if (el == null) return "";
            StringBuilder sb = new StringBuilder(128);
            bool secret = IsPassword(el);
            try
            {
                IUIAutomationValuePattern value = Pattern(el, PatValue) as IUIAutomationValuePattern;
                if (value != null) { string v = value.CurrentValue ?? ""; sb.Append("v=").Append(secret ? v.Length.ToString(CultureInfo.InvariantCulture) : v).Append('|'); }
            }
            catch (Exception) { }
            try
            {
                IUIAutomationTogglePattern toggle = Pattern(el, PatToggle) as IUIAutomationTogglePattern;
                if (toggle != null) sb.Append("t=").Append((int)toggle.CurrentToggleState).Append('|');
            }
            catch (Exception) { }
            try
            {
                IUIAutomationSelectionItemPattern item = Pattern(el, PatSelectionItem) as IUIAutomationSelectionItemPattern;
                if (item != null) sb.Append("s=").Append(item.CurrentIsSelected).Append('|');
            }
            catch (Exception) { }
            try
            {
                IUIAutomationExpandCollapsePattern expand = Pattern(el, PatExpand) as IUIAutomationExpandCollapsePattern;
                if (expand != null) sb.Append("e=").Append((int)expand.CurrentExpandCollapseState).Append('|');
            }
            catch (Exception) { }
            try
            {
                IUIAutomationRangeValuePattern range = Pattern(el, PatRangeValue) as IUIAutomationRangeValuePattern;
                if (range != null) sb.Append("r=").Append(range.CurrentValue.ToString(CultureInfo.InvariantCulture)).Append('|');
            }
            catch (Exception) { }
            try
            {
                IUIAutomationScrollPattern scroll = Pattern(el, PatScroll) as IUIAutomationScrollPattern;
                if (scroll != null) sb.Append("sc=").Append(scroll.CurrentVerticalScrollPercent.ToString("0.###", CultureInfo.InvariantCulture)).Append(',').Append(scroll.CurrentHorizontalScrollPercent.ToString("0.###", CultureInfo.InvariantCulture)).Append('|');
            }
            catch (Exception) { }
            if (!secret)
            {
                try
                {
                    IUIAutomationTextPattern text = Pattern(el, PatText) as IUIAutomationTextPattern;
                    if (text != null) { string t = text.DocumentRange.GetText(4000) ?? ""; sb.Append("x=").Append(t.Length).Append(':').Append(t.GetHashCode()).Append('|'); }
                }
                catch (Exception) { }
            }
            try { sb.Append("n=").Append(el.CurrentName ?? "").Append("|en=").Append(el.CurrentIsEnabled); } catch (Exception) { sb.Append("gone"); }
            return sb.ToString();
        }

        /** The readable text of an element, for the answer (never a password's). */
        private static string TextOf(IUIAutomationElement el)
        {
            if (el == null || IsPassword(el)) return null;
            try
            {
                IUIAutomationValuePattern value = Pattern(el, PatValue) as IUIAutomationValuePattern;
                if (value != null) return value.CurrentValue ?? "";
            }
            catch (Exception) { }
            try
            {
                IUIAutomationTextPattern text = Pattern(el, PatText) as IUIAutomationTextPattern;
                if (text != null) return text.DocumentRange.GetText(2000) ?? "";
            }
            catch (Exception) { }
            return null;
        }

        /** The visible top-level windows of a process: a click that opens or closes a dialog shows here. */
        private static string WindowsOf(uint pid)
        {
            StringBuilder sb = new StringBuilder(128);
            Native2.EnumWindowsProc proc = delegate (IntPtr hwnd, IntPtr data)
            {
                uint owner;
                Native.GetWindowThreadProcessId(hwnd, out owner);
                if (owner == pid && Native.IsWindowVisible(hwnd)) sb.Append(hwnd.ToInt64().ToString("x")).Append(':').Append(TitleOf(hwnd)).Append(';');
                return true;
            };
            Native2.EnumWindows(proc, IntPtr.Zero);
            GC.KeepAlive(proc);
            return sb.ToString();
        }

        private static string TreePrint(IntPtr hwnd)
        {
            try
            {
                int seen;
                List<NodeInfo> nodes = ReadAll(hwnd, 1500, false, true, out seen);
                StringBuilder sb = new StringBuilder(nodes.Count * 24 + 16);
                sb.Append(seen).Append('#');
                foreach (NodeInfo node in nodes)
                {
                    sb.Append(node.Role).Append(':').Append(node.Name).Append(':').Append(node.Value ?? "").Append(':').Append(node.X).Append(',').Append(node.Y).Append(',').Append(node.W).Append(',').Append(node.H)
                        .Append(node.Enabled ? 'e' : 'd').Append(node.Offscreen ? 'o' : 'v').Append(';');
                }
                return sb.Length + ":" + sb.ToString().GetHashCode();
            }
            catch (Exception) { return "?"; }
        }

        /** A coarse picture of the window (a grid of samples), read from the window itself, so a window on top of it does not matter. 0: no picture. */
        private static long PixelPrint(IntPtr hwnd)
        {
            try
            {
                string how;
                using (Bitmap picture = CaptureWindow(hwnd, out how))
                {
                    if (how != "window") return 0;
                    long hash = 1469598103934665603L;
                    int cols = 96, rows = 64;
                    for (int j = 0; j < rows; j++)
                    {
                        int y = (int)((j + 0.5) * picture.Height / rows);
                        for (int i = 0; i < cols; i++)
                        {
                            int x = (int)((i + 0.5) * picture.Width / cols);
                            hash = unchecked((hash ^ (picture.GetPixel(x, y).ToArgb() & 0xFFFFFF)) * 1099511628211L);
                        }
                    }
                    return hash == 0 ? 1 : hash;
                }
            }
            catch (Exception) { return 0; }
        }

        private static Snap Before(IntPtr hwnd, uint pid, IUIAutomationElement el, bool heavy)
        {
            Snap snap = new Snap();
            snap.State = StateOf(el);
            snap.Windows = WindowsOf(pid);
            if (heavy)
            {
                snap.Tree = TreePrint(hwnd); snap.HasTree = true;
                snap.Pixels = PixelPrint(hwnd); snap.HasPixels = snap.Pixels != 0;
            }
            return snap;
        }

        /** Looks for the effect for up to waitMs. The answer names the evidence, or is null when nothing changed. */
        private static string Changed(IntPtr hwnd, uint pid, IUIAutomationElement el, Snap before, int waitMs)
        {
            Stopwatch sw = Stopwatch.StartNew();
            int round = 0;
            for (;;)
            {
                if (!Native.IsWindow(hwnd)) return "window closed";
                if (el != null && StateOf(el) != before.State) return "state";
                if (WindowsOf(pid) != before.Windows) return "window";
                if (round % 2 == 1 || sw.ElapsedMilliseconds >= waitMs)
                {
                    if (before.HasTree && TreePrint(hwnd) != before.Tree) return "tree";
                    if (before.HasPixels) { long now = PixelPrint(hwnd); if (now != 0 && now != before.Pixels) return "picture"; }
                }
                if (sw.ElapsedMilliseconds >= waitMs) return null;
                Thread.Sleep(70);
                round++;
            }
        }

        // ---- finding where to send ----

        private static IUIAutomationElement ElementOf(Dictionary<string, object> req, IntPtr hwnd, out string problem)
        {
            problem = null;
            string id = J.Get(req, "node");
            if (!string.IsNullOrEmpty(id))
            {
                IUIAutomationElement known;
                lock (Elements) Elements.TryGetValue(id, out known);
                if (known != null)
                {
                    try { int alive = known.CurrentProcessId; if (alive != 0) return known; } catch (Exception) { }
                }
                if (string.IsNullOrEmpty(J.Get(req, "name"))) { problem = "That element is gone (the window drew itself again). Read the window again."; return null; }
            }
            string name = J.Get(req, "name");
            if (!string.IsNullOrEmpty(name))
            {
                int nth = Math.Max(1, J.Int(req, "nth", 1));
                int road;
                List<NodeInfo> hits = Matches(hwnd, name, J.Get(req, "role"), nth, out road);
                if (hits.Count >= nth) return hits[nth - 1].Element;
                problem = hits.Count == 0 ? "Nothing in that window is called \"" + name + "\"." : "Only " + hits.Count + " thing(s) in that window are called \"" + name + "\".";
                return null;
            }
            return null;
        }

        /** The smallest thing in the window's tree that holds this screen point (the window may be covered: the tree is read from the window, not the screen). */
        private static IUIAutomationElement ElementAt(IntPtr hwnd, int sx, int sy)
        {
            try
            {
                int seen;
                List<NodeInfo> nodes = ReadAll(hwnd, 3000, true, false, out seen);
                NodeInfo best = null;
                long bestArea = long.MaxValue;
                foreach (NodeInfo node in nodes)
                {
                    if (sx < node.X || sy < node.Y || sx >= node.X + node.W || sy >= node.Y + node.H) continue;
                    long area = (long)node.W * node.H;
                    if (area < bestArea) { best = node; bestArea = area; }
                }
                return best == null ? null : best.Element;
            }
            catch (Exception) { return null; }
        }

        private static bool RectOf(IUIAutomationElement el, out int x, out int y, out int w, out int h)
        {
            x = y = w = h = 0;
            try
            {
                tagRECT r = el.CurrentBoundingRectangle;
                x = r.left; y = r.top; w = r.right - r.left; h = r.bottom - r.top;
                return w >= 1 && h >= 1;
            }
            catch (Exception) { return false; }
        }

        /** The deepest child window of `top` at a screen point. Asked of the window itself, so what covers it on screen does not matter. */
        private static IntPtr ChildAt(IntPtr top, int sx, int sy)
        {
            IntPtr current = top;
            for (int depth = 0; depth < 32; depth++)
            {
                Native.POINT p; p.X = sx; p.Y = sy;
                Native2.ScreenToClient(current, ref p);
                IntPtr child = Native2.ChildWindowFromPointEx(current, p, Native2.CWP_SKIPINVISIBLE | Native2.CWP_SKIPTRANSPARENT);
                if (child == IntPtr.Zero || child == current) break;
                current = child;
            }
            return current;
        }

        /** The window an element lives in: its own handle, else its nearest ancestor's with one, inside `top`. */
        private static IntPtr HwndOfElement(IUIAutomationElement el, IntPtr top)
        {
            try
            {
                IUIAutomationTreeWalker walker = Uia().ControlViewWalker;
                IUIAutomationElement at = el;
                for (int i = 0; i < 40 && at != null; i++)
                {
                    IntPtr handle = IntPtr.Zero;
                    try { handle = at.CurrentNativeWindowHandle; } catch (Exception) { }
                    if (handle != IntPtr.Zero) return handle;
                    at = walker.GetParentElement(at);
                }
            }
            catch (Exception) { }
            return top;
        }

        private static IntPtr MakeLParam(int x, int y)
        {
            return new IntPtr((int)(((uint)(y & 0xFFFF) << 16) | (uint)(x & 0xFFFF)));
        }

        // ---- posted input ----

        private static void PostMouse(IntPtr target, int sx, int sy, string action)
        {
            Native.POINT p; p.X = sx; p.Y = sy;
            Native2.ScreenToClient(target, ref p);
            IntPtr at = MakeLParam(p.X, p.Y);
            Native2.PostMessage(target, Native2.WM_MOUSEMOVE, IntPtr.Zero, at);
            Thread.Sleep(15);
            if (action == "right_click")
            {
                Native2.PostMessage(target, Native2.WM_RBUTTONDOWN, new IntPtr(2), at);
                Thread.Sleep(25);
                Native2.PostMessage(target, Native2.WM_RBUTTONUP, IntPtr.Zero, at);
                return;
            }
            Native2.PostMessage(target, Native2.WM_LBUTTONDOWN, new IntPtr(1), at);
            Thread.Sleep(25);
            Native2.PostMessage(target, Native2.WM_LBUTTONUP, IntPtr.Zero, at);
            if (action == "double_click")
            {
                Thread.Sleep(25);
                Native2.PostMessage(target, Native2.WM_LBUTTONDBLCLK, new IntPtr(1), at);
                Thread.Sleep(25);
                Native2.PostMessage(target, Native2.WM_LBUTTONUP, IntPtr.Zero, at);
            }
        }

        private static void PostWheel(IntPtr target, int sx, int sy, int dy)
        {
            // One notch (120) is about 100 px of page in most programs; down is negative.
            int left = -dy * 120 / 100;
            if (left == 0) left = dy > 0 ? -120 : 120;
            IntPtr at = MakeLParam(sx, sy);
            int guard = 0;
            while (left != 0 && guard++ < 60)
            {
                int step = Math.Max(-120, Math.Min(120, left));
                Native2.PostMessage(target, Native2.WM_MOUSEWHEEL, new IntPtr(step << 16), at);
                left -= step;
                Thread.Sleep(12);
            }
        }

        private static void PostText(IntPtr target, string text)
        {
            foreach (char c in text)
            {
                char send = c == '\n' ? '\r' : c;
                Native2.PostMessage(target, Native2.WM_CHAR, new IntPtr(send), new IntPtr(1));
                Thread.Sleep(4);
            }
        }

        private static readonly Dictionary<string, int> ActKeys = BuildActKeys();

        private static Dictionary<string, int> BuildActKeys()
        {
            Dictionary<string, int> map = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            map["Escape"] = 0x1B; map["Esc"] = 0x1B; map["Enter"] = 0x0D; map["Return"] = 0x0D; map["Tab"] = 0x09; map["Space"] = 0x20; map["Backspace"] = 0x08; map["Delete"] = 0x2E; map["Insert"] = 0x2D;
            map["ArrowLeft"] = 0x25; map["ArrowUp"] = 0x26; map["ArrowRight"] = 0x27; map["ArrowDown"] = 0x28; map["Left"] = 0x25; map["Up"] = 0x26; map["Right"] = 0x27; map["Down"] = 0x28;
            map["PageUp"] = 0x21; map["PageDown"] = 0x22; map["End"] = 0x23; map["Home"] = 0x24;
            for (int i = 1; i <= 12; i++) map["F" + i] = 0x6F + i;
            return map;
        }

        private static bool ExtendedKey(int vk)
        {
            return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E;
        }

        /** "ctrl+shift+s" -> modifiers and one key. False when the key has no name here. */
        private static bool ParseKey(string combo, out int vk, out bool ctrl, out bool alt, out bool shift)
        {
            vk = 0; ctrl = alt = shift = false;
            string[] parts = (combo ?? "").Split('+');
            for (int i = 0; i < parts.Length; i++)
            {
                string part = parts[i].Trim();
                if (part.Length == 0) continue;
                string lower = part.ToLowerInvariant();
                if (lower == "ctrl" || lower == "control") { ctrl = true; continue; }
                if (lower == "alt") { alt = true; continue; }
                if (lower == "shift") { shift = true; continue; }
                int code;
                if (ActKeys.TryGetValue(part, out code)) { vk = code; continue; }
                if (part.Length == 1)
                {
                    char c = char.ToUpperInvariant(part[0]);
                    if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) { vk = c; continue; }
                    short scan = Native2.VkKeyScan(part[0]);
                    if (scan != -1) { vk = scan & 0xFF; continue; }
                }
                return false;
            }
            return vk != 0;
        }

        private static IntPtr KeyLParam(int vk, bool up, bool alt)
        {
            uint scan = Native2.MapVirtualKey((uint)vk, 0);
            uint value = 1 | (scan << 16);
            if (ExtendedKey(vk)) value |= 1u << 24;
            if (alt) value |= 1u << 29;
            if (up) value |= (1u << 30) | (1u << 31);
            return new IntPtr(unchecked((int)value));
        }

        /**
         * Posts one key, with modifiers. A program asks Windows which modifiers are held (GetKeyState), and a posted
         * key does not change that. So for a key with Ctrl, Alt or Shift this thread joins the TARGET thread's input
         * for the moment of the key and marks the modifiers held in that queue only. It never does so when the target
         * has the person's keyboard (his own held keys live in that queue): then the plain posts go alone.
         */
        private static string PostKey(IntPtr target, int vk, bool ctrl, bool alt, bool shift)
        {
            uint pid;
            uint theirs = Native.GetWindowThreadProcessId(target, out pid);
            uint me = Native.GetCurrentThreadId();
            bool mods = ctrl || alt || shift;
            IntPtr fg = Native.GetForegroundWindow();
            uint fgThread = fg == IntPtr.Zero ? 0 : Native.GetWindowThreadProcessId(fg, out pid);
            bool hisKeyboard = fgThread == theirs;
            bool joined = false;
            byte[] saved = null;
            string how = "post:key";
            try
            {
                if (mods && !hisKeyboard && theirs != 0 && theirs != me && Native.AttachThreadInput(me, theirs, true))
                {
                    joined = true;
                    saved = new byte[256];
                    Native2.GetKeyboardState(saved);
                    byte[] held = (byte[])saved.Clone();
                    if (ctrl) { held[0x11] = 0x80; held[0xA2] = 0x80; }
                    if (alt) { held[0x12] = 0x80; held[0xA4] = 0x80; }
                    if (shift) { held[0x10] = 0x80; held[0xA0] = 0x80; }
                    Native2.SetKeyboardState(held);
                    how = "post:key+state";
                }
                uint down = alt && !ctrl ? Native2.WM_SYSKEYDOWN : Native2.WM_KEYDOWN;
                uint up = alt && !ctrl ? Native2.WM_SYSKEYUP : Native2.WM_KEYUP;
                if (ctrl) Native2.PostMessage(target, Native2.WM_KEYDOWN, new IntPtr(0x11), KeyLParam(0x11, false, false));
                if (shift) Native2.PostMessage(target, Native2.WM_KEYDOWN, new IntPtr(0x10), KeyLParam(0x10, false, false));
                if (alt) Native2.PostMessage(target, Native2.WM_SYSKEYDOWN, new IntPtr(0x12), KeyLParam(0x12, false, true));
                Native2.PostMessage(target, down, new IntPtr(vk), KeyLParam(vk, false, alt));
                // A plain key that types (Enter, Tab, Backspace, Escape, Space) is also a character to most programs.
                if (!mods && (vk == 0x0D || vk == 0x09 || vk == 0x08 || vk == 0x1B || vk == 0x20)) Native2.PostMessage(target, Native2.WM_CHAR, new IntPtr(vk), KeyLParam(vk, false, false));
                Thread.Sleep(30);
                Native2.PostMessage(target, up, new IntPtr(vk), KeyLParam(vk, true, alt));
                if (alt) Native2.PostMessage(target, Native2.WM_KEYUP, new IntPtr(0x12), KeyLParam(0x12, true, false));
                if (shift) Native2.PostMessage(target, Native2.WM_KEYUP, new IntPtr(0x10), KeyLParam(0x10, true, false));
                if (ctrl) Native2.PostMessage(target, Native2.WM_KEYUP, new IntPtr(0x11), KeyLParam(0x11, true, false));
                // The target reads the held modifiers when it takes the key from its queue: give it that long.
                if (joined) Thread.Sleep(120);
            }
            finally
            {
                if (joined)
                {
                    if (saved != null) Native2.SetKeyboardState(saved);
                    Native.AttachThreadInput(me, theirs, false);
                }
            }
            return how;
        }

        /** The window inside `top` that has that program's keyboard focus (its own, not the person's), else `top`. */
        private static IntPtr FocusOf(IntPtr top)
        {
            uint pid;
            uint thread = Native.GetWindowThreadProcessId(top, out pid);
            Native2.GUITHREADINFO info = new Native2.GUITHREADINFO();
            info.cbSize = Marshal.SizeOf(typeof(Native2.GUITHREADINFO));
            if (Native2.GetGUIThreadInfo(thread, ref info) && info.hwndFocus != IntPtr.Zero && Native.GetAncestor(info.hwndFocus, Native.GA_ROOT) == top) return info.hwndFocus;
            return top;
        }

        // ---- the ladder ----

        private delegate void Step();

        /** Runs a UI Automation call that may not come back (a button that opens a modal dialog returns only when it closes). */
        private static string Call(Step step, int timeoutMs)
        {
            Exception failed = null;
            Task task = Task.Factory.StartNew(delegate () { try { step(); } catch (Exception e) { failed = e; } }, TaskCreationOptions.LongRunning);
            if (!task.Wait(timeoutMs)) return "still running";
            return failed == null ? null : failed.GetType().Name;
        }

        private sealed class ActRun
        {
            public IntPtr Hwnd;
            public uint Pid;
            public int WaitMs;
            public HashSet<string> Only;
            public HashSet<string> Avoid = new HashSet<string>();
            public volatile string Trying;
            public List<Tried> Tried = new List<Tried>();
            public string Rung, Evidence;

            public bool Allowed(string family)
            {
                return Only == null || Only.Count == 0 || Only.Contains(family);
            }
        }

        /** One rung: do it, look for the effect. True when the effect was seen. */
        private static bool Attempt(ActRun run, string rung, IUIAutomationElement watch, Step step)
        {
            if (run.Avoid.Contains(rung)) { run.Tried.Add(new Tried(rung, "skipped (it took his window focus on this program before)")); return false; }
            run.Trying = rung;
            Snap before = Before(run.Hwnd, run.Pid, watch, true);
            string problem = Call(step, 1500);
            if (problem != null && problem != "still running")
            {
                run.Tried.Add(new Tried(rung, "refused (" + problem + ")"));
                return false;
            }
            string evidence = Changed(run.Hwnd, run.Pid, watch, before, run.WaitMs);
            if (evidence == null)
            {
                run.Tried.Add(new Tried(rung, "sent, nothing changed"));
                return false;
            }
            run.Tried.Add(new Tried(rung, "worked (" + evidence + ")"));
            run.Rung = rung;
            run.Evidence = evidence;
            return true;
        }

        private static bool ClassicEdit(IntPtr hwnd)
        {
            string cls = ClassOf(hwnd);
            return cls == "Edit" || cls.StartsWith("RichEdit", StringComparison.OrdinalIgnoreCase) || cls == "TEdit" || cls == "TMemo" || cls.StartsWith("WindowsForms10.EDIT", StringComparison.OrdinalIgnoreCase);
        }

        private static string Act(Dictionary<string, object> req)
        {
            IntPtr hwnd = Hwnd(req);
            IntPtr root = Native.GetAncestor(hwnd, Native.GA_ROOT);
            if (root != IntPtr.Zero) hwnd = root;
            uint pid;
            Native.GetWindowThreadProcessId(hwnd, out pid);
            int wantPid = J.Int(req, "pid", 0);
            // The handle must still be the window that was read: a closed window's number can be given to a new one.
            if (wantPid != 0 && (uint)wantPid != pid) throw new OpError("no_window", "That window is closed (its number now belongs to another program). List the windows again.");
            if (IsExcluded(hwnd)) throw new OpError("own_window", "That is one of this app's own windows. Use the app's own tools for it.");
            string action = (J.Get(req, "action") ?? "click").ToLowerInvariant();
            string text = J.Get(req, "text") ?? "";
            string code;
            string blocked = NeedsOwnDesktop(hwnd, req, out code);
            if (blocked != null) throw new OpError(code, blocked + " It needs the agent's own desktop.");
            bool hasPoint = req.ContainsKey("x") && req.ContainsKey("y");
            if (Native.IsIconic(hwnd) && (hasPoint || action == "double_click" || action == "right_click")) throw new OpError("minimised", "That window is minimised, so nothing in it has a place to click. Act on an element by name, or ask him to restore it.");

            Native.POINT cursorBefore;
            Native2.GetCursorPos(out cursorBefore);
            IntPtr fgBefore = Native.GetForegroundWindow();

            ActRun run = new ActRun();
            FocusGuard guard = !J.Bool(req, "guard", true) || fgBefore == IntPtr.Zero || Native.GetAncestor(fgBefore, Native.GA_ROOT) == hwnd ? null : new FocusGuard(fgBefore, pid, run);
            try { return ActInner(req, run, guard, hwnd, pid, fgBefore, cursorBefore, action, text); }
            finally { if (guard != null) guard.Finish(); }
        }

        private static string ActInner(Dictionary<string, object> req, ActRun run, FocusGuard guard, IntPtr hwnd, uint pid, IntPtr fgBefore, Native.POINT cursorBefore, string action, string text)
        {
            bool hasPoint = req.ContainsKey("x") && req.ContainsKey("y");
            run.Hwnd = hwnd;
            run.Pid = pid;
            run.WaitMs = Math.Max(100, Math.Min(5000, J.Int(req, "waitMs", 900)));
            object avoid;
            if (req.TryGetValue("avoid", out avoid) && avoid is object[])
            {
                foreach (object item in (object[])avoid) if (item is string) run.Avoid.Add(((string)item).ToLowerInvariant());
            }
            object only;
            if (req.TryGetValue("rungs", out only) && only is object[])
            {
                run.Only = new HashSet<string>();
                foreach (object item in (object[])only) if (item is string) run.Only.Add(((string)item).ToLowerInvariant());
            }

            string problem;
            IUIAutomationElement element = ElementOf(req, hwnd, out problem);
            if (problem != null) throw new OpError("no_element", problem);
            Native.RECT frame = FrameOf(hwnd);
            int sx = 0, sy = 0;
            if (hasPoint)
            {
                // Window coordinates: pixels from the top left of the window as screen_read pictures it.
                sx = frame.Left + J.Int(req, "x", 0);
                sy = frame.Top + J.Int(req, "y", 0);
                if (sx < frame.Left || sy < frame.Top || sx >= frame.Right || sy >= frame.Bottom) throw new OpError("bad_request", "That point is outside the window (" + (frame.Right - frame.Left) + " x " + (frame.Bottom - frame.Top) + " pixels).");
                if (element == null && run.Allowed("uia")) element = ElementAt(hwnd, sx, sy);
            }
            int ex = 0, ey = 0, ew = 0, eh = 0;
            bool placed = element != null && RectOf(element, out ex, out ey, out ew, out eh);
            if (!hasPoint && placed) { sx = ex + ew / 2; sy = ey + eh / 2; }
            bool anywhere = !hasPoint && !placed;
            if (anywhere) { sx = (frame.Left + frame.Right) / 2; sy = (frame.Top + frame.Bottom) / 2; }
            if (element != null)
            {
                bool enabled = true;
                try { enabled = element.CurrentIsEnabled != 0; } catch (Exception) { }
                if (!enabled && action != "scroll") throw new OpError("disabled", "That control is disabled (greyed out) right now.");
            }
            bool named = !string.IsNullOrEmpty(J.Get(req, "node")) || !string.IsNullOrEmpty(J.Get(req, "name"));
            IntPtr child = element != null && !hasPoint ? HwndOfElement(element, hwnd) : ChildAt(hwnd, sx, sy);
            if (child == IntPtr.Zero) child = hwnd;
            bool done = false;
            string note = null;

            switch (action)
            {
                case "click":
                    {
                        if (element != null && run.Allowed("uia"))
                        {
                            int type = 0;
                            try { type = element.CurrentControlType; } catch (Exception) { }
                            IUIAutomationInvokePattern invoke = Pattern(element, PatInvoke) as IUIAutomationInvokePattern;
                            IUIAutomationTogglePattern toggle = Pattern(element, PatToggle) as IUIAutomationTogglePattern;
                            IUIAutomationSelectionItemPattern item = Pattern(element, PatSelectionItem) as IUIAutomationSelectionItemPattern;
                            IUIAutomationExpandCollapsePattern expand = Pattern(element, PatExpand) as IUIAutomationExpandCollapsePattern;
                            IUIAutomationLegacyIAccessiblePattern legacy = Pattern(element, PatLegacy) as IUIAutomationLegacyIAccessiblePattern;
                            bool pickFirst = type == TTabItem || type == TListItem || type == TRadioButton || type == TTreeItem || type == TDataItem;
                            if (!done && toggle != null && (type == TCheckBox || invoke == null)) done = Attempt(run, "uia:toggle", element, delegate () { toggle.Toggle(); });
                            if (!done && item != null && pickFirst) done = Attempt(run, "uia:select", element, delegate () { item.Select(); });
                            if (!done && invoke != null) done = Attempt(run, "uia:invoke", element, delegate () { invoke.Invoke(); });
                            if (!done && item != null && !pickFirst) done = Attempt(run, "uia:select", element, delegate () { item.Select(); });
                            if (!done && expand != null) done = Attempt(run, "uia:expand", element, delegate ()
                            {
                                if (expand.CurrentExpandCollapseState == ExpandCollapseState.ExpandCollapseState_Collapsed) expand.Expand(); else expand.Collapse();
                            });
                            if (!done && legacy != null) done = Attempt(run, "uia:default", element, delegate () { legacy.DoDefaultAction(); });
                        }
                        if (!done && run.Allowed("post") && !anywhere) done = Attempt(run, "post:mouse", element, delegate () { PostMouse(child, sx, sy, "click"); });
                        break;
                    }
                case "double_click":
                    {
                        if (anywhere) throw new OpError("bad_request", "Say what to double click: an element, or x and y.");
                        if (run.Allowed("post")) done = Attempt(run, "post:mouse", element, delegate () { PostMouse(child, sx, sy, "double_click"); });
                        break;
                    }
                case "right_click":
                    {
                        if (anywhere) throw new OpError("bad_request", "Say what to right click: an element, or x and y.");
                        IUIAutomationElement3 three = element as IUIAutomationElement3;
                        if (three != null && named && run.Allowed("uia")) done = Attempt(run, "uia:contextmenu", element, delegate () { three.ShowContextMenu(); });
                        if (!done && run.Allowed("post")) done = Attempt(run, "post:mouse", element, delegate () { PostMouse(child, sx, sy, "right_click"); });
                        if (!done && run.Allowed("post")) done = Attempt(run, "post:contextmenu", element, delegate () { Native2.PostMessage(child, Native2.WM_CONTEXTMENU, child, MakeLParam(sx, sy)); });
                        break;
                    }
                case "type":
                case "set_value":
                    {
                        bool append = J.Bool(req, "append", false);
                        IntPtr edit = element != null || hasPoint ? child : FocusOf(hwnd);
                        // A program that is not in front is reached by a window message first: the value pattern can bring it to the front.
                        IntPtr frontNow = Native.GetForegroundWindow();
                        bool inFront = frontNow != IntPtr.Zero && Native.GetAncestor(frontNow, Native.GA_ROOT) == hwnd;
                        bool msgFirst = !inFront && ClassicEdit(edit) && run.Allowed("msg");
                        for (int pass = 0; pass < 2 && !done; pass++)
                        {
                            if (pass == (msgFirst ? 1 : 0))
                            {
                        if (element != null && run.Allowed("uia"))
                        {
                            IUIAutomationValuePattern value = Pattern(element, PatValue) as IUIAutomationValuePattern;
                            bool readOnly = false;
                            try { readOnly = value != null && value.CurrentIsReadOnly != 0; } catch (Exception) { }
                            if (value != null && !readOnly)
                            {
                                string next = text;
                                if (append && !IsPassword(element)) { try { next = (value.CurrentValue ?? "") + text; } catch (Exception) { } }
                                done = Attempt(run, "uia:value", element, delegate () { value.SetValue(next); });
                            }
                            if (!done && action == "set_value")
                            {
                                IUIAutomationRangeValuePattern range = Pattern(element, PatRangeValue) as IUIAutomationRangeValuePattern;
                                double number;
                                if (range != null && double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out number)) done = Attempt(run, "uia:range", element, delegate () { range.SetValue(number); });
                            }
                        }
                            }
                            else
                            {
                        if (!done && run.Allowed("msg") && ClassicEdit(edit))
                        {
                            IntPtr result;
                            if (append)
                            {
                                done = Attempt(run, "msg:replacesel", element, delegate ()
                                {
                                    Native.SendMessageTimeout(edit, Native2.EM_SETSEL, new IntPtr(0x7FFFFFFF), new IntPtr(0x7FFFFFFF), 2, 1000, out result);
                                    Native2.SendMessageTimeoutText(edit, Native2.EM_REPLACESEL, new IntPtr(1), text, 2, 1500, out result);
                                });
                            }
                            else done = Attempt(run, "msg:settext", element, delegate () { Native2.SendMessageTimeoutText(edit, Native2.WM_SETTEXT, IntPtr.Zero, text, 2, 1500, out result); });
                        }
                            }
                        }
                        if (!done && run.Allowed("post") && action == "type")
                        {
                            // Characters go where that program's own caret is. A field that was named is clicked first so the caret is in it.
                            if (element != null || hasPoint) { PostMouse(child, sx, sy, "click"); Thread.Sleep(80); }
                            IntPtr target = element != null || hasPoint ? child : FocusOf(hwnd);
                            done = Attempt(run, "post:char", element, delegate () { PostText(target, text); });
                            if (done && !append) note = "Typed at the caret: what was already in the field was not cleared (only the element's own value pattern can replace it).";
                        }
                        break;
                    }
                case "toggle":
                    {
                        if (element == null) throw new OpError("bad_request", "Say which control to toggle (name or node).");
                        IUIAutomationTogglePattern toggle = Pattern(element, PatToggle) as IUIAutomationTogglePattern;
                        string want = (J.Get(req, "state") ?? "").ToLowerInvariant();
                        if (toggle != null && run.Allowed("uia"))
                        {
                            bool on = false;
                            try { on = toggle.CurrentToggleState == ToggleState.ToggleState_On; } catch (Exception) { }
                            if ((want == "on" && on) || (want == "off" && !on)) { run.Rung = "uia:toggle"; run.Evidence = "already " + want; run.Tried.Add(new Tried("uia:toggle", "already " + want)); done = true; }
                            else done = Attempt(run, "uia:toggle", element, delegate () { toggle.Toggle(); });
                        }
                        if (!done && run.Allowed("post") && placed) done = Attempt(run, "post:mouse", element, delegate () { PostMouse(child, sx, sy, "click"); });
                        break;
                    }
                case "select":
                    {
                        if (element == null) throw new OpError("bad_request", "Say what to select (name or node).");
                        IUIAutomationElement pick = element;
                        if (text.Length > 0 && run.Allowed("uia"))
                        {
                            // A list or combo box and the name of the item in it.
                            IUIAutomationExpandCollapsePattern open = Pattern(element, PatExpand) as IUIAutomationExpandCollapsePattern;
                            if (open != null) { Call(delegate () { open.Expand(); }, 1200); Thread.Sleep(150); }
                            IUIAutomationCondition byName = Uia().CreatePropertyConditionEx(PName, text, PropertyConditionFlags.PropertyConditionFlags_IgnoreCase);
                            IUIAutomationElement found = null;
                            try { found = element.FindFirst(TreeScope.TreeScope_Descendants, byName); } catch (Exception) { }
                            if (found == null) { try { found = Uia().ElementFromHandle(hwnd).FindFirst(TreeScope.TreeScope_Descendants, byName); } catch (Exception) { } }
                            if (found == null)
                            {
                                if (open != null) Call(delegate () { open.Collapse(); }, 1200);
                                throw new OpError("no_element", "Nothing called \"" + text + "\" is in that list.");
                            }
                            pick = found;
                            IUIAutomationSelectionItemPattern chosen = Pattern(pick, PatSelectionItem) as IUIAutomationSelectionItemPattern;
                            if (chosen != null) done = Attempt(run, "uia:select", pick, delegate () { chosen.Select(); });
                            if (!done)
                            {
                                IUIAutomationInvokePattern press = Pattern(pick, PatInvoke) as IUIAutomationInvokePattern;
                                if (press != null) done = Attempt(run, "uia:invoke", element, delegate () { press.Invoke(); });
                            }
                            if (open != null) Call(delegate () { try { if (open.CurrentExpandCollapseState != ExpandCollapseState.ExpandCollapseState_Collapsed) open.Collapse(); } catch (Exception) { } }, 1200);
                        }
                        else if (run.Allowed("uia"))
                        {
                            IUIAutomationSelectionItemPattern item = Pattern(element, PatSelectionItem) as IUIAutomationSelectionItemPattern;
                            if (item != null) done = Attempt(run, "uia:select", element, delegate () { item.Select(); });
                        }
                        if (!done && run.Allowed("post") && RectOf(pick, out ex, out ey, out ew, out eh))
                        {
                            int px = ex + ew / 2, py = ey + eh / 2;
                            IntPtr at = HwndOfElement(pick, hwnd);
                            done = Attempt(run, "post:mouse", element, delegate () { PostMouse(at, px, py, "click"); });
                        }
                        break;
                    }
                case "expand":
                case "collapse":
                    {
                        if (element == null) throw new OpError("bad_request", "Say what to " + action + " (name or node).");
                        IUIAutomationExpandCollapsePattern expand = Pattern(element, PatExpand) as IUIAutomationExpandCollapsePattern;
                        if (expand != null && run.Allowed("uia"))
                        {
                            bool open = false;
                            try { open = expand.CurrentExpandCollapseState != ExpandCollapseState.ExpandCollapseState_Collapsed; } catch (Exception) { }
                            if (open == (action == "expand")) { run.Rung = "uia:expand"; run.Evidence = "already " + (open ? "open" : "closed"); run.Tried.Add(new Tried("uia:expand", run.Evidence)); done = true; }
                            else done = Attempt(run, "uia:expand", element, delegate () { if (action == "expand") expand.Expand(); else expand.Collapse(); });
                        }
                        if (!done && run.Allowed("post") && placed) done = Attempt(run, "post:mouse", element, delegate () { PostMouse(child, sx, sy, "click"); });
                        break;
                    }
                case "scroll":
                    {
                        int dy = J.Int(req, "dy", 300);
                        if (dy == 0) dy = 300;
                        IUIAutomationElement scroller = null;
                        IUIAutomationScrollPattern pattern = null;
                        if (run.Allowed("uia"))
                        {
                            try
                            {
                                IUIAutomationTreeWalker walker = Uia().ControlViewWalker;
                                IUIAutomationElement at = element ?? ElementAt(hwnd, sx, sy);
                                for (int i = 0; i < 30 && at != null && pattern == null; i++)
                                {
                                    IUIAutomationScrollPattern candidate = Pattern(at, PatScroll) as IUIAutomationScrollPattern;
                                    if (candidate != null && candidate.CurrentVerticallyScrollable != 0) { pattern = candidate; scroller = at; }
                                    else at = walker.GetParentElement(at);
                                }
                            }
                            catch (Exception) { }
                        }
                        if (pattern != null)
                        {
                            done = Attempt(run, "uia:scroll", scroller, delegate ()
                            {
                                int big = Math.Abs(dy) / 500, small = (Math.Abs(dy) % 500) / 40;
                                if (big == 0 && small == 0) small = 1;
                                for (int i = 0; i < Math.Min(big, 40); i++) pattern.Scroll(ScrollAmount.ScrollAmount_NoAmount, dy > 0 ? ScrollAmount.ScrollAmount_LargeIncrement : ScrollAmount.ScrollAmount_LargeDecrement);
                                for (int i = 0; i < Math.Min(small, 40); i++) pattern.Scroll(ScrollAmount.ScrollAmount_NoAmount, dy > 0 ? ScrollAmount.ScrollAmount_SmallIncrement : ScrollAmount.ScrollAmount_SmallDecrement);
                            });
                        }
                        if (!done && run.Allowed("post")) done = Attempt(run, "post:wheel", scroller ?? element, delegate () { PostWheel(child, sx, sy, dy); });
                        break;
                    }
                case "key":
                    {
                        int vk; bool ctrl, alt, shift;
                        string combo = J.Get(req, "key") ?? text;
                        if (!ParseKey(combo, out vk, out ctrl, out alt, out shift)) throw new OpError("bad_request", "That key has no name here: use Enter, Tab, Escape, Backspace, Delete, the arrows, PageUp, PageDown, Home, End, F1 to F12, or a letter or digit, with ctrl+, alt+ or shift+ before it.");
                        IntPtr target = named || hasPoint ? child : FocusOf(hwnd);
                        if (run.Allowed("post"))
                        {
                            string how = "post:key";
                            done = Attempt(run, "post:key", named ? element : null, delegate () { how = PostKey(target, vk, ctrl, alt, shift); });
                            if (run.Tried.Count > 0) run.Tried[run.Tried.Count - 1].Rung = how;
                            if (done) run.Rung = how;
                        }
                        break;
                    }
                default:
                    throw new OpError("bad_request", "Unknown action: " + action + ". Use click, double_click, right_click, type, set_value, toggle, select, expand, collapse, scroll or key.");
            }

            // His pointer and his window: read again, and his window gets the keyboard back if the target took it.
            Native.POINT cursorAfter;
            Native2.GetCursorPos(out cursorAfter);
            IntPtr fgAfter = Native.GetForegroundWindow();
            bool took = false, gaveBack = false;
            int times = 0; long lostMs = 0; string tookOn = null;
            if (guard != null)
            {
                guard.Finish();
                times = guard.Taken; lostMs = guard.LostMs; tookOn = guard.TookOn;
                if (times > 0)
                {
                    took = true;
                    gaveBack = guard.Restored > 0;
                    fgAfter = Native.GetForegroundWindow();
                    for (int again = 0; again < 6 && !gaveBack && Native.IsWindow(fgBefore) && fgAfter != fgBefore && fgAfter != IntPtr.Zero; again++)
                    {
                        gaveBack = GiveBack(fgBefore, fgAfter);
                        Thread.Sleep(40);
                        fgAfter = Native.GetForegroundWindow();
                        gaveBack = fgAfter == fgBefore;
                    }
                }
            }
            if (!took && fgAfter != fgBefore && fgBefore != IntPtr.Zero && fgAfter != IntPtr.Zero)
            {
                uint nowPid;
                Native.GetWindowThreadProcessId(fgAfter, out nowPid);
                if (nowPid == pid && Native.IsWindow(fgBefore))
                {
                    took = true;
                    gaveBack = GiveBack(fgBefore, fgAfter);
                    fgAfter = Native.GetForegroundWindow();
                }
            }

            StringBuilder sb = new StringBuilder(512);
            sb.Append("{\"ok\":").Append(done ? "true" : "false");
            if (done) { sb.Append(",\"rung\":\"").Append(run.Rung).Append("\",\"evidence\":"); J.Str(sb, run.Evidence); }
            else { sb.Append(",\"reason\":\"").Append(run.Tried.Count == 0 ? "no_way" : "ignored").Append('"'); }
            sb.Append(",\"action\":\"").Append(action).Append("\",\"tried\":[");
            for (int i = 0; i < run.Tried.Count; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append("{\"rung\":\"").Append(run.Tried[i].Rung).Append("\",\"result\":");
                J.Str(sb, run.Tried[i].Result);
                sb.Append('}');
            }
            sb.Append("],\"point\":{\"x\":").Append(sx).Append(",\"y\":").Append(sy).Append('}');
            if (placed) { sb.Append(",\"rect\":"); J.Rect(sb, ex, ey, ew, eh); }
            if (element != null)
            {
                string name = "";
                try { name = element.CurrentName ?? ""; } catch (Exception) { }
                sb.Append(",\"element\":");
                J.Str(sb, name.Length > 120 ? name.Substring(0, 120) : name);
                string now = TextOf(element);
                if (now != null) { sb.Append(",\"value\":"); J.Str(sb, now.Length > 400 ? now.Substring(0, 400) : now); }
            }
            if (note != null) { sb.Append(",\"note\":"); J.Str(sb, note); }
            sb.Append(",\"cursor\":{\"before\":{\"x\":").Append(cursorBefore.X).Append(",\"y\":").Append(cursorBefore.Y).Append("},\"after\":{\"x\":").Append(cursorAfter.X).Append(",\"y\":").Append(cursorAfter.Y).Append("}}");
            sb.Append(",\"foreground\":{\"before\":\"").Append(HwndText(fgBefore)).Append("\",\"after\":\"").Append(HwndText(fgAfter)).Append("\",\"taken\":").Append(took ? "true" : "false")
                .Append(",\"givenBack\":").Append(gaveBack ? "true" : "false").Append(",\"times\":").Append(times).Append(",\"lostMs\":").Append(lostMs);
            if (tookOn != null) { sb.Append(",\"tookOn\":"); J.Str(sb, tookOn); }
            sb.Append("}}");
            return sb.ToString();
        }

        /**
         * Watches the foreground window while one action runs (and 180 ms after). The moment the target's own program takes the
         * keyboard from the window he was in, that window gets it back, and the rung that did it is named so the caller
         * never uses it on that program again. It stands down if he touches the mouse or keyboard himself.
         */
        private sealed class FocusGuard
        {
            public int Taken, Restored;
            public long LostMs;
            public string TookOn;
            private readonly IntPtr his;
            private readonly uint targetPid;
            private readonly ActRun run;
            private readonly uint startInput;
            private readonly Thread thread;
            private volatile bool stop;

            public FocusGuard(IntPtr his, uint targetPid, ActRun run)
            {
                this.his = his; this.targetPid = targetPid; this.run = run;
                startInput = LastInput();
                thread = new Thread(Loop);
                thread.IsBackground = true;
                thread.Start();
            }

            private static uint LastInput()
            {
                Native.LASTINPUTINFO last = new Native.LASTINPUTINFO();
                last.cbSize = (uint)Marshal.SizeOf(typeof(Native.LASTINPUTINFO));
                return Native.GetLastInputInfo(ref last) ? last.dwTime : 0;
            }

            private void Loop()
            {
                Stopwatch lost = new Stopwatch();
                Stopwatch tail = null;
                for (;;)
                {
                    if (stop && tail == null) tail = Stopwatch.StartNew();
                    if (tail != null && tail.ElapsedMilliseconds > 180) break;
                    IntPtr fg = Native.GetForegroundWindow();
                    if (fg != his && fg != IntPtr.Zero && Native.IsWindow(his))
                    {
                        uint pid;
                        Native.GetWindowThreadProcessId(fg, out pid);
                        if (pid == targetPid && LastInput() == startInput)
                        {
                            if (!lost.IsRunning) { lost.Restart(); Taken++; if (TookOn == null) TookOn = run.Trying; }
                            if (GiveBack(his, fg)) { Restored++; LostMs += lost.ElapsedMilliseconds; lost.Reset(); }
                            else Thread.Sleep(30); // hammering a program that is still activating makes it worse (seen on Calculator)
                        }
                    }
                    Thread.Sleep(3);
                }
                if (lost.IsRunning) LostMs += lost.ElapsedMilliseconds;
            }

            public void Finish()
            {
                stop = true;
                thread.Join(1500);
            }
        }

        /** The target brought itself to the front because of what was sent: the window he was in gets the keyboard back. */
        private static bool GiveBack(IntPtr his, IntPtr taker)
        {
            return GiveBackOnce(his, taker, false) || GiveBackOnce(his, taker, true);
        }

        /** both = join the input of his window as well as the taker's (some programs only let go then). */
        private static bool GiveBackOnce(IntPtr his, IntPtr taker, bool both)
        {
            if (both)
            {
                uint pidB;
                uint takerThread = Native.GetWindowThreadProcessId(taker, out pidB);
                uint hisThread = Native.GetWindowThreadProcessId(his, out pidB);
                uint meB = Native.GetCurrentThreadId();
                bool a = takerThread != 0 && takerThread != meB && Native.AttachThreadInput(meB, takerThread, true);
                bool b = hisThread != 0 && hisThread != meB && hisThread != takerThread && Native.AttachThreadInput(meB, hisThread, true);
                try { Native.BringWindowToTop(his); Native.SetForegroundWindow(his); }
                finally { if (b) Native.AttachThreadInput(meB, hisThread, false); if (a) Native.AttachThreadInput(meB, takerThread, false); }
                return Native.GetForegroundWindow() == his;
            }
            uint pid;
            uint owner = Native.GetWindowThreadProcessId(taker, out pid);
            uint me = Native.GetCurrentThreadId();
            bool joined = owner != 0 && owner != me && Native.AttachThreadInput(me, owner, true);
            try { Native.SetForegroundWindow(his); }
            finally { if (joined) Native.AttachThreadInput(me, owner, false); }
            return Native.GetForegroundWindow() == his;
        }

        // ---- the person's own activity, and real input as the last resort ----

        public static volatile bool Injecting;
        public static volatile bool InjectAbort;

        /** His pointer and his window right now: what a proof compares before and after. */
        private static string Presence()
        {
            Native.POINT cursor;
            Native2.GetCursorPos(out cursor);
            IntPtr fg = Native.GetForegroundWindow();
            Native.LASTINPUTINFO last = new Native.LASTINPUTINFO();
            last.cbSize = (uint)Marshal.SizeOf(typeof(Native.LASTINPUTINFO));
            long idle = -1;
            if (Native.GetLastInputInfo(ref last)) idle = unchecked((uint)Environment.TickCount - last.dwTime);
            return "{\"cursor\":{\"x\":" + cursor.X + ",\"y\":" + cursor.Y + "},\"foreground\":\"" + HwndText(fg) + "\",\"idleMs\":" + idle + "}";
        }

        private static Native2.INPUT MouseInput(uint flags, int data)
        {
            Native2.INPUT input = new Native2.INPUT();
            input.type = 0;
            input.u.mi.dwFlags = flags;
            input.u.mi.mouseData = unchecked((uint)data);
            return input;
        }

        private static Native2.INPUT KeyInput(ushort vk, ushort scan, uint flags)
        {
            Native2.INPUT input = new Native2.INPUT();
            input.type = 1;
            input.u.ki.wVk = vk;
            input.u.ki.wScan = scan;
            input.u.ki.dwFlags = flags;
            return input;
        }

        private static void Send(params Native2.INPUT[] inputs)
        {
            Native2.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Native2.INPUT)));
        }

        /**
         * Real input, the last resort. Only the app's input lock asks for this, after telling him. It checks for itself
         * that he has been idle, watches for any mouse or key event that is not its own and stops at once when one
         * comes, and puts his pointer and his window back whether it finished or not.
         */
        private static string Inject(Dictionary<string, object> req)
        {
            IntPtr hwnd = Hwnd(req);
            uint pid;
            Native.GetWindowThreadProcessId(hwnd, out pid);
            int wantPid = J.Int(req, "pid", 0);
            if (wantPid == 0 || (uint)wantPid != pid) throw new OpError("no_window", "Real input needs the window and its process id, and they must still match.");
            if (IsExcluded(hwnd)) throw new OpError("own_window", "That is one of this app's own windows.");
            int minIdle = Math.Max(1000, J.Int(req, "minIdleMs", 10000));
            Native.LASTINPUTINFO last = new Native.LASTINPUTINFO();
            last.cbSize = (uint)Marshal.SizeOf(typeof(Native.LASTINPUTINFO));
            long idle = 0;
            if (Native.GetLastInputInfo(ref last)) idle = unchecked((uint)Environment.TickCount - last.dwTime);
            if (idle < minIdle) throw new OpError("busy", "He touched the mouse or keyboard " + idle + " ms ago. Real input waits until he has been idle for " + minIdle + " ms.");
            object raw;
            if (!req.TryGetValue("steps", out raw) || !(raw is object[]) || ((object[])raw).Length == 0) throw new OpError("bad_request", "No steps.");
            object[] steps = (object[])raw;
            bool ownHooks = !Hooks.Running;
            if (ownHooks) Hooks.Start(new List<string>(), false);
            Native.POINT cursorBefore;
            Native2.GetCursorPos(out cursorBefore);
            IntPtr fgBefore = Native.GetForegroundWindow();
            Native.RECT frame = FrameOf(hwnd);
            int done = 0;
            string stopped = null;
            InjectAbort = false;
            Injecting = true;
            try
            {
                // Real input goes to the window in front, so the target has to be in front for these few steps.
                if (fgBefore != hwnd) GiveBack(hwnd, fgBefore == IntPtr.Zero ? hwnd : fgBefore);
                Thread.Sleep(60);
                IntPtr front = Native.GetForegroundWindow();
                if (front == IntPtr.Zero || Native.GetAncestor(front, Native.GA_ROOT) != hwnd) throw new OpError("refused", "Windows did not bring that window to the front, so nothing was sent.");
                foreach (object item in steps)
                {
                    if (InjectAbort) { stopped = "he touched the mouse or keyboard"; break; }
                    // Before EVERY step: the window in front must still be the target.
                    front = Native.GetForegroundWindow();
                    if (front == IntPtr.Zero || Native.GetAncestor(front, Native.GA_ROOT) != hwnd) { stopped = "another window came to the front"; break; }
                    Dictionary<string, object> step = item as Dictionary<string, object>;
                    if (step == null) continue;
                    string kind = (J.Get(step, "do") ?? "").ToLowerInvariant();
                    if (kind == "click" || kind == "double_click" || kind == "right_click" || kind == "move")
                    {
                        Native2.SetCursorPos(frame.Left + J.Int(step, "x", 0), frame.Top + J.Int(step, "y", 0));
                        Thread.Sleep(40);
                        if (kind == "click") Send(MouseInput(0x2, 0), MouseInput(0x4, 0));
                        else if (kind == "double_click") { Send(MouseInput(0x2, 0), MouseInput(0x4, 0)); Thread.Sleep(60); Send(MouseInput(0x2, 0), MouseInput(0x4, 0)); }
                        else if (kind == "right_click") Send(MouseInput(0x8, 0), MouseInput(0x10, 0));
                    }
                    else if (kind == "scroll") Send(MouseInput(0x800, -J.Int(step, "dy", 300) * 120 / 100));
                    else if (kind == "type")
                    {
                        foreach (char c in J.Get(step, "text") ?? "")
                        {
                            if (InjectAbort) break;
                            if (c == '\n') Send(KeyInput(0x0D, 0, 0), KeyInput(0x0D, 0, 2));
                            else Send(KeyInput(0, c, 4), KeyInput(0, c, 4 | 2));
                            Thread.Sleep(6);
                        }
                    }
                    else if (kind == "key")
                    {
                        int vk; bool ctrl, alt, shift;
                        if (!ParseKey(J.Get(step, "key"), out vk, out ctrl, out alt, out shift)) throw new OpError("bad_request", "Unknown key in a step.");
                        List<Native2.INPUT> keys = new List<Native2.INPUT>();
                        if (ctrl) keys.Add(KeyInput(0x11, 0, 0));
                        if (alt) keys.Add(KeyInput(0x12, 0, 0));
                        if (shift) keys.Add(KeyInput(0x10, 0, 0));
                        keys.Add(KeyInput((ushort)vk, 0, ExtendedKey(vk) ? 1u : 0u));
                        keys.Add(KeyInput((ushort)vk, 0, 2 | (ExtendedKey(vk) ? 1u : 0u)));
                        if (shift) keys.Add(KeyInput(0x10, 0, 2));
                        if (alt) keys.Add(KeyInput(0x12, 0, 2));
                        if (ctrl) keys.Add(KeyInput(0x11, 0, 2));
                        Send(keys.ToArray());
                    }
                    else throw new OpError("bad_request", "Unknown step: " + kind);
                    done++;
                    Thread.Sleep(Math.Max(20, Math.Min(2000, J.Int(step, "waitMs", 90))));
                }
            }
            finally
            {
                // The injected events are still on their way through the hook: only then is his own input his again.
                Thread.Sleep(60);
                Injecting = false;
                if (!InjectAbort) Native2.SetCursorPos(cursorBefore.X, cursorBefore.Y);
                IntPtr now = Native.GetForegroundWindow();
                if (fgBefore != IntPtr.Zero && now != fgBefore && Native.IsWindow(fgBefore)) GiveBack(fgBefore, now == IntPtr.Zero ? fgBefore : now);
                if (ownHooks) Hooks.Stop();
            }
            if (InjectAbort && stopped == null) stopped = "he touched the mouse or keyboard";
            StringBuilder sb = new StringBuilder(160);
            sb.Append("{\"done\":").Append(done).Append(",\"of\":").Append(steps.Length).Append(",\"aborted\":").Append(stopped == null ? "false" : "true");
            if (stopped != null) { sb.Append(",\"why\":"); J.Str(sb, stopped); }
            sb.Append(",\"cursorRestored\":").Append(InjectAbort ? "false" : "true").Append(",\"foregroundRestored\":").Append(Native.GetForegroundWindow() == fgBefore ? "true" : "false").Append('}');
            return sb.ToString();
        }
    }
}
