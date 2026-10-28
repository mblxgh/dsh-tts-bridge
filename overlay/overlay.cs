// 大肥鱼悬浮窗 —— 照 ACT OverlayPlugin 的那套做法。
//
//   · 置顶：每秒沿 Z 序往上爬一次，撞到游戏窗口才修（OverlayForm.cs 的 IsOverlaysGameWindow）
//   · 拖动：左键按住任意非按钮区域
//   · 缩放：右下角 16px
//   · 穿透：WS_EX_TRANSPARENT 动态开关，开了鼠标直接穿到游戏里
//   · 热键：TTS 全屏时鼠标可能被游戏捕获，所以每个动作用都配了键盘通道
//       Ctrl+Alt+K  敲一下
//       Ctrl+Alt+P  切穿透
//       Ctrl+Alt+O  透明度减 / Ctrl+Alt+I 透明度加
//       Ctrl+Alt+L  锁定位置
//       Ctrl+Alt+Q  退出
//   · 右键菜单：穿透 / 锁定 / 透明度 / 复位 / 退出
//   · 不进 Alt+Tab（WS_EX_TOOLWINDOW）、点击不抢游戏焦点（WS_EX_NOACTIVATE）
//   · 位置、尺寸、透明度、穿透、锁定写在 overlay.cfg，下次起来照旧
//
// 编译：
//   csc /nologo /target:winexe /codepage:65001 /win32manifest:overlay.manifest \
//       /out:overlay.exe overlay.cs /r:System.Drawing.dll /r:System.Windows.Forms.dll

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using System.Runtime.InteropServices;

// ─────────────────────────────── 配置 ───────────────────────────────
class Cfg
{
    public int X = -1, Y = 60, W = 320, H = 128;
    public double Opacity = 0.92;
    public bool ClickThru, Locked;
    public string Game = "go";   // 桌游种类
    public string Color = "";    // 我执什么色：B / W / 空=未定

    static string Path(Cfg _)
    {
        return System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "overlay.cfg");
    }

    public static Cfg Load()
    {
        var c = new Cfg();
        try
        {
            string f = Path(c);
            if (!File.Exists(f)) return c;
            foreach (string line in File.ReadAllLines(f, Encoding.UTF8))
            {
                int eq = line.IndexOf('=');
                if (eq <= 0) continue;
                string k = line.Substring(0, eq).Trim();
                string v = line.Substring(eq + 1).Trim();
                switch (k)
                {
                    case "x": c.X = int.Parse(v); break;
                    case "y": c.Y = int.Parse(v); break;
                    case "w": c.W = int.Parse(v); break;
                    case "h": c.H = int.Parse(v); break;
                    case "opacity": c.Opacity = double.Parse(v, System.Globalization.CultureInfo.InvariantCulture); break;
                    case "clickthru": c.ClickThru = v == "1"; break;
                    case "locked": c.Locked = v == "1"; break;
                    case "game": c.Game = v; break;
                    case "color": c.Color = v; break;
                }
            }
        }
        catch { }
        return c;
    }

    public void Save()
    {
        try
        {
            File.WriteAllLines(Path(this), new[]
            {
                "x=" + X,
                "y=" + Y,
                "w=" + W,
                "h=" + H,
                "opacity=" + Opacity.ToString(System.Globalization.CultureInfo.InvariantCulture),
                "clickthru=" + (ClickThru ? "1" : "0"),
                "locked=" + (Locked ? "1" : "0"),
                "game=" + Game,
                "color=" + Color,
            }, Encoding.UTF8);
        }
        catch { }
    }
}

// ─────────────────────────────── 窗体 ───────────────────────────────
class Overlay : Form
{
    // ── Win32 ──
    [DllImport("user32.dll")]
    static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")]
    static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")]
    static extern int GetWindowLong(IntPtr h, int idx);
    [DllImport("user32.dll")]
    static extern int SetWindowLong(IntPtr h, int idx, int val);
    [DllImport("user32.dll")]
    static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
    [DllImport("user32.dll")]
    static extern bool UnregisterHotKey(IntPtr h, int id);

