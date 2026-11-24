// imgview: one image in a pane, with zoom and pan.
//   wheel           zoom toward the cursor        shift+wheel / drag   pan
//   double-click    fit <-> 100% at that point    + - 0 1              zoom in / out / fit / 100%
//   arrows          pan                           c copy  r reload  q/Esc close
// props: { file: absolute path, on: machine name or null for this computer }.
// The app draws only images inside its own folder, so the file is copied (from the
// other machine via `hc exec`) to <app home>/data/imgview/ and removed on close.
// It re-copies by itself when the file changes (an agent re-rendered it).
// Commands (keys.json "<key>": "imgview.<cmd>", or herdr-app do imgview.<cmd>):
//   zoom-in, zoom-out, fit, actual, copy, reload, close.
import { View, div, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, props, theme, appHome, run, panes, checking, nextCommand, settings } from "herdr";

// Sizes and pointer positions come in window pixels, but lengths we set are scaled by the
// app zoom (settings.json "zoom"), so divide measurements by it.
const Z = () => settings()?.zoom || 1;

const NATIVE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const ZOOM_MAX = 16;
let counter = 0;

// Copies src (already local) into dir as something GPUI draws, prints "w h name".
// ext set: a format GPUI draws, kept as is; the size comes from Pillow, or from the file's
// header when Pillow isn't installed. ext empty (TIFF, HEIC, AVIF...): Pillow converts to PNG.
const PREP = String.raw`
import os, sys, shutil, struct
src, dir, base, ext = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
def header_size(p):
    with open(p, "rb") as f: d = f.read(1 << 16)
    if d[:8] == b"\x89PNG\r\n\x1a\n": return struct.unpack(">II", d[16:24])
    if d[:6] in (b"GIF87a", b"GIF89a"): return struct.unpack("<HH", d[6:10])
    if d[:2] == b"BM": w, h = struct.unpack("<ii", d[18:26]); return w, abs(h)
    if d[:4] == b"RIFF" and d[8:12] == b"WEBP":
        k = d[12:16]
        if k == b"VP8X": return 1 + int.from_bytes(d[24:27], "little"), 1 + int.from_bytes(d[27:30], "little")
        if k == b"VP8 ": w, h = struct.unpack("<HH", d[26:30]); return w & 0x3fff, h & 0x3fff
        if k == b"VP8L": b = int.from_bytes(d[21:25], "little"); return (b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1
    if d[:2] == b"\xff\xd8":
        i = 2
        while i < len(d) - 9:
            if d[i] != 0xFF: i += 1; continue
            m = d[i + 1]
            if m in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                h, w = struct.unpack(">HH", d[i + 5:i + 9]); return w, h
            i += 2 + struct.unpack(">H", d[i + 2:i + 4])[0]
    raise SystemExit("unrecognised image")
try:
    from PIL import Image
except ImportError:
    Image = None
if ext:
    w, h = Image.open(src).size if Image else header_size(src)
    name = base + ext
    shutil.copyfile(src, os.path.join(dir, name))
else:
    if not Image: raise SystemExit("this format needs Pillow (pip install pillow)")
    im = Image.open(src); w, h = im.size
    im.seek(0); name = base + ".png"
    im.convert("RGBA").save(os.path.join(dir, name))
print(w, h, name)
`;

// Clipboard: xclip or wl-copy on Linux, osascript on macOS. Takes a PNG path.
const CLIP = 'if command -v osascript >/dev/null; then osascript -e "set the clipboard to (read (POSIX file \\"$1\\") as «class PNGf»)"; ' +
  'elif [ -n "$WAYLAND_DISPLAY" ] && command -v wl-copy >/dev/null; then wl-copy -t image/png < "$1"; ' +
  'else xclip -selection clipboard -t image/png -i "$1"; fi';

const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

