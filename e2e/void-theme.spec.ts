import { expect, test } from "@playwright/test";

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseCssColor(value: string): Rgba {
  const channels = value.match(/[\d.]+/g)?.map(Number);
  if (!channels || channels.length < 3) {
    throw new Error(`Unsupported computed color: ${value}`);
  }
  return {
    r: channels[0],
    g: channels[1],
    b: channels[2],
    a: channels[3] ?? 1,
  };
}

function relativeLuminance({ r, g, b }: Rgba): number {
  const linearize = (channel: number) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

function contrastRatio(foregroundValue: string, backgroundValue: string) {
  const foreground = parseCssColor(foregroundValue);
  const background = parseCssColor(backgroundValue);
  const composited = {
    r: foreground.r * foreground.a + background.r * (1 - foreground.a),
    g: foreground.g * foreground.a + background.g * (1 - foreground.a),
    b: foreground.b * foreground.a + background.b * (1 - foreground.a),
    a: 1,
  };
  const foregroundLuminance = relativeLuminance(composited);
  const backgroundLuminance = relativeLuminance(background);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
}

test("Void theme is selectable and survives a reload", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => window.localStorage.removeItem("theme"));
  await page.reload();

  const preferences = page.getByRole("button", { name: "Preferences" });
  await preferences.focus();
  await preferences.press("Enter");

  const themeTrigger = page.getByRole("button", { name: "Select theme" });
  await themeTrigger.focus();
  await themeTrigger.press("Enter");

  const voidOption = page.getByRole("menuitemradio", { name: "Void" });
  await expect(voidOption).toBeVisible();
  await expect(voidOption).toHaveAttribute("aria-checked", "false");
  await voidOption.focus();
  await voidOption.press("Enter");

  await expect(page.locator("html")).toHaveAttribute("data-theme", "void");
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("theme")))
    .toBe("void");

  await themeTrigger.press("Enter");
  await expect(
    page.getByRole("menuitemradio", { name: "Void" }),
  ).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");

  const voidStyles = await page.evaluate(() => {
    const probes = document.createElement("div");
    probes.setAttribute("aria-hidden", "true");
    probes.innerHTML = `
      <div data-probe="glow" class="app-glow"></div>
      <div data-probe="surface" class="glass-surface glass-sheen"></div>
      <div data-probe="gradient" class="bg-gradient-probe" style="background-image: linear-gradient(red, blue)"></div>
      <div data-probe="skeleton" class="skeleton"></div>
      <div data-probe="fade" class="fade-in glass-fade"></div>
      <div data-probe="tooltip" class="ui-tooltip"></div>
      <button data-probe="control" class="ui-icon-button"></button>
    `;
    document.body.appendChild(probes);

    const probe = (name: string) =>
      probes.querySelector<HTMLElement>(`[data-probe="${name}"]`)!;
    const surface = getComputedStyle(probe("surface"));
    const fade = getComputedStyle(probe("fade"));
    const result = {
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      bodyColor: getComputedStyle(document.body).color,
      controlBorderColor: getComputedStyle(probe("control")).borderTopColor,
      fadeAnimationName: fade.animationName,
      fadeMaskImage: fade.getPropertyValue("mask-image"),
      glowDisplay: getComputedStyle(probe("glow")).display,
      gradientBackgroundImage: getComputedStyle(probe("gradient"))
        .backgroundImage,
      sheenDisplay: getComputedStyle(probe("surface"), "::before").display,
      skeletonAnimationName: getComputedStyle(probe("skeleton")).animationName,
      surfaceBackdropFilter: surface.backdropFilter,
      surfaceBackground: surface.backgroundColor,
      surfaceBackgroundImage: surface.backgroundImage,
      tooltipAnimationName: getComputedStyle(probe("tooltip")).animationName,
    };
    probes.remove();
    return result;
  });

  expect(voidStyles.bodyBackground).toBe("rgb(0, 0, 0)");
  expect(voidStyles.surfaceBackground).toBe("rgb(0, 0, 0)");
  expect(voidStyles.surfaceBackgroundImage).toBe("none");
  expect(voidStyles.surfaceBackdropFilter).toBe("none");
  expect(voidStyles.glowDisplay).toBe("none");
  expect(voidStyles.gradientBackgroundImage).toBe("none");
  expect(voidStyles.sheenDisplay).toBe("none");
  expect(voidStyles.fadeMaskImage).toBe("none");
  expect(voidStyles.skeletonAnimationName).toBe("none");
  expect(voidStyles.fadeAnimationName).toBe("none");
  expect(voidStyles.tooltipAnimationName).toBe("none");
  expect(
    contrastRatio(voidStyles.bodyColor, voidStyles.bodyBackground),
  ).toBeGreaterThanOrEqual(4.5);
  expect(
    contrastRatio(voidStyles.controlBorderColor, voidStyles.surfaceBackground),
  ).toBeGreaterThanOrEqual(3);

  await page.reload();

  await expect(page.locator("html")).toHaveAttribute("data-theme", "void");
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(0, 0, 0)",
  );
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("theme")))
    .toBe("void");
});