    // ── 逐像素 alpha ──
    // WinForms 的窗口天生是矩形：圆角用画笔描，四角外面仍然被 BackColor 刷满，
    // 看起来还是方块，而且边缘是硬的。只有分层窗口 + 每像素 alpha 才能让圆角真的透出去。
    [StructLayout(LayoutKind.Sequential)] struct LPoint { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct LSize { public int cx, cy; }
    [StructLayout(LayoutKind.Sequential)]
    struct BlendFunction { public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat; }

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst,
        ref LPoint pptDst, ref LSize psize, IntPtr hdcSrc, ref LPoint pptSrc,
        int crKey, ref BlendFunction pblend, int dwFlags);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr hdc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out WRect r);

    [StructLayout(LayoutKind.Sequential)]
    struct WRect { public int Left, Top, Right, Bottom; }

    // 这台机器上 WinForms 的 Form.Left/Top 跟真实物理坐标不是一回事（多屏 + DPI 换算，
    // 实测差两百多像素，而且不是固定偏移）。所以定位一律用 GetWindowRect / SetWindowPos 的真坐标，
    // 别拿 Form.Bounds 去算别人的位置。
    static Rectangle RealBounds(IntPtr h)
    {
        if (h == IntPtr.Zero) return Rectangle.Empty;
        WRect r;
        if (!GetWindowRect(h, out r)) return Rectangle.Empty;
        return Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom);
    }

    static void MoveTo(IntPtr h, int x, int y)
    {
        SetWindowPos(h, IntPtr.Zero, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    }

    const int ULW_ALPHA = 2;
    const byte AC_SRC_OVER = 0;
    const byte AC_SRC_ALPHA = 1;
    const int WS_EX_LAYERED_ = 0x00080000;

    static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    const uint GW_HWNDPREV = 3;
    const uint SWP_NOSIZE = 0x0001;
    const uint SWP_NOMOVE = 0x0002;
    const uint SWP_NOZORDER = 0x0004;
    const uint SWP_NOACTIVATE = 0x0010;
    const uint SWP_FRAMECHANGED = 0x0020;
    const uint SWP_SHOWWINDOW = 0x0040;
    const int GWL_EXSTYLE = -20;
    const int WS_EX_TRANSPARENT = 0x00000020;
    const uint MOD_ALT = 0x0001;
    const uint MOD_CONTROL = 0x0002;
    const uint MOD_SHIFT = 0x0004;
    const uint MOD_NOREPEAT = 0x4000;
    const int WM_HOTKEY = 0x0312;

    const int HK_KNOCK = 1, HK_PEN = 2, HK_DIM = 3, HK_BRIGHT = 4, HK_LOCK = 5, HK_QUIT = 6;

    const int DRAG_H = 26;   // 标题栏高度：按住这里拖窗口
    const int GRIP = 22;     // 右下角缩放手柄边长
    const int SNAP = 12;     // 贴边吸附阈值

    // ── 配色（大肥鱼）──
    static readonly Color C_BG = Color.FromArgb(24, 56, 168);
    static readonly Color C_EDGE = Color.FromArgb(59, 146, 246);
    static readonly Color C_TEXT = Color.FromArgb(250, 250, 180);
    static readonly Color C_DIM = Color.FromArgb(180, 205, 215, 240);
    static readonly Color C_IDLE = Color.FromArgb(59, 146, 246);
    static readonly Color C_BUSY = Color.FromArgb(245, 195, 66);
    static readonly Color C_NONE = Color.FromArgb(138, 143, 163);

    // ── 状态 ──
    enum Phase { Unknown, Idle, Busy, Offline }
    Phase phase = Phase.Unknown;
    string message = "";
    Cfg cfg;

    static readonly string TracePath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "overlay-trace.log");
    internal static void T(string s)
    {
        try { File.AppendAllText(TracePath, DateTime.Now.ToString("HH:mm:ss.fff") + "  " + s + Environment.NewLine, Encoding.UTF8); }
        catch { }
    }

    // ── 交互 ──
    bool dragging, resizing;
    Point dragOrigin, resizeOrigin;
    Size resizeBase;
    Rectangle btnRect, gripRect;
    Rectangle gameRect, colorRect, chatRect;   // 游戏 / 执色 / 聊天 三个小按钮
    Rectangle[] quickRects = new Rectangle[4];   // 0 锁 / 1 菜单 / 2 设置 / 3 穿透
    int hoverQuick = -1;
    int hoverSel = -1;   // 0 游戏 / 1 执色 / 2 聊天

    // ── 节拍 ──
    System.Windows.Forms.Timer uiTick;
    System.Threading.Timer netTick;
    int checks, fixes;
    bool busyKnocking;

    // 游戏窗口句柄缓存（照 ACT：进程没了就重找，15 秒重试间隔）
    static readonly object procLock = new object();
    static Process gameProc;
    static DateTime lastTry = DateTime.MinValue;
    static readonly TimeSpan tryInterval = TimeSpan.FromSeconds(15);

    static IntPtr GameHandle()
    {
        lock (procLock)
        {
            if (gameProc != null && gameProc.HasExited) gameProc = null;
            if (gameProc == null && DateTime.Now - lastTry > tryInterval)
            {
                gameProc = Process.GetProcessesByName("Tabletop Simulator").FirstOrDefault();
                lastTry = DateTime.Now;
            }
            return gameProc != null ? gameProc.MainWindowHandle : IntPtr.Zero;
        }
    }

    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams cp = base.CreateParams;
            cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE：点击不抢游戏焦点
            cp.ExStyle |= 0x00000080; // WS_EX_TOOLWINDOW：不进 Alt+Tab
            cp.ExStyle |= WS_EX_LAYERED_; // 分层窗口，UpdateLayeredWindow 必需
            return cp;
        }
    }

    public Overlay(Cfg c)
    {
        T("ctor begin");
        cfg = c;
        // 关键：WinForms 默认按 96 DPI 基准的逻辑坐标缩放 Form.Location，
        // 而 Screen.WorkingArea 拿到的是物理像素。不清掉这个缩放，
        // 算出来的位置会被系统再乘一次缩放比，窗口直接飞出屏幕。
        AutoScaleMode = AutoScaleMode.None;
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = false;
        TopMost = true;
        DoubleBuffered = true;
        BackColor = C_BG;
        Text = "大肥鱼";
        // 注意：不要设 Form.Opacity —— 它内部会调 SetLayeredWindowAttributes，
        // 跟 UpdateLayeredWindow 抢同一条路，结果是整窗发灰或者干脆画不出来。
        // 透明度改由 Render() 里的 SourceConstantAlpha 控制。

        Relayout();
        // 夹紧范围按「整个虚拟桌面」算，不能只算主屏 —— 否则窗口放副屏，重启就被拽回主屏
        Rectangle wa = SystemInformation.VirtualScreen;
        T("screen virtual=" + wa + " primary=" + Screen.PrimaryScreen.WorkingArea);
        if (cfg.X < 0) cfg.X = wa.Right - Width - 24;
        // 夹回可见范围 —— DPI 缩放会让算出来的位置跑到屏幕外
        cfg.X = Math.Max(wa.Left, Math.Min(cfg.X, wa.Right - Width));
        cfg.Y = Math.Max(wa.Top, Math.Min(cfg.Y, wa.Bottom - Height));
        Location = new Point(cfg.X, cfg.Y);
        ApplyClickThru();

        uiTick = new System.Windows.Forms.Timer { Interval = 400 };
        uiTick.Tick += delegate { Render(); };
        uiTick.Start();

        netTick = new System.Threading.Timer(Poll, null, 300, 1000);

        BuildMenu();
        T("ctor end, size=" + Width + "x" + Height + " loc=" + Location.X + "," + Location.Y + " opacity=" + Opacity);
    }

    void Relayout()
    {
        Width = Math.Max(240, cfg.W);
        Height = Math.Max(DRAG_H + 6 + 24 + 6 + 34 + 26, cfg.H);

        // 第二行：游戏选择 / 执色选择 / 聊天
        int selY = DRAG_H + 6;
        gameRect = new Rectangle(12, selY, 76, 24);
        colorRect = new Rectangle(94, selY, 76, 24);
        chatRect = new Rectangle(Width - 12 - 34, selY, 34, 24);

        // 主按钮占剩下的，底部留 26px 给缩放手柄
        int btnTop = selY + 24 + 6;
        btnRect = new Rectangle(12, btnTop, Width - 24, Height - btnTop - 26);

        gripRect = new Rectangle(Width - GRIP, Height - GRIP, GRIP, GRIP);

        // 标题栏右侧四个快捷按钮，从右往左排：穿透、设置、菜单、锁定
        const int qs = 20, qg = 3;
        int right = Width - 8;
        for (int i = 3; i >= 0; i--)
        {
            right -= qs;
            quickRects[i] = new Rectangle(right, (DRAG_H - qs) / 2, qs, qs);
            right -= qg;
        }
    }

    // ── 置顶纠正：只读爬链，被压了才动 ──
    void ZFixTick()
    {
        checks++;
        if (!Visible) { if (checks % 10 == 0) T("zfix: not visible"); return; }
        IntPtr game = GameHandle();
        if (game == IntPtr.Zero) { if (checks % 10 == 0) T("zfix: game not found"); return; }
        IntPtr h = Handle;
        bool behind = false;
        while (h != IntPtr.Zero)
        {
            if (h == game) { behind = true; break; }
            h = GetWindow(h, GW_HWNDPREV);
        }
        if (!behind)
        {
            if (checks % 20 == 0) T("zfix: on top (checks=" + checks + " fixes=" + fixes + ")");
            return;
        }
        SetWindowPos(Handle, HWND_TOPMOST, 0, 0, 0, 0,
            SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
        fixes++;
        T("ZReorder: was behind the game, fixed  #" + fixes);
    }

    // ── 网络 ──
    // 对接的是 dsh 插件（dsh-tts-bridge）而不是那个 node 接收端：
    //   GET  /status  → dsh 在不在（同时也是「重连」：每秒问一次，回来就自动恢复）
    //   POST /knock   → 插件读盘后直接往当前会话塞一条消息
    const string BASE = "http://127.0.0.1:39902";

    static string HttpGet(string url, int timeoutMs)
    {
        var req = (HttpWebRequest)WebRequest.Create(url);
        req.Timeout = timeoutMs;
        req.ReadWriteTimeout = timeoutMs;
        req.Proxy = null;
        using (var resp = (HttpWebResponse)req.GetResponse())
        using (var sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
            return sr.ReadToEnd();
    }

    // 三态由插件给的 busy 决定，不靠「HTTP 慢不慢」猜：
    //   busy=true  → 有任务在跑，显示「思考中」
    //   busy=false → 空闲，显示「待机」
    //   连不上     → 「掉线」，每秒判一次
    void Poll(object _)
    {
        try
        {
            string body = HttpGet(BASE + "/status", 1200);
            SetPhase(body.Contains("\"busy\":true") ? Phase.Busy : Phase.Idle, null);
        }
        catch
        {
            SetPhase(Phase.Offline, null);
        }
    }

    void SetPhase(Phase p, string msg)
    {
        if (IsDisposed) return;
        try
        {
            BeginInvoke(new Action(delegate
            {
                bool changed = phase != p || (msg != null && message != msg);
                phase = p;
                if (msg != null) message = msg;
                if (changed) Render();
            }));
        }
        catch { }
    }

    void Knock()
    {
        if (busyKnocking) return;
        if (phase == Phase.Offline) { message = "dsh 没在跑"; Render(); return; }
        if (phase == Phase.Busy) { message = "还在想，等一下"; Render(); return; }

        busyKnocking = true;
        SetPhase(Phase.Busy, "敲了…");
        ThreadPool.QueueUserWorkItem(delegate
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(BASE + "/knock");
                req.Method = "POST";
                req.ContentType = "application/json; charset=utf-8";
                req.Timeout = 15000;
                req.Proxy = null;
                // 把当前选的对局配置一起带上，我那边就知道这盘该执什么色
                string payload = "{\"game\":" + JsonStr(cfg.Game) + ",\"color\":" + JsonStr(cfg.Color) + "}";
                byte[] body = Encoding.UTF8.GetBytes(payload);
                req.ContentLength = body.Length;
                using (var st = req.GetRequestStream()) st.Write(body, 0, body.Length);
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                {
                    string said = sr.ReadToEnd().Trim();
                    SetPhase(Phase.Busy, said.Length > 0 ? said : "敲到了");
                }
            }
            catch (Exception ex)
            {
                SetPhase(Phase.Offline, "敲不到：" + ex.GetType().Name);
            }
            finally { busyKnocking = false; }
        });
    }

    // ── 穿透 ──
    void ApplyClickThru()
    {
        // 不能用整窗的 WS_EX_TRANSPARENT —— 那样连「解除穿透」的按钮一起穿透，
        // 点什么都点不到，只能靠热键回来。改成在 WM_NCHITTEST 里逐区域回答：
        // 穿透按钮那块永远归我，其余的点一律让给下面的窗口。
        Render();
        T("clickthru=" + cfg.ClickThru);
    }

    // ── 右键菜单 ──
    ContextMenuStrip menu;

    void BuildMenu()
    {
        menu = new ContextMenuStrip();

        menu.Items.Add("敲一下", null, delegate { Knock(); });
        menu.Items.Add(new ToolStripSeparator());

        var pen = new ToolStripMenuItem("点击穿透");
        pen.Click += delegate { TogglePen(); };
        menu.Items.Add(pen);

        var lockItem = new ToolStripMenuItem("锁定位置");
        lockItem.Click += delegate
        {
            cfg.Locked = !cfg.Locked;
            cfg.Save();
            Render();
            T("locked=" + cfg.Locked);
        };
        menu.Items.Add(lockItem);

        menu.Items.Add("透明度 +", null, delegate { ChangeOpacity(0.05); });
        menu.Items.Add("透明度 −", null, delegate { ChangeOpacity(-0.05); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("回到右上角", null, delegate
        {
            Rectangle wa = Screen.PrimaryScreen.WorkingArea;
            cfg.X = wa.Right - Width - 24;
            cfg.Y = wa.Top + 60;
            Location = new Point(cfg.X, cfg.Y);
            cfg.Save();
        });
        menu.Items.Add("退出", null, delegate { Close(); });

        // 菜单永远是鼠标的第一入口，热键只写在旁边当提示
        menu.Opening += delegate
        {
            pen.Text = (cfg.ClickThru ? "✓ " : "") + "点击穿透        穿透后只能按 Ctrl+Alt+P 回来";
            lockItem.Text = (cfg.Locked ? "✓ " : "") + "锁定位置";
        };
        ContextMenuStrip = menu;
    }

    void TogglePen()
    {
        cfg.ClickThru = !cfg.ClickThru;
        ApplyClickThru();
        cfg.Save();
    }

    void ChangeOpacity(double d)
    {
        cfg.Opacity = Math.Max(0.2, Math.Min(1.0, cfg.Opacity + d));
        cfg.Save();
        Render();
    }

    // ── 绘制 ──
    /// <summary>把界面画到一张 ARGB 位图上，再用 UpdateLayeredWindow 贴上去 —— 四角才是真透明。</summary>
    void Render()
    {
        if (!IsHandleCreated || Width <= 0 || Height <= 0) return;

        using (var bmp = new Bitmap(Width, Height, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
        {
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
                g.Clear(Color.Transparent);   // 圆角外面从这里透出去
                PaintContent(g);
            }

            IntPtr hScreen = GetDC(IntPtr.Zero);
            IntPtr hMem = CreateCompatibleDC(hScreen);
            IntPtr hBmp = IntPtr.Zero;
            IntPtr hOld = IntPtr.Zero;
            try
            {
                hBmp = bmp.GetHbitmap(Color.FromArgb(0));
                hOld = SelectObject(hMem, hBmp);

                var dst = new LPoint { X = Left, Y = Top };
                var src = new LPoint { X = 0, Y = 0 };
                var size = new LSize { cx = Width, cy = Height };
                var blend = new BlendFunction
                {
                    BlendOp = AC_SRC_OVER,
                    BlendFlags = 0,
                    SourceConstantAlpha = (byte)Math.Max(0, Math.Min(255, cfg.Opacity * 255.0)),
                    AlphaFormat = AC_SRC_ALPHA,
                };
                UpdateLayeredWindow(Handle, hScreen, ref dst, ref size, hMem, ref src, 0, ref blend, ULW_ALPHA);
            }
            finally
            {
                if (hOld != IntPtr.Zero) SelectObject(hMem, hOld);
                if (hBmp != IntPtr.Zero) DeleteObject(hBmp);
                if (hMem != IntPtr.Zero) DeleteDC(hMem);
                ReleaseDC(IntPtr.Zero, hScreen);
            }
        }
    }

    void PaintContent(Graphics g)
    {
        using (var bg = new SolidBrush(C_BG))
        // 穿透时边框变黄加粗：一眼能看出「现在我摸不到，只有右上那个圈能点」
        using (var edge = new Pen(cfg.ClickThru ? C_BUSY : C_EDGE, cfg.ClickThru ? 2.2f : 1.5f))
        using (var path = Round(new Rectangle(1, 1, Width - 3, Height - 3), 10))
        {
            g.FillPath(bg, path);
            g.DrawPath(edge, path);
        }

        // ── 标题栏：拖动点阵 + 名字 ──
        using (var dots = new SolidBrush(Color.FromArgb(105, C_TEXT)))
            for (int r = 0; r < 2; r++)
                for (int c = 0; c < 3; c++)
                    g.FillEllipse(dots, 10 + c * 5, 10 + r * 5, 2.2f, 2.2f);

        using (var f = new Font("Microsoft YaHei UI", 11f, FontStyle.Bold))
        using (var b = new SolidBrush(C_TEXT))
            g.DrawString("大肥鱼", f, b, 31, 4);

        // 锁图标：锁上时出现在名字右边
        if (cfg.Locked)
        {
            using (var p = new Pen(Color.FromArgb(210, C_BUSY), 1.4f))
            {
                g.DrawRectangle(p, 82, 9, 7, 6);
                g.DrawArc(p, 82.5f, 4.5f, 6, 7, 180, 180);
            }
        }

        // 状态点 + 状态字，贴在快捷按钮左边
        Color dot = phase == Phase.Idle ? C_IDLE : phase == Phase.Busy ? C_BUSY : C_NONE;
        string label = phase == Phase.Idle ? "待机" : phase == Phase.Busy ? "思考中" : phase == Phase.Offline ? "掉线" : "…";
        using (var f = new Font("Microsoft YaHei UI", 9.5f))
        using (var b = new SolidBrush(dot))
        {
            var sz = g.MeasureString(label, f);
            float tx = quickRects[0].X - 8 - sz.Width;
            g.FillEllipse(b, tx - 12, 12, 7, 7);
            g.DrawString(label, f, b, tx, 8);
        }

        // 标题栏右侧四个快捷按钮：锁定 / 菜单 / 设置 / 穿透
        for (int i = 0; i < 4; i++) PaintQuick(g, i, quickRects[i]);

        // ── 第二行：游戏 / 执色 / 聊天 ──
        PaintChip(g, gameRect, cfg.Game == "go" ? "围棋 ▾" : cfg.Game + " ▾", hoverSel == 0);
        PaintChip(g, colorRect,
            cfg.Color == "B" ? "执黑 ▾" : cfg.Color == "W" ? "执白 ▾" : "执色 ▾",
            hoverSel == 1);
        PaintChip(g, chatRect, "聊", hoverSel == 2 || (chatWin != null && !chatWin.IsDisposed));

        // ── 按钮 ──
        bool usable = phase == Phase.Idle;
        using (var btn = new SolidBrush(usable ? C_EDGE : Color.FromArgb(68, 88, 118)))
        using (var path = Round(btnRect, 8))
            g.FillPath(btn, path);

        // 按钮文字三样，跟状态严格对应，不再混「敲到了」这类一次性提示
        string caption = usable ? "敲一下"
            : phase == Phase.Busy ? "思考中" : "掉线";
        if (caption.Length > 14) caption = caption.Substring(0, 13) + "…";
        using (var f = new Font("Microsoft YaHei UI", 12.5f, FontStyle.Bold))
        using (var b = new SolidBrush(usable ? C_BG : Color.FromArgb(165, 195, 215, 240)))
        {
            var sz = g.MeasureString(caption, f);
            g.DrawString(caption, f, b,
                btnRect.X + (btnRect.Width - sz.Width) / 2,
                btnRect.Y + (btnRect.Height - sz.Height) / 2);
        }

        // ── 缩放手柄：实心三角，比三条细线显眼得多 ──
        using (var b = new SolidBrush(Color.FromArgb(130, C_EDGE)))
        {
            g.FillPolygon(b, new[]
            {
                new PointF(Width - 4, Height - 4),
                new PointF(Width - 17, Height - 4),
                new PointF(Width - 4, Height - 17),
            });
        }
    }

    /// <summary>第二行的小胶囊按钮（游戏 / 执色 / 聊天）</summary>
    void PaintChip(Graphics g, Rectangle r, string label, bool hot)
    {
        using (var b = new SolidBrush(Color.FromArgb(hot ? 95 : 55, C_TEXT)))
        using (var p = Round(r, 6))
            g.FillPath(b, p);
        using (var f = new Font("Microsoft YaHei UI", 9f))
        using (var b = new SolidBrush(Color.FromArgb(240, C_TEXT)))
        {
            var sz = g.MeasureString(label, f);
            g.DrawString(label, f, b,
                r.X + (r.Width - sz.Width) / 2,
                r.Y + (r.Height - sz.Height) / 2);
        }
    }

    /// <summary>标题栏快捷按钮：0 锁 / 1 菜单 / 2 设置 / 3 穿透</summary>
    void PaintQuick(Graphics g, int i, Rectangle r)
    {
        bool on = (i == 0 && cfg.Locked) || (i == 3 && cfg.ClickThru);
        bool hot = (hoverQuick == i);

        if (on || hot)
        {
            using (var b = new SolidBrush(Color.FromArgb(on ? 100 : 45, C_TEXT)))
            using (var p = Round(r, 5))
                g.FillPath(b, p);
        }

        Color c = on ? C_BUSY : Color.FromArgb(hot ? 250 : 190, C_TEXT);
        int cx = r.X + r.Width / 2;
        int cy = r.Y + r.Height / 2;

        using (var pen = new Pen(c, 1.4f))
        {
            switch (i)
            {
                case 0: // 锁定：锁上时锁梁闭合，开锁时缺口朝右
                    g.DrawRectangle(pen, cx - 4, cy, 8, 6);
                    g.DrawArc(pen, cx - 3, cy - 6, 6, 8, 180, cfg.Locked ? 180 : 135);
                    break;

                case 1: // 菜单：三横
                    for (int k = -1; k <= 1; k++)
                        g.DrawLine(pen, cx - 5, cy + k * 4, cx + 5, cy + k * 4);
                    break;

                case 2: // 设置：三根滑块
                    {
                        g.DrawLine(pen, cx - 5, cy - 4, cx + 5, cy - 4);
                        g.DrawLine(pen, cx - 5, cy, cx + 5, cy);
                        g.DrawLine(pen, cx - 5, cy + 4, cx + 5, cy + 4);
                        using (var b = new SolidBrush(c))
                        {
                            g.FillEllipse(b, cx - 2, cy - 6, 3, 3);
                            g.FillEllipse(b, cx + 1, cy - 2, 3, 3);
                            g.FillEllipse(b, cx - 4, cy + 2, 3, 3);
                        }
                        break;
                    }

                default: // 穿透：空心 = 可点，实心 = 已穿透
                    {
                        g.DrawEllipse(pen, cx - 5, cy - 5, 10, 10);
                        if (cfg.ClickThru)
                            using (var b = new SolidBrush(c))
                                g.FillEllipse(b, cx - 2, cy - 2, 4, 4);
                        break;
                    }
            }
        }
    }

    static GraphicsPath Round(Rectangle r, int rad)
    {
        var p = new GraphicsPath();
        int d = rad * 2;
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    // ── 鼠标 ──
    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        if (e.Button != MouseButtons.Left) return;

        for (int i = 0; i < 4; i++)
            if (quickRects[i].Contains(e.Location)) { QuickAction(i); return; }

        if (gameRect.Contains(e.Location)) { PickGame(); return; }
        if (colorRect.Contains(e.Location)) { PickColor(); return; }
        if (chatRect.Contains(e.Location)) { OpenChat(); return; }

        if (btnRect.Contains(e.Location)) { Knock(); return; }

        if (!cfg.Locked && gripRect.Contains(e.Location))
        {
            resizing = true;
            resizeOrigin = Cursor.Position;
            resizeBase = Size;
            return;
        }

        // 只有标题栏能拖 —— 其余地方点了什么也不做，标准 Windows 行为
        if (e.Y < DRAG_H && !cfg.Locked)
        {
            dragging = true;
            dragOrigin = Cursor.Position;
        }
    }

    void QuickAction(int i)
    {
        if (i == 0)
        {
            cfg.Locked = !cfg.Locked;
            cfg.Save();
            Render();
            T("locked=" + cfg.Locked);
        }
        else if (i == 1) menu.Show(Cursor.Position);
        else if (i == 2) ShowSettings();
        else TogglePen();
    }

    // ── 游戏 / 执色 / 聊天 ──
    void PickGame()
    {
        var m = new ContextMenuStrip();
        var go = new ToolStripMenuItem("围棋");
        go.Checked = cfg.Game == "go";
        go.Click += delegate { cfg.Game = "go"; cfg.Save(); Render(); };
        m.Items.Add(go);
        m.Items.Add(new ToolStripSeparator());
        var more = new ToolStripMenuItem("（以后加别的桌游）");
        more.Enabled = false;
        m.Items.Add(more);
        m.Show(Cursor.Position);
    }

    void PickColor()
    {
        var m = new ContextMenuStrip();
        var opts = new[]
        {
            new { T = "我执黑（先手）", V = "B" },
            new { T = "我执白（后手）", V = "W" },
            new { T = "还没定", V = "" },
        };
        foreach (var o in opts)
        {
            var item = new ToolStripMenuItem(o.T);
            item.Checked = cfg.Color == o.V;
            string v = o.V;
            item.Click += delegate
            {
                cfg.Color = v;
                cfg.Save();
                Render();
            };
            m.Items.Add(item);
        }
        m.Show(Cursor.Position);
    }

    ChatWindow chatWin;

    // 「聊」是开关：开着再点一下就收起来
    void OpenChat()
    {
        if (chatWin != null && !chatWin.IsDisposed)
        {
            chatWin.Close();
            chatWin = null;
            Render();
            return;
        }

        chatWin = new ChatWindow();
        chatWin.FormClosed += delegate
        {
            chatWin = null;
            Render();
        };
        chatWin.Show(this);
        PlaceChat();
        Render();
    }

    // 摆聊天窗：左 → 右 → 上 → 下，哪个方向能整块站进某块屏的工作区就用哪个。
    // 先在本屏试，本屏塞不下就跨屏试；实在都不成就贴屏幕边缘，绝不压到主窗身上。
    void PlaceChat()
    {
        if (chatWin == null || chatWin.IsDisposed) return;

        Rectangle me = RealBounds(Handle);
        if (me.Width <= 0) me = new Rectangle(cfg.X, cfg.Y, Width, Height);
        Rectangle cb = RealBounds(chatWin.Handle);
        int cw = cb.Width > 0 ? cb.Width : chatWin.Width;
        int ch = cb.Height > 0 ? cb.Height : chatWin.Height;
        if (cw <= 0 || ch <= 0) return;

        const int gap = 10;
        Screen host = Screen.FromRectangle(me);
        Rectangle used = host.WorkingArea;
        Point pick = new Point(int.MinValue, int.MinValue);

        // 本屏优先，其余屏按 AllScreens 顺序兜底
        Screen[] order = new Screen[Screen.AllScreens.Length];
        order[0] = host;
        int k = 1;
        foreach (Screen s in Screen.AllScreens)
            if (s.DeviceName != host.DeviceName && k < order.Length) order[k++] = s;

        foreach (Screen sc in order)
        {
            if (sc == null) continue;
            Rectangle wa = sc.WorkingArea;
            Point[] cands = new Point[]
            {
                new Point(me.Left - cw - gap, me.Top),      // 左
                new Point(me.Right + gap, me.Top),          // 右
                new Point(me.Left, me.Top - ch - gap),      // 上
                new Point(me.Left, me.Bottom + gap),        // 下
            };
            foreach (Point p in cands)
            {
                if (p.X >= wa.Left && p.Y >= wa.Top &&
                    p.X + cw <= wa.Right && p.Y + ch <= wa.Bottom)
                {
                    pick = p;
                    used = wa;
                    break;
                }
            }
            if (pick.X != int.MinValue) break;
        }

        if (pick.X == int.MinValue)
        {
            // 哪块屏都塞不下：贴着主窗反方向的屏幕边缘，纵向夹进工作区
            int x = (me.Right > used.Right - cw) ? used.Left : used.Right - cw;
            pick = new Point(x, Math.Max(used.Top, Math.Min(me.Top, used.Bottom - ch)));
        }

        MoveTo(chatWin.Handle, pick.X, pick.Y);
        T("chat placed " + pick.X + "," + pick.Y + " me=" + me + " chat=" + cw + "x" + ch);
    }

    static string JsonStr(string s)
    {
        var sb = new StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c == '\n') sb.Append("\\n");
            else if (c == '\r') { }
            else if (c < ' ') sb.Append(' ');
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }

    void SendChat(string text)
    {
        ThreadPool.QueueUserWorkItem(delegate
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(BASE + "/chat");
                req.Method = "POST";
                req.ContentType = "application/json; charset=utf-8";
                req.Timeout = 15000;
                req.Proxy = null;
                byte[] data = Encoding.UTF8.GetBytes("{\"text\":" + JsonStr(text) + "}");
                req.ContentLength = data.Length;
                using (var s = req.GetRequestStream()) s.Write(data, 0, data.Length);
                using (var resp = (HttpWebResponse)req.GetResponse())
                {
                    using (var sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8)) sr.ReadToEnd();
                }
                T("chat 已发出：" + text.Substring(0, Math.Min(20, text.Length)));
            }
            catch (Exception ex)
            {
                T("chat 发送失败: " + ex.Message);
            }
        });
    }

    // 设置菜单：只放「调外观」的事，跟右键菜单（干活的事）分开
    void ShowSettings()
    {
        var m = new ContextMenuStrip();

        var op = new ToolStripMenuItem("透明度");
        foreach (int p in new[] { 100, 90, 75, 60, 40 })
        {
            int v = p;
            op.DropDownItems.Add(p + "%", null, delegate
            {
                cfg.Opacity = v / 100.0;
                cfg.Save();
                Render();
            });
        }
        m.Items.Add(op);

        var sz = new ToolStripMenuItem("大小");
        var presets = new[]
        {
            new { N = "小", W = 240, H = 94 },
            new { N = "中", W = 320, H = 104 },
            new { N = "大", W = 420, H = 124 },
        };
        foreach (var pr in presets)
        {
            var q = pr;
            sz.DropDownItems.Add(q.N + "  " + q.W + " × " + q.H, null, delegate
            {
                cfg.W = q.W;
                cfg.H = q.H;
                Relayout();
                Rectangle wa = Screen.PrimaryScreen.WorkingArea;
                cfg.X = Math.Max(wa.Left, Math.Min(cfg.X, wa.Right - Width));
                cfg.Y = Math.Max(wa.Top, Math.Min(cfg.Y, wa.Bottom - Height));
                Location = new Point(cfg.X, cfg.Y);
                cfg.Save();
                Render();
            });
        }
        m.Items.Add(sz);

        var pos = new ToolStripMenuItem("贴到屏幕");
        foreach (string q in new[] { "左上", "右上", "左下", "右下" })
        {
            string name = q;
            pos.DropDownItems.Add(q, null, delegate { SnapTo(name); });
        }
        m.Items.Add(pos);

        m.Show(Cursor.Position);
    }

    void SnapTo(string where)
    {
        Rectangle wa = Screen.FromRectangle(RealBounds(Handle)).WorkingArea;
        int x = where.Contains("右") ? wa.Right - Width : wa.Left;
        int y = where.Contains("下") ? wa.Bottom - Height : wa.Top;
        cfg.X = x;
        cfg.Y = y;
        MoveTo(Handle, x, y);
        cfg.Save();
        if (chatWin != null && !chatWin.IsDisposed) PlaceChat();
        T("snap to " + where);
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        if (dragging)
        {
            Point now = Cursor.Position;
            int dx = now.X - dragOrigin.X, dy = now.Y - dragOrigin.Y;
            if (dx != 0 || dy != 0)
            {
                Rectangle me = RealBounds(Handle);
                if (me.Width > 0) MoveTo(Handle, me.Left + dx, me.Top + dy);
                // 聊天窗跟着一起走，别让主窗一头撞上去
                if (chatWin != null && !chatWin.IsDisposed)
                {
                    Rectangle cb = RealBounds(chatWin.Handle);
                    if (cb.Width > 0) MoveTo(chatWin.Handle, cb.Left + dx, cb.Top + dy);
                }
            }
            dragOrigin = now;
            return;
        }
        if (resizing)
        {
            Point now = Cursor.Position;
            cfg.W = Math.Max(200, resizeBase.Width + now.X - resizeOrigin.X);
            cfg.H = Math.Max(DRAG_H + 68, resizeBase.Height + now.Y - resizeOrigin.Y);
            Relayout();
            return;
        }

        // 快捷按钮 / 第二行胶囊的悬停高亮
        int hover = -1;
        for (int i = 0; i < 4; i++)
            if (quickRects[i].Contains(e.Location)) { hover = i; break; }
        if (hover != hoverQuick) { hoverQuick = hover; Render(); }

        int sel = gameRect.Contains(e.Location) ? 0
            : colorRect.Contains(e.Location) ? 1
            : chatRect.Contains(e.Location) ? 2
            : -1;
        if (sel != hoverSel) { hoverSel = sel; Render(); }

        Cursor = hover >= 0 || sel >= 0 ? Cursors.Hand
            : btnRect.Contains(e.Location) ? Cursors.Hand
            : !cfg.Locked && gripRect.Contains(e.Location) ? Cursors.SizeNWSE
            : !cfg.Locked && e.Y < DRAG_H ? Cursors.SizeAll
            : Cursors.Default;
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        base.OnMouseLeave(e);
        if (hoverQuick != -1) { hoverQuick = -1; Render(); }
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        base.OnMouseUp(e);
        if (!dragging && !resizing) return;
        dragging = resizing = false;

        Rectangle me = RealBounds(Handle);
        if (me.Width <= 0) me = new Rectangle(cfg.X, cfg.Y, Width, Height);

        // 贴边吸附：拖到离屏幕边缘 SNAP 以内就贴住，省得自己对齐
        Rectangle wa = Screen.FromRectangle(me).WorkingArea;
        int x = me.Left, y = me.Top;
        if (Math.Abs(x - wa.Left) <= SNAP) x = wa.Left;
        if (Math.Abs(wa.Right - (x + me.Width)) <= SNAP) x = wa.Right - me.Width;
        if (Math.Abs(y - wa.Top) <= SNAP) y = wa.Top;
        if (Math.Abs(wa.Bottom - (y + me.Height)) <= SNAP) y = wa.Bottom - me.Height;
        MoveTo(Handle, x, y);

        cfg.X = x; cfg.Y = y;
        cfg.W = me.Width; cfg.H = me.Height;
        cfg.Save();
        T("moved to " + x + "," + y + " size=" + me.Width + "x" + me.Height);
    }

    protected override void OnMouseWheel(MouseEventArgs e)
    {
        base.OnMouseWheel(e);
        ChangeOpacity(e.Delta > 0 ? 0.04 : -0.04);
    }

    // ── 生命周期 ──
    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        T("OnShown, hwnd=" + Handle.ToInt64());
        SetWindowPos(Handle, HWND_TOPMOST, 0, 0, 0, 0,
            SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
        // Form.Location 会被 WinForms 按 DPI 换算跑偏，用真实物理坐标再定一次
        MoveTo(Handle, cfg.X, cfg.Y);
        T("OnShown pos=" + cfg.X + "," + cfg.Y + " real=" + RealBounds(Handle));

        // 热键只是加速通道，六个全部记结果 —— 之前只打了两个，L 没注册上都不知道
        uint mod = MOD_CONTROL | MOD_ALT | MOD_NOREPEAT;
        // Ctrl+Alt+L / Ctrl+Alt+O 在这台机器上被别的程序占了，换 Ctrl+Shift
        uint mod2 = MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT;
        T("hotkey K knock =" + RegisterHotKey(Handle, HK_KNOCK, mod, (uint)Keys.K));
        T("hotkey P pen   =" + RegisterHotKey(Handle, HK_PEN, mod, (uint)Keys.P));
        T("hotkey I bright=" + RegisterHotKey(Handle, HK_BRIGHT, mod, (uint)Keys.I));
        T("hotkey Q quit  =" + RegisterHotKey(Handle, HK_QUIT, mod, (uint)Keys.Q));
        T("hotkey O dim   =" + RegisterHotKey(Handle, HK_DIM, mod2, (uint)Keys.O));
        T("hotkey L lock  =" + RegisterHotKey(Handle, HK_LOCK, mod2, (uint)Keys.L));

        var z = new System.Threading.Timer(delegate { try { ZFixTick(); } catch (Exception ex) { T("zfix " + ex.Message); } }, null, 1000, 1000);
        FormClosed += delegate { z.Dispose(); };
        Render();   // 首次绘制：分层窗口不会自动画，得自己贴上去
        T("OnShown done");
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_HOTKEY)
        {
            int id = m.WParam.ToInt32();
            if (id == HK_KNOCK) Knock();
            else if (id == HK_PEN) TogglePen();
            else if (id == HK_DIM) ChangeOpacity(-0.05);
            else if (id == HK_BRIGHT) ChangeOpacity(0.05);
            else if (id == HK_LOCK) { cfg.Locked = !cfg.Locked; cfg.Save(); Render(); }
            else if (id == HK_QUIT) Close();
            return;
        }

        // 穿透时逐区域回答命中测试：只有右上那个穿透按钮还归我，别处的点一律让给下面的窗口。
        // 这样开了穿透还能用鼠标点回来，不必记热键。
        if (m.Msg == 0x0084 && cfg.ClickThru)
        {
            int lp = m.LParam.ToInt32();
            Point pt = PointToClient(new Point((short)(lp & 0xFFFF), (short)((lp >> 16) & 0xFFFF)));
            if (!quickRects[3].Contains(pt))
            {
                m.Result = new IntPtr(-1);   // HTTRANSPARENT
                return;
            }
        }

        base.WndProc(ref m);
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        T("OnFormClosed reason=" + e.CloseReason);
        foreach (int id in new[] { HK_KNOCK, HK_PEN, HK_DIM, HK_BRIGHT, HK_LOCK, HK_QUIT })
            UnregisterHotKey(Handle, id);
        cfg.Save();
        if (netTick != null) netTick.Dispose();
        if (uiTick != null) uiTick.Dispose();
        base.OnFormClosed(e);
    }
}

