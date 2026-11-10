// agent-screen: the Windows screen reader behind "show me how" (apps/desktop/src/main/showme/native).
//
// A long-lived helper the desktop app starts as a child. It speaks JSON lines:
//   stdin   {"id":1,"op":"find","hwnd":"0x1234","name":"Save"}
//   stdout  {"id":1,"ok":true,"ms":7,"result":{...}}    or    {"id":1,"ok":false,"code":"elevated","error":"..."}
//   stdout  {"event":"input",...}  {"event":"move",...}  {"event":"ready",...}       (not answers to a request)
//
// What it does: reads any window's controls through Windows UI Automation, finds one control's rectangle,
// follows it, captures a window or a screen area as PNG, and reports clicks and a few named keys.
//
// What it never does: click, type, block, delay or swallow input. The mouse and keyboard hooks exist only between
// {"op":"input","on":true} and {"op":"input","on":false}; they pass every event on at once, and the only keys
// that ever leave this process are the names the caller asked to watch (plus "paste" for Ctrl+V). Nothing typed
// is logged or stored. The value of a password field is never read. It exits when stdin closes or the parent dies.
//
// Every rectangle is in physical screen pixels (the process is per-monitor DPI aware, see app.manifest).
//
// Built with the C# compiler that ships with Windows (.NET Framework 4.x), so it needs nothing installed:
// see ../build.cmd. C# 5 only. UI Automation is used through its COM client (UIAutomationCore), about three times
// faster here than the managed System.Windows.Automation wrapper; the interop types are embedded in the exe.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using UIA;

namespace AgentScreen
{
    internal sealed class OpError : Exception
    {
        public readonly string Code;
        public OpError(string code, string message) : base(message) { Code = code; }
    }

