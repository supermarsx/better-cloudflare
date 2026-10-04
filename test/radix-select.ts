/**
 * Driving the app's themed dropdown (`@/components/ui/select`) from a test.
 *
 * The themed `Select` is a Radix trigger plus a portaled popover, not a native
 * `<select>`, so `fireEvent.change` does nothing to it and `HTMLSelectElement`
 * is the wrong type for its trigger. Three things about this environment are
 * worth stating once here rather than rediscovering per suite:
 *
 * 1. **Opening it needs pointer-capture stubs.** Radix's trigger calls
 *    `target.hasPointerCapture(...)` on `pointerdown`, which jsdom does not
 *    implement, and the popover is positioned by floating-ui, which wants a
 *    `ResizeObserver`. {@link enableThemedSelectEnvironment} installs both.
 *    With them in place the keyboard path — `ArrowDown` on the trigger, which
 *    is one of Radix's own open keys — opens the popover for real, so these
 *    helpers drive the component rather than its internals.
 * 2. **A closed popover is still in the document.** Radix renders a closed
 *    `Select`'s items into a detached `DocumentFragment`; `test/node-test-env`
 *    flattens `createPortal`, so here they land inline instead. That is why
 *    the helpers below always open the popover first: the closed-state nodes
 *    are a harness artifact, and the content's own props (its classes
 *    included) are not applied to them.
 * 3. **The selected item's text is doubled.** `SelectValue` shows the chosen
 *    item by portaling its text into the trigger; flattened, that copy renders
 *    next to the original. {@link optionLabel} collapses it, and is the only
 *    reason a label assertion needs a helper at all.
 *
 * Values are read from a `data-value` attribute the call sites put on each
 * item, because Radix consumes `value` and never reaches the DOM with it.
 */
import { act, fireEvent } from "@testing-library/react";

/** The jsdom gaps a real Radix `Select` needs in order to open. */
export function enableThemedSelectEnvironment(): void {
  const prototype = window.Element.prototype as unknown as Record<
    string,
    unknown
  >;
  prototype.hasPointerCapture ??= () => false;
  prototype.setPointerCapture ??= () => {};
  prototype.releasePointerCapture ??= () => {};
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as Record<string, unknown>).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
}

/**
 * Open a themed dropdown and return its listbox.
 *
 * `ArrowDown` is one of the keys Radix's own trigger opens on, so this is the
 * keyboard path a user has, not a synthetic state change.
 */
export async function openThemedSelect(
  trigger: HTMLElement,
): Promise<HTMLElement> {
  await act(async () => {
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
  });
  const listbox = document.querySelector<HTMLElement>('[role="listbox"]');
  if (listbox === null) {
    throw new Error(
      `the dropdown did not open (trigger state: ${trigger.getAttribute("data-state")})`,
    );
  }
  return listbox;
}

/**
 * Close an open dropdown with Escape.
 *
 * Radix's open popover marks everything outside itself `aria-hidden`, so a
 * dropdown left open hides the rest of the surface from every `*ByRole` query.
 * Every reading helper below therefore closes what it opened.
 */
export async function closeThemedSelect(): Promise<void> {
  const listbox = document.querySelector<HTMLElement>('[role="listbox"]');
  if (listbox === null) return;
  await act(async () => {
    fireEvent.keyDown(listbox, { key: "Escape" });
  });
}

/** Open the dropdown, read something out of it, and close it again. */
async function readOpen<T>(
  trigger: HTMLElement,
  read: (listbox: HTMLElement) => T,
): Promise<T> {
  const listbox = await openThemedSelect(trigger);
  try {
    return read(listbox);
  } finally {
    await closeThemedSelect();
  }
}

/** Every option a dropdown offers, in order, by `data-value`. */
export async function themedSelectValues(
  trigger: HTMLElement,
): Promise<string[]> {
  return readOpen(trigger, (listbox) =>
    Array.from(listbox.querySelectorAll<HTMLElement>('[role="option"]')).map(
      (option) => option.dataset.value ?? "",
    ),
  );
}

/**
 * One option's label, with the duplicate `SelectValue` copy collapsed.
 *
 * The collapse is halves-equal, not a trim, so it only fires on the exact
 * doubling this harness produces.
 */
export function optionLabel(option: HTMLElement): string {
  const text = option.textContent ?? "";
  if (text.length > 0 && text.length % 2 === 0) {
    const half = text.length / 2;
    if (text.slice(0, half) === text.slice(half)) return text.slice(0, half);
  }
  return text;
}

/** Every option's label, in order. */
export async function themedSelectLabels(
  trigger: HTMLElement,
): Promise<string[]> {
  return readOpen(trigger, (listbox) =>
    Array.from(listbox.querySelectorAll<HTMLElement>('[role="option"]')).map(
      optionLabel,
    ),
  );
}

/** Which option the dropdown currently reports as chosen, by `data-value`. */
export async function themedSelectValue(
  trigger: HTMLElement,
): Promise<string | null> {
  return readOpen(
    trigger,
    (listbox) =>
      listbox.querySelector<HTMLElement>(
        '[role="option"][data-state="checked"]',
      )?.dataset.value ?? null,
  );
}

/** Pick an option by its `data-value`, the way a pointer would. */
export async function chooseThemedSelectValue(
  trigger: HTMLElement,
  value: string,
): Promise<void> {
  const listbox = await openThemedSelect(trigger);
  const option = Array.from(
    listbox.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((candidate) => candidate.dataset.value === value);
  if (option === undefined) {
    throw new Error(`the dropdown offers no option with value ${value}`);
  }
  await act(async () => {
    fireEvent.click(option);
  });
}