/// <summary>聊天输入框：独立小窗口，回车发送、Esc 取消。用普通窗口是因为要真输入框（含中文输入法）。</summary>
class ChatForm : Form
{
    public string Message = "";
    readonly TextBox box;

    public ChatForm()
    {
        AutoScaleMode = AutoScaleMode.None;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        Size = new Size(320, 58);
        BackColor = Color.FromArgb(24, 56, 168);
        Padding = new Padding(10, 13, 10, 13);

        box = new TextBox();
        box.BorderStyle = BorderStyle.None;
        box.BackColor = Color.FromArgb(240, 244, 255);
        box.ForeColor = Color.FromArgb(20, 30, 60);
        box.Font = new Font("Microsoft YaHei UI", 11f);
        box.Dock = DockStyle.Fill;
        box.ImeMode = ImeMode.On; // 中文输入法
        box.KeyDown += Box_KeyDown;
        Controls.Add(box);
    }

    void Box_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.KeyCode == Keys.Enter)
        {
            Message = box.Text.Trim();
            DialogResult = DialogResult.OK;
            Close();
            e.SuppressKeyPress = true;
        }
        else if (e.KeyCode == Keys.Escape)
        {
            DialogResult = DialogResult.Cancel;
            Close();
            e.SuppressKeyPress = true;
        }
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        Activate();
        box.Focus();
    }
}

