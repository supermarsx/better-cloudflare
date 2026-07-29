import { expect, test } from "@playwright/test";

const FADE_HEIGHT = "clamp(16px, 4%, 32px)";

test("bottom scroll fade stays short, readable, and interactive", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(process.env.BOTTOM_FADE_TEST_URL ?? "/");

  for (const { name, theme, height } of [
    { name: "light", theme: "light", height: 240 },
    { name: "dark", theme: "sunset", height: 800 },
  ] as const) {
    const probeId = `bottom-fade-${name}`;

    await page.evaluate(
      ({ probeId, theme, height }) => {
        document.documentElement.dataset.theme = theme;

        const fixture = document.createElement("div");
        fixture.id = probeId;
        fixture.className =
          "glass-surface glass-fade-table relative overflow-hidden rounded-xl";
        fixture.style.cssText = [
          "position:fixed",
          "left:24px",
          "top:24px",
          "width:360px",
          `height:${height}px`,
          "--table-bottom-fade:1",
          "z-index:99999",
        ].join(";");

        const finalAction = document.createElement("button");
        finalAction.type = "button";
        finalAction.dataset.testid = `${probeId}-action`;
        finalAction.textContent = "Final visible action";
        finalAction.style.cssText = [
          "position:absolute",
          "left:40px",
          "right:40px",
          "bottom:0",
          "height:40px",
          "background:hsl(var(--primary))",
          "color:hsl(var(--primary-foreground))",
        ].join(";");
        finalAction.addEventListener("click", () => {
          finalAction.dataset.clicked = "true";
        });

        fixture.append(finalAction);
        document.body.append(fixture);
      },
      { probeId, theme, height },
    );

    const fixture = page.locator(`#${probeId}`);
    const finalAction = page.getByTestId(`${probeId}-action`);
    const evidence = await fixture.evaluate((element) => {
      const style = getComputedStyle(element);
      const action = element.querySelector("button");
      if (!action) throw new Error("Fade probe action is missing");
      const rect = action.getBoundingClientRect();

      return {
        maskImage: style.maskImage,
        fadeHeight: style.getPropertyValue("--table-bottom-fade-height").trim(),
        hitTarget:
          document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          ) === action,
      };
    });

    expect(evidence.fadeHeight).toBe(FADE_HEIGHT);
    expect(evidence.maskImage).toContain(FADE_HEIGHT);
    expect(evidence.maskImage).toContain("rgba(0, 0, 0, 0.9)");
    expect(evidence.maskImage).toContain("rgba(0, 0, 0, 0.78)");
    expect(evidence.maskImage).not.toContain("rgba(0, 0, 0, 0) 100%");
    expect(evidence.hitTarget).toBe(true);

    await expect(finalAction).toBeVisible();
    await finalAction.click();
    await expect(finalAction).toHaveAttribute("data-clicked", "true");
    await fixture.screenshot({
      path: testInfo.outputPath(`bottom-fade-${name}-${height}px.png`),
    });

    await fixture.evaluate((element) => element.remove());
  }
});
