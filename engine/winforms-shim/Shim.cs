using System;
using System.Collections.Generic;
using System.Drawing;

namespace System.Windows.Forms
{
    public delegate void MethodInvoker();
    public delegate void PaintEventHandler(object sender, PaintEventArgs e);
    public enum DockStyle { None, Top, Bottom, Left, Right, Fill }
    public enum FormStartPosition { Manual, CenterScreen, WindowsDefaultLocation, WindowsDefaultBounds, CenterParent }
    public enum FormBorderStyle { None, FixedSingle, Fixed3D, FixedDialog, Sizable, FixedToolWindow, SizableToolWindow }
    public enum ProgressBarStyle { Blocks, Continuous, Marquee }
    public enum DialogResult { None, OK, Cancel, Abort, Retry, Ignore, Yes, No }

    public class PaintEventArgs : EventArgs
    {
        public Graphics Graphics { get; } = new Graphics();
    }

    public class Control : IDisposable
    {
        public string Text { get; set; } = string.Empty;
        public Size Size { get; set; }
        public int Width { get => Size.Width; set => Size = new Size(value, Size.Height); }
        public int Height { get => Size.Height; set => Size = new Size(Size.Width, value); }
        public DockStyle Dock { get; set; }
        public Color ForeColor { get; set; }
        public Color BackColor { get; set; }
        public bool Visible { get; set; }
        public List<Control> Controls { get; } = new List<Control>();
        public event PaintEventHandler Paint;
        public event EventHandler Click;
        public object Invoke(Delegate method) => method.DynamicInvoke();
        public object Invoke(Delegate method, params object[] args) => method.DynamicInvoke(args);
        public IAsyncResult BeginInvoke(Delegate method) { method.DynamicInvoke(); return null; }
        public void Show() { }
        public void Hide() { }
        public void Refresh() { }
        public void Invalidate() { }
        public void Dispose() { }
    }

    public class Form : Control
    {
        public FormStartPosition StartPosition { get; set; }
        public FormBorderStyle FormBorderStyle { get; set; }
        public bool MaximizeBox { get; set; }
        public bool MinimizeBox { get; set; }
        public bool TopMost { get; set; }
        public event EventHandler Shown;
        public event EventHandler Load;
        public void Close() { }
        public DialogResult ShowDialog() => DialogResult.Cancel;
    }

    public class ProgressBar : Control
    {
        public int Minimum { get; set; }
        public int Maximum { get; set; } = 100;
        public int Value { get; set; }
        public ProgressBarStyle Style { get; set; }
    }

    public class Label : Control { }
    public class Button : Control { }
    public class Panel : Control { }

    public static class Application
    {
        // No message loop and no window: the form is never shown, so Run returns at once.
        public static void Run(Form form) { }
        public static void DoEvents() { }
        public static void Exit() { }
    }

    public static class MessageBox
    {
        public static DialogResult Show(string text) => DialogResult.OK;
        public static DialogResult Show(string text, string caption) => DialogResult.OK;
    }
}

namespace System.Drawing
{
    public class Graphics : IDisposable
    {
        public void DrawString(string s, Font font, Brush brush, PointF point) { }
        public void Dispose() { }
    }

    public class Font : IDisposable
    {
        public Font(string familyName, float emSize) { }
        public void Dispose() { }
    }

    public class Brush : IDisposable
    {
        public void Dispose() { }
    }

    public static class Brushes
    {
        public static Brush White { get; } = new Brush();
        public static Brush Black { get; } = new Brush();
    }
}