/// <summary>
/// 聊天面板：上半是来回对话，下半是输入框。
/// 用独立普通窗口而不是画在悬浮窗里，是为了拿到真 RichTextBox（滚动、选中、中文输入法都省事）。
/// </summary>
class ChatWindow : Form
{
    const string BASE = "http://127.0.0.1:39902";

    readonly RichTextBox log;
    readonly TextBox input;
    readonly System.Threading.Timer poll;
    int seq = 0;
    int fails = 0;

    static readonly Color BG = Color.FromArgb(14, 34, 108);
    static readonly Color EDGE = Color.FromArgb(59, 146, 246);
    static readonly Color TXT = Color.FromArgb(250, 250, 180);

    public ChatWindow()
    {
        AutoScaleMode = AutoScaleMode.None;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        Size = new Size(430, 360);
        BackColor = BG;
        Padding = new Padding(12, 10, 12, 10);

        // 下半：输入框 + 发送
        var bottom = new Panel { Dock = DockStyle.Bottom, Height = 38 };
        var send = new Button
        {
            Text = "发",
            Dock = DockStyle.Right,
            Width = 52,
            FlatStyle = FlatStyle.Flat,
            BackColor = EDGE,
            ForeColor = BG,
            Font = new Font("Microsoft YaHei UI", 10f, FontStyle.Bold),
        };
        send.FlatAppearance.BorderSize = 0;
        send.Click += delegate { DoSend(); };

        input = new TextBox
        {
            Dock = DockStyle.Fill,
            BorderStyle = BorderStyle.None,
            BackColor = Color.FromArgb(240, 244, 255),
            ForeColor = Color.FromArgb(20, 30, 60),
            Font = new Font("Microsoft YaHei UI", 11f),
            ImeMode = ImeMode.On,
        };
        input.KeyDown += delegate(object s, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Enter && !e.Shift)
            {
                DoSend();
                e.SuppressKeyPress = true;
            }
            else if (e.KeyCode == Keys.Escape)
            {
                Close();
                e.SuppressKeyPress = true;
            }
        };
        bottom.Controls.Add(input);
        bottom.Controls.Add(send);

