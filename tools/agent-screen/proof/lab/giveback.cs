using System; using System.Runtime.InteropServices; using System.Threading;
static class G {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool on);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint flags);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  static IntPtr P(string s) { return new IntPtr(Convert.ToInt64(s.Substring(2), 16)); }
  static int Main(string[] a) {
    IntPtr his = P(a[0]); IntPtr fg = GetForegroundWindow();
    Console.WriteLine("fg now 0x" + fg.ToInt64().ToString("x"));
    if (fg == his) return 0;
    uint pid; uint owner = GetWindowThreadProcessId(fg, out pid); uint me = GetCurrentThreadId();
    bool j = AttachThreadInput(me, owner, true);
    bool ok = SetForegroundWindow(his);
    if (j) AttachThreadInput(me, owner, false);
    Thread.Sleep(80);
    Console.WriteLine("joined " + j + " set " + ok + " fg 0x" + GetForegroundWindow().ToInt64().ToString("x"));
    if (a.Length > 1) SetWindowPos(P(a[1]), new IntPtr(1), 0, 0, 0, 0, 0x13);
    return 0;
  }
}
