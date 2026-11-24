// imgview-watch: lets an agent open an image in imgview beside its own terminal, on this
// computer or on any machine Herdr is connected to. Draws nothing; add it to the layout as a
// floating block so it is always running.
//
// The agent (or the `imgview` script) labels its own terminal:
//   hc label "$HC_TERMINAL_ID" "imgview.open=<unix time>|<absolute path>"
// This mod sees the label on that terminal, opens the file in an imgview pane to the right of
// the pane showing it (replacing an imgview already in that tab) and removes the label.
//
// props (optional): { machines: ["local", "vps"] } handles only those machines' terminals
// ("local" is this computer). Useful when two Herdr windows (HERDR_APP_HOME) share one core.
import { View, div } from "gpui-kit";
import { terminals, panes, props, hc, checking } from "herdr";
import { openImage } from "./open.js";

const LABEL = "imgview.open";

export default class ImgViewWatch extends View {
  init(_props, cx) {
    this.handling = {};
    if (checking()) return;
    cx.timer.every(1000, () => this.tick());
  }

  tick() {
    const only = props()?.machines;
    for (const t of terminals()) {
      const v = t.labels?.[LABEL];
      if (!v || this.handling[t.address] === v) continue;
      const machine = t.address.includes("/") ? t.address.split("/")[0] : null;
      if (Array.isArray(only) && !only.includes(machine ?? "local")) continue;
      const pane = panes().find((p) => p.terminal === t.address);
      if (!pane) continue;                      // not shown in this window: leave it for one that does
      this.handling[t.address] = v;
      hc(["label", t.address, `${LABEL}=`]);
      openImage({ file: v.slice(v.indexOf("|") + 1), on: machine, pane: pane.pane });
    }
  }

  render() {
    return div();
  }
}