        // 上半：对话
        log = new RichTextBox
        {
            Dock = DockStyle.Fill,
            BorderStyle = BorderStyle.None,
            BackColor = Color.FromArgb(8, 20, 66),
            ForeColor = Color.FromArgb(220, 230, 250),
            Font = new Font("Microsoft YaHei UI", 10.5f),
            ReadOnly = true,
            ScrollBars = RichTextBoxScrollBars.Vertical,
        };

        Controls.Add(log);
        Controls.Add(bottom);

        poll = new System.Threading.Timer(Poll, null, 300, 1000);

        Shown += delegate { input.Focus(); };
    }

    void DoSend()
    {
        string text = input.Text.Trim();
        if (text.Length == 0) return;
        input.Clear();

        ThreadPool.QueueUserWorkItem(delegate
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(BASE + "/chat");
                req.Method = "POST";
                req.ContentType = "application/json; charset=utf-8";
                req.Timeout = 15000;
                req.Proxy = null;
                byte[] data = Encoding.UTF8.GetBytes("{\"text\":" + JsonStr(text) + "}");
                req.ContentLength = data.Length;
                using (var s = req.GetRequestStream()) s.Write(data, 0, data.Length);
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8)) sr.ReadToEnd();
            }
            catch (Exception ex)
            {
                try { BeginInvoke(new Action(delegate { Append("·", "发送失败：" + ex.Message, true); })); } catch { }
            }
        });
    }

    void Poll(object _)
    {
        try
        {
            string url = BASE + "/chatlog?since=" + seq;
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Timeout = 2000;
            req.Proxy = null;
            string body;
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8)) body = sr.ReadToEnd();
            fails = 0;

            // 极简 JSON 取出 items 里的 role/text/seq
            var items = MiniJson.ParseItems(body);
            if (items.Count == 0) return;
            try
            {
                BeginInvoke(new Action(delegate
                {
                    foreach (var it in items)
                    {
                        if (it.seq <= seq) continue;
                        seq = it.seq;
                        Append(it.role == "agent" ? "大肥鱼" : "主人", it.text, false);
                    }
                }));
            }
            catch { }
        }
        catch
        {
            fails++;
            if (fails == 3)
            {
                try { BeginInvoke(new Action(delegate { Append("·", "连不上 dsh", true); })); } catch { }
            }
        }
    }

    void Append(string who, string text, bool dim)
    {
        if (IsDisposed) return;
        log.SelectionStart = log.TextLength;
        log.SelectionLength = 0;
        log.SelectionColor = dim ? Color.FromArgb(140, 150, 175) : (who == "主人" ? Color.FromArgb(140, 200, 255) : TXT);
        log.AppendText(who + "  ");
        log.SelectionColor = Color.FromArgb(225, 232, 245);
        log.AppendText(text + "\n\n");
        log.SelectionStart = log.TextLength;
        log.ScrollToCaret();
    }

    static string JsonStr(string s)
    {
        var sb = new StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c == '\n') sb.Append("\\n");
            else if (c == '\r') { }
            else if (c < ' ') sb.Append(' ');
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        using (var p = new Pen(EDGE, 1.6f)) e.Graphics.DrawRectangle(p, 0, 0, Width - 1, Height - 1);
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        if (poll != null) poll.Dispose();
        base.OnFormClosed(e);
    }
}

