/**
 * Reaching the login screen's key and settings menu.
 *
 * Add New Key, Manage Key and Settings moved off the login card into the
 * preferences dock — the collapsed pill at the top-left that also holds the
 * language and theme toggles. Two specs drive that route, so the two awkward
 * parts of it live here rather than being rediscovered in each.
 */
import { expect, type Page } from "@playwright/test";

/**
 * Expand the dock and open the keys-and-settings menu.
 *
 * Two things about this are worth knowing before changing it:
 *
 * - **Hover, never click, to expand.** The dock opens on pointer enter, so by
 *   the time a click on the chevron lands the dock is already open and the
 *   click toggles it straight back shut.
 * - **Do not gate on the gear being "visible".** The collapsed dock clips its
 *   contents with `max-w-0`, which leaves the buttons inside with a box of
 *   their own — visible to Playwright, and unclickable. `aria-expanded` on the
 *   chevron is the honest signal.
 */
export async function openLoginSettingsMenu(page: Page) {
  const dockToggle = page.getByRole("button", { name: "Preferences" });
  await dockToggle.hover();
  await expect(dockToggle).toHaveAttribute("aria-expanded", "true");

  await page.getByRole("button", { name: "Keys and settings" }).click();

  const menu = page.getByRole("menu").first();
  await expect(menu).toBeVisible();
  return menu;
}

/** Open the add-key dialog from that menu. */
export async function openAddKeyDialog(page: Page) {
  await openLoginSettingsMenu(page);
  await page.getByRole("menuitem", { name: "Add New Key" }).click();
  await expect(
    page.getByRole("dialog", { name: "Add New API Key" }),
  ).toBeVisible();
}
