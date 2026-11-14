// quiet.exe: start a program without taking the keyboard, push its window to the bottom, report what happened.
//   quiet.exe start <exe> [args...]      -> JSON {pid, hwnd, fgBefore, fgAfter, stolen, restored}
//   quiet.exe bottom <hwnd>              push a window behind everything, no activation
//   quiet.exe place <hwnd> x y w h       move/size without activation (stays at the bottom)
//   quiet.exe close <hwnd>               WM_CLOSE
using System; using System.Diagnostics; using System.Runtime.InteropServices; using System.Text; using System.Threading; using System.Collections.Generic;
static class Quiet {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO { public int cb; public string r, desktop, title; public int x, y, xs, ys, xc, yc, fill, flags; public short show, r2; public IntPtr r3, i, o, e; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hp, ht; public uint pid, tid; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool on);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint flags);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr d);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder t, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder t, int max);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  delegate bool EnumProc(IntPtr h, IntPtr d);
  static List<IntPtr> Tops() { var all = new List<IntPtr>(); EnumProc p = (h, d) => { if (IsWindowVisible(h)) { var t = new StringBuilder(8); if (GetWindowText(h, t, 8) > 0) all.Add(h); } return true; }; EnumWindows(p, IntPtr.Zero); GC.KeepAlive(p); return all; }
  static string Hex(IntPtr h) { return "0x" + h.ToInt64().ToString("x"); }
  static IntPtr Parse(string s) { return new IntPtr(Convert.ToInt64(s.StartsWith("0x") ? s.Substring(2) : s, s.StartsWith("0x") ? 16 : 10)); }
  static bool GiveBack(IntPtr his, IntPtr taker) { uint pid; uint owner = GetWindowThreadProcessId(taker, out pid); uint me = GetCurrentThreadId(); bool j = AttachThreadInput(me, owner, true); SetForegroundWindow(his); if (j) AttachThreadInput(me, owner, false); return GetForegroundWindow() == his; }
  static int Main(string[] a) {
    SetProcessDpiAwarenessContext(new IntPtr(-4));
    if (a.Length >= 2 && a[0] == "bottom") { SetWindowPos(Parse(a[1]), new IntPtr(1), 0, 0, 0, 0, 0x13); return 0; }
    if (a.Length >= 6 && a[0] == "place") { IntPtr h = Parse(a[1]); ShowWindow(h, 4); SetWindowPos(h, new IntPtr(1), int.Parse(a[2]), int.Parse(a[3]), int.Parse(a[4]), int.Parse(a[5]), 0x10); return 0; }
    if (a.Length >= 2 && a[0] == "close") { PostMessage(Parse(a[1]), 0x10, IntPtr.Zero, IntPtr.Zero); return 0; }
    if (a.Length >= 2 && a[0] == "start") {
      var before = new HashSet<IntPtr>(Tops()); IntPtr fg0 = GetForegroundWindow();
      var cmd = new StringBuilder(); for (int i = 1; i < a.Length; i++) { if (i > 1) cmd.Append(' '); cmd.Append(a[i].Contains(" ") ? "\"" + a[i] + "\"" : a[i]); }
      var si = new STARTUPINFO(); si.cb = Marshal.SizeOf(typeof(STARTUPINFO)); si.flags = 1; si.show = 4; // STARTF_USESHOWWINDOW, SW_SHOWNOACTIVATE
      PROCESS_INFORMATION pi;
      if (!CreateProcess(null, cmd, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, null, ref si, out pi)) { Console.WriteLine("{\"error\":\"CreateProcess " + Marshal.GetLastWin32Error() + "\"}"); return 1; }
      IntPtr found = IntPtr.Zero; uint fpid = 0; bool stolen = false, restored = false; var sw = Stopwatch.StartNew();
      while (sw.ElapsedMilliseconds < 8000) {
        Thread.Sleep(50);
        IntPtr fg = GetForegroundWindow();
        if (fg != fg0 && fg != IntPtr.Zero && !before.Contains(fg)) { stolen = true; if (fg0 != IntPtr.Zero) restored = GiveBack(fg0, fg); }
        if (found == IntPtr.Zero) foreach (IntPtr h in Tops()) if (!before.Contains(h)) { var c = new StringBuilder(64); GetClassName(h, c, 64); string cls = c.ToString(); if (cls == "IME" || cls.StartsWith("MSCTFIME")) continue; found = h; GetWindowThreadProcessId(h, out fpid); break; }
        if (found != IntPtr.Zero) { SetWindowPos(found, new IntPtr(1), 0, 0, 0, 0, 0x13); if (sw.ElapsedMilliseconds > 1500) break; }
      }
      Console.WriteLine("{\"pid\":" + fpid + ",\"started\":" + pi.pid + ",\"hwnd\":\"" + Hex(found) + "\",\"fgBefore\":\"" + Hex(fg0) + "\",\"fgAfter\":\"" + Hex(GetForegroundWindow()) + "\",\"stolen\":" + (stolen ? "true" : "false") + ",\"restored\":" + (restored ? "true" : "false") + "}");
      return 0;
    }
    return 2;
  }
}
