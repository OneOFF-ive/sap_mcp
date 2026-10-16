using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal sealed class GuiContext : ApplicationContext
{
    private readonly NotifyIcon tray;
    private readonly Process child;
    private readonly EventWaitHandle reopen;
    private readonly System.Windows.Forms.Timer timer;
    private readonly ToolStripMenuItem exitItem;
    private volatile Uri session;
    private bool opened;
    private volatile bool stopping;

    internal GuiContext(EventWaitHandle reopenEvent)
    {
        reopen = reopenEvent;
        var menu = new ContextMenuStrip();
        menu.Items.Add("打开管理界面", null, delegate { OpenBrowser(); });
        exitItem = new ToolStripMenuItem("退出 SAP MCP 管理", null, delegate { Stop(); });
        menu.Items.Add(exitItem);
        tray = new NotifyIcon { Text = "SAP MCP 管理", Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location), ContextMenuStrip = menu, Visible = true };
        tray.DoubleClick += delegate { OpenBrowser(); };
        var start = Launcher.Node(new[] { "ui", "--no-open" });
        start.CreateNoWindow = true;
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        start.StandardOutputEncoding = Encoding.UTF8;
        child = new Process { StartInfo = start };
        child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args)
        {
            const string prefix = "Management session URL: ";
            if (args.Data == null || !args.Data.StartsWith(prefix, StringComparison.Ordinal)) return;
            Uri candidate;
            if (Uri.TryCreate(args.Data.Substring(prefix.Length), UriKind.Absolute, out candidate) &&
                candidate.Scheme == "http" && candidate.Host == "127.0.0.1" && candidate.AbsolutePath == "/" && candidate.Fragment.Length > 1)
                session = candidate;
        };
        // Session URLs and diagnostics remain private; never write them to launcher logs.
        child.ErrorDataReceived += delegate { };
        child.Start(); child.BeginOutputReadLine(); child.BeginErrorReadLine();
        timer = new System.Windows.Forms.Timer { Interval = 500 };
        timer.Tick += delegate
        {
            if (child.HasExited)
            {
                if (child.ExitCode != 0 && !stopping)
                    MessageBox.Show("管理界面未能启动。请先关闭已有的管理进程，或运行 sapmcp doctor --json 检查。后台 MCP 服务可用 sapmcp service stop --json 正常停止。", "SAP MCP", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                timer.Stop(); tray.Dispose(); child.Dispose(); ExitThread(); return;
            }
            if ((!opened || reopen.WaitOne(0)) && session != null) { opened = true; OpenBrowser(); }
            exitItem.Enabled = !stopping && session != null;
        };
        timer.Start();
    }

    private void OpenBrowser()
    {
        if (session == null || stopping) return;
        try { Process.Start(new ProcessStartInfo(session.AbsoluteUri) { UseShellExecute = true }); }
        catch { MessageBox.Show("无法打开默认浏览器。请检查 Windows 默认浏览器设置。", "SAP MCP"); }
    }

    private void Stop()
    {
        if (session == null || stopping) return;
        stopping = true;
        ThreadPool.QueueUserWorkItem(delegate
        {
            try
            {
                var request = (HttpWebRequest)WebRequest.Create(new Uri(session, "/api/application/stop"));
                request.Method = "POST"; request.ContentLength = 0; request.Timeout = 5000;
                request.Proxy = null; request.AllowAutoRedirect = false;
                request.Headers["Origin"] = session.GetLeftPart(UriPartial.Authority);
                request.Headers["X-Admin-Token"] = session.Fragment.Substring(1);
                using (var response = request.GetResponse()) { }
            }
            catch
            {
                stopping = false;
                MessageBox.Show("未能确认退出请求，请稍后重试。现有进程没有被强制结束。", "SAP MCP");
            }
        });
    }
}

internal static class GuiProgram
{
    [STAThread]
    private static void Main()
    {
        string identity;
        using (var hash = SHA256.Create()) identity = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(Launcher.Root.ToUpperInvariant()))).Replace("-", "");
        bool first;
        using (var mutex = new Mutex(true, "Local\\SAPMCP.GUI." + identity, out first))
        using (var reopen = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\SAPMCP.GUI.Open." + identity))
        {
            if (!first) { reopen.Set(); return; }
            try
            {
                Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new GuiContext(reopen));
            }
            catch { MessageBox.Show("SAP MCP 无法启动，请修复安装或运行 sapmcp doctor --json 检查。", "SAP MCP"); }
            finally { mutex.ReleaseMutex(); }
        }
    }
}
