# Better Cloudflare — Design System (Glass Modern Sunset)

## 1) Current System Review (Repo Reality)

- **Stack**: Tailwind + shadcn-style semantic tokens (`--background`, `--foreground`, etc.) defined in `src/index.css` and mapped in `tailwind.config.js`.
- **Theming mechanism**: `document.documentElement.dataset.theme` (set by `src/components/ui/ThemeToggle.tsx`) with theme IDs:
  - `sunset` (default in UI)
  - `oled` (deep black)
  - `light` (tarnished light; warm faded white)
- **Visual direction already present**:
  - Glass surfaces: frequent use of `bg-card/70..90` + `backdrop-blur-*` in `src/components/ui/*`.
  - Sunset glow: gradients and warm highlights in `app/layout.tsx` and utilities in `src/index.css`.
- **Gaps / inconsistencies to clean up over time**:
  - Several **hard-coded RGBA** glows/gradients exist alongside token-based colors (good candidates to token-ize).
  - Theme is token-driven, but some “glass feel” decisions (blur, border alpha, shadow recipes) are embedded per-component instead of being standardized as recipes.

## 2) Design Principles (What “Glass Modern Sunset” Means Here)

1. **Modernism**: clear hierarchy, generous spacing, restrained ornament, high legibility.
2. **Glassmorphism**: translucent surfaces with blur, subtle borders, and controlled specular highlights.
3. **Sunset identity**: warm orange-red accents and glows; never neon by default.
4. **Dark-mode friendly by default**: the primary brand theme is dark (`sunset`) with readable contrast and subdued backgrounds.
5. **Theme parity**: all themes share the same semantic tokens; components should not need theme-specific class overrides.

## 3) Token Model (Single Source of Truth)

All UI styling should be expressed via semantic tokens (HSL triplets) and Tailwind’s mapped colors.

**Core tokens (existing and required)**
- `--background`, `--foreground`
- `--card`, `--card-foreground`
- `--popover`, `--popover-foreground`
- `--primary`, `--primary-foreground`
- `--secondary`, `--secondary-foreground`
- `--muted`, `--muted-foreground`
- `--accent`, `--accent-foreground`
- `--destructive`, `--destructive-foreground`
- `--border`, `--input`, `--ring`
- `--radius`

**Alpha usage convention (how “glass” is applied)**
- Use alpha at the usage site, not in tokens:
  - Surfaces: `bg-card/70..90`, `bg-popover/85..95`
  - Borders: `border-border/50..70`
  - Text: `text-foreground/70..90`, `text-muted-foreground`
  - Overlays: `bg-background/70..85`

## 4) Themes (Palettes + Intent)

Theme IDs are applied as `data-theme` on `<html>`.

### 4.1 Sunset (Default Brand, Dark-Mode First)

Intent: warm, cinematic dark UI; orange primary; comfortable contrast.

- Backgrounds: near-black warm (`--background`), dark cards, warm borders.
- Primary: sunset orange-red.
- Accent/muted: warm brown/ember, never gray-blue.

### 4.2 OLED (Deep Black)

Intent: true-black canvas for OLED power savings and maximum contrast; keep chrome minimal.

- Background & card: pure black.
- Borders/inputs: low but visible contrast (dark gray).
- Primary: sunset orange stays saturated but avoid large bright fills.

### 4.3 Light (Tarnished / Faded White)

Intent: bright but not sterile; warm paper/ivory background; sunset primary remains the identity.

- Background: warm faded ivory.
- Cards/popovers: slightly brighter paper.
- Borders: soft warm-gray (not blue-gray).

## 5) Glass Surface Recipes (Standardize These)

Use these recipes consistently across components (Card, Menus, Dialogs, Panels).

**Framework note**
- The repo currently uses Tailwind + shadcn-style primitives. This doc is intentionally written so you can **keep Tailwind** while building a **fully personalized CSS framework layer** (custom utilities + components) on top.
- If you decide to **remove Tailwind**, do it as a staged migration: introduce stable custom classes first (this repo now has `glass-surface`, `ui-entry`, `ui-tag`, etc.), then replace Tailwind usage incrementally.