/// <summary>够用就好的 JSON 片段解析：只认 /chatlog 的形状，不引第三方库。</summary>
static class MiniJson
{
    public class Item
    {
        public int seq;
        public string role = "";
        public string text = "";
    }

    public static List<Item> ParseItems(string s)
    {
        var list = new List<Item>();
        int at = s.IndexOf("\"items\"", StringComparison.Ordinal);
        if (at < 0) return list;
        int i = s.IndexOf('[', at);
        if (i < 0) return list;

        while (i < s.Length)
        {
            int objStart = s.IndexOf('{', i);
            if (objStart < 0) break;
            int objEnd = s.IndexOf('}', objStart);
            if (objEnd < 0) break;
            string obj = s.Substring(objStart, objEnd - objStart + 1);
            var item = new Item
            {
                seq = (int)ReadNum(obj, "\"seq\""),
                role = ReadStr(obj, "\"role\""),
                text = ReadStr(obj, "\"text\""),
            };
            if (item.seq > 0) list.Add(item);
            i = objEnd + 1;
            int close = s.IndexOf(']', i);
            int nextObj = s.IndexOf('{', i);
            if (nextObj < 0 || (close >= 0 && close < nextObj)) break;
        }
        return list;
    }

    static double ReadNum(string obj, string key)
    {
        int i = obj.IndexOf(key, StringComparison.Ordinal);
        if (i < 0) return 0;
        i = obj.IndexOf(':', i) + 1;
        var sb = new StringBuilder();
        for (; i < obj.Length; i++)
        {
            char c = obj[i];
            if (c == ',' || c == '}') break;
            if (!char.IsWhiteSpace(c)) sb.Append(c);
        }
        double v;
        return double.TryParse(sb.ToString(), out v) ? v : 0;
    }