export default class ImgView extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.file = p.file;
    this.on = p.on ?? null;
    this.name = (this.file || "").split("/").pop();
    this.dir = appHome() + "/data/imgview";
    this.state = "loading";          // loading | ready | error
    this.err = "";
    this.img = null;                 // path under the app home, for image()
    this.W = 0; this.H = 0;          // natural size
    this.s = 1; this.ox = 0; this.oy = 0;
    this.mode = "fit";               // fit | free
    this.cw = 0; this.ch = 0;        // canvas size
    this.drag = null;
    this.stamp = null;
    this.note = "";
    this.h = cx.focus_handle();
    if (checking()) return;
    cx.spawn(async (cx) => {       // pane.go hands us the keyboard; keys.json can send commands
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.h.focus();
        else if (c === "zoom-in") this.zoomAt(1.25);
        else if (c === "zoom-out") this.zoomAt(0.8);
        else if (c === "fit") this.fit();
        else if (c === "actual") this.actual();
        else if (c === "copy") this.copy(cx);
        else if (c === "reload") await this.load(cx, true);
        else if (c === "close") this.close_pane();
        cx.notify();
      }
    });
    cx.spawn(async (cx) => {
      await exec("sh", ["-c", `mkdir -p ${q(this.dir)} && find ${q(this.dir)} -type f -mmin +1440 -delete`]).catch(() => {});
      await this.load(cx);
    });
    // Re-copy when the file changes on disk.
    cx.timer.every(3000, (cx) => cx.spawn(async (cx) => {
      if (this.state === "loading" || this.busy) return;
      const st = await this.statFile();
      if (st && this.stamp && st !== this.stamp) await this.load(cx, true);
    }));
  }

  async statFile() {
    try {
      const r = await exec("sh", ["-c", 'stat -c %s:%Y "$1" 2>/dev/null || stat -f %z:%m "$1"', "sh", this.file],
        { on: this.on, timeout: 10000 });
      return r.code === 0 ? r.stdout.trim() : null;
    } catch { return null; }
  }

  async load(cx, keepView = false) {
    this.busy = true;
    try {
      if (!this.file) throw new Error("No file given");
      this.stamp = await this.statFile();
      if (!this.stamp) throw new Error(`Can't read ${this.file}${this.on ? " on " + this.on : ""}`);
      const base = `${Date.now()}-${++counter}`;
      const raw = `${this.dir}/${base}.raw`;
      // Fetch: a local copy, or the bytes from the other machine through herdr-core.
      const fetch = this.on
        ? await exec("sh", ["-c", 'hc exec --on "$1" cat -- "$2" > "$3"', "sh", this.on, this.file, raw], { timeout: 120000 })
        : await exec("cp", ["--", this.file, raw]);
      if (fetch.code !== 0) throw new Error((fetch.stderr || "copy failed").trim().slice(0, 300));
      const r = await exec("python3", ["-c", PREP, raw, this.dir, base, NATIVE.test(this.file) ? "." + this.file.split(".").pop().toLowerCase() : ""], { timeout: 60000 });
      await exec("rm", ["-f", raw]);
      if (r.code !== 0) throw new Error("Not an image I can read: " + (r.stderr.trim().split("\n").pop() || ""));
      const [w, h, name] = r.stdout.trim().split(/\s+/);
      const old = this.img;
      const sameSize = keepView && +w === this.W && +h === this.H;
      this.W = +w; this.H = +h;
      this.img = "data/imgview/" + name;
      this.state = "ready";
      if (!sameSize) this.fit();
      if (keepView) this.flash("reloaded");
      if (old) exec("rm", ["-f", appHome() + "/" + old]).catch(() => {});
    } catch (e) {
      this.state = "error";
      this.err = String(e?.message ?? e);
    }
    this.busy = false;
    cx.notify();
  }

  flash(text) { this.note = text; this.noteAt = Date.now(); }

  fitScale() {
    if (!this.W || !this.cw) return 1;
    return Math.min(this.cw / this.W, this.ch / this.H, 1);
  }

  fit() { this.mode = "fit"; this.s = this.fitScale(); this.clamp(); }

  clamp() {
    const iw = this.W * this.s, ih = this.H * this.s;
    this.ox = iw <= this.cw ? (this.cw - iw) / 2 : Math.min(0, Math.max(this.cw - iw, this.ox));
    this.oy = ih <= this.ch ? (this.ch - ih) / 2 : Math.min(0, Math.max(this.ch - ih, this.oy));
  }

  zoomAt(factor, px = this.cw / 2, py = this.ch / 2) {
    const min = Math.min(this.fitScale(), 1) * 0.5;
    const ns = Math.max(min, Math.min(ZOOM_MAX, this.s * factor));
    this.ox = px - (px - this.ox) * (ns / this.s);
    this.oy = py - (py - this.oy) * (ns / this.s);
    this.s = ns;
    this.mode = "free";
    this.clamp();
  }

  actual(px = this.cw / 2, py = this.ch / 2) { this.zoomAt(1 / this.s, px, py); }

  pt(e) { return e.local_position ? { x: e.local_position.x / Z(), y: e.local_position.y / Z() } : { x: this.cw / 2, y: this.ch / 2 }; }

  pan(dx, dy) { this.ox += dx; this.oy += dy; this.mode = "free"; this.clamp(); }

  myPane() {
    const mine = panes().filter((p) => p.mod === "imgview");
    return (mine.find((p) => p.focused) ?? (mine.length === 1 ? mine[0] : null))?.pane;
  }

  close_pane() {
    const pane = this.myPane();
    if (pane) run("pane.close", { pane });
  }

  copy(cx) {
    if (this.state !== "ready") return;
    const src = appHome() + "/" + this.img;
    const toPng = 'python3 -c "import sys; from PIL import Image; Image.open(sys.argv[1]).convert(\'RGBA\').save(sys.argv[2])" "$1" "$1.clip.png" ' +
      '|| sips -s format png "$1" --out "$1.clip.png" >/dev/null';
    const sh = /\.png$/i.test(src)
      ? `set -- "$1"; ${CLIP}`
      : `c="$1.clip.png"; ${toPng} && set -- "$c" && { ${CLIP}; }; r=$?; rm -f "$c"; exit $r`;
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", sh + " </dev/null >/dev/null 2>&1", "sh", src]).catch(() => ({ code: 1 }));
      this.flash(r.code === 0 ? "copied" : "copy failed");
      cx.notify();
    });
  }

  onKey(e, cx) {
    const k = e.keystroke;
    if (k === "+" || k === "=" || k === "shift-=" || k === "shift-+") this.zoomAt(1.25);
    else if (k === "-") this.zoomAt(0.8);
    else if (k === "0" || k === "f") this.fit();
    else if (k === "1") this.actual();
    else if (k === "left") this.pan(80, 0);
    else if (k === "right") this.pan(-80, 0);
    else if (k === "up") this.pan(0, 80);
    else if (k === "down") this.pan(0, -80);
    else if (k === "c") return this.copy(cx);
    else if (k === "r") return cx.spawn(async (cx) => this.load(cx, true));
    else if (k === "q" || k === "escape") return this.close_pane();
    else return;
    cx.notify();
  }

  button(t, id, label, fn) {
    return div().id(id).px(7).py(2).rounded(5).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { fn(cx); cx.notify(); }).child(label);
  }

  render(cx) {
    const t = theme();
    if (this.note && Date.now() - (this.noteAt || 0) > 2500) this.note = "";
    const pct = Math.round(this.s * 100);
    const where = this.on ? ` · ${this.on}` : "";
    const header = h_flex().h(30).flex_none().px(10).gap(4).items_center().bg(t.chrome).border_b(1).border_color(t.border).text_size(12)
      .when(this.state === "ready", (el) => el
        .child(div().text_color(t.dim).child(`${this.W}×${this.H} · ${pct}%${where}`))
        .when(Boolean(this.note), (el) => el.child(div().text_color(t.done).px(4).child(`✓ ${this.note}`))))
      .child(div().flex_1())
      .when(this.state === "ready", (el) => el
        .child(this.button(t, "fit", "Fit", () => this.fit()))
        .child(this.button(t, "one", "1:1", () => this.actual()))
        .child(this.button(t, "out", "−", () => this.zoomAt(0.8)))
        .child(this.button(t, "in", "+", () => this.zoomAt(1.25)))
        .child(this.button(t, "copy", "Copy", (cx) => this.copy(cx))))
      .child(this.button(t, "close", "✕", () => this.close_pane()));

    let body;
    if (this.state === "ready") {
      body = div().id("canvas").relative().flex_1().overflow_hidden().bg(t.background)
        .when(this.mode === "free" && this.s > this.fitScale(), (el) => el.cursor_grab())
        .child(image(this.img).absolute().left(this.ox).top(this.oy).w(this.W * this.s).h(this.H * this.s))
        .on_scroll_wheel((e, cx) => {
          const lines = e.delta_lines ? e.delta_lines : { x: e.delta.x / 40, y: e.delta.y / 40 };
          if (e.modifiers?.shift) this.pan((e.delta.x || e.delta.y) / Z(), e.delta.x ? e.delta.y / Z() : 0);
          else {
            const p = this.pt(e);
            this.zoomAt(Math.pow(1.2, Math.max(-3, Math.min(3, lines.y))), p.x, p.y);
          }
          cx.stop_propagation();
          cx.notify();
        })
        .on_pinch((e, cx) => {
          const p = this.pt(e);
          this.zoomAt(1 + e.delta, p.x, p.y);
          cx.notify();
        })
        .on_mouse_down("left", (e, cx) => {
          this.h.focus();
          if (e.click_count >= 2) {
            const p = this.pt(e);
            if (this.mode === "fit" || Math.abs(this.s - this.fitScale()) < 0.01) this.actual(p.x, p.y);
            else this.fit();
            this.drag = null;
            cx.notify();
            return;
          }
          this.drag = { x: e.position.x, y: e.position.y, ox: this.ox, oy: this.oy };
        })
        .on_mouse_move((e, cx) => {
          if (!this.drag) return;
          this.ox = this.drag.ox + (e.position.x - this.drag.x) / Z();
          this.oy = this.drag.oy + (e.position.y - this.drag.y) / Z();
          this.mode = "free";
          this.clamp();
          cx.notify();
        })
        .on_mouse_up("left", () => { this.drag = null; })
        .on_hover((hov) => { if (!hov) this.drag = null; });
    } else {
      body = v_flex().flex_1().items_center().justify_center().gap(6).p(20).bg(t.background).text_size(13)
        .child(div().text_color(this.state === "error" ? t.blocked : t.muted)
          .child(this.state === "error" ? this.err : `Loading ${this.name}${this.on ? " from " + this.on : ""}…`));
    }

    return v_flex().id("root").size_full().track_focus(this.h).key_context("ImgView")
      .on_key_down((e, cx) => this.onKey(e, cx))
      .on_size_change((size, cx) => {
        this.cw = size.width / Z(); this.ch = Math.max(0, size.height / Z() - 30);
        if (this.mode === "fit") this.fit(); else this.clamp();
        cx.notify();
      })
      .child(header).child(body);
  }

  async close() {
    if (this.img) await exec("rm", ["-f", appHome() + "/" + this.img]);
  }
}
