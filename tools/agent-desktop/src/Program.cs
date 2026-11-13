// agent-desktop prototype sidecar.
// Creates a separate desktop object the agent owns on the same window station (WinSta0),
// launches an app there (STARTUPINFO.lpDesktop), captures top-level windows with PrintWindow,
// and delivers input to window handles with PostMessage/SendMessage (not SendInput, which only
// reaches the one input desktop). JSON lines over stdio, like tools/agent-screen.
// Every command that touches the system records GetCursorPos + GetForegroundWindow before/after.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

static class P {
    [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    static extern IntPtr CreateDesktop(string name, IntPtr dev, IntPtr dm, int flags, uint access, IntPtr sa);
    [DllImport("user32.dll", SetLastError=true)] static extern bool CloseDesktop(IntPtr h);
    [DllImport("user32.dll", SetLastError=true)] static extern bool SetThreadDesktop(IntPtr h);
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr GetThreadDesktop(uint tid);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", SetLastError=true)] static extern bool EnumDesktopWindows(IntPtr desk, EnumWindowsProc cb, IntPtr p);
    delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr p);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);

    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L,T,R,B; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X,Y; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    struct STARTUPINFO { public int cb; public string res; public string desktop; public string title;
        public int x,y,xs,ys,xc,yc,fill,flags; public short show,cbr; public IntPtr lpr,si,so,se; }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hp, ht; public uint pid, tid; }
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inh, uint flags,
        IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

    const uint GENERIC_ALL = 0x10000000;
    const uint WM_LBUTTONDOWN=0x201, WM_LBUTTONUP=0x202, WM_CHAR=0x102, WM_MOUSEMOVE=0x200, WM_KEYDOWN=0x100, WM_KEYUP=0x101;
    const uint PW_RENDERFULLCONTENT = 2;
    const uint CREATE_NEW_CONSOLE = 0x10;

    static IntPtr g_desk = IntPtr.Zero;
    static string g_deskName = null;
    static List<uint> g_pids = new List<uint>();
    static JavaScriptSerializer J = new JavaScriptSerializer();

    static void Main() {
        var o = Console.OpenStandardOutput();
        var w = new StreamWriter(o, new UTF8Encoding(false)); w.AutoFlush = true;
        string line;
        var sr = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        while ((line = sr.ReadLine()) != null) {
            if (line.Trim().Length == 0) continue;
            Dictionary<string,object> req;
            try { req = (Dictionary<string,object>)J.DeserializeObject(line); }
            catch { w.WriteLine(J.Serialize(new { ok=false, error="bad json" })); continue; }
            object res;
            var g0 = Guard();
            try { res = Handle(req); } catch (Exception e) { res = new Dictionary<string,object>{{"ok",false},{"error",e.Message}}; }
            var g1 = Guard();
            var d = (Dictionary<string,object>)res;
            d["cursorMoved"] = g0[0]!=g1[0] || g0[1]!=g1[1];
            d["foregroundChanged"] = g0[2]!=g1[2];
            w.WriteLine(J.Serialize(d));
        }
    }

    static long[] Guard() {
        POINT p; GetCursorPos(out p);
        return new long[]{ p.X, p.Y, (long)GetForegroundWindow() };
    }

    static object Handle(Dictionary<string,object> r) {
        string cmd = r.ContainsKey("cmd") ? (string)r["cmd"] : "";
        switch (cmd) {
            case "open": return Open(Str(r,"name"));
            case "launch": return Launch(Str(r,"app"), Str(r,"args"));
            case "windows": return Windows();
            case "capture": return Capture(Hwnd(r), Str(r,"path"));
            case "click": return Click(Hwnd(r), Int(r,"x"), Int(r,"y"));
            case "type": return Type(Hwnd(r), Str(r,"text"));
            case "close": return Close();
            case "ping": return new Dictionary<string,object>{{"ok",true},{"desk",g_deskName}};
            default: return new Dictionary<string,object>{{"ok",false},{"error","unknown cmd "+cmd}};
        }
    }

    static object Open(string name) {
        if (string.IsNullOrEmpty(name)) name = "AgentDesk_" + Guid.NewGuid().ToString("N").Substring(0,8);
        g_desk = CreateDesktop(name, IntPtr.Zero, IntPtr.Zero, 0, GENERIC_ALL, IntPtr.Zero);
        if (g_desk == IntPtr.Zero) return Err("CreateDesktop failed err=" + Marshal.GetLastWin32Error());
        g_deskName = name;
        return new Dictionary<string,object>{{"ok",true},{"desk",name}};
    }

    static object Launch(string app, string args) {
        if (g_desk == IntPtr.Zero) return Err("no desktop open");
        var si = new STARTUPINFO(); si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.desktop = "WinSta0\\" + g_deskName;
        PROCESS_INFORMATION pi;
        string cmd = "\"" + app + "\"" + (string.IsNullOrEmpty(args) ? "" : " " + args);
        bool ok = CreateProcess(null, cmd, IntPtr.Zero, IntPtr.Zero, false, CREATE_NEW_CONSOLE, IntPtr.Zero, null, ref si, out pi);
        if (!ok) return Err("CreateProcess failed err=" + Marshal.GetLastWin32Error());
        g_pids.Add(pi.pid);
        return new Dictionary<string,object>{{"ok",true},{"pid",pi.pid}};
    }

    static object Windows() {
        if (g_desk == IntPtr.Zero) return Err("no desktop open");
        var list = new List<object>();
        EnumDesktopWindows(g_desk, (h, p) => {
            if (!IsWindowVisible(h)) return true;
            var sb = new StringBuilder(512); GetWindowTextW(h, sb, 512);
            RECT rc; GetWindowRect(h, out rc);
            uint pid; GetWindowThreadProcessId(h, out pid);
            if ((rc.R-rc.L) < 2 || (rc.B-rc.T) < 2) return true;
            list.Add(new Dictionary<string,object>{
                {"hwnd",(long)h},{"title",sb.ToString()},{"pid",pid},
                {"x",rc.L},{"y",rc.T},{"w",rc.R-rc.L},{"h",rc.B-rc.T}});
            return true;
        }, IntPtr.Zero);
        return new Dictionary<string,object>{{"ok",true},{"windows",list}};
    }

    static object Capture(IntPtr h, string path) {
        if (h == IntPtr.Zero) return Err("no hwnd");
        RECT rc; if (!GetWindowRect(h, out rc)) return Err("GetWindowRect failed");
        int ww = rc.R-rc.L, hh = rc.B-rc.T;
        if (ww<1||hh<1) return Err("zero size");
        using (var bmp = new Bitmap(ww, hh, PixelFormat.Format32bppArgb))
        using (var gr = Graphics.FromImage(bmp)) {
            IntPtr hdc = gr.GetHdc();
            bool ok = PrintWindow(h, hdc, PW_RENDERFULLCONTENT);
            gr.ReleaseHdc(hdc);
            if (!ok) return Err("PrintWindow failed");
            bmp.Save(path, ImageFormat.Png);
            // crude blank check: sample corners+centre
            var c0 = bmp.GetPixel(ww/2,hh/2); var c1 = bmp.GetPixel(2,2);
            return new Dictionary<string,object>{{"ok",true},{"path",path},{"w",ww},{"h",hh},
                {"centrePixel", c0.R+","+c0.G+","+c0.B},{"cornerPixel", c1.R+","+c1.G+","+c1.B}};
        }
    }

    static object Click(IntPtr h, int cx, int cy) {
        if (h == IntPtr.Zero) return Err("no hwnd");
        IntPtr lp = (IntPtr)((cy << 16) | (cx & 0xFFFF));
        PostMessage(h, WM_MOUSEMOVE, IntPtr.Zero, lp);
        PostMessage(h, WM_LBUTTONDOWN, (IntPtr)1, lp);
        PostMessage(h, WM_LBUTTONUP, IntPtr.Zero, lp);
        return new Dictionary<string,object>{{"ok",true},{"x",cx},{"y",cy}};
    }

    static object Type(IntPtr h, string text) {
        if (h == IntPtr.Zero) return Err("no hwnd");
        if (text == null) text = "";
        foreach (char ch in text) PostMessage(h, WM_CHAR, (IntPtr)ch, IntPtr.Zero);
        return new Dictionary<string,object>{{"ok",true},{"chars",text.Length}};
    }

    static object Close() {
        int killed = 0;
        foreach (var pid in g_pids) {
            try { var pr = System.Diagnostics.Process.GetProcessById((int)pid); pr.Kill(); killed++; } catch {}
        }
        g_pids.Clear();
        if (g_desk != IntPtr.Zero) { CloseDesktop(g_desk); g_desk = IntPtr.Zero; }
        g_deskName = null;
        return new Dictionary<string,object>{{"ok",true},{"killed",killed}};
    }

    static Dictionary<string,object> Err(string m){ return new Dictionary<string,object>{{"ok",false},{"error",m}}; }
    static string Str(Dictionary<string,object> r, string k){ return r.ContainsKey(k)&&r[k]!=null ? r[k].ToString() : null; }
    static int Int(Dictionary<string,object> r, string k){ return r.ContainsKey(k)&&r[k]!=null ? Convert.ToInt32(r[k]) : 0; }
    static IntPtr Hwnd(Dictionary<string,object> r){ return r.ContainsKey("hwnd")&&r["hwnd"]!=null ? (IntPtr)Convert.ToInt64(r["hwnd"]) : IntPtr.Zero; }
}