**Surface levels**
- `surface-1` (resting panels): `bg-card/80 backdrop-blur-md border border-border/60 shadow-[...]`
- `surface-2` (menus/popovers): `bg-popover/90..95 backdrop-blur-xl border border-border/60 shadow-[...]`
- `surface-3` (modal content): `bg-popover/90 backdrop-blur-xl border border-border/60 shadow-[0_18px_40px_rgba(0,0,0,0.2)]`

**Personalized utilities (implemented)**
- `glass-surface`: consistent glass background + blur + highlight + border
- `glass-surface-hover`: hover lift + border glow
- `glass-fade`: masked fade at the top edge (softens large containers)
- `ui-entry`: menu/list entry hover/active treatment (Radix `data-highlighted` aware)
- `ui-tag`: pill/tag styling with optional `data-variant="primary"`
- `ui-icon-button`: glassy icon button styling

**Borders**
- Default: `border-border/60`
- Focus/active: `ring-2 ring-ring ring-offset-2 ring-offset-background`

**Highlights**
- Use subtle inner highlights: `shadow` + `inset` lines rather than bright gradients on every surface.

## 6) Typography

**Font**
- Primary: Space Grotesk (500–600) as set in `src/index.css`.
- Fallbacks: `"Segoe UI", sans-serif`.

**Scale (Tailwind defaults recommended)**
- Body: `text-sm` and `text-base`
- Headings: `text-lg`, `text-xl`, `text-2xl`

**Letter spacing**
- Use tracking sparingly; reserve wide tracking for chrome (e.g., titlebar) and small caps-like labels.

## 7) Layout, Spacing, Radius

**Spacing**
- Use Tailwind spacing scale; favor `p-6` for panel interiors, `gap-4` for primary stacks, `gap-2` for controls.

**Radius**
- Global radius: `--radius` (currently `0.5rem`); use:
  - Cards/Dialogs: `rounded-xl`
  - Inputs/Buttons: `rounded-md`
  - Pills/toggles: `rounded-full`

## 8) Color Usage Rules (Semantic > Literal)

- **Never** hard-code hex/RGB in components for UI color decisions.
- Gradients/glows are allowed, but should be expressed as **theme-aware tokens** or utilities where possible.
- Use `primary` for calls to action, not for decoration.
- Use `accent` for hover/selected backgrounds; keep contrast safe across themes.

## 9) Components (Behavior + Visual Spec)

### Button
- Default: primary fill, subtle border, elevated shadow; hover increases brightness + shadow.
- Secondary: glass card surface (`bg-card/70`), border, inner shadow.
- Ghost: hover-only background using `accent`.
- Focus: always show ring with `--ring`.

### Card
- Always use `surface-1` recipe.
- Avoid placing high-saturation gradients inside card backgrounds; keep imagery as overlays behind glass.

### Input
- Use `bg-background` + `border-input`.
- Placeholder: `text-muted-foreground`.
- Focus: ring with `--ring`.

### Dropdown / Select / Popover
- Use `surface-2` recipe.
- Item hover/focus uses `accent/70` (not `primary`).

### Dialog
- Overlay: `bg-background/80 backdrop-blur-sm`.
- Content: `surface-3` recipe.

### Switch
- Track: `border-border` and a muted fill.
- Thumb: clear contrast; keep it neutral and let “on” state be expressed via `primary`.

### Toast
- Surface: `surface-2` with reduced shadow.
- Severity: destructive uses `--destructive`, others keep neutral with optional icon color.

## 10) Accessibility & Motion

- Ensure text contrast remains readable on translucent surfaces; prefer increasing surface opacity before increasing text brightness.
- Respect reduced-motion: animations should remain short and non-essential.
- Focus states must be visible on all themes; use ring tokens consistently.

## 11) Implementation References

- Tokens: `src/index.css`
- Tailwind mapping: `tailwind.config.js`
- Theme switching: `src/components/ui/ThemeToggle.tsx`
- Glass overlays: `app/layout.tsx`