    static string ReadStr(string obj, string key)
    {
        int i = obj.IndexOf(key, StringComparison.Ordinal);
        if (i < 0) return "";
        i = obj.IndexOf('"', obj.IndexOf(':', i) + 1);
        if (i < 0) return "";
        i++;
        var sb = new StringBuilder();
        bool esc = false;
        for (; i < obj.Length; i++)
        {
            char c = obj[i];
            if (esc)
            {
                esc = false;
                if (c == 'n') sb.Append('\n');
                else if (c == 't') sb.Append('\t');
                else sb.Append(c);
                continue;
            }
            if (c == '\\') { esc = true; continue; }
            if (c == '"') break;
            sb.Append(c);
        }
        return sb.ToString();
    }
}

static class Program
{
    static readonly string ErrLog = System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "overlay-error.log");

    static void LogEx(string tag, object ex)
    {
        try
        {
            File.AppendAllText(ErrLog,
                DateTime.Now.ToString("HH:mm:ss.fff") + " [" + tag + "] " + ex + Environment.NewLine + Environment.NewLine,
                Encoding.UTF8);
        }
        catch { }
    }

    [STAThread]
    static void Main()
    {
        AppDomain.CurrentDomain.UnhandledException += delegate (object s, UnhandledExceptionEventArgs e) { LogEx("appdomain", e.ExceptionObject); };
        Application.ThreadException += delegate (object s, ThreadExceptionEventArgs e) { LogEx("thread", e.Exception); };
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);

        try
        {
            Application.EnableVisualStyles();
            Overlay.T("Main: run begin");
            Application.Run(new Overlay(Cfg.Load()));
            Overlay.T("Main: run returned normally");
        }
        catch (Exception ex)
        {
            Overlay.T("Main: threw " + ex);
            LogEx("main", ex);
        }
    }
}
