import { getDrawingTool, hasDrawingTool } from "openalgo-charts/draw";
import type { Widget } from "openalgo-charts/widget";
import { t } from "../../i18n";

// The drawing toolbar's More menu saves templates and applies them, but has
// no way to change one: this adds "Manage templates…" to it, which opens a
// dialog of the selected drawing's tool's templates, each renamed in place,
// given the drawing's current look, or deleted, and the tool's default
// forgotten. Built from the library's own dialog classes, so it looks like
// its "Save as template". Templates are looks only: nothing of an account.

/** How soon after the More button is pressed its menu counts as the one to add to. */
const MENU_WITHIN_MS = 1000;
const MAX_NAME = 120;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, className = "oac-btn") {
  const b = el("button", className, label);
  b.type = "button";
  return b;
}

const toolName = (tool: string) => (hasDrawingTool(tool) ? getDrawingTool(tool).name : tool);

/** The dialog, for one tool's templates. Returns its closer. */
function openManager(widget: Widget, tool: string): () => void {
  const templates = widget.drawingTemplates;
  if (!templates) return () => {};
  const panel = el("div", "oac-panel oac-pop pd-template-manager");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", t("chart.templates.title", { tool: toolName(tool) }));

  const head = el("div", "oac-dialog__head");
  head.append(
    el("span", "oac-dialog__title", t("chart.templates.title", { tool: toolName(tool) })),
  );
  const body = el("div", "oac-dialog__body");
  const error = el("p", "oac-input-error");
  error.setAttribute("role", "alert");
  error.hidden = true;
  const foot = el("div", "oac-dialog__foot");
  const done = button(t("chart.templates.close"), "oac-btn oac-btn--primary");
  const actions = el("div", "oac-dialog__actions");
  actions.append(done);
  foot.append(el("div", "oac-spacer"), actions);
  panel.append(head, body, error, foot);

  const fail = (e: unknown) => {
    error.textContent = t("chart.templates.failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    error.hidden = false;
  };
  const run = (work: () => Promise<unknown>) => {
    error.hidden = true;
    work().catch(fail);
  };
  /** The drawing whose look "Use this drawing's look" takes: the one selected, if it's this tool. */
  const source = () => {
    const id = widget.draw.selection()[0];
    const drawing = id ? widget.draw.get(id) : undefined;
    return drawing?.tool === tool ? drawing : undefined;
  };

  const render = () => {
    body.replaceChildren();
    const list = templates.templatesFor(tool);
    if (templates.defaultFor(tool)) {
      const row = el("div", "pd-template-row");
      row.append(el("span", "pd-template-default", t("chart.templates.default")));
      const forget = button(t("chart.templates.forget"));
      forget.addEventListener("click", () => run(() => templates.clearDefault(tool)));
      row.append(forget);
      body.append(row);
    }
    if (list.length === 0) {
      body.append(el("p", "pd-template-none", t("chart.templates.none")));
      return;
    }
    for (const template of list) {
      const row = el("div", "pd-template-row");
      const name = el("input", "oac-template-name__input pd-template-name");
      name.type = "text";
      name.maxLength = MAX_NAME;
      name.value = template.name;
      name.setAttribute("aria-label", t("chart.templates.name"));
      const rename = () => {
        const next = name.value.trim();
        if (!next || next === template.name) {
          name.value = template.name;
          return;
        }
        run(() => templates.store.renameTemplate(template.id, next));
      };
      name.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          name.blur();
        }
        if (e.key === "Escape") {
          e.stopPropagation();
          name.value = template.name;
          name.blur();
        }
      });
      name.addEventListener("blur", rename);

      const update = button(t("chart.templates.update"));
      update.title = t("chart.templates.updateHint");
      const drawing = source();
      update.disabled = !drawing;
      update.addEventListener("click", () => {
        const now = source();
        if (now) run(() => templates.saveTemplate(now.id, template.name));
      });

      // Deleting asks once more on the same button, so a slip costs nothing.
      const remove = button(t("chart.templates.delete"), "oac-btn oac-btn--danger");
      let armed = false;
      remove.addEventListener("click", () => {
        if (!armed) {
          armed = true;
          remove.textContent = t("chart.templates.confirm");
          return;
        }
        run(() => templates.removeTemplate(template.id));
      });
      remove.addEventListener("blur", () => {
        armed = false;
        remove.textContent = t("chart.templates.delete");
      });
      row.append(name, update, remove);
      body.append(row);
    }
  };

  render();
  const off = templates.subscribe(render);
  const close = widget.context.openOverlay(panel, {
    placement: "center",
    onClose: () => off(),
  });
  done.addEventListener("click", () => close());
  return close;
}

/**
 * "Manage templates…" at the foot of the drawing toolbar's More menu, for a
 * selected drawing whose tool has a template or a default saved.
 */
export function attachTemplateManager(widget: Widget): () => void {
  const { root } = widget;
  let pressed = 0;

  const toolOfSelection = () => {
    const ids = widget.draw.selection();
    const tools = new Set(ids.map((id) => widget.draw.get(id)?.tool));
    const [tool] = tools;
    return tools.size === 1 && typeof tool === "string" ? tool : undefined;
  };

  const onPress = (e: MouseEvent) => {
    if ((e.target as Element).closest?.('[data-drawbar="more"]')) pressed = Date.now();
  };

  const addRow = (menu: Element) => {
    const templates = widget.drawingTemplates;
    const tool = toolOfSelection();
    if (!templates || !tool) return;
    if (templates.templatesFor(tool).length === 0 && !templates.defaultFor(tool)) return;
    const body = menu.querySelector(".oac-menu__body") ?? menu;
    if (body.querySelector(".pd-template-manage")) return;
    const row = button("", "oac-menu__row pd-template-manage");
    row.setAttribute("role", "menuitem");
    row.append(
      el("span", "oac-glyph oac-glyph--chrome"),
      el("span", "oac-menu__label", t("chart.templates.manage")),
    );
    row.addEventListener("click", () => {
      // The menu is the newest overlay: close it, then open the dialog.
      widget.context.overlays.closeTop();
      openManager(widget, tool);
    });
    body.append(row);
  };

  const watch = new MutationObserver((records) => {
    if (Date.now() - pressed > MENU_WITHIN_MS) return;
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        const menu = node.matches('[role="menu"]') ? node : node.querySelector('[role="menu"]');
        if (menu) {
          pressed = 0;
          addRow(menu);
          return;
        }
      }
    }
  });
  watch.observe(root, { childList: true, subtree: true });
  root.addEventListener("click", onPress, true);
  return () => {
    watch.disconnect();
    root.removeEventListener("click", onPress, true);
  };
}
