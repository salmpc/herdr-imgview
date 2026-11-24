// Same as mods/imgview/open.js (a mod can't import from another mod's folder). Keep them in step.
// Opens an image in an imgview pane to the right of a pane, replacing any
// imgview already open in that tab (one viewer per tab, like imgshow --pane).
import { run, panes, focused, notify, exec } from "herdr";

export function openImage({ file, on, pane }) {
  const all = panes();
  const src = all.find((p) => p.pane === pane);
  if (!src) return false;
  for (const p of all) {
    if (p.mod === "imgview" && p.tab === src.tab) run("pane.close", { pane: p.pane });
  }
  const before = new Set(all.map((p) => p.pane));
  run("pane.split", { direction: "right", pane, mod: "imgview", props: { file, on: on ?? null } });
  nameNewPane(before, src.tab, file.split("/").pop());
  const here = focused();
  if (here?.tab !== src.tab) {
    notify({
      title: "Image opened",
      body: `${file.split("/").pop()}, beside ${src.title || "an agent"}`,
      level: "info",
      action: { name: "pane.focus", args: { pane } },
    });
  }
  return true;
}

// run() returns nothing, so wait for the new viewer pane to show up and give it the file's name.
async function nameNewPane(before, tab, name) {
  for (let i = 0; i < 15; i++) {
    const p = panes().find((p) => p.mod === "imgview" && p.tab === tab && !before.has(p.pane));
    if (p) { run("pane.rename", { pane: p.pane, name }); return; }
    await exec("sleep", ["0.2"]).catch(() => {});
  }
}
