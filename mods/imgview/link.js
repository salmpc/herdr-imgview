// Ctrl-click on an image path in any terminal (this computer or another machine)
// opens it in imgview beside that terminal.
import { exec } from "herdr";
import { openImage } from "./open.js";

export async function handleLink({ link, source }) {
  if (link.kind !== "file" || !source.pane) return "pass";
  let file = link.path;
  if (!file) {
    // Remote or unresolved: work it out from the raw text and the terminal's folder.
    file = link.raw.replace(/^file:\/\/[^/]*/, "");
    try { file = decodeURIComponent(file); } catch {}
    file = file.replace(/(:\d+)+$/, "");
    if (file.startsWith("~/")) {
      const r = await exec("sh", ["-c", "printf %s \"$HOME\""], { on: source.machine });
      file = r.stdout.trim() + file.slice(1);
    } else if (!file.startsWith("/")) {
      if (!source.cwd) return "pass";
      file = source.cwd.replace(/\/$/, "") + "/" + file.replace(/^\.\//, "");
    }
  }
  return openImage({ file, on: source.machine, pane: source.pane }) ? "handled" : "pass";
}