    internal static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)]
        public struct POINT { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)]
        public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct MONITORINFOEX
        {
            public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
        }
        [StructLayout(LayoutKind.Sequential)]
        public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

        public delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
        public delegate void WinEventProc(IntPtr hook, uint evt, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
        public delegate bool MonitorEnumProc(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data);

        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
        [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
        [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFOEX info);
        [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);
        [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
        [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
        [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
        [DllImport("user32.dll")] public static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint thread);
        [DllImport("user32.dll")] public static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventProc proc, uint pid, uint thread, uint flags);
        [DllImport("user32.dll")] public static extern bool UnhookWinEvent(IntPtr hook);
        [DllImport("user32.dll")] public static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
        [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG msg);
        [DllImport("user32.dll")] public static extern IntPtr DispatchMessage(ref MSG msg);
        [DllImport("user32.dll")] public static extern bool PostThreadMessage(uint thread, uint msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
        [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
        [DllImport("kernel32.dll")] public static extern IntPtr GetModuleHandle(string name);
        [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref int size);
        [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr handle, uint ms);
        [DllImport("advapi32.dll")] public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll")] public static extern bool GetTokenInformation(IntPtr token, int cls, out int info, int length, out int returned);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT value, int size);
        [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] public static extern int DwmGetWindowAttributeInt(IntPtr hwnd, int attr, out int value, int size);
        [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint dpiX, out uint dpiY);

        public const int GWL_EXSTYLE = -20;
        public const long WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x08000000;
        public const uint GW_HWNDNEXT = 2, GA_ROOT = 2;
        public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9, DWMWA_CLOAKED = 14;
        public const uint WM_QUIT = 0x12, WM_GETOBJECT = 0x3D;
        public const uint SYNCHRONIZE = 0x00100000, PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    }

    internal static class J
    {
        public static void Str(StringBuilder sb, string s)
        {
            if (s == null) { sb.Append("\"\""); return; }
            sb.Append('"');
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20 || c == 0x2028 || c == 0x2029 || char.IsSurrogate(c) && !ValidSurrogate(s, i))
                            sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }

        private static bool ValidSurrogate(string s, int i)
        {
            if (char.IsHighSurrogate(s[i])) return i + 1 < s.Length && char.IsLowSurrogate(s[i + 1]);
            return i > 0 && char.IsHighSurrogate(s[i - 1]);
        }

        public static void Rect(StringBuilder sb, int x, int y, int w, int h)
        {
            sb.Append("{\"x\":").Append(x).Append(",\"y\":").Append(y).Append(",\"width\":").Append(w).Append(",\"height\":").Append(h).Append('}');
        }

        public static string Get(Dictionary<string, object> d, string key)
        {
            object v;
            if (!d.TryGetValue(key, out v) || v == null) return null;
            return Convert.ToString(v, CultureInfo.InvariantCulture);
        }

        public static int Int(Dictionary<string, object> d, string key, int fallback)
        {
            object v;
            if (!d.TryGetValue(key, out v) || v == null) return fallback;
            try { return Convert.ToInt32(v, CultureInfo.InvariantCulture); } catch (Exception) { return fallback; }
        }

        public static bool Bool(Dictionary<string, object> d, string key, bool fallback)
        {
            object v;
            if (!d.TryGetValue(key, out v) || v == null) return fallback;
            if (v is bool) return (bool)v;
            return fallback;
        }
    }

    internal sealed class NodeInfo
    {
        public IUIAutomationElement Element;
        public string Role, Name, Value, Path;
        public int X, Y, W, H;
        public bool Enabled, Offscreen, Interactive;
        public int Score;
    }

    internal sealed class Watch
    {
        public int Id;
        public IntPtr Hwnd;
        public IUIAutomationElement Element;
        public string Name, Role;
        public int Nth;
        public bool HasLast, LastNull, Browser;
        public int X, Y, W, H;
        public long LostAt, LastRefind;
    }

    internal static class Program
    {
        private const string Version = "0.1.1";
        private static readonly BlockingCollection<string> Out = new BlockingCollection<string>();
        private static readonly HashSet<uint> Excluded = new HashSet<uint>();
        private static readonly Dictionary<string, IUIAutomationElement> Elements = new Dictionary<string, IUIAutomationElement>();
        private static readonly Queue<string> ElementOrder = new Queue<string>();
        private static readonly Dictionary<int, Watch> Watches = new Dictionary<int, Watch>();
        private static readonly Dictionary<IntPtr, IUIAutomationElement> UrlBars = new Dictionary<IntPtr, IUIAutomationElement>();
        private static readonly Dictionary<IntPtr, long> NoUrlBarUntil = new Dictionary<IntPtr, long>();
        private static readonly HashSet<IntPtr> Woken = new HashSet<IntPtr>();
        private static readonly HashSet<IntPtr> Filled = new HashSet<IntPtr>();
        private static readonly Stopwatch Clock = Stopwatch.StartNew();
        private static int nextElement, nextWatch;
        private static Timer watchTimer;
        private static int watchBusy;
        private static bool selfElevated;
        /**
         * When the page last scrolled under his hand (Clock ms): the wheel turned, a key that scrolls a page went down
         * outside a text field, or the mouse was dragged with the button held (a scroll bar). Only known while the
         * hooks are on.
         */
        public static long WheelAt = -100000;

        public static void ScrollNow()
        {
            Interlocked.Exchange(ref WheelAt, Clock.ElapsedMilliseconds);
        }

        private static int scrollKeyBusy;

        /**
         * A key that scrolls a page went down (PageUp, PageDown, Home, End, an arrow, Space). In a text field the same
         * keys move the caret or type, so the control that has the keyboard is asked first; nothing is asked at all
         * when no element is being followed.
         */
        public static void ScrollKey()
        {
            lock (Watches) { if (Watches.Count == 0) return; }
            if (Interlocked.Exchange(ref scrollKeyBusy, 1) == 1) return;
            Task.Factory.StartNew(delegate ()
            {
                try
                {
                    bool typing = false;
                    try
                    {
                        IUIAutomationElement focused = Uia().GetFocusedElement();
                        if (focused != null)
                        {
                            int type = focused.CurrentControlType;
                            typing = type == TEdit || type == TComboBox || type == TSpinner;
                        }
                    }
                    catch (Exception) { }
                    if (!typing) ScrollNow();
                }
                finally { Interlocked.Exchange(ref scrollKeyBusy, 0); }
            });
        }
        public static long ClockMs { get { return Clock.ElapsedMilliseconds; } }

        [MTAThread]
        private static int Main(string[] args)
        {
            try { Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { }
            uint parent = 0;
            for (int i = 0; i < args.Length; i++)
            {
                uint pid;
                if (args[i] == "--parent" && i + 1 < args.Length && uint.TryParse(args[i + 1], out pid)) { parent = pid; Excluded.Add(pid); }
                if (args[i] == "--exclude" && i + 1 < args.Length && uint.TryParse(args[i + 1], out pid)) Excluded.Add(pid);
                if (args[i] == "--version") { Console.Out.WriteLine(Version); return 0; }
            }
            Excluded.Add((uint)Process.GetCurrentProcess().Id);
            selfElevated = IsElevated((uint)Process.GetCurrentProcess().Id) == 1;

            Thread writer = new Thread(WriteLoop);
            writer.IsBackground = true;
            writer.Start();
            if (parent != 0) WatchParent(parent);

            Emit("{\"event\":\"ready\",\"version\":\"" + Version + "\",\"pid\":" + Process.GetCurrentProcess().Id + ",\"elevated\":" + (selfElevated ? "true" : "false") + "}");

            StreamReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            JavaScriptSerializer json = new JavaScriptSerializer();
            json.MaxJsonLength = 4 * 1024 * 1024;
            string line;
            while ((line = input.ReadLine()) != null)
            {
                if (line.Trim().Length == 0) continue;
                Dictionary<string, object> req;
                try { req = json.DeserializeObject(line) as Dictionary<string, object>; }
                catch (Exception) { req = null; }
                if (req == null) continue;
                string op = J.Get(req, "op") ?? "";
                if (op == "quit") break;
                Dispatch(req, op);
            }
            Hooks.Stop();
            Out.CompleteAdding();
            writer.Join(500);
            return 0;
        }

        private static void WriteLoop()
        {
            Stream stdout = Console.OpenStandardOutput();
            UTF8Encoding utf8 = new UTF8Encoding(false);
            try
            {
                foreach (string line in Out.GetConsumingEnumerable())
                {
                    byte[] bytes = utf8.GetBytes(line + "\n");
                    stdout.Write(bytes, 0, bytes.Length);
                    stdout.Flush();
                }
            }
            catch (Exception) { Environment.Exit(0); }
        }

        public static void Emit(string line)
        {
            try { Out.Add(line); } catch (Exception) { }
        }

        private static void WatchParent(uint pid)
        {
            IntPtr handle = Native.OpenProcess(Native.SYNCHRONIZE, false, pid);
            if (handle == IntPtr.Zero) return;
            Thread t = new Thread(delegate ()
            {
                Native.WaitForSingleObject(handle, 0xFFFFFFFF);
                Hooks.Stop();
                Environment.Exit(0);
            });
            t.IsBackground = true;
            t.Start();
        }

        public static long NowMs()
        {
            return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
        }

        // ---- requests ----

        private static void Dispatch(Dictionary<string, object> req, string op)
        {
            int id = J.Int(req, "id", 0);
            int timeout = J.Int(req, "timeoutMs", op == "capture" ? 15000 : 8000);
            int answered = 0;
            Stopwatch sw = Stopwatch.StartNew();
            Task.Factory.StartNew(delegate ()
            {
                string reply;
                try
                {
                    string result = Run(req, op);
                    reply = "{\"id\":" + id + ",\"ok\":true,\"ms\":" + sw.ElapsedMilliseconds + ",\"result\":" + result + "}";
                }
                catch (OpError e) { reply = Fail(id, e.Code, e.Message); }
                catch (Exception e) { reply = Fail(id, "failed", e.GetType().Name + ": " + e.Message); }
                if (Interlocked.Exchange(ref answered, 1) == 0) Emit(reply);
            }, TaskCreationOptions.LongRunning);
            // A window that hangs must not hang the caller: answer for it after the limit.
            Task.Delay(timeout).ContinueWith(delegate (Task t)
            {
                if (Interlocked.Exchange(ref answered, 1) == 0) Emit(Fail(id, "timeout", "That window did not answer in time."));
            });
        }

        private static string Fail(int id, string code, string message)
        {
            StringBuilder sb = new StringBuilder();
            sb.Append("{\"id\":").Append(id).Append(",\"ok\":false,\"code\":");
            J.Str(sb, code);
            sb.Append(",\"error\":");
            J.Str(sb, message);
            sb.Append('}');
            return sb.ToString();
        }

        private static string Run(Dictionary<string, object> req, string op)
        {
            switch (op)
            {
                case "hello": return Hello();
                case "exclude": return Exclude(req);
                case "activeWindow": return ActiveWindowJson(PickActiveWindow(), true) ?? "null";
                case "window": return ActiveWindowJson(Hwnd(req), true) ?? "null";
                case "windows": return Windows();
                case "monitors": return Monitors();
                case "tree": return Tree(req);
                case "find": return Find(req);
                case "watch": return StartWatch(req);
                case "unwatch": return StopWatch(req);
                case "capture": return Capture(req);
                case "input": return Input(req);
                default: throw new OpError("unknown", "Unknown request: " + op);
            }
        }

        private static string Hello()
        {
            Native.LASTINPUTINFO last = new Native.LASTINPUTINFO();
            last.cbSize = (uint)Marshal.SizeOf(typeof(Native.LASTINPUTINFO));
            long idle = -1;
            if (Native.GetLastInputInfo(ref last)) idle = unchecked((uint)Environment.TickCount - last.dwTime);
            return "{\"version\":\"" + Version + "\",\"pid\":" + Process.GetCurrentProcess().Id + ",\"elevated\":" + (selfElevated ? "true" : "false") +
                ",\"idleMs\":" + idle + ",\"hooks\":" + (Hooks.Running ? "true" : "false") + "}";
        }

        private static string Exclude(Dictionary<string, object> req)
        {
            object raw;
            if (req.TryGetValue("pids", out raw) && raw is object[])
            {
                lock (Excluded)
                {
                    foreach (object item in (object[])raw)
                    {
                        try { Excluded.Add(Convert.ToUInt32(item, CultureInfo.InvariantCulture)); } catch (Exception) { }
                    }
                }
            }
            return "true";
        }

        private static IntPtr Hwnd(Dictionary<string, object> req)
        {
            IntPtr hwnd = ParseHwnd(J.Get(req, "hwnd"));
            if (hwnd == IntPtr.Zero || !Native.IsWindow(hwnd)) throw new OpError("no_window", "That window is closed.");
            return hwnd;
        }

        public static IntPtr ParseHwnd(string text)
        {
            if (string.IsNullOrEmpty(text)) return IntPtr.Zero;
            long value;
            string t = text.Trim();
            if (t.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
            {
                if (!long.TryParse(t.Substring(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out value)) return IntPtr.Zero;
            }
            else if (!long.TryParse(t, NumberStyles.Integer, CultureInfo.InvariantCulture, out value)) return IntPtr.Zero;
            return new IntPtr(value);
        }

        public static string HwndText(IntPtr hwnd)
        {
            return "0x" + hwnd.ToInt64().ToString("x");
        }

        // ---- windows ----

        private static bool IsExcluded(IntPtr hwnd)
        {
            uint pid;
            Native.GetWindowThreadProcessId(hwnd, out pid);
            lock (Excluded) return Excluded.Contains(pid);
        }

        private static string ClassOf(IntPtr hwnd)
        {
            StringBuilder sb = new StringBuilder(256);
            Native.GetClassName(hwnd, sb, 256);
            return sb.ToString();
        }

        private static string TitleOf(IntPtr hwnd)
        {
            StringBuilder sb = new StringBuilder(512);
            Native.GetWindowText(hwnd, sb, 512);
            return sb.ToString();
        }

        private static bool Cloaked(IntPtr hwnd)
        {
            int cloaked;
            return Native.DwmGetWindowAttributeInt(hwnd, Native.DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0;
        }

        private static Native.RECT FrameOf(IntPtr hwnd)
        {
            Native.RECT r;
            if (Native.DwmGetWindowAttribute(hwnd, Native.DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(Native.RECT))) == 0 && r.Right > r.Left) return r;
            Native.GetWindowRect(hwnd, out r);
            return r;
        }

        /** A window a person works in: on screen, not minimised, not a tool or shell surface, not the caller's own. */
        private static bool Workable(IntPtr hwnd)
        {
            if (!Native.IsWindowVisible(hwnd) || Native.IsIconic(hwnd) || Cloaked(hwnd) || IsExcluded(hwnd)) return false;
            long ex = Native.GetWindowLongPtr(hwnd, Native.GWL_EXSTYLE).ToInt64();
            if ((ex & Native.WS_EX_TOOLWINDOW) != 0 || (ex & Native.WS_EX_NOACTIVATE) != 0) return false;
            string cls = ClassOf(hwnd);
            if (cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd" || cls == "Windows.UI.Core.CoreWindow" || cls == "XamlExplorerHostIslandWindow") return false;
            if (TitleOf(hwnd).Length == 0) return false;
            Native.RECT r = FrameOf(hwnd);
            return r.Right - r.Left > 40 && r.Bottom - r.Top > 40;
        }

        /** The window in front; when that is the caller's own (the quick-ask box, the overlay), the one behind it. */
        private static IntPtr PickActiveWindow()
        {
            IntPtr fg = Native.GetForegroundWindow();
            if (fg != IntPtr.Zero)
            {
                IntPtr root = Native.GetAncestor(fg, Native.GA_ROOT);
                if (root != IntPtr.Zero) fg = root;
                if (!IsExcluded(fg) && Native.IsWindowVisible(fg) && !Native.IsIconic(fg)) return fg;
            }
            // The caller's own window is in front (the quick-ask box): the window he was working in is the first one
            // behind it. An always-on-top window (a browser's "is sharing your screen" bar, a pinned player) sits above
            // that one without being it, so it only counts when there is nothing else.
            IntPtr hwnd = Native.GetTopWindow(IntPtr.Zero);
            IntPtr pinned = IntPtr.Zero;
            int guard = 0;
            while (hwnd != IntPtr.Zero && guard++ < 4000)
            {
                if (Workable(hwnd))
                {
                    if ((Native.GetWindowLongPtr(hwnd, Native.GWL_EXSTYLE).ToInt64() & 0x8) == 0) return hwnd;
                    if (pinned == IntPtr.Zero) pinned = hwnd;
                }
                hwnd = Native.GetWindow(hwnd, Native.GW_HWNDNEXT);
            }
            return pinned;
        }

        /** Every window a person could be working in, front to back. */
        private static string Windows()
        {
            List<string> all = new List<string>();
            IntPtr hwnd = Native.GetTopWindow(IntPtr.Zero);
            int guard = 0;
            while (hwnd != IntPtr.Zero && guard++ < 4000 && all.Count < 100)
            {
                if (Workable(hwnd))
                {
                    string window = ActiveWindowJson(hwnd, false);
                    if (window != null) all.Add(window);
                }
                hwnd = Native.GetWindow(hwnd, Native.GW_HWNDNEXT);
            }
            return "[" + string.Join(",", all.ToArray()) + "]";
        }

        private static string ProcessName(uint pid)
        {
            IntPtr handle = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (handle == IntPtr.Zero) return "";
            try
            {
                StringBuilder sb = new StringBuilder(1024);
                int size = sb.Capacity;
                if (!Native.QueryFullProcessImageName(handle, 0, sb, ref size)) return "";
                string name = Path.GetFileName(sb.ToString());
                return name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? name.Substring(0, name.Length - 4) : name;
            }
            finally { Native.CloseHandle(handle); }
        }

        /** 1 elevated, 0 not, -1 unknown (a protected process). */
        private static int IsElevated(uint pid)
        {
            IntPtr handle = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (handle == IntPtr.Zero) return -1;
            try
            {
                IntPtr token;
                if (!Native.OpenProcessToken(handle, 0x0008, out token)) return -1;
                try
                {
                    int elevated, returned;
                    if (!Native.GetTokenInformation(token, 20, out elevated, 4, out returned)) return -1;
                    return elevated != 0 ? 1 : 0;
                }
                finally { Native.CloseHandle(token); }
            }
            finally { Native.CloseHandle(handle); }
        }

        private static bool CannotRead(IntPtr hwnd)
        {
            if (selfElevated) return false;
            uint pid;
            Native.GetWindowThreadProcessId(hwnd, out pid);
            return IsElevated(pid) == 1;
        }

        private static void RequireReadable(IntPtr hwnd)
        {
            if (CannotRead(hwnd)) throw new OpError("elevated", "That window runs as administrator, so its controls cannot be read.");
        }

        public static string ActiveWindowJson(IntPtr hwnd, bool withUrl)
        {
            if (hwnd == IntPtr.Zero || !Native.IsWindow(hwnd)) return null;
            uint pid;
            Native.GetWindowThreadProcessId(hwnd, out pid);
            Native.RECT r = FrameOf(hwnd);
            string cls = ClassOf(hwnd);
            bool elevated = !selfElevated && IsElevated(pid) == 1;
            StringBuilder sb = new StringBuilder(256);
            sb.Append("{\"hwnd\":\"").Append(HwndText(hwnd)).Append("\",\"pid\":").Append(pid).Append(",\"process\":");
            J.Str(sb, ProcessName(pid));
            sb.Append(",\"title\":");
            J.Str(sb, TitleOf(hwnd));
            sb.Append(",\"className\":");
            J.Str(sb, cls);
            sb.Append(",\"bounds\":");
            J.Rect(sb, r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top);
            IntPtr monitor = Native.MonitorFromWindow(hwnd, 2);
            Native.MONITORINFOEX info = new Native.MONITORINFOEX();
            info.cbSize = Marshal.SizeOf(typeof(Native.MONITORINFOEX));
            if (monitor != IntPtr.Zero && Native.GetMonitorInfo(monitor, ref info))
            {
                sb.Append(",\"monitor\":");
                MonitorJson(sb, monitor, info);
            }
            sb.Append(",\"elevated\":").Append(elevated ? "true" : "false");
            if (withUrl && !elevated)
            {
                string url = null;
                try { url = BrowserUrl(hwnd, cls); } catch (Exception) { }
                if (!string.IsNullOrEmpty(url)) { sb.Append(",\"url\":"); J.Str(sb, url); }
            }
            sb.Append('}');
            return sb.ToString();
        }

        private static void MonitorJson(StringBuilder sb, IntPtr monitor, Native.MONITORINFOEX info)
        {
            uint dx = 96, dy = 96;
            try { Native.GetDpiForMonitor(monitor, 0, out dx, out dy); } catch (Exception) { }
            sb.Append("{\"device\":");
            J.Str(sb, info.szDevice);
            sb.Append(",\"bounds\":");
            J.Rect(sb, info.rcMonitor.Left, info.rcMonitor.Top, info.rcMonitor.Right - info.rcMonitor.Left, info.rcMonitor.Bottom - info.rcMonitor.Top);
            sb.Append(",\"work\":");
            J.Rect(sb, info.rcWork.Left, info.rcWork.Top, info.rcWork.Right - info.rcWork.Left, info.rcWork.Bottom - info.rcWork.Top);
            sb.Append(",\"scale\":").Append((dx / 96.0).ToString("0.###", CultureInfo.InvariantCulture));
            sb.Append(",\"primary\":").Append((info.dwFlags & 1) != 0 ? "true" : "false").Append('}');
        }

        private static string Monitors()
        {
            List<string> all = new List<string>();
            Native.MonitorEnumProc proc = delegate (IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data)
            {
                Native.MONITORINFOEX info = new Native.MONITORINFOEX();
                info.cbSize = Marshal.SizeOf(typeof(Native.MONITORINFOEX));
                if (Native.GetMonitorInfo(monitor, ref info))
                {
                    StringBuilder sb = new StringBuilder();
                    MonitorJson(sb, monitor, info);
                    all.Add(sb.ToString());
                }
                return true;
            };
            Native.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, proc, IntPtr.Zero);
            GC.KeepAlive(proc);
            return "[" + string.Join(",", all.ToArray()) + "]";
        }

        // ---- UI Automation (the COM client, UIAutomationCore) ----

        private const int PName = 30005, PControlType = 30003, PBounds = 30001, PEnabled = 30010, POffscreen = 30022, PPassword = 30019,
            PFocusable = 30009, PInvoke = 30031, PHasValue = 30043, PValue = 30045, PReadOnly = 30046, PHwnd = 30020;
        private const int TButton = 50000, TCheckBox = 50002, TComboBox = 50003, TEdit = 50004, THyperlink = 50005, TListItem = 50007,
            TMenuItem = 50011, TRadioButton = 50013, TSlider = 50015, TSpinner = 50016, TTabItem = 50019, TTreeItem = 50024,
            TCustom = 50025, TDataItem = 50029, TDocument = 50030, TSplitButton = 50031, TWindow = 50032, TPane = 50033, THeaderItem = 50035;
        private static readonly int[] InteractiveTypes = new int[] { TButton, TSplitButton, THyperlink, TEdit, TComboBox, TCheckBox, TRadioButton, TMenuItem, TTabItem, TListItem, TTreeItem, TDataItem, TSlider, TSpinner, THeaderItem };
        private static readonly string[] TypeNames = new string[]
        {
            "button", "calendar", "checkbox", "combobox", "textbox", "link", "image", "listitem", "list", "menu", "menubar", "menuitem", "progressbar",
            "radio", "scrollbar", "slider", "spinner", "statusbar", "tablist", "tab", "text", "toolbar", "tooltip", "tree", "treeitem", "custom", "group",
            "thumb", "datagrid", "row", "document", "button", "window", "pane", "header", "headeritem", "table", "titlebar", "separator", "semanticzoom", "appbar",
        };

        private static IUIAutomation uia;
        private static IUIAutomationCondition interactiveCondition;
        private static readonly object UiaGate = new object();

        private static IUIAutomation Uia()
        {
            if (uia != null) return uia;
            lock (UiaGate)
            {
                if (uia != null) return uia;
                IUIAutomation made;
                try { made = new CUIAutomation8(); } catch (Exception) { made = new CUIAutomation(); }
                // A window that stops answering must not stop us for long.
                try { IUIAutomation2 two = made as IUIAutomation2; if (two != null) { two.ConnectionTimeout = 2000; two.TransactionTimeout = 4000; } } catch (Exception) { }
                IUIAutomationCondition any = made.CreatePropertyCondition(PInvoke, true);
                any = made.CreateOrCondition(any, made.CreateAndCondition(made.CreatePropertyCondition(PControlType, TCustom), made.CreatePropertyCondition(PFocusable, true)));
                foreach (int type in InteractiveTypes) any = made.CreateOrCondition(any, made.CreatePropertyCondition(PControlType, type));
                interactiveCondition = any;
                uia = made;
                return uia;
            }
        }

        private static IUIAutomationCacheRequest NodeCache(TreeScope scope)
        {
            IUIAutomationCacheRequest cache = Uia().CreateCacheRequest();
            foreach (int p in new int[] { PName, PControlType, PBounds, PEnabled, POffscreen, PPassword, PFocusable, PInvoke, PHasValue, PValue, PReadOnly }) cache.AddProperty(p);
            cache.TreeScope = scope;
            cache.TreeFilter = Uia().ControlViewCondition;
            return cache;
        }

        // ---- the browser's address ----

        private static bool BrowserClass(string cls)
        {
            return cls == "Chrome_WidgetWin_1" || cls == "MozillaWindowClass";
        }

        /**
         * The address bar's text, for any Chromium or Gecko browser: the first text field outside the page whose
         * name reads like an address bar, else the first one at all. Found once per window (a short walk that never
         * enters the page), then one property read per call.
         */
        private static string BrowserUrl(IntPtr hwnd, string cls)
        {
            if (!BrowserClass(cls)) return null;
            IUIAutomationElement bar;
            lock (UrlBars) UrlBars.TryGetValue(hwnd, out bar);
            if (bar != null)
            {
                try { return CleanUrl(bar.GetCurrentPropertyValue(PValue) as string); }
                catch (Exception) { lock (UrlBars) UrlBars.Remove(hwnd); }
            }
            long until;
            lock (UrlBars) { if (NoUrlBarUntil.TryGetValue(hwnd, out until) && Clock.ElapsedMilliseconds < until) return null; }
            bar = FindUrlBar(hwnd);
            lock (UrlBars)
            {
                if (bar == null) { NoUrlBarUntil[hwnd] = Clock.ElapsedMilliseconds + 5000; return null; }
                if (UrlBars.Count > 64) UrlBars.Clear();
                UrlBars[hwnd] = bar;
            }
            return CleanUrl(bar.GetCurrentPropertyValue(PValue) as string);
        }

        private static IUIAutomationElement FindUrlBar(IntPtr hwnd)
        {
            IUIAutomationElement root = Uia().ElementFromHandle(hwnd);
            IUIAutomationCacheRequest cache = Uia().CreateCacheRequest();
            cache.AddProperty(PControlType);
            cache.AddProperty(PName);
            cache.AddProperty(PPassword);
            IUIAutomationTreeWalker walker = Uia().ControlViewWalker;
            Queue<IUIAutomationElement> queue = new Queue<IUIAutomationElement>();
            queue.Enqueue(root);
            IUIAutomationElement first = null;
            int seen = 0;
            while (queue.Count > 0 && seen < 500)
            {
                IUIAutomationElement parent = queue.Dequeue();
                IUIAutomationElement child = walker.GetFirstChildElementBuildCache(parent, cache);
                while (child != null && seen < 500)
                {
                    seen++;
                    int type = child.CachedControlType;
                    if (type == TEdit && child.CachedIsPassword == 0)
                    {
                        string name = (child.CachedName ?? "").ToLowerInvariant();
                        if (name.Contains("address") || name.Contains("url") || name.Contains("adres") || name.Contains("location")) return child;
                        if (first == null) first = child;
                    }
                    else if (type != TDocument) queue.Enqueue(child);
                    child = walker.GetNextSiblingElementBuildCache(child, cache);
                }
            }
            return first;
        }

        /** The bar hides the scheme; put one back. Text that is being typed (a search, not an address) gives nothing. */
        private static string CleanUrl(string raw)
        {
            if (raw == null) return null;
            string text = raw.Trim();
            if (text.Length == 0 || text.Length > 4000 || text.IndexOf(' ') >= 0) return null;
            if (text.IndexOf("://", StringComparison.Ordinal) > 0) return text;
            int colon = text.IndexOf(':');
            if (colon > 0 && colon < 20)
            {
                string scheme = text.Substring(0, colon).ToLowerInvariant();
                if (scheme == "about" || scheme == "chrome" || scheme == "edge" || scheme == "brave" || scheme == "file" || scheme == "view-source" || scheme == "data") return text;
            }
            string host = text;
            int cut = host.IndexOfAny(new char[] { '/', '?', '#' });
            if (cut >= 0) host = host.Substring(0, cut);
            int port = host.LastIndexOf(':');
            string bare = port > 0 ? host.Substring(0, port) : host;
            if (bare.Length == 0) return null;
            System.Net.IPAddress ip;
            bool local = bare == "localhost" || System.Net.IPAddress.TryParse(bare, out ip);
            if (!local && bare.IndexOf('.') < 0) return null;
            return (local ? "http://" : "https://") + text;
        }

        // ---- reading a window's controls ----

        /**
         * Chromium and Electron fill their tree only once something asks for it. Asking the page's own window for
         * its accessible object is that ask; the first answer can be empty, so the caller looks again shortly.
         */
        private static void Wake(IntPtr hwnd, string cls)
        {
            if (!BrowserClass(cls)) return;
            lock (Woken) { if (!Woken.Add(hwnd)) return; if (Woken.Count > 256) Woken.Clear(); }
            IntPtr child = Native.FindWindowEx(hwnd, IntPtr.Zero, "Chrome_RenderWidgetHostHWND", null);
            IntPtr result;
            if (child != IntPtr.Zero) Native.SendMessageTimeout(child, Native.WM_GETOBJECT, IntPtr.Zero, new IntPtr(1), 2, 300, out result);
        }

        private static string RoleOf(int type)
        {
            int at = type - 50000;
            return at >= 0 && at < TypeNames.Length ? TypeNames[at] : "custom";
        }

        private static bool InteractiveType(int type)
        {
            return Array.IndexOf(InteractiveTypes, type) >= 0;
        }

        private static bool CachedBool(IUIAutomationElement el, int property)
        {
            try { object value = el.GetCachedPropertyValue(property); return value is bool && (bool)value; }
            catch (Exception) { return false; }
        }

        /** One element's facts from the cache. */
        private static NodeInfo Describe(IUIAutomationElement el)
        {
            NodeInfo node = new NodeInfo();
            node.Element = el;
            int type = TCustom;
            try { type = el.CachedControlType; } catch (Exception) { }
            node.Role = RoleOf(type);
            try { node.Name = (el.CachedName ?? "").Trim(); } catch (Exception) { node.Name = ""; }
            if (node.Name.Length > 200) node.Name = node.Name.Substring(0, 200);
            bool placed = false;
            try
            {
                tagRECT r = el.CachedBoundingRectangle;
                placed = r.right - r.left >= 1 && r.bottom - r.top >= 1;
                if (placed) { node.X = r.left; node.Y = r.top; node.W = r.right - r.left; node.H = r.bottom - r.top; }
            }
            catch (Exception) { }
            bool offscreen = false, enabled = true, password = false, focusable = false;
            try { offscreen = el.CachedIsOffscreen != 0; } catch (Exception) { }
            try { enabled = el.CachedIsEnabled != 0; } catch (Exception) { }
            try { password = el.CachedIsPassword != 0; } catch (Exception) { }
            try { focusable = el.CachedIsKeyboardFocusable != 0; } catch (Exception) { }
            node.Offscreen = !placed || offscreen;
            node.Enabled = enabled;
            bool hasValue = CachedBool(el, PHasValue);
            bool readOnly = hasValue && CachedBool(el, PReadOnly);
            bool invoke = CachedBool(el, PInvoke);
            node.Interactive = InteractiveType(type) || (type == TDocument && focusable && hasValue && !readOnly) ||
                (invoke && type != TWindow && type != TPane && type != TDocument) || (type == TCustom && focusable);
            if (!password && hasValue && (type == TEdit || type == TComboBox || type == TSpinner || type == TSlider))
            {
                try
                {
                    string value = el.GetCachedPropertyValue(PValue) as string;
                    if (!string.IsNullOrEmpty(value)) node.Value = value.Length > 200 ? value.Substring(0, 200) : value;
                }
                catch (Exception) { }
            }
            return node;
        }

        private static bool Unnamed(NodeInfo node)
        {
            return node.Name.Length == 0 && node.Role != "textbox" && node.Role != "combobox";
        }

        private static string PathOf(List<string> names)
        {
            int from = Math.Max(0, names.Count - 4);
            StringBuilder sb = new StringBuilder();
            for (int i = from; i < names.Count; i++)
            {
                if (sb.Length > 0) sb.Append(" > ");
                sb.Append(names[i]);
            }
            return sb.ToString();
        }

        private static string Short(string name)
        {
            return name.Length > 40 ? name.Substring(0, 40) : name;
        }

        private static void Collect(IUIAutomationElement parent, List<string> names, List<NodeInfo> into, int max, bool interactiveOnly, bool includeOffscreen, int depth, ref int seen, ref bool page)
        {
            if (depth > 60) return;
            IUIAutomationElementArray children;
            try { children = parent.GetCachedChildren(); } catch (Exception) { return; }
            if (children == null) return;
            int count = children.Length;
            for (int i = 0; i < count; i++)
            {
                IUIAutomationElement child = children.GetElement(i);
                seen++;
                NodeInfo node = Describe(child);
                bool wanted = (includeOffscreen || !node.Offscreen) && !Unnamed(node) && (!interactiveOnly || node.Interactive);
                if (wanted && into.Count < max)
                {
                    node.Path = PathOf(names);
                    into.Add(node);
                }
                bool pushed = false;
                string label = Short(node.Name);
                if (label.Length > 0 && (names.Count == 0 || names[names.Count - 1] != label)) { names.Add(label); pushed = true; }
                int before = seen;
                Collect(child, names, into, max, interactiveOnly, includeOffscreen, depth + 1, ref seen, ref page);
                if (node.Role == "document" && seen > before) page = true;
                if (pushed) names.RemoveAt(names.Count - 1);
            }
        }

        private static List<NodeInfo> ReadAll(IntPtr hwnd, int max, bool interactiveOnly, bool includeOffscreen, out int seen)
        {
            string cls = ClassOf(hwnd);
            Wake(hwnd, cls);
            List<NodeInfo> nodes = new List<NodeInfo>();
            seen = 0;
            // A browser that was just asked for its tree answers with only its own toolbar at first.
            for (int attempt = 0; attempt < 8; attempt++)
            {
                nodes.Clear();
                seen = 0;
                bool page = false;
                IUIAutomationElement root = Uia().ElementFromHandleBuildCache(hwnd, NodeCache(TreeScope.TreeScope_Subtree));
                Collect(root, new List<string>(), nodes, max, interactiveOnly, includeOffscreen, 0, ref seen, ref page);
                bool waking;
                lock (Woken) waking = BrowserClass(cls) && !page && !Filled.Contains(hwnd);
                if (!waking || attempt == 7)
                {
                    if (page) lock (Woken) { if (Filled.Count > 256) Filled.Clear(); Filled.Add(hwnd); }
                    break;
                }
                Thread.Sleep(150);
            }
            return nodes;
        }

        private static string Remember(IUIAutomationElement el)
        {
            lock (Elements)
            {
                string id = "n" + (++nextElement);
                Elements[id] = el;
                ElementOrder.Enqueue(id);
                while (ElementOrder.Count > 20000) Elements.Remove(ElementOrder.Dequeue());
                return id;
            }
        }

        private static void NodeJson(StringBuilder sb, NodeInfo node)
        {
            sb.Append("{\"id\":\"").Append(Remember(node.Element)).Append("\",\"role\":");
            J.Str(sb, node.Role);
            sb.Append(",\"name\":");
            J.Str(sb, node.Name);
            if (node.Value != null) { sb.Append(",\"value\":"); J.Str(sb, node.Value); }
            sb.Append(",\"bounds\":");
            J.Rect(sb, node.X, node.Y, node.W, node.H);
            sb.Append(",\"enabled\":").Append(node.Enabled ? "true" : "false");
            sb.Append(",\"offscreen\":").Append(node.Offscreen ? "true" : "false");
            sb.Append(",\"path\":");
            J.Str(sb, node.Path ?? "");
            sb.Append('}');
        }

        private static string Tree(Dictionary<string, object> req)
        {
            IntPtr hwnd = Hwnd(req);
            RequireReadable(hwnd);
            int max = Math.Max(1, Math.Min(5000, J.Int(req, "max", 400)));
            bool interactiveOnly = J.Bool(req, "interactiveOnly", true);
            int seen;
            List<NodeInfo> nodes = ReadAll(hwnd, max, interactiveOnly, false, out seen);
            StringBuilder sb = new StringBuilder(nodes.Count * 160 + 64);
            sb.Append("{\"seen\":").Append(seen).Append(",\"nodes\":[");
            for (int i = 0; i < nodes.Count; i++)
            {
                if (i > 0) sb.Append(',');
                NodeJson(sb, nodes[i]);
            }
            sb.Append("]}");
            return sb.ToString();
        }

        // ---- finding one control ----

        private static string Norm(string text)
        {
            StringBuilder sb = new StringBuilder(text.Length);
            bool space = false;
            foreach (char raw in text)
            {
                char c = char.ToLowerInvariant(raw);
                if (c == '&' || c == '…') continue;
                if (char.IsWhiteSpace(c) || c == ' ') { space = sb.Length > 0; continue; }
                if (space) { sb.Append(' '); space = false; }
                sb.Append(c);
            }
            return sb.ToString().TrimEnd('.', ':', ' ');
        }

        /** The roles an asked role accepts: the engine speaks in web words ("link", "textbox", "option"). */
        private static string[] RolesFor(string asked)
        {
            if (string.IsNullOrEmpty(asked)) return null;
            switch (asked.ToLowerInvariant())
            {
                case "button": return new string[] { "button" };
                case "link": case "hyperlink": return new string[] { "link" };
                case "textbox": case "searchbox": case "edit": case "input": return new string[] { "textbox", "combobox", "document", "spinner" };
                case "combobox": case "select": case "dropdown": return new string[] { "combobox" };
                case "checkbox": case "switch": return new string[] { "checkbox", "button" };
                case "radio": case "radiobutton": return new string[] { "radio" };
                case "tab": return new string[] { "tab" };
                case "menuitem": return new string[] { "menuitem" };
                case "option": return new string[] { "listitem", "menuitem", "treeitem" };
                case "listitem": case "row": case "treeitem": return new string[] { "listitem", "row", "treeitem" };
                default: return new string[] { asked.ToLowerInvariant() };
            }
        }

        private static bool RoleMatches(string[] roles, string role)
        {
            return roles == null || Array.IndexOf(roles, role) >= 0;
        }

        private static IUIAutomationCondition TypeCondition(string[] roles)
        {
            IUIAutomationCondition any = null;
            for (int i = 0; i < TypeNames.Length; i++)
            {
                if (Array.IndexOf(roles, TypeNames[i]) < 0) continue;
                IUIAutomationCondition one = Uia().CreatePropertyCondition(PControlType, 50000 + i);
                any = any == null ? one : Uia().CreateOrCondition(any, one);
            }
            return any;
        }

        /** How well a node answers the asked name: 0 no match, higher is better. */
        private static int Score(NodeInfo node, string wanted, string[] roles)
        {
            if (!RoleMatches(roles, node.Role)) return 0;
            string name = Norm(node.Name);
            if (name.Length == 0) return 0;
            int score;
            if (name == wanted) score = 100;
            else if (name.StartsWith(wanted, StringComparison.Ordinal)) score = 70;
            else if (name.Contains(wanted)) score = 50;
            else if (wanted.Contains(name) && name.Length >= 4) score = 30;
            else return 0;
            if (node.Interactive) score += 8;
            if (!node.Offscreen) score += 4;
            if (node.Enabled) score += 1;
            return score;
        }

        /**
         * The elements that answer a name, best first. Three roads, each slower than the one before:
         *  1. the first thing on screen with exactly that name that can be clicked or typed in (the search stops there);
         *  2. everything with exactly that name, on screen or not;
         *  3. everything, matched loosely (the start of a name, part of a name).
         * `road` says which one answered.
         */
        private static List<NodeInfo> Matches(IntPtr hwnd, string name, string role, int nth, out int road)
        {
            string wanted = Norm(name);
            string[] roles = RolesFor(role);
            List<NodeInfo> hits = new List<NodeInfo>();
            road = 0;
            if (wanted.Length == 0) return hits;
            Wake(hwnd, ClassOf(hwnd));
            IUIAutomation a = Uia();
            IUIAutomationElement root = a.ElementFromHandle(hwnd);
            IUIAutomationCacheRequest cache = NodeCache(TreeScope.TreeScope_Element);
            IUIAutomationCondition named = a.CreatePropertyConditionEx(PName, name.Trim(), PropertyConditionFlags.PropertyConditionFlags_IgnoreCase);
            if (nth <= 1)
            {
                IUIAutomationCondition kind = roles == null ? interactiveCondition : TypeCondition(roles);
                if (kind != null)
                {
                    IUIAutomationCondition fast = a.CreateAndCondition(a.CreateAndCondition(named, a.CreatePropertyCondition(POffscreen, false)), kind);
                    IUIAutomationElement first = root.FindFirstBuildCache(TreeScope.TreeScope_Descendants, fast, cache);
                    if (first != null)
                    {
                        NodeInfo node = Describe(first);
                        node.Score = Score(node, wanted, roles);
                        if (node.Score > 0 && !node.Offscreen) { hits.Add(node); road = 1; return hits; }
                    }
                }
            }
            IUIAutomationElementArray exact = root.FindAllBuildCache(TreeScope.TreeScope_Descendants, named, cache);
            int count = exact == null ? 0 : exact.Length;
            for (int i = 0; i < count; i++)
            {
                NodeInfo node = Describe(exact.GetElement(i));
                node.Score = Score(node, wanted, roles);
                if (node.Score > 0) hits.Add(node);
            }
            road = 2;
            if (hits.Count == 0)
            {
                road = 3;
                int seen;
                List<NodeInfo> all = ReadAll(hwnd, 5000, false, true, out seen);
                foreach (NodeInfo node in all)
                {
                    node.Score = Score(node, wanted, roles);
                    if (node.Score > 0) hits.Add(node);
                }
            }
            // The best band (exact, starts with, contains) counts for nth; in it, what can be used and seen comes first, in page order.
            int best = 0;
            foreach (NodeInfo node in hits) if (node.Score > best) best = node.Score;
            int band = best >= 100 ? 100 : best >= 70 ? 70 : best >= 50 ? 50 : 30;
            List<NodeInfo> ordered = new List<NodeInfo>();
            foreach (NodeInfo node in hits) if (node.Score >= band && node.Interactive && !node.Offscreen) ordered.Add(node);
            foreach (NodeInfo node in hits) if (node.Score >= band && !(node.Interactive && !node.Offscreen)) ordered.Add(node);
            return ordered;
        }

        private static string AncestorPath(IUIAutomationElement el, IntPtr hwnd)
        {
            List<string> names = new List<string>();
            try
            {
                IUIAutomationCacheRequest cache = Uia().CreateCacheRequest();
                cache.AddProperty(PName);
                cache.AddProperty(PHwnd);
                IUIAutomationTreeWalker walker = Uia().ControlViewWalker;
                IUIAutomationElement at = walker.GetParentElementBuildCache(el, cache);
                int guard = 0;
                while (at != null && guard++ < 40)
                {
                    if (at.CachedNativeWindowHandle == hwnd) break;
                    string name = Short((at.CachedName ?? "").Trim());
                    if (name.Length > 0 && (names.Count == 0 || names[names.Count - 1] != name)) names.Add(name);
                    at = walker.GetParentElementBuildCache(at, cache);
                }
            }
            catch (Exception) { }
            names.Reverse();
            return PathOf(names);
        }

        private static string Find(Dictionary<string, object> req)
        {
            IntPtr hwnd = Hwnd(req);
            RequireReadable(hwnd);
            string name = J.Get(req, "name") ?? "";
            int nth = Math.Max(1, J.Int(req, "nth", 1));
            int road;
            List<NodeInfo> hits = Matches(hwnd, name, J.Get(req, "role"), nth, out road);
            if (hits.Count < nth) return "{\"node\":null,\"matches\":" + hits.Count + ",\"road\":" + road + "}";
            NodeInfo node = hits[nth - 1];
            if (node.Path == null) node.Path = J.Bool(req, "path", true) ? AncestorPath(node.Element, hwnd) : "";
            StringBuilder sb = new StringBuilder(256);
            sb.Append("{\"node\":");
            NodeJson(sb, node);
            sb.Append(",\"matches\":").Append(hits.Count).Append(",\"road\":").Append(road).Append('}');
            return sb.ToString();
        }

        // ---- following one control ----

        private static string StartWatch(Dictionary<string, object> req)
        {
            IntPtr hwnd = Hwnd(req);
            Watch watch = new Watch();
            watch.Hwnd = hwnd;
            watch.Name = J.Get(req, "name") ?? "";
            watch.Role = J.Get(req, "role") ?? "";
            watch.Nth = Math.Max(1, J.Int(req, "nth", 1));
            watch.Browser = BrowserClass(ClassOf(hwnd));
            string id = J.Get(req, "node") ?? "";
            lock (Elements) Elements.TryGetValue(id, out watch.Element);
            if (watch.Element == null && watch.Name.Length > 0)
            {
                int road;
                List<NodeInfo> hits = Matches(hwnd, watch.Name, watch.Role, watch.Nth, out road);
                if (hits.Count >= watch.Nth) watch.Element = hits[watch.Nth - 1].Element;
            }
            lock (Watches)
            {
                watch.Id = ++nextWatch;
                Watches[watch.Id] = watch;
                if (watchTimer == null) watchTimer = new Timer(PollWatches, null, 0, 33);
            }
            return "{\"watch\":" + watch.Id + "}";
        }

        private static string StopWatch(Dictionary<string, object> req)
        {
            int id = J.Int(req, "watch", 0);
            lock (Watches)
            {
                Watches.Remove(id);
                if (Watches.Count == 0 && watchTimer != null) { watchTimer.Dispose(); watchTimer = null; }
            }
            return "true";
        }

        private static void PollWatches(object state)
        {
            if (Interlocked.Exchange(ref watchBusy, 1) == 1) return;
            try
            {
                Watch[] all;
                lock (Watches) { all = new Watch[Watches.Count]; Watches.Values.CopyTo(all, 0); }
                foreach (Watch watch in all) PollOne(watch);
            }
            catch (Exception) { }
            finally { Interlocked.Exchange(ref watchBusy, 0); }
        }

        /** Reads where the element is now. gone: it no longer exists. hidden: it exists but cannot be seen. */
        private static void Place(Watch watch, out bool gone, out bool hidden, out int x, out int y, out int w, out int h)
        {
            gone = false; hidden = false; x = y = w = h = 0;
            if (!Native.IsWindow(watch.Hwnd) || watch.Element == null) { gone = true; return; }
            try
            {
                tagRECT r = watch.Element.CurrentBoundingRectangle;
                x = r.left; y = r.top; w = r.right - r.left; h = r.bottom - r.top;
                if (w < 1 || h < 1) { hidden = true; return; }
                // Out of the window is out of sight at once; a browser takes half a second to say so itself.
                Native.RECT frame = FrameOf(watch.Hwnd);
                if (x >= frame.Right || y >= frame.Bottom || x + w <= frame.Left || y + h <= frame.Top || Native.IsIconic(watch.Hwnd)) { hidden = true; return; }
                if (watch.Element.CurrentIsOffscreen != 0) hidden = true;
            }
            catch (Exception) { gone = true; watch.Element = null; }
        }

        private static void PollOne(Watch watch)
        {
            bool gone, hidden;
            int x, y, w, h;
            Place(watch, out gone, out hidden, out x, out y, out w, out h);
            long now = Clock.ElapsedMilliseconds;
            if (!gone && !hidden) watch.LostAt = 0;
            else if (Native.IsWindow(watch.Hwnd) && watch.Name.Length > 0)
            {
                // A page that drew itself again made a new element with the same name, and the old one lingers as
                // an empty shell or disappears. Look for the new one: soon at first, then once a second.
                if (watch.LostAt == 0) watch.LostAt = now;
                long every = now - watch.LostAt < 10000 ? 200 : 1000;
                if (now - watch.LastRefind >= every && now - watch.LostAt >= 60)
                {
                    watch.LastRefind = now;
                    try
                    {
                        int road;
                        List<NodeInfo> hits = Matches(watch.Hwnd, watch.Name, watch.Role, watch.Nth, out road);
                        if (hits.Count >= watch.Nth && (gone || !hits[watch.Nth - 1].Offscreen))
                        {
                            watch.Element = hits[watch.Nth - 1].Element;
                            Place(watch, out gone, out hidden, out x, out y, out w, out h);
                            if (!gone && !hidden) watch.LostAt = 0;
                        }
                    }
                    catch (Exception) { }
                }
            }
            // A browser tells where things are about half a second after a scroll. Until then the old place is wrong,
            // so while the wheel turns over a browser the element counts as out of sight; it comes back in its new place.
            bool scrolling = !gone && !hidden && watch.Browser && now - Interlocked.Read(ref WheelAt) < 650;
            if (scrolling) hidden = true;
            bool isNull = gone || hidden;
            if (watch.HasLast && watch.LastNull == isNull && (isNull || (watch.X == x && watch.Y == y && watch.W == w && watch.H == h))) return;
            watch.HasLast = true; watch.LastNull = isNull; watch.X = x; watch.Y = y; watch.W = w; watch.H = h;
            StringBuilder sb = new StringBuilder(128);
            sb.Append("{\"event\":\"move\",\"watch\":").Append(watch.Id).Append(",\"rect\":");
            if (isNull) sb.Append("null"); else J.Rect(sb, x, y, w, h);
            sb.Append(",\"why\":\"").Append(gone ? "gone" : scrolling ? "scrolling" : hidden ? "hidden" : "moved").Append("\",\"time\":").Append(NowMs()).Append('}');
            Emit(sb.ToString());
        }

        // ---- pictures ----

        private static string Capture(Dictionary<string, object> req)
        {
            int maxWidth = J.Int(req, "maxWidth", 0);
            Bitmap picture;
            string how;
            if (J.Get(req, "hwnd") != null)
            {
                IntPtr hwnd = Hwnd(req);
                picture = CaptureWindow(hwnd, out how);
            }
            else
            {
                int x = J.Int(req, "x", 0), y = J.Int(req, "y", 0), w = J.Int(req, "width", 0), h = J.Int(req, "height", 0);
                if (w < 1 || h < 1 || w > 20000 || h > 20000) throw new OpError("bad_request", "That screen area has no size.");
                picture = CaptureScreen(x, y, w, h);
                how = "screen";
            }
            try
            {
                if (maxWidth > 0 && picture.Width > maxWidth)
                {
                    int height = Math.Max(1, (int)Math.Round(picture.Height * (maxWidth / (double)picture.Width)));
                    Bitmap small = new Bitmap(maxWidth, height, PixelFormat.Format24bppRgb);
                    using (Graphics g = Graphics.FromImage(small))
                    {
                        g.InterpolationMode = InterpolationMode.HighQualityBilinear;
                        g.DrawImage(picture, 0, 0, maxWidth, height);
                    }
                    picture.Dispose();
                    picture = small;
                }
                using (MemoryStream stream = new MemoryStream())
                {
                    picture.Save(stream, ImageFormat.Png);
                    return "{\"width\":" + picture.Width + ",\"height\":" + picture.Height + ",\"how\":\"" + how + "\",\"png\":\"" + Convert.ToBase64String(stream.GetBuffer(), 0, (int)stream.Length) + "\"}";
                }
            }
            finally { picture.Dispose(); }
        }

        private static Bitmap CaptureScreen(int x, int y, int w, int h)
        {
            Bitmap bitmap = new Bitmap(w, h, PixelFormat.Format24bppRgb);
            using (Graphics g = Graphics.FromImage(bitmap)) g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
            return bitmap;
        }

        /** The window's own picture (so a window on top of it is not in it); the screen area when the window refuses. */
        private static Bitmap CaptureWindow(IntPtr hwnd, out string how)
        {
            Native.RECT full, frame = FrameOf(hwnd);
            Native.GetWindowRect(hwnd, out full);
            int w = full.Right - full.Left, h = full.Bottom - full.Top;
            int fw = frame.Right - frame.Left, fh = frame.Bottom - frame.Top;
            if (Native.IsIconic(hwnd) || w < 1 || h < 1) throw new OpError("no_window", "That window is minimised.");
            Bitmap whole = new Bitmap(w, h, PixelFormat.Format32bppRgb);
            bool ok;
            using (Graphics g = Graphics.FromImage(whole))
            {
                IntPtr hdc = g.GetHdc();
                try { ok = Native.PrintWindow(hwnd, hdc, 2); }
                finally { g.ReleaseHdc(hdc); }
            }
            if (ok && !Blank(whole))
            {
                how = "window";
                Rectangle crop = Rectangle.Intersect(new Rectangle(frame.Left - full.Left, frame.Top - full.Top, fw, fh), new Rectangle(0, 0, w, h));
                if (crop.Width == w && crop.Height == h || crop.Width < 1 || crop.Height < 1) return whole;
                Bitmap cut = whole.Clone(crop, PixelFormat.Format24bppRgb);
                whole.Dispose();
                return cut;
            }
            whole.Dispose();
            how = "screen";
            return CaptureScreen(frame.Left, frame.Top, fw, fh);
        }

        private static bool Blank(Bitmap bitmap)
        {
            int first = bitmap.GetPixel(bitmap.Width / 2, bitmap.Height / 2).ToArgb();
            for (int i = 1; i < 24; i++)
            {
                int x = (bitmap.Width * i) / 24, y = (bitmap.Height * ((i * 7) % 24)) / 24;
                if (bitmap.GetPixel(Math.Min(x, bitmap.Width - 1), Math.Min(y, bitmap.Height - 1)).ToArgb() != first) return false;
            }
            return true;
        }

        // ---- the person's clicks and a few named keys ----

        private static string Input(Dictionary<string, object> req)
        {
            bool on = J.Bool(req, "on", false);
            if (!on) { Hooks.Stop(); return "{\"hooks\":false}"; }
            List<string> keys = new List<string>();
            object raw;
            if (req.TryGetValue("keys", out raw) && raw is object[])
            {
                foreach (object item in (object[])raw) if (item is string) keys.Add((string)item);
            }
            Hooks.Start(keys, (J.Get(req, "clickOn") ?? "up") == "down");
            return "{\"hooks\":true}";
        }

        private static IntPtr lastForeground;
        private static int foregroundBusy;

        /** Forget what was in front, so the first look after the hooks start reports nothing. */
        public static void ForegroundReset()
        {
            IntPtr fg = Native.GetForegroundWindow();
            lastForeground = fg == IntPtr.Zero ? IntPtr.Zero : Native.GetAncestor(fg, Native.GA_ROOT);
        }

        /**
         * Reports the window in front when it is another one than last time. Windows does not always say when a
         * window comes to the front (a click on a window that opened in the background says nothing), so this is
         * asked on its own clock while the hooks are on, and at once when Windows does say or a click lands.
         */
        public static void ForegroundCheck()
        {
            if (Interlocked.Exchange(ref foregroundBusy, 1) == 1) return;
            try
            {
                IntPtr fg = Native.GetForegroundWindow();
                if (fg == IntPtr.Zero) return;
                IntPtr root = Native.GetAncestor(fg, Native.GA_ROOT);
                if (root == IntPtr.Zero) root = fg;
                if (root == lastForeground || !Native.IsWindowVisible(root)) return;
                lastForeground = root;
                // This app's own windows (the quick-ask box, the overlay) are never news.
                if (IsExcluded(root)) return;
                string window = ActiveWindowJson(root, true);
                if (window != null) Emit("{\"event\":\"input\",\"kind\":\"foreground\",\"window\":" + window + ",\"time\":" + NowMs() + "}");
            }
            catch (Exception) { }
            finally { Interlocked.Exchange(ref foregroundBusy, 0); }
        }

        public static void ForegroundSoon()
        {
            Task.Factory.StartNew(delegate () { ForegroundCheck(); Thread.Sleep(60); ForegroundCheck(); });
        }
    }

    /**
     * The low-level mouse and keyboard hooks, on their own thread with a message pump. Strictly passive: each
     * callback reads a few numbers, queues a line and passes the event on. Installed by Start, removed by Stop.
     */
    internal static class Hooks
    {
        private static Thread thread;
        private static uint threadId;
        private static IntPtr mouseHook, keyHook, eventHook;
        private static Native.HookProc mouseProc, keyProc;
        private static Native.WinEventProc eventProc;
        private static volatile HashSet<int> watched = new HashSet<int>();
        private static volatile bool clickOnDown;
        private static long lastWheel;
        private static volatile bool leftDown;
        private static int downX, downY;
        private static volatile bool dragging;
        private static Timer foregroundTimer;
        private static readonly object Gate = new object();

        public static bool Running { get { return thread != null; } }

        private static readonly Dictionary<string, int> KeyCodes = BuildKeys();
        private static readonly Dictionary<int, string> KeyNames = new Dictionary<int, string>();

        private static Dictionary<string, int> BuildKeys()
        {
            Dictionary<string, int> map = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            map["Escape"] = 0x1B; map["Enter"] = 0x0D; map["Tab"] = 0x09; map["Space"] = 0x20; map["Backspace"] = 0x08; map["Delete"] = 0x2E;
            map["ArrowLeft"] = 0x25; map["ArrowUp"] = 0x26; map["ArrowRight"] = 0x27; map["ArrowDown"] = 0x28;
            map["PageUp"] = 0x21; map["PageDown"] = 0x22; map["End"] = 0x23; map["Home"] = 0x24;
            for (int i = 1; i <= 12; i++) map["F" + i] = 0x6F + i;
            return map;
        }

        public static void Start(List<string> keys, bool onDown)
        {
            HashSet<int> codes = new HashSet<int>();
            lock (KeyNames)
            {
                foreach (string key in keys)
                {
                    int code;
                    if (KeyCodes.TryGetValue(key, out code)) { codes.Add(code); KeyNames[code] = key; }
                }
            }
            watched = codes;
            clickOnDown = onDown;
            lock (Gate)
            {
                if (thread != null) return;
                Program.ForegroundReset();
                foregroundTimer = new Timer(delegate (object state) { Program.ForegroundCheck(); }, null, 120, 120);
                ManualResetEvent ready = new ManualResetEvent(false);
                thread = new Thread(delegate () { Pump(ready); });
                thread.IsBackground = true;
                thread.SetApartmentState(ApartmentState.STA);
                thread.Start();
                ready.WaitOne(2000);
            }
        }

        public static void Stop()
        {
            lock (Gate)
            {
                if (thread == null) return;
                if (foregroundTimer != null) { foregroundTimer.Dispose(); foregroundTimer = null; }
                Native.PostThreadMessage(threadId, Native.WM_QUIT, IntPtr.Zero, IntPtr.Zero);
                thread.Join(1000);
                thread = null;
            }
        }

        private static void Pump(ManualResetEvent ready)
        {
            threadId = Native.GetCurrentThreadId();
            mouseProc = OnMouse;
            keyProc = OnKey;
            eventProc = OnForeground;
            IntPtr module = Native.GetModuleHandle(null);
            mouseHook = Native.SetWindowsHookEx(14, mouseProc, module, 0);
            keyHook = Native.SetWindowsHookEx(13, keyProc, module, 0);
            eventHook = Native.SetWinEventHook(3, 3, IntPtr.Zero, eventProc, 0, 0, 0);
            ready.Set();
            try
            {
                Native.MSG msg;
                while (Native.GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
                {
                    Native.TranslateMessage(ref msg);
                    Native.DispatchMessage(ref msg);
                }
            }
            finally
            {
                if (mouseHook != IntPtr.Zero) Native.UnhookWindowsHookEx(mouseHook);
                if (keyHook != IntPtr.Zero) Native.UnhookWindowsHookEx(keyHook);
                if (eventHook != IntPtr.Zero) Native.UnhookWinEvent(eventHook);
                mouseHook = keyHook = eventHook = IntPtr.Zero;
            }
        }

        private static IntPtr OnMouse(int code, IntPtr wParam, IntPtr lParam)
        {
            if (code >= 0)
            {
                int message = wParam.ToInt32();
                bool down = clickOnDown;
                string button = null;
                if (message == (down ? 0x201 : 0x202)) button = "left";
                else if (message == (down ? 0x204 : 0x205)) button = "right";
                else if (message == (down ? 0x207 : 0x208)) button = "middle";
                // A drag with the button held moves a scroll bar (or selects text): either way the page may be moving
                // under a ring, and a browser says where things are only half a second later.
                if (message == 0x201) { leftDown = true; dragging = false; downX = Marshal.ReadInt32(lParam, 0); downY = Marshal.ReadInt32(lParam, 4); }
                else if (message == 0x200 && leftDown)
                {
                    if (!dragging && Math.Abs(Marshal.ReadInt32(lParam, 0) - downX) + Math.Abs(Marshal.ReadInt32(lParam, 4) - downY) > 6) dragging = true;
                    if (dragging) Program.ScrollNow();
                }
                else if (message == 0x202) { if (dragging) Program.ScrollNow(); leftDown = false; dragging = false; }
                if (message == 0x20A || message == 0x20E)
                {
                    // The wheel turned: one line at most every 50 ms, so a caller can let its ring rest while the page moves.
                    long now = Program.NowMs();
                    Interlocked.Exchange(ref Program.WheelAt, Program.ClockMs);
                    if (now - lastWheel >= 50)
                    {
                        lastWheel = now;
                        Program.Emit("{\"event\":\"input\",\"kind\":\"wheel\",\"x\":" + Marshal.ReadInt32(lParam, 0) + ",\"y\":" + Marshal.ReadInt32(lParam, 4) + ",\"time\":" + now + "}");
                    }
                }
                if (button != null)
                {
                    int x = Marshal.ReadInt32(lParam, 0), y = Marshal.ReadInt32(lParam, 4);
                    int flags = Marshal.ReadInt32(lParam, 12);
                    Program.ForegroundSoon();
                    Program.Emit("{\"event\":\"input\",\"kind\":\"click\",\"x\":" + x + ",\"y\":" + y + ",\"button\":\"" + button + "\",\"injected\":" + ((flags & 1) != 0 ? "true" : "false") + ",\"time\":" + Program.NowMs() + "}");
                }
            }
            return Native.CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
        }

        private static bool Held(int vk)
        {
            return (Native.GetAsyncKeyState(vk) & 0x8000) != 0;
        }

        private static IntPtr OnKey(int code, IntPtr wParam, IntPtr lParam)
        {
            if (code >= 0)
            {
                int message = wParam.ToInt32();
                if (message == 0x100 || message == 0x104)
                {
                    int vk = Marshal.ReadInt32(lParam, 0);
                    // PageUp, PageDown, End, Home, the arrows and Space scroll a page: noted here, never sent anywhere.
                    if (((vk >= 0x21 && vk <= 0x28) || vk == 0x20) && !Held(0x12)) Program.ScrollKey();
                    // Only these leave the process: Ctrl+V or Shift+Insert as "paste", and the keys the caller named.
                    if ((vk == 0x56 && Held(0x11) && !Held(0x12)) || (vk == 0x2D && Held(0x10)))
                    {
                        Program.Emit("{\"event\":\"input\",\"kind\":\"paste\",\"time\":" + Program.NowMs() + "}");
                    }
                    else if (watched.Contains(vk))
                    {
                        string name;
                        lock (KeyNames) KeyNames.TryGetValue(vk, out name);
                        if (name != null)
                        {
                            Program.Emit("{\"event\":\"input\",\"kind\":\"key\",\"key\":\"" + name + "\",\"ctrl\":" + (Held(0x11) ? "true" : "false") +
                                ",\"alt\":" + (Held(0x12) ? "true" : "false") + ",\"shift\":" + (Held(0x10) ? "true" : "false") + ",\"time\":" + Program.NowMs() + "}");
                        }
                    }
                }
            }
            return Native.CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
        }

        private static void OnForeground(IntPtr hook, uint evt, IntPtr hwnd, int idObject, int idChild, uint eventThread, uint time)
        {
            Program.ForegroundSoon();
        }
    }
}
